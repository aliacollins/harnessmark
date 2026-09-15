#!/usr/bin/env node
// Acceptance test for tools/wt.mjs.
//
// Runs against a synthetic throwaway git repo in a temp dir (NOT this project's
// repo) and needs no dependencies. Verifies the core isolation property:
// work inside a worktree never touches the main working tree.
import {spawnSync} from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, "..", "..", "tools", "wt.mjs")

let pass = 0
let fail = 0
const check = (cond, label) => {
	if (cond) {
		pass++
		console.log(`PASS: ${label}`)
	} else {
		fail++
		console.log(`FAIL: ${label}`)
	}
}

// ---------------------------------------------------------------- git helpers

const git = (dir, args) => {
	const r = spawnSync("git", args, {cwd: dir, encoding: "utf8"})
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
	return r.stdout
}

const wt = (dir, args) => spawnSync(process.execPath, [WT, ...args], {cwd: dir, encoding: "utf8"})

const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

// Every regular file outside .git/ and .worktrees/, as relpath -> sha256.
function snapshot(root) {
	const out = {}
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
			if (entry.name === ".git" || entry.name === ".worktrees") continue
			const abs = path.join(dir, entry.name)
			if (entry.isDirectory()) walk(abs)
			else if (entry.isFile()) out[path.relative(root, abs)] = sha(abs)
		}
	}
	walk(root)
	return out
}

function makeRepo() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"))
	fs.mkdirSync(path.join(tmp, "repo"))
	// realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) while
	// `git rev-parse --show-toplevel` reports the resolved path.
	const repo = fs.realpathSync(path.join(tmp, "repo"))
	git(repo, ["init", "-q", "-b", "main"])
	git(repo, ["config", "user.email", "test@example.com"])
	git(repo, ["config", "user.name", "wt test"])
	git(repo, ["config", "commit.gpgsign", "false"])
	fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n")
	fs.writeFileSync(path.join(repo, "a.txt"), "alpha\n")
	git(repo, ["add", "-A"])
	git(repo, ["commit", "-q", "-m", "init"])
	return {tmp, repo}
}

function withRepo(fn) {
	const {tmp, repo} = makeRepo()
	try {
		fn(repo)
	} finally {
		fs.rmSync(tmp, {recursive: true, force: true})
	}
}

const busyWait = ms => {
	const until = Date.now() + ms
	while (Date.now() < until) {
		/* spin */
	}
}

// MAJOR 1: `diff` must not mutate the worktree's real index.
function testDiffLeavesIndexAlone() {
	withRepo(repo => {
		check(wt(repo, ["up", "w"]).status === 0, "diff-isolation: up succeeds")
		const wtPath = path.join(repo, ".worktrees", "w")
		fs.writeFileSync(path.join(wtPath, "a.txt"), "changed\n")
		fs.writeFileSync(path.join(wtPath, "b.txt"), "bravo\n")
		const before = git(wtPath, ["status", "--porcelain"])
		const d = wt(repo, ["diff", "w"])
		check(d.status === 0, "diff-isolation: diff exits 0")
		check(git(wtPath, ["status", "--porcelain"]) === before, "diff-isolation: worktree git status is byte-identical after diff")
		const patch = fs.readFileSync(path.join(repo, ".worktrees", "w.patch"), "utf8")
		check(patch.includes("b.txt") && patch.includes("bravo"), "diff-isolation: patch still contains untracked b.txt")
		const st = spawnSync("git", ["stash"], {cwd: wtPath, encoding: "utf8"})
		check(st.status === 0, `diff-isolation: git stash in worktree succeeds (${(st.stderr || "").trim()})`)
	})
}

