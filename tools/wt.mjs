#!/usr/bin/env node
// wt.mjs — minimal git-worktree helper for parallel agents.
//
// Each agent gets its own worktree under .worktrees/<name> on branch
// agent/<name>. The main working tree is never touched: the only entries
// this tool ever creates or removes live under .worktrees/.
//
// Zero dependencies (node: builtins only).
import {spawnSync} from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WT_DIRNAME = ".worktrees"

// ---------------------------------------------------------------- primitives

function fail(msg) {
	console.error(`wt: ${msg}`)
	process.exit(1)
}

function git(cwd, args, env) {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: env ? {...process.env, ...env} : process.env
	})
	if (r.error) fail(`failed to run git: ${r.error.message}`)
	return {ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim()}
}

function gitOrFail(cwd, args) {
	const r = git(cwd, args)
	if (!r.ok) fail(`git ${args.join(" ")} failed: ${r.err || r.out}`)
	return r.out
}

function repoRoot() {
	const r = git(process.cwd(), ["rev-parse", "--show-toplevel"])
	if (!r.ok) fail("not inside a git repository")
	return r.out
}

function parseArgs(argv) {
	const positional = []
	const flags = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--json") flags.json = true
		else if (a === "--baseline") flags.baseline = true
		else if (a === "--force") flags.force = true
		else if (a === "--base") flags.base = argv[++i]
		else if (a.startsWith("--base=")) flags.base = a.slice("--base=".length)
		else if (a.startsWith("--")) fail(`unknown flag: ${a}`)
		else positional.push(a)
	}
	if (flags.base === undefined && "base" in flags) fail("--base requires a value")
	return {positional, flags}
}

const paths = root => ({
	wtDir: path.join(root, WT_DIRNAME),
	metaDir: path.join(root, WT_DIRNAME, ".meta"),
	baseline: path.join(root, WT_DIRNAME, ".verify-baseline.json"),
})

function checkName(name) {
	if (!name || !NAME_RE.test(name)) fail(`invalid worktree name: ${JSON.stringify(name)} (use [A-Za-z0-9._-])`)
}

const branchOf = name => `agent/${name}`
const metaFile = (root, name) => path.join(paths(root).metaDir, `${name}.json`)

function writeMeta(root, meta) {
	const dir = paths(root).metaDir
	fs.mkdirSync(dir, {recursive: true})
	const file = path.join(dir, `${meta.name}.json`)
	// Atomic: a torn write must not make the worktree invisible to `list`.
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, `${JSON.stringify(meta, null, "\t")}\n`)
	fs.renameSync(tmp, file)
}

function readMeta(root, name) {
	const file = metaFile(root, name)
	if (!fs.existsSync(file)) fail(`unknown worktree: ${name}`)
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (e) {
		return fail(`corrupt metadata for ${name}: ${e.message}`)
	}
}

// Worktrees git knows about under .worktrees/, whether or not we have metadata.
function gitWorktrees(root) {
	const wtDir = path.resolve(paths(root).wtDir)
	const out = git(root, ["worktree", "list", "--porcelain"]).out
	const list = []
	let cur = null
	for (const line of out ? out.split("\n") : []) {
		if (line.startsWith("worktree ")) {
			if (cur) list.push(cur)
			cur = {path: line.slice("worktree ".length), branch: null}
		} else if (line.startsWith("branch ") && cur) {
			cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
		}
	}
	if (cur) list.push(cur)
	return list.filter(w => {
		const abs = path.resolve(w.path)
		return abs !== wtDir && abs.startsWith(`${wtDir}${path.sep}`)
	})
}

