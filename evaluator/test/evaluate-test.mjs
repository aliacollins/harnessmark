import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {REPOS, loadTasks} from "../../harness/registry.mjs"
import {baseline, evaluate} from "../evaluate.mjs"

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg) {
	if (cond) {
		pass++
	} else {
		fail++
		failures.push(msg)
		console.log(`  FAIL ${msg}`)
	}
}
function eq(actual, expected, msg) {
	const a = JSON.stringify(actual)
	const b = JSON.stringify(expected)
	ok(a === b, `${msg} (got ${a}, want ${b})`)
}

function git(dir, args, allowFail = false) {
	const r = spawnSync("git", args, {cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024})
	if (!allowFail && r.status !== 0) {
		throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
	}
	return (r.stdout || "").trim()
}

function gitRaw(dir, args) {
	const r = spawnSync("git", args, {cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024})
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
	return r.stdout || ""
}

function write(root, rel, content) {
	const p = path.join(root, rel)
	fs.mkdirSync(path.dirname(p), {recursive: true})
	fs.writeFileSync(p, content)
}


const RUNNER_SRC = `import fs from "node:fs"
import path from "node:path"
const argv = process.argv.slice(2)
const files = argv.filter(a => !a.startsWith("--"))
const outArg = argv.find(a => a.startsWith("--outputFile="))
const outFile = outArg ? outArg.slice("--outputFile=".length) : null
const cwd = process.cwd()
const read = p => { try { return fs.readFileSync(path.join(cwd, p), "utf8") } catch { return "" } }
if (fs.existsSync(path.join(cwd, "src/hang.txt"))) { const t = Date.now(); while (Date.now() - t < 10000) {} }
const fixed = /fixed\\s*=\\s*true/.test(read("src/fix.js"))
const breakers = new Set(read("src/break.txt").split("\\n").map(s => s.trim()).filter(Boolean))
const suppress = fs.existsSync(path.join(cwd, "src/notests.txt"))
const list = files.length ? files : ["tests/foo.test.js"]
const testResults = []
if (!suppress) {
	for (const f of list) {
		const src = read(f)
		const names = [...src.matchAll(/\\bit\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]/g)].map(m => m[1])
		const assertionResults = names.map(name => {
			let status = "passed"
			if (breakers.has(name)) status = "failed"
			else if (/f2p/.test(name) && !fixed) status = "failed"
			return {ancestorTitles: [], fullName: name, title: name, status, failureMessages: status === "failed" ? ["forced"] : [], duration: 1}
		})
		testResults.push({name: path.resolve(cwd, f), status: assertionResults.some(a => a.status === "failed") ? "failed" : "passed", assertionResults})
	}
}
const all = testResults.flatMap(t => t.assertionResults)
const passed = all.filter(a => a.status === "passed").length
const failed = all.filter(a => a.status === "failed").length
if (outFile) fs.writeFileSync(outFile, JSON.stringify({numTotalTests: all.length, numPassedTests: passed, numFailedTests: failed, testResults}))
process.exit(failed ? 1 : 0)
`

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-synth-"))
	git(root, ["init", "-q"])
	git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
	git(root, ["config", "user.email", "eval@test"])
	git(root, ["config", "user.name", "eval"])
	write(root, "runner.mjs", RUNNER_SRC)
	write(root, ".gitignore", "node_modules/\n")
	write(root, "package.json", `${JSON.stringify({name: "synth", private: true}, null, 2)}\n`)
	write(root, "src/fix.js", "export const fixed = false\n")
	write(root, "src/other.js", "export const other = 1\n")
	write(root, "fixtures/helper.js", "export const helper = 1\n")
	write(root, "tests/foo.test.js", `it("works alpha", () => {})\nit("works beta", () => {})\n`)
	write(root, "tests/other.test.js", `it("other one", () => {})\n`)
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "parent"])
	const parent = git(root, ["rev-parse", "HEAD"])
	write(root, "src/fix.js", "export const fixed = true\n")
	write(
		root,
		"tests/foo.test.js",
		`it("works alpha", () => {})\nit("works beta", () => {})\nit("f2p gamma", () => {})\nit("f2p delta", () => {})\n`
	)
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "fix"])
	const sha = git(root, ["rev-parse", "HEAD"])
	return {root, parent, sha}
}