// MAJOR 2: `down` must not silently destroy uncaptured work.
function testDownGuards() {
	withRepo(repo => {
		check(wt(repo, ["up", "d1"]).status === 0, "down-guard(a): up d1")
		const p1 = path.join(repo, ".worktrees", "d1")
		fs.writeFileSync(path.join(p1, "w.txt"), "work\n")
		const r1 = wt(repo, ["down", "d1"])
		check(r1.status !== 0, "down-guard(a): dirty+uncaptured down exits nonzero")
		check(fs.existsSync(p1) && fs.existsSync(path.join(p1, "w.txt")), "down-guard(a): worktree and file survive")
		check(`${r1.stdout}${r1.stderr}`.includes("--force"), "down-guard(a): message says how to proceed")

		check(wt(repo, ["diff", "d1"]).status === 0, "down-guard(b): diff d1")
		check(wt(repo, ["down", "d1"]).status === 0, "down-guard(b): dirty+fresh patch down exits 0")

		check(wt(repo, ["up", "d2"]).status === 0, "down-guard(c): up d2")
		fs.writeFileSync(path.join(repo, ".worktrees", "d2", "w.txt"), "work\n")
		check(wt(repo, ["down", "d2", "--force"]).status === 0, "down-guard(c): --force down exits 0")

		check(wt(repo, ["up", "d3"]).status === 0, "down-guard(d): up d3")
		check(wt(repo, ["down", "d3"]).status === 0, "down-guard(d): clean down exits 0 without a flag")

		check(wt(repo, ["up", "d4"]).status === 0, "down-guard(e): up d4")
		const p4 = path.join(repo, ".worktrees", "d4")
		fs.writeFileSync(path.join(p4, "w.txt"), "one\n")
		check(wt(repo, ["diff", "d4"]).status === 0, "down-guard(e): diff d4")
		busyWait(20)
		fs.writeFileSync(path.join(p4, "w.txt"), "two\n")
		check(wt(repo, ["down", "d4"]).status !== 0, "down-guard(e): stale patch refuses")
		check(wt(repo, ["down", "d4", "--force"]).status === 0, "down-guard(e): --force still works")
	})
}

// MAJOR 3: torn/missing metadata must not hide a worktree that exists on disk.
function testMetaReconcile() {
	withRepo(repo => {
		// (b) hand-created worktree, no `wt up`. Do this first, while metadata is
		// healthy, so `list` exits 0.
		const manual = path.join(repo, ".worktrees", "manual")
		git(repo, ["worktree", "add", "-b", "agent/manual", manual])
		const r2 = wt(repo, ["list", "--json"])
		let e2 = null
		try {
			e2 = JSON.parse(r2.stdout)
		} catch {
			/* leave null */
		}
		check(r2.status === 0, "meta: list --json exits 0 with only untracked metadata")
		check(!!e2 && e2.some(e => e.name === "manual"), "meta: hand-created worktree appears in list --json")

		// (a) truncated metadata for a known worktree.
		check(wt(repo, ["up", "m1"]).status === 0, "meta: up m1")
		const leftovers = fs.readdirSync(path.join(repo, ".worktrees", ".meta")).filter(f => f.endsWith(".tmp"))
		check(leftovers.length === 0, "meta: atomic metadata write leaves no temp files")
		fs.writeFileSync(path.join(repo, ".worktrees", ".meta", "m1.json"), '{"name":"m1","path"')
		const r = wt(repo, ["list", "--json"])
		let entries = null
		try {
			entries = JSON.parse(r.stdout)
		} catch {
			/* leave null */
		}
		check(Array.isArray(entries) && entries.length > 0, "meta: list --json does not print an empty array for corrupt metadata")
		check(!!entries && entries.some(e => e.name === "m1"), "meta: list --json still reports the corrupt worktree m1")
		check(r.status !== 0, "meta: list --json exits nonzero for corrupt metadata")
	})
}

