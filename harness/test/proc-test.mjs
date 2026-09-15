import {spawn} from "node:child_process"
import {descendants, killTree, awaitExit, armBudget} from "../proc.mjs"

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg) {
	if (cond) pass++
	else {
		fail++
		failures.push(msg)
		console.log(`  FAIL ${msg}`)
	}
}
const alive = pid => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function testGrandchildInOwnGroupIsKilled() {
	console.log("== a grandchild in its own process group holding stdout is killed and does not stall the wait ==")
	// The child starts a grandchild via `setsid`-less trick: `sh -c` puts the
	// sleeper in a new session with `perl -e setsid` when available; otherwise it
	// still inherits stdout, which is the stall we care about.
	const child = spawn("/bin/sh", ["-c", "(perl -e 'use POSIX; setsid(); exec @ARGV' sleep 300 || sleep 300) & echo started; wait"], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"]
	})
	await sleep(400)
	const kids = descendants(child.pid)
	ok(kids.length >= 1, `descendants() sees the grandchild (got ${kids.length})`)
	const t0 = Date.now()
	killTree(child, "SIGKILL")
	const r = await awaitExit(child, {graceMs: 1500})
	const took = Date.now() - t0
	ok(took < 5000, `awaitExit returns promptly after the kill (${took}ms)`)
	await sleep(300)
	ok(kids.every(k => !alive(k)), "every descendant is dead after killTree")
	ok(typeof r.code === "number" && typeof r.closed === "boolean", "result carries code and closed")
}

async function testGraceWhenPipeHeld() {
	console.log("== exit with a held pipe resolves after the grace period, closed:false ==")
	// Grandchild keeps stdout open and ignores SIGTERM-free scenario: we only
	// kill the child itself (not the tree) to simulate a survivor.
	const child = spawn("/bin/sh", ["-c", "sleep 300 & exec sleep 300"], {detached: true, stdio: ["ignore", "pipe", "pipe"]})
	await sleep(300)
	const kids = descendants(child.pid)
	process.kill(child.pid, "SIGKILL") // only the leader; the backgrounded sleep survives and holds the pipe
	const t0 = Date.now()
	const r = await awaitExit(child, {graceMs: 800})
	const took = Date.now() - t0
	ok(took >= 700 && took < 4000, `resolved after the grace window, not after the survivor (${took}ms)`)
	ok(r.closed === false, "closed:false reports that pipes were still held")
	for (const k of kids) {
		try {
			process.kill(k, "SIGKILL")
		} catch {}
	}
}

async function testArmBudget() {
	console.log("== armBudget kills the tree at the deadline and reports timedOut ==")
	const child = spawn("/bin/sh", ["-c", "sleep 300"], {detached: true, stdio: ["ignore", "pipe", "pipe"]})
	let fired = false
	const b = armBudget(child, 300, {killAfterMs: 500, onTimeout: () => (fired = true)})
	const r = await awaitExit(child, {graceMs: 1000})
	b.cancel()
	ok(fired && b.timedOut(), "timeout callback fired and timedOut() is true")
	ok(r.signal === "SIGTERM" || r.signal === "SIGKILL" || r.code !== 0, `child was signalled (signal=${r.signal}, code=${r.code})`)
	const none = armBudget(child, null)
	ok(none.timedOut() === false, "no budget -> never times out")
}

async function testNormalExit() {
	console.log("== a normal exit resolves with closed:true and the exit code ==")
	const child = spawn("/bin/sh", ["-c", "echo hi; exit 3"], {detached: true, stdio: ["ignore", "pipe", "pipe"]})
	let out = ""
	child.stdout.on("data", d => (out += d))
	const r = await awaitExit(child)
	ok(r.code === 3 && r.closed === true, `code 3, closed (got code=${r.code} closed=${r.closed})`)
	ok(out.trim() === "hi", "stdout fully drained before resolve")
}

await testNormalExit()
await testArmBudget()
await testGrandchildInOwnGroupIsKilled()
await testGraceWhenPipeHeld()
console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) for (const f of failures) console.log(` - ${f}`)
process.exit(fail ? 1 : 0)
