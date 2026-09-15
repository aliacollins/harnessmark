#!/usr/bin/env node
// Prepares the upstream clones the runner and harvester work from. Each active
// repo in harness/registry.mjs is cloned into its `cloneDir` (spike/work/<repo>,
// gitignored) and its dependencies installed with the registry's `install`
// recipe. Worktrees for every trial are cut from this clone and its dependency
// directory is linked in, so a run cannot start without it.
//
//   node tools/setup.mjs            # every active repo
//   node tools/setup.mjs hono       # one repo (active or candidate)
//   node tools/setup.mjs --check    # report what is missing, change nothing
import {spawnSync} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {REPOS, ROOT, activeRepos} from "../harness/registry.mjs"

export function status(spec) {
	const cloned = fs.existsSync(path.join(spec.cloneDir, ".git"))
	const deps = cloned && fs.existsSync(path.join(spec.cloneDir, spec.deps || "node_modules"))
	return {cloned, deps}
}

function sh(cmd, args, cwd, timeoutMs) {
	const r = spawnSync(cmd, args, {cwd, stdio: "inherit", timeout: timeoutMs})
	if (r.error) throw r.error
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`)
}

export function setup(spec) {
	const s = status(spec)
	if (!s.cloned) {
		fs.mkdirSync(path.dirname(spec.cloneDir), {recursive: true})
		console.log(`[${spec.name}] cloning ${spec.url}`)
		sh("git", ["clone", "--quiet", spec.url, spec.cloneDir], ROOT, spec.installTimeoutMs)
	} else {
		console.log(`[${spec.name}] clone present, fetching`)
		sh("git", ["fetch", "--quiet", "--all"], spec.cloneDir, spec.installTimeoutMs)
	}
	if (!s.deps || !s.cloned) {
		const [cmd, ...args] = spec.install
		console.log(`[${spec.name}] installing: ${spec.install.join(" ")}`)
		sh(cmd, args, spec.cloneDir, spec.installTimeoutMs)
	} else {
		console.log(`[${spec.name}] dependencies present`)
	}
}

function main(argv) {
	const check = argv.includes("--check")
	const names = argv.filter(a => !a.startsWith("--"))
	const specs = names.length ? names.map(n => {
		if (!REPOS[n]) throw new Error(`unknown repo "${n}" (known: ${Object.keys(REPOS).join(", ")})`)
		return REPOS[n]
	}) : activeRepos()
	let missing = 0
	for (const spec of specs) {
		if (check) {
			const s = status(spec)
			const state = !s.cloned ? "missing clone" : !s.deps ? "missing dependencies" : "ready"
			if (state !== "ready") missing++
			console.log(`${spec.name.padEnd(12)} ${state.padEnd(22)} ${path.relative(ROOT, spec.cloneDir)}`)
		} else {
			setup(spec)
		}
	}
	if (check && missing) console.log(`\n${missing} repo(s) not ready; run: node tools/setup.mjs`)
	return check && missing ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		process.exit(main(process.argv.slice(2)))
	} catch (e) {
		console.error(`setup: ${e.message}`)
		process.exit(1)
	}
}