// MINOR: name/arg validation, --base, patch round-trip, verify deleted file, list.
function testMinor() {
	withRepo(repo => {
		check(wt(repo, ["up", "bad name"]).status !== 0, "minor: up rejects an invalid name")
		check(!fs.existsSync(path.join(repo, ".worktrees", "bad name")), "minor: invalid name creates nothing")
		check(wt(repo, ["up", "x.patch"]).status !== 0, "minor: up rejects a .patch name")
		check(!fs.existsSync(path.join(repo, ".worktrees", "x.patch")), "minor: .patch name creates nothing")

		const extra = wt(repo, ["up", "foo", "bar"])
		check(extra.status !== 0, "minor: up rejects extra positional args")
		check(!fs.existsSync(path.join(repo, ".worktrees", "foo")), "minor: extra-arg up creates nothing")
		check(`${extra.stdout}${extra.stderr}`.toLowerCase().includes("usage"), "minor: extra-arg rejection prints a usage line")

		fs.writeFileSync(path.join(repo, "c.txt"), "charlie\n")
		git(repo, ["add", "-A"])
		git(repo, ["commit", "-q", "-m", "second"])
		const first = git(repo, ["rev-parse", "HEAD~1"]).trim()
		check(wt(repo, ["up", "b1", "--base", first]).status === 0, "minor: up --base <ref> exits 0")
		const b1 = path.join(repo, ".worktrees", "b1")
		check(!fs.existsSync(path.join(b1, "c.txt")), "minor: --base worktree starts at the given ref")
		check(fs.existsSync(path.join(b1, "a.txt")), "minor: --base worktree has the base files")
	})

	withRepo(repo => {
		check(wt(repo, ["up", "rt"]).status === 0, "roundtrip: up rt")
		const p = path.join(repo, ".worktrees", "rt")
		fs.writeFileSync(path.join(p, "a.txt"), "roundtrip\n")
		fs.writeFileSync(path.join(p, "new.txt"), "new\n")
		check(wt(repo, ["diff", "rt"]).status === 0, "roundtrip: diff rt")
		const ap = spawnSync("git", ["apply", "--check", path.join(repo, ".worktrees", "rt.patch")], {
			cwd: repo,
			encoding: "utf8"
		})
		check(ap.status === 0, `roundtrip: git apply --check accepts the patch (${(ap.stderr || "").trim()})`)
	})

	withRepo(repo => {
		check(wt(repo, ["verify", "--baseline"]).status === 0, "verify-deleted: baseline")
		fs.rmSync(path.join(repo, "a.txt"))
		const r = wt(repo, ["verify"])
		check(r.status !== 0, "verify-deleted: exits nonzero for a deleted file")
		check(`${r.stdout}${r.stderr}`.includes("a.txt"), "verify-deleted: names the deleted file")
	})

	withRepo(repo => {
		check(wt(repo, ["up", "l1"]).status === 0, "list: up l1")
		const rj = wt(repo, ["list", "--json"])
		let arr = null
		try {
			arr = JSON.parse(rj.stdout)
		} catch {
			/* leave null */
		}
		check(rj.status === 0, "list --json exits 0")
		check(!!arr && arr.length === 1 && arr[0].name === "l1" && arr[0].branch === "agent/l1", "list --json reports the worktree")
		const rt = wt(repo, ["list"])
		check(rt.status === 0 && rt.stdout.includes("l1"), "list (text) reports the worktree")
	})
}