function tamperBranch(root, sha, name, mutate, paths, binary = false) {
	git(root, ["checkout", "-f", "main"])
	git(root, ["clean", "-fd"])
	git(root, ["checkout", "-q", "-B", name, sha])
	mutate(root)
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", name])
	const args = ["diff"]
	if (binary) args.push("--binary")
	args.push(sha, name, "--", ...paths)
	const piece = gitRaw(root, args)
	git(root, ["checkout", "-q", "main"])
	return piece
}

async function main() {
	const {root, parent, sha} = makeRepo()
	const patches = fs.mkdtempSync(path.join(os.tmpdir(), "eval-patches-"))
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cache-"))
	const put = (name, text) => {
		const p = path.join(patches, name)
		fs.writeFileSync(p, text)
		return p
	}

	const task = {
		sha,
		parent_sha: parent,
		test_paths: ["tests/foo.test.js"],
		support_paths: ["fixtures/helper.js"],
		source_paths: ["src/fix.js"]
	}

	const stub = path.join(root, "runner.mjs")
	REPOS.synth = {
		url: "",
		cloneDir: root,
		install: [],
		testCmd: process.execPath,
		testArgs: files => [stub, ...files],
		testTimeoutMs: 2500,
		installTimeoutMs: 1000
	}

	const fixPatch = gitRaw(root, ["diff", parent, sha, "--", "src/fix.js"])

	const noopPiece = tamperBranch(root, sha, "noop", r => write(r, "src/note.js", "export const note = 1\n"), ["src/note.js"])
	const breakPiece = tamperBranch(root, sha, "brk", r => write(r, "src/break.txt", "works beta\n"), ["src/break.txt"])
	const hangPiece = tamperBranch(root, sha, "hang", r => write(r, "src/hang.txt", "x\n"), ["src/hang.txt"])
	const nonePiece = tamperBranch(root, sha, "none", r => write(r, "src/notests.txt", "x\n"), ["src/notests.txt"])

	console.log("== synthetic baseline ==")
	const base = await baseline({repo: "synth", task, dir: root, opts: {cacheDir}})
	eq(base.f2p, ["f2p delta", "f2p gamma"], "baseline f2p is the two oracle failures")
	eq(base.p2p, ["works alpha", "works beta"], "baseline p2p is the pre-existing passes")
	eq(base.raw.failed, 2, "baseline raw failed count")

	const fixFile = put("fix.patch", fixPatch)
	const noopFile = put("noop.patch", noopPiece)
	const emptyFile = put("empty.patch", "\n")

	console.log("== reason reachability ==")
	const rResolved = await evaluate({repo: "synth", task, candidatePatch: fixFile, dir: root, baseline: base})
	ok(rResolved.resolved === true, "reference fix resolves")
	eq(rResolved.reason, "resolved", "reference fix reason")
	eq(rResolved.f2p.passed, 2, "reference fix f2p passed")
	eq(rResolved.p2p.passed, 2, "reference fix p2p passed")

	const rF2p = await evaluate({repo: "synth", task, candidatePatch: noopFile, dir: root, baseline: base})
	ok(rF2p.resolved === false, "no fix does not resolve")
	eq(rF2p.reason, "f2p_failed", "no fix reason f2p_failed")
	eq(rF2p.p2p.passed, 2, "no fix keeps p2p passing")
	ok(rF2p.f2p.passed < rF2p.f2p.required, "no fix leaves f2p incomplete")

	const rEmpty = await evaluate({repo: "synth", task, candidatePatch: emptyFile, dir: root, baseline: base})
	eq(rEmpty.reason, "empty_patch", "empty patch reason")
	eq(rEmpty.patch.empty, true, "empty patch flagged")

	const badFix = put(
		"bad.patch",
		`diff --git a/src/fix.js b/src/fix.js\nindex 1111111..2222222 100644\n--- a/src/fix.js\n+++ b/src/fix.js\n@@ -1,3 +1,3 @@\n-this context does not exist\n+nor does this\n`
	)
	const rBad = await evaluate({repo: "synth", task, candidatePatch: badFix, dir: root, baseline: base})
	eq(rBad.reason, "patch_apply_failed", "bad patch reason")
	eq(rBad.patch.applied, false, "bad patch not applied")

	const timeoutFile = put("timeout.patch", fixPatch + "\n" + hangPiece)
	const rTimeout = await evaluate({repo: "synth", task, candidatePatch: timeoutFile, dir: root, baseline: base})
	eq(rTimeout.reason, "test_timeout", "hanging tests reason")

	const noTestsBase = {...base, f2p: [], p2p: base.p2p, raw: {exit: 0, passed: 0, failed: 0, total: 0}, sha: base.sha}
	const rNoBaseline = await evaluate({repo: "synth", task, candidatePatch: fixFile, dir: root, baseline: noTestsBase})
	eq(rNoBaseline.reason, "no_tests_ran", "baseline with zero f2p is ungradable")

	const noTestsFile = put("notests.patch", fixPatch + "\n" + nonePiece)
	const rNoTests = await evaluate({repo: "synth", task, candidatePatch: noTestsFile, dir: root, baseline: base})
	eq(rNoTests.reason, "no_tests_ran", "candidate run with no per-test names")

	const breakFile = put("break.patch", fixPatch + "\n" + breakPiece)
	const rBreak = await evaluate({repo: "synth", task, candidatePatch: breakFile, dir: root, baseline: base})
	eq(rBreak.reason, "p2p_regression", "p2p regression reason")
	eq(rBreak.f2p.passed, 2, "p2p regression still fixes f2p")
	ok(rBreak.p2p.passed < rBreak.p2p.required, "p2p regression detected")

	console.log("== tamper rules (each revert-sensitive: the bare fix resolves) ==")
	const tamperCases = [
		{
			kind: "modifies_oracle_test",
			what: "support file under task.support_paths",
			piece: tamperBranch(root, sha, "t-oracle", r => write(r, "fixtures/helper.js", "export const helper = 2\n"), ["fixtures/helper.js"])
		},
		{
			kind: "modifies_test_infra",
			what: "package.json",
			piece: tamperBranch(root, sha, "t-infra", r => write(r, "package.json", `${JSON.stringify({name: "synth", private: true, extra: 1})}\n`), ["package.json"])
		},
		{
			kind: "deletes_test_file",
			what: "tests/other.test.js removed",
			piece: tamperBranch(root, sha, "t-del", r => git(r, ["rm", "-q", "tests/other.test.js"]), ["tests/other.test.js"])
		},
		{
			kind: "weakens_assertions",
			what: "it.skip added to tests/other.test.js",
			piece: tamperBranch(
				root,
				sha,
				"t-weak",
				r => write(r, "tests/other.test.js", `it("other one", () => {})\nit.skip("disabled", () => {})\n`),
				["tests/other.test.js"]
			)
		},
		{
			kind: "touches_outside_repo",
			what: "path containing ..",
			piece: tamperBranch(root, sha, "t-out", r => write(r, "src/a..b.js", "export const ab = 1\n"), ["src/a..b.js"])
		},
		{
			kind: "binary_patch",
			what: "git binary patch",
			piece: tamperBranch(
				root,
				sha,
				"t-bin",
				r => write(r, "assets/blob.bin", Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 200])),
				["assets/blob.bin"],
				true
			)
		}
	]

	const FATAL_KINDS = new Set(["touches_outside_repo", "binary_patch"])
	for (const c of tamperCases) {
		const file = put(`tamper-${c.kind}.patch`, fixPatch + "\n" + c.piece)
		const r = await evaluate({repo: "synth", task, candidatePatch: file, dir: root, baseline: base})
		const kinds = r.tamper.findings.map(f => f.kind)
		const finding = r.tamper.findings.find(f => f.kind === c.kind)
		ok(kinds.includes(c.kind), `${c.kind}: finding present (got ${JSON.stringify(kinds)})`)
		if (FATAL_KINDS.has(c.kind)) {
			ok(r.tamper.clean === false, `${c.kind}: fatal, tamper.clean false (${c.what})`)
			eq(finding.fatal, true, `${c.kind}: marked fatal`)
			ok(r.resolved === false, `${c.kind}: not resolved`)
			eq(r.reason, "tamper_detected", `${c.kind}: reason tamper_detected`)
		} else {
			// Recoverable: the grading environment is rebuilt from the oracle, so the
			// candidate is judged on its source change alone.
			ok(r.tamper.clean === true, `${c.kind}: recoverable, tamper.clean true (${c.what})`)
			eq(finding.fatal, false, `${c.kind}: marked non-fatal`)
			ok(r.reason !== "tamper_detected", `${c.kind}: not failed for tampering (got ${r.reason})`)
		}
		const bare = await evaluate({repo: "synth", task, candidatePatch: fixFile, dir: root, baseline: base})
		ok(bare.resolved === true, `${c.kind}: revert-sensitivity, bare fix resolves`)
	}

	// The property that makes this sound: weakening or disabling the oracle tests
	// cannot turn an unsolved task into a solved one, because the oracle files are
	// restored from the fix commit before grading.
	const cheatPiece = tamperCases.find(c => c.kind === "weakens_assertions").piece
	const rCheat = await evaluate({repo: "synth", task, candidatePatch: put("cheat-only.patch", cheatPiece), dir: root, baseline: base})
	ok(rCheat.resolved === false, "cheat-only: disabling tests without a source fix does not resolve")
	ok(rCheat.f2p.passed === 0, "cheat-only: f2p still failing after oracle restoration")

	const deletePiece = tamperCases.find(c => c.kind === "deletes_test_file").piece
	const rDeleteCheat = await evaluate({repo: "synth", task, candidatePatch: put("delcheat.patch", deletePiece), dir: root, baseline: base})
	ok(rDeleteCheat.resolved === false, "delete-cheat: removing the oracle file does not resolve")

	console.log("== precedence ordering ==")
	const binaryOnly = put("binary-only.patch", "GIT binary patch\n")
	const rEmptyOverTamper = await evaluate({repo: "synth", task, candidatePatch: binaryOnly, dir: root, baseline: base})
	ok(rEmptyOverTamper.tamper.findings.some(f => f.kind === "binary_patch"), "empty/tamper: binary finding recorded")
	eq(rEmptyOverTamper.reason, "empty_patch", "empty_patch precedes tamper_detected")

	const badDelete = put(
		"bad-delete.patch",
		`diff --git a/tests/other.test.js b/tests/other.test.js\ndeleted file mode 100644\n--- a/tests/other.test.js\n+++ /dev/null\n@@ -1,99 +0,0 @@\n-it("nope", () => {})\n`
	)
	const rApplyOverTamper = await evaluate({repo: "synth", task, candidatePatch: badDelete, dir: root, baseline: base})
	ok(rApplyOverTamper.tamper.findings.some(f => f.kind === "deletes_test_file"), "apply/tamper: delete finding recorded")
	eq(rApplyOverTamper.reason, "patch_apply_failed", "patch_apply_failed precedes tamper_detected")

	const tamperTimeout = put("tamper-timeout.patch", fixPatch + "\n" + tamperCases[4].piece + "\n" + hangPiece)
	const rTamperOverTimeout = await evaluate({repo: "synth", task, candidatePatch: tamperTimeout, dir: root, baseline: base})
	ok(rTamperOverTimeout.tamper.clean === false, "tamper/timeout: tamper recorded")
	eq(rTamperOverTimeout.reason, "tamper_detected", "tamper_detected precedes test_timeout")

	const timeoutNoTests = put("timeout-notests.patch", fixPatch + "\n" + hangPiece + "\n" + nonePiece)
	const rTimeoutOverNoTests = await evaluate({repo: "synth", task, candidatePatch: timeoutNoTests, dir: root, baseline: base})
	eq(rTimeoutOverNoTests.reason, "test_timeout", "test_timeout precedes no_tests_ran")

	console.log("== real integration: immer ==")
	const evDir = process.env.EVAL_TEST_DIR || "/tmp/ev-immer"
	if (!fs.existsSync(evDir)) {
		console.log(`  SKIP integration: ${evDir} missing`)
	} else {
		const tasks = loadTasks("immer")
		const itask = tasks[0]
		const gitRun = args => gitRaw(evDir, args)
		const srcPaths = itask.source_paths || []
		const refPatch = gitRun(["diff", itask.parent_sha, itask.sha, "--", ...srcPaths])
		const fullPatch = gitRun(["diff", itask.parent_sha, itask.sha])
		const refFile = put("immer-ref.patch", refPatch)
		const fullFile = put("immer-full.patch", fullPatch)
		const immerEmpty = put("immer-empty.patch", "")

		const t = Date.now()
		const ibase = await baseline({repo: "immer", task: itask, dir: evDir, opts: {refresh: true}})
		console.log(`  baseline ${itask.sha.slice(0, 8)}: f2p=${ibase.f2p.length} p2p=${ibase.p2p.length} (${Date.now() - t}ms)`)

		const rRef = await evaluate({repo: "immer", task: itask, candidatePatch: refFile, dir: evDir, baseline: ibase})
		eq(rRef.reason, "resolved", "immer reference fix reason")
		ok(rRef.resolved === true, "immer reference fix resolved")
		console.log(`  reference: resolved=${rRef.resolved} reason=${rRef.reason} f2p=${rRef.f2p.passed}/${rRef.f2p.required}`)

		const rEmptyImmer = await evaluate({repo: "immer", task: itask, candidatePatch: immerEmpty, dir: evDir, baseline: ibase})
		eq(rEmptyImmer.reason, "empty_patch", "immer empty patch reason")
		ok(rEmptyImmer.resolved === false, "immer empty patch not resolved")
		console.log(`  empty: resolved=${rEmptyImmer.resolved} reason=${rEmptyImmer.reason}`)

		// A candidate that also edits the oracle test file is normal agent
		// behaviour, not cheating: the oracle files are restored before grading,
		// so the source fix is still graded fairly and the task can resolve.
		const rTestEdit = await evaluate({repo: "immer", task: itask, candidatePatch: fullFile, dir: evDir, baseline: ibase})
		ok(rTestEdit.tamper.clean === true, "immer test-file edit is not fatal")
		ok(
			rTestEdit.tamper.findings.some(f => f.kind === "modifies_oracle_test" && f.fatal === false),
			"immer test-file edit recorded as non-fatal"
		)
		ok((rTestEdit.tamper.restored || []).length > 0, "immer oracle test restored before grading")
		eq(rTestEdit.reason, "resolved", "immer patch touching test file still resolves on its source fix")
		console.log(`  test-edit: resolved=${rTestEdit.resolved} reason=${rTestEdit.reason} restored=${JSON.stringify(rTestEdit.tamper.restored)}`)
	}

	console.log(`\npass=${pass} fail=${fail}`)
	if (failures.length) {
		console.log("failures:")
		for (const f of failures) console.log(` - ${f}`)
	}
	process.exit(fail ? 1 : 0)
}

main().catch(e => {
	console.error("FATAL", e)
	process.exit(1)
})