// Metadata for every worktree that exists on disk. Corrupt or missing metadata
// is reported with whatever is recoverable instead of being silently dropped.
function listMeta(root) {
	const dir = paths(root).metaDir
	const byName = new Map()
	if (fs.existsSync(dir)) {
		for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
			const fallback = f.slice(0, -".json".length)
			try {
				const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
				if (!meta || typeof meta !== "object") throw new Error("not an object")
				meta.corrupt = false
				byName.set(meta.name || fallback, meta)
			} catch (e) {
				byName.set(fallback, {
					name: fallback,
					path: path.join(paths(root).wtDir, fallback),
					branch: branchOf(fallback),
					base: null,
					base_sha: null,
					corrupt: true,
					corrupt_error: e.message
				})
			}
		}
	}
	for (const wt of gitWorktrees(root)) {
		const name = path.basename(wt.path)
		const meta = byName.get(name)
		if (meta) {
			if (!meta.path) meta.path = wt.path
			if (!meta.branch) meta.branch = wt.branch
			continue
		}
		byName.set(name, {
			name,
			path: wt.path,
			branch: wt.branch || branchOf(name),
			base: null,
			base_sha: null,
			untracked_meta: true
		})
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function branchExists(root, branch) {
	return git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok
}

function countLines(file) {
	try {
		const stat = fs.statSync(file)
		if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return 0
		const buf = fs.readFileSync(file)
		if (buf.includes(0)) return 0
		const text = buf.toString("utf8")
		if (text === "") return 0
		let n = text.split("\n").length
		if (text.endsWith("\n")) n--
		return n
	} catch {
		return 0
	}
}

// Parse `git status --porcelain` into {tracked, untracked} path lists.
function porcelain(wtPath) {
	const out = git(wtPath, ["status", "--porcelain"]).out
	const tracked = []
	const untracked = []
	for (const line of out ? out.split("\n") : []) {
		if (!line) continue
		const code = line.slice(0, 2)
		let file = line.slice(3)
		if (code.includes("R") && file.includes(" -> ")) file = file.split(" -> ").pop()
		if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)
		if (code === "??") untracked.push(file)
		else tracked.push(file)
	}
	return {tracked, untracked, dirty: tracked.length > 0 || untracked.length > 0}
}

// Has the worktree's current state been captured in .worktrees/<name>.patch?
// Compares the patch mtime against the newest mtime of the changed files.
function patchCaptured(root, name, wtPath, baseSha) {
	let patchStat
	try {
		patchStat = fs.statSync(path.join(paths(root).wtDir, `${name}.patch`))
	} catch {
		return false
	}
	if (!patchStat.isFile()) return false
	const {tracked, untracked} = porcelain(wtPath)
	const vsBase = baseSha ? git(wtPath, ["diff", "--name-only", baseSha]).out : ""
	const files = new Set([...tracked, ...untracked, ...(vsBase ? vsBase.split("\n") : [])])
	let newest = 0
	for (const f of files) {
		if (!f) continue
		try {
			const m = fs.statSync(path.join(wtPath, f)).mtimeMs
			if (m > newest) newest = m
		} catch {
			/* deleted file: nothing to weigh */
		}
	}
	return patchStat.mtimeMs >= newest
}

function describe(root, meta) {
	const wtPath = meta.path
	const branch = meta.branch
	const base = meta.base
	const exists = fs.existsSync(wtPath)
	const entry = {
		name: meta.name,
		path: wtPath,
		branch,
		base,
		corrupt: !!meta.corrupt,
		untracked_meta: !!meta.untracked_meta,
		changed_files: [],
		diff_lines: 0,
		dirty: false,
		last_change_ms_ago: null
	}
	if (!exists) return entry
	const baseSha = meta.base_sha || null
	const {tracked, untracked, dirty} = porcelain(wtPath)
	const trackedVsBase = baseSha ? git(wtPath, ["diff", "--name-only", baseSha]).out : ""
	const changed = [...new Set([...(trackedVsBase ? trackedVsBase.split("\n") : []), ...tracked, ...untracked])]
		.filter(Boolean)
		.sort()
	entry.changed_files = changed
	entry.dirty = dirty
	let lines = 0
	const numstat = baseSha ? git(wtPath, ["diff", "--numstat", baseSha]).out : ""
	for (const l of numstat ? numstat.split("\n") : []) {
		if (!l) continue
		const [add, del] = l.split("\t")
		lines += (Number.parseInt(add, 10) || 0) + (Number.parseInt(del, 10) || 0)
	}
	for (const f of untracked) lines += countLines(path.join(wtPath, f))
	entry.diff_lines = lines
	let newest = meta.created_ms || 0
	for (const f of changed) {
		try {
			const m = fs.statSync(path.join(wtPath, f)).mtimeMs
			if (m > newest) newest = m
		} catch {
			/* deleted file: keep previous */
		}
	}
	entry.last_change_ms_ago = Math.max(0, Date.now() - newest)
	return entry
}

