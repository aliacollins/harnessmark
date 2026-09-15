// Process-tree control shared by the adapters.
//
// The adapters spawn a harness CLI with detached:true so the CLI and its tools
// form one process group and a negative-pid signal reaps them together. That is
// not enough on its own: a harness may put a tool it runs into its own process
// group (a `grep -r` over node_modules did exactly this), and a grandchild that
// survives the group kill keeps the inherited stdout pipe open, so waiting for
// the child's "close" event stalls until the grandchild finishes. One trial ran
// 55 minutes against a 30-minute budget that way. So: enumerate descendants
// before signalling, signal every one of them, and stop waiting a short grace
// period after "exit" whether or not the pipes have closed.
import {execFileSync} from "node:child_process"

// Direct and indirect children of `pid`, deepest first so leaves die before
// their parents can respawn anything. Uses `pgrep -P`, present on macOS and
// Linux; if it is missing the list is empty and callers fall back to the group.
export function descendants(pid) {
	const out = []
	const seen = new Set()
	const stack = [pid]
	while (stack.length) {
		const p = stack.pop()
		let kids = []
		try {
			kids = execFileSync("pgrep", ["-P", String(p)], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]})
				.split("\n")
				.map(s => Number.parseInt(s.trim(), 10))
				.filter(n => Number.isInteger(n) && n > 0)
		} catch {
			kids = []
		}
		for (const k of kids) {
			if (seen.has(k)) continue
			seen.add(k)
			out.push(k)
			stack.push(k)
		}
	}
	return out.reverse()
}

// Signal the child's process group, then every descendant individually (they may
// live in other groups), then the child itself. Never throws.
export function killTree(child, sig = "SIGTERM") {
	const pid = child && typeof child.pid === "number" ? child.pid : null
	if (pid === null) return
	const kids = descendants(pid)
	try {
		process.kill(-pid, sig)
	} catch {}
	for (const k of kids) {
		try {
			process.kill(k, sig)
		} catch {}
	}
	try {
		process.kill(pid, sig)
	} catch {}
}

// Resolve with {code, signal, closed} when the child has exited. Normally that
// is the "close" event (all stdio drained). If "exit" fires and the pipes are
// still held open by something else, give them `graceMs` and then resolve
// anyway with closed:false, so a stray grandchild cannot stall the adapter.
export function awaitExit(child, {graceMs = 3000, onError} = {}) {
	return new Promise(resolve => {
		let done = false
		let graceTimer = null
		const finish = (code, signal, closed) => {
			if (done) return
			done = true
			if (graceTimer) clearTimeout(graceTimer)
			resolve({code: typeof code === "number" ? code : -1, signal: signal || null, closed})
		}
		child.on("error", err => {
			if (onError) onError(err)
			finish(-1, null, false)
		})
		child.on("exit", (code, signal) => {
			graceTimer = setTimeout(() => {
				// Pipes still open: whoever holds them is not our concern any more.
				try {
					child.stdout && child.stdout.destroy()
					child.stderr && child.stderr.destroy()
				} catch {}
				finish(code, signal, false)
			}, graceMs)
		})
		child.on("close", (code, signal) => finish(code, signal, true))
	})
}

// Budget enforcement: SIGTERM the tree at `budgetMs`, SIGKILL it `killAfterMs`
// later. Returns {cancel(), timedOut()}.
export function armBudget(child, budgetMs, {killAfterMs = 5000, onTimeout} = {}) {
	const budget = Number(budgetMs)
	if (!Number.isFinite(budget) || budget <= 0) return {cancel() {}, timedOut: () => false}
	let timedOut = false
	let killTimer = null
	const t = setTimeout(() => {
		timedOut = true
		if (onTimeout) onTimeout()
		killTree(child, "SIGTERM")
		killTimer = setTimeout(() => killTree(child, "SIGKILL"), killAfterMs)
	}, budget)
	return {
		cancel() {
			clearTimeout(t)
			if (killTimer) clearTimeout(killTimer)
		},
		timedOut: () => timedOut
	}
}