function main() {
	const {tmp, repo} = makeRepo()
	try {
		const initial = snapshot(repo)
		const name = "worker"
		const wtPath = path.join(repo, ".worktrees", name)
		const branch = `agent/${name}`

		// Baseline taken while the main tree is pristine.
		const baseline = wt(repo, ["verify", "--baseline"])
		check(baseline.status === 0, "verify --baseline writes a baseline")

		// 1. up creates the worktree and the branch.
		const up = wt(repo, ["up", name])
		check(up.status === 0, "up exits 0")
		check(up.stdout.trim() === wtPath, "up prints the absolute worktree path")
		check(fs.existsSync(wtPath) && fs.statSync(wtPath).isDirectory(), "up creates the worktree directory")
		check(git(repo, ["branch", "--list", branch]).trim() !== "", `up creates branch ${branch}`)

		// 8a. up refuses a duplicate name.
		const dup = wt(repo, ["up", name])
		check(dup.status !== 0, "up refuses a duplicate name")

		// 2. Work inside the worktree does NOT appear in the main tree.
		fs.writeFileSync(path.join(wtPath, "b.txt"), "bravo\n")
		fs.writeFileSync(path.join(wtPath, "a.txt"), "alpha from worktree\n")
		check(fs.readFileSync(path.join(repo, "a.txt"), "utf8") === "alpha\n", "worktree edit does not touch main a.txt")
		check(!fs.existsSync(path.join(repo, "b.txt")), "worktree-created file does not appear in main tree")
		check(JSON.stringify(snapshot(repo)) === JSON.stringify(initial), "main tree is byte-identical after worktree edits")

		// 3. diff captures the patch; status reports the changed file.
		const diff = wt(repo, ["diff", name])
		check(diff.status === 0, "diff exits 0")
		const patchFile = path.join(repo, ".worktrees", `${name}.patch`)
		check(fs.existsSync(patchFile), "diff writes .worktrees/<name>.patch")
		const patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : ""
		check(patch.includes("b.txt") && patch.includes("bravo"), "patch contains the new untracked file")
		check(patch.includes("alpha from worktree"), "patch contains the modified file")

		const status = wt(repo, ["status", name, "--json"])
		check(status.status === 0, "status --json exits 0")
		let info = null
		try {
			info = JSON.parse(status.stdout)
		} catch {
			/* leave null */
		}
		check(info !== null, "status --json emits parseable JSON")
		check(!!info && info.changed_files.includes("b.txt"), "status reports the changed file b.txt")
		check(!!info && info.changed_files.includes("a.txt"), "status reports the changed file a.txt")
		check(!!info && info.dirty === true, "status reports dirty")
		check(!!info && info.diff_lines > 0, "status reports diff_lines")
		check(!!info && typeof info.last_change_ms_ago === "number" && info.last_change_ms_ago >= 0, "status reports last_change_ms_ago")
		check(!!info && info.path === wtPath && info.branch === branch, "status reports path and branch")

		// 4. verify passes when only the worktree changed.
		const verifyClean = wt(repo, ["verify"])
		check(verifyClean.status === 0, "verify passes when only the worktree changed")

		// 5. verify fails nonzero when the main tree is modified directly.
		fs.writeFileSync(path.join(repo, "a.txt"), "escaped!\n")
		const verifyDirty = wt(repo, ["verify"])
		check(verifyDirty.status !== 0, "verify fails nonzero when the main tree is modified")
		const verifyOut = `${verifyDirty.stdout}${verifyDirty.stderr}`
		check(verifyOut.includes("a.txt"), "verify lists the offending path")
		fs.writeFileSync(path.join(repo, "a.txt"), "alpha\n")
		check(wt(repo, ["verify"]).status === 0, "verify passes again after the main tree is restored")

		// 5b. an untracked NEW file in the main tree is an escape too. This is the
		// likeliest artifact of an agent writing outside its worktree, and plain
		// `git ls-files` misses it.
		fs.writeFileSync(path.join(repo, "escaped.txt"), "escape\n")
		const verifyUntracked = wt(repo, ["verify"])
		check(verifyUntracked.status !== 0, "verify fails nonzero for an untracked new file in the main tree")
		check(
			`${verifyUntracked.stdout}${verifyUntracked.stderr}`.includes("escaped.txt"),
			"verify lists the untracked file as added"
		)
		fs.rmSync(path.join(repo, "escaped.txt"))
		check(wt(repo, ["verify"]).status === 0, "verify passes again after the untracked file is removed")

		// 6. down removes the worktree and branch; main tree is byte-identical.
		const down = wt(repo, ["down", name])
		check(down.status === 0, "down exits 0")
		check(!fs.existsSync(wtPath), "down removes the worktree directory")
		check(git(repo, ["branch", "--list", branch]).trim() === "", `down deletes branch ${branch}`)
		check(JSON.stringify(snapshot(repo)) === JSON.stringify(initial), "main tree is byte-identical after down")

		// 7. down is idempotent.
		const down2 = wt(repo, ["down", name])
		check(down2.status === 0, "down is idempotent (second run exits 0)")

		// 8b. up refuses a duplicate name (worktree re-created).
		check(wt(repo, ["up", name]).status === 0, "up succeeds again after down")
		check(wt(repo, ["up", name]).status !== 0, "up refuses a duplicate name (recreated)")
		check(wt(repo, ["down", name]).status === 0, "cleanup down succeeds")
	} finally {
		fs.rmSync(tmp, {recursive: true, force: true})
	}

	testDiffLeavesIndexAlone()
	testDownGuards()
	testMetaReconcile()
	testMinor()

	console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`)
	if (fail > 0) process.exit(1)
}

main()