// ---------------------------------------------------------------- commands

function cmdUp(root, name, flags) {
	checkName(name)
	if (name.endsWith(".patch")) fail(`invalid worktree name: ${name} (the .patch suffix is reserved for \`wt diff\` output)`)
	const p = paths(root)
	const wtPath = path.join(p.wtDir, name)
	const patchFile = path.join(p.wtDir, `${name}.patch`)
	if (fs.existsSync(patchFile) && fs.statSync(patchFile).isDirectory()) fail(`patch path is a directory: ${patchFile}`)
	const branch = branchOf(name)
	if (fs.existsSync(wtPath)) fail(`worktree path already exists: ${wtPath}`)
	if (branchExists(root, branch)) fail(`branch already exists: ${branch}`)
	const base = flags.base || "HEAD"
	const baseSha = git(root, ["rev-parse", "--verify", `${base}^{commit}`])
	if (!baseSha.ok) fail(`cannot resolve base ref ${JSON.stringify(base)}: ${baseSha.err || baseSha.out}`)
	fs.mkdirSync(p.wtDir, {recursive: true})
	gitOrFail(root, ["worktree", "add", wtPath, "-b", branch, baseSha.out])
	writeMeta(root, {
		name,
		path: wtPath,
		branch,
		base,
		base_sha: baseSha.out,
		created_ms: Date.now()
	})
	console.log(wtPath)
}

function cmdStatus(root, name, flags) {
	const metas = name ? [readMeta(root, name)] : listMeta(root)
	const entries = metas.map(m => describe(root, m))
	const corrupt = entries.filter(e => e.corrupt)
	if (corrupt.length > 0) console.error(`wt: warning: corrupt metadata for ${corrupt.map(e => e.name).join(", ")}`)
	if (flags.json) {
		console.log(JSON.stringify(name ? entries[0] : entries, null, "\t"))
		return
	}
	for (const e of entries) {
		const note = e.corrupt ? "  (corrupt metadata)" : e.untracked_meta ? "  (untracked metadata)" : ""
		console.log(`${e.name}  ${e.branch}  base=${e.base}  dirty=${e.dirty}  lines=${e.diff_lines}  idle=${e.last_change_ms_ago}ms${note}`)
		for (const f of e.changed_files) console.log(`  ${f}`)
	}
}

function cmdDiff(root, name) {
	checkName(name)
	const meta = readMeta(root, name)
	if (!fs.existsSync(meta.path)) fail(`worktree path is missing: ${meta.path}`)
	const patchFile = path.join(paths(root).wtDir, `${name}.patch`)
	// Intent-to-add makes untracked files appear in the patch without staging
	// content changes. It must never touch the worktree's own index, or a live
	// agent's `git stash` breaks and untracked files start showing up as `A` in
	// its `git status`. Run `add -N` + `diff` against a throwaway copy of the
	// real index (GIT_INDEX_FILE) and delete it afterwards.
	const realIndex = gitOrFail(meta.path, ["rev-parse", "--git-path", "index"])
	const realIndexAbs = path.isAbsolute(realIndex) ? realIndex : path.resolve(meta.path, realIndex)
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-index-"))
	const env = {GIT_INDEX_FILE: path.join(tmpDir, "index")}
	let patch = ""
	let numstat = ""
	let err = null
	try {
		if (fs.existsSync(realIndexAbs)) fs.copyFileSync(realIndexAbs, env.GIT_INDEX_FILE)
		const add = git(meta.path, ["add", "-A", "-N"], env)
		if (!add.ok) err = `git add -N failed: ${add.err || add.out}`
		else {
			const d = git(meta.path, ["diff", meta.base_sha], env)
			if (!d.ok) err = `git diff failed: ${d.err || d.out}`
			else {
				patch = d.out
				numstat = git(meta.path, ["diff", "--numstat", meta.base_sha], env).out
			}
		}
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true})
	}
	if (err) fail(err)
	fs.writeFileSync(patchFile, patch === "" ? "" : `${patch}\n`)
	let total = 0
	const rows = []
	for (const l of numstat ? numstat.split("\n") : []) {
		if (!l) continue
		const [add, del, ...rest] = l.split("\t")
		const a = Number.parseInt(add, 10) || 0
		const d = Number.parseInt(del, 10) || 0
		total += a + d
		rows.push(`+${a} -${d}  ${rest.join("\t")}`)
	}
	console.log(patchFile)
	for (const r of rows) console.log(r)
	console.log(`total: ${rows.length} file(s), ${total} line(s)`)
}

function hashFile(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function mainFiles(root) {
	// --others --exclude-standard matters: the most likely artifact of an agent
	// escaping its worktree is a NEW file in the main tree, which plain
	// `git ls-files` would never see.
	const out = gitOrFail(root, ["ls-files", "--cached", "--others", "--exclude-standard"])
	return out
		.split("\n")
		.filter(Boolean)
		.filter(f => !f.startsWith(`${WT_DIRNAME}/`))
		.sort()
}

function cmdVerify(root, flags) {
	const p = paths(root)
	const files = mainFiles(root)
	const current = {}
	for (const f of files) {
		const abs = path.join(root, f)
		try {
			current[f] = hashFile(abs)
		} catch {
			current[f] = "MISSING"
		}
	}
	if (flags.baseline) {
		fs.mkdirSync(p.wtDir, {recursive: true})
		fs.writeFileSync(p.baseline, `${JSON.stringify({files: current}, null, "\t")}\n`)
		console.log(`baseline: ${files.length} file(s) hashed`)
		return
	}
	if (!fs.existsSync(p.baseline)) fail("no baseline found; run `wt verify --baseline` first")
	let baseline
	try {
		baseline = JSON.parse(fs.readFileSync(p.baseline, "utf8"))
	} catch (e) {
		return fail(`corrupt baseline: ${e.message}`)
	}
	const before = baseline.files || {}
	const offending = []
	for (const f of Object.keys(before)) {
		if (!(f in current)) offending.push(`${f} (deleted)`)
		else if (current[f] !== before[f]) offending.push(`${f} (modified)`)
	}
	for (const f of Object.keys(current)) {
		if (!(f in before)) offending.push(`${f} (added)`)
	}
	if (offending.length > 0) {
		console.error(`wt: main working tree changed (${offending.length} file(s)):`)
		for (const f of offending.sort()) console.error(`  ${f}`)
		process.exit(1)
	}
	console.log(`verify OK: ${files.length} file(s) unchanged`)
}

function cmdDown(root, name, flags) {
	checkName(name)
	const p = paths(root)
	const wtPath = path.join(p.wtDir, name)
	const branch = branchOf(name)
	const existed = fs.existsSync(wtPath) || branchExists(root, branch)
	if (fs.existsSync(wtPath) && !flags.force) {
		const {tracked, untracked, dirty} = porcelain(wtPath)
		let meta = null
		const file = metaFile(root, name)
		if (fs.existsSync(file)) {
			try {
				meta = JSON.parse(fs.readFileSync(file, "utf8"))
			} catch {
				meta = null
			}
		}
		if (dirty && !patchCaptured(root, name, wtPath, meta && meta.base_sha)) {
			const files = [...new Set([...tracked, ...untracked])].sort()
			console.error(
				`wt: refusing to remove ${name}: ${files.length} uncommitted file(s) not captured in ${path.join(p.wtDir, `${name}.patch`)}`
			)
			for (const f of files) console.error(`  ${f}`)
			console.error(`wt: run \`wt diff ${name}\` to capture the work first, or pass --force to discard it`)
			process.exit(1)
		}
	}
	if (fs.existsSync(wtPath)) {
		const r = git(root, ["worktree", "remove", "--force", wtPath])
		if (!r.ok) fs.rmSync(wtPath, {recursive: true, force: true})
	}
	git(root, ["worktree", "prune"])
	if (branchExists(root, branch)) gitOrFail(root, ["branch", "-D", branch])
	fs.rmSync(metaFile(root, name), {force: true})
	fs.rmSync(path.join(p.wtDir, `${name}.patch`), {force: true})
	console.log(existed ? `removed ${name}` : `${name} already gone`)
}

function cmdList(root, flags) {
	const metas = listMeta(root)
	const entries = metas.map(m => ({
		name: m.name,
		path: m.path,
		branch: m.branch,
		base: m.base ?? null,
		exists: m.path ? fs.existsSync(m.path) : false,
		corrupt: !!m.corrupt,
		untracked_meta: !!m.untracked_meta
	}))
	if (flags.json) {
		console.log(JSON.stringify(entries, null, "\t"))
	} else {
		for (const e of entries) {
			const note = e.corrupt ? "  (corrupt metadata)" : e.untracked_meta ? "  (untracked metadata)" : ""
			console.log(`${e.name}  ${e.branch}  ${e.path}${e.exists ? "" : "  (missing)"}${note}`)
		}
	}
	const loose = entries.filter(e => e.untracked_meta)
	if (loose.length > 0)
		console.error(`wt: warning: ${loose.length} worktree(s) on disk have no metadata: ${loose.map(e => e.name).join(", ")}`)
	const corrupt = entries.filter(e => e.corrupt)
	if (corrupt.length > 0) {
		console.error(`wt: error: corrupt metadata for: ${corrupt.map(e => e.name).join(", ")}`)
		process.exit(1)
	}
}

const USAGE = `usage: wt <command> [args]

  up <name> [--base <ref>]   create .worktrees/<name> on branch agent/<name>
  status [<name>] [--json]   per-worktree change summary (done/stalled primitive)
  diff <name>                write .worktrees/<name>.patch vs its base
  verify [--baseline]        hash main tree, compare to baseline (escape guard)
  down <name> [--force]      remove worktree + branch (idempotent); refuses to
                             discard uncommitted work that was never diffed
  list [--json]              list worktrees (incl. corrupt/missing metadata)

verify boundary: it hashes tracked + untracked-non-ignored files in the MAIN
working tree only. It does NOT detect gitignored files (e.g. node_modules),
anything written under .worktrees/ (per-worktree integrity is status/diff's
job), or a file changed and then restored to its original bytes.
`

function main() {
	const argv = process.argv.slice(2)
	const cmd = argv[0]
	if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
		console.log(USAGE)
		if (!cmd) process.exit(1)
		return
	}
	const {positional, flags} = parseArgs(argv.slice(1))
	const root = repoRoot()
	const maxPositional = {up: 1, status: 1, diff: 1, verify: 0, down: 1, list: 0}
	if (cmd in maxPositional && positional.length > maxPositional[cmd]) {
		console.error(USAGE.trimEnd())
		fail(`unexpected argument: ${JSON.stringify(positional[maxPositional[cmd]])}`)
	}
	switch (cmd) {
		case "up":
			return cmdUp(root, positional[0], flags)
		case "status":
			if (positional[0]) checkName(positional[0])
			return cmdStatus(root, positional[0], flags)
		case "diff":
			return cmdDiff(root, positional[0])
		case "verify":
			return cmdVerify(root, flags)
		case "down":
			return cmdDown(root, positional[0], flags)
		case "list":
			return cmdList(root, flags)
		default:
			fail(`unknown command: ${cmd}`)
	}
}

main()
