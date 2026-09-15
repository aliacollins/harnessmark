#!/usr/bin/env node
// Acceptance test for the validation-core fixes (F1-F4) in spike/harvest.mjs.
//
// Runs against a synthetic throwaway git repo in a temp dir and does NOT need
// vitest or any dependency. The test command is injectable: we point the harvest
// validator at spike/test/stub.mjs, a tiny Node stub that emits controlled
// output and exit codes based on STUB_SCENARIO and the working-tree state.
import {execFileSync} from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {
	classify,
	harvest,
	validate,
	categoryOf,
	sizeBucketOf,
	subsystemOf,
	subsystemsOf,
	testDeltaOf,
	splitOutcomes,
	MEASUREMENT_ARTIFACTS
} from "../harvest.mjs"

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const STUB = path.join(TEST_DIR, "stub.mjs")
const CFG = {testCmd: process.execPath, testArgs: files => [STUB, ...files], testTimeoutMs: 20_000}

const DATE1 = "2026-01-14T12:00:00+00:00"
const DATE2 = "2026-01-15T12:00:00+00:00"

const BUGGY_SRC = 'export function add(a, b) {\n\treturn a - b\n}\n'
const FIXED_SRC = 'export function add(a, b) {\n\treturn a + b\n}\n'
const OLD_TEST = 'import {add} from "../src/lib.js"\n\nexport const marker = "OLD"\n'
const NEW_TEST = 'import {add} from "../src/lib.js"\n\nexport const marker = "ORACLE_CASE"\n'

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

const git = (dir, args) => execFileSync("git", args, {cwd: dir, stdio: ["ignore", "pipe", "pipe"]}).toString()

function makeRepo(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spike-nc-${prefix}-`))
	git(dir, ["init", "-q", "-b", "main"])
	git(dir, ["config", "user.email", "spike-nc@test.local"])
	git(dir, ["config", "user.name", "Spike Negative Control"])
	return dir
}

function commit(dir, message, files, date) {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		fs.mkdirSync(path.dirname(abs), {recursive: true})
		fs.writeFileSync(abs, content)
	}
	git(dir, ["add", "-A"])
	execFileSync("git", ["commit", "-q", "-m", message], {
		cwd: dir,
		env: {...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date}
	})
	return git(dir, ["rev-parse", "HEAD"]).trim()
}

function makeCandidateRepo() {
	const dir = makeRepo("cand")
	commit(dir, "initial buggy source and old test", {"src/lib.js": BUGGY_SRC, "test/lib.test.js": OLD_TEST}, DATE1)
	const sha = commit(
		dir,
		"fix add and add oracle test",
		{"src/lib.js": FIXED_SRC, "test/lib.test.js": NEW_TEST},
		DATE2
	)
	const cand = {
		sha,
		parent: `${sha}^`,
		date: DATE2,
		post_cutoff: true,
		subject: "fix add and add oracle test",
		test_paths: ["test/lib.test.js"],
		support_paths: [],
		source_paths: ["src/lib.js"],
		infra_paths: [],
		diffstat: {files: 2, added: 4, deleted: 4, lines: 8}
	}
	return {dir, cand}
}

async function runScenario(scenario) {
	const {dir, cand} = makeCandidateRepo()
	process.env.STUB_SCENARIO = scenario
	process.env.STUB_COUNTER = path.join(dir, "stub-counter.txt")
	try {
		return await validate(dir, CFG, cand)
	} finally {
		delete process.env.STUB_SCENARIO
		delete process.env.STUB_COUNTER
		fs.rmSync(dir, {recursive: true, force: true})
	}
}

// Change B builders: candidates with added-only, mixed, and mislabeled oracles.
function makeAddedOnlyRepo() {
	const dir = makeRepo("added")
	commit(dir, "initial buggy source", {"src/lib.js": BUGGY_SRC}, DATE1)
	const sha = commit(
		dir,
		"fix add and add oracle test",
		{"src/lib.js": FIXED_SRC, "test/new.test.js": NEW_TEST},
		DATE2
	)
	const cand = {
		sha,
		parent: `${sha}^`,
		date: DATE2,
		post_cutoff: true,
		subject: "fix add and add oracle test",
		test_paths: ["test/new.test.js"],
		oracle_files_status: [{path: "test/new.test.js", status: "A"}],
		support_paths: [],
		source_paths: ["src/lib.js"],
		infra_paths: [],
		diffstat: {files: 2, added: 4, deleted: 1, lines: 5}
	}
	return {dir, cand}
}

function makeMixedRepo() {
	const dir = makeRepo("mixed")
	commit(
		dir,
		"initial buggy source and old red test",
		{"src/lib.js": BUGGY_SRC, "test/old.test.js": OLD_TEST},
		DATE1
	)
	const sha = commit(
		dir,
		"fix add and add oracle test",
		{"src/lib.js": FIXED_SRC, "test/old.test.js": NEW_TEST, "test/new.test.js": NEW_TEST},
		DATE2
	)
	const cand = {
		sha,
		parent: `${sha}^`,
		date: DATE2,
		post_cutoff: true,
		subject: "fix add and add oracle test",
		test_paths: ["test/old.test.js", "test/new.test.js"],
		oracle_files_status: [
			{path: "test/old.test.js", status: "M"},
			{path: "test/new.test.js", status: "A"}
		],
		support_paths: [],
		source_paths: ["src/lib.js"],
		infra_paths: [],
		diffstat: {files: 3, added: 6, deleted: 2, lines: 8}
	}
	return {dir, cand}
}

function makeMislabeledRepo() {
	const dir = makeRepo("mislabel")
	commit(
		dir,
		"initial buggy source and old test",
		{"src/lib.js": BUGGY_SRC, "test/lib.test.js": OLD_TEST},
		DATE1
	)
	const sha = commit(
		dir,
		"fix add with mislabeled oracle",
		{"src/lib.js": FIXED_SRC, "test/lib.test.js": NEW_TEST},
		DATE2
	)
	const cand = {
		sha,
		parent: `${sha}^`,
		date: DATE2,
		post_cutoff: true,
		subject: "fix add with mislabeled oracle",
		test_paths: ["test/lib.test.js"],
		// False claim: this file actually exists at the parent. The git check in
		// validate() must correct it to M and force the control to run.
		oracle_files_status: [{path: "test/lib.test.js", status: "A"}],
		support_paths: [],
		source_paths: ["src/lib.js"],
		infra_paths: [],
		diffstat: {files: 2, added: 3, deleted: 2, lines: 5}
	}
	return {dir, cand}
}

async function runWith(builder, scenario) {
	const {dir, cand} = builder()
	process.env.STUB_SCENARIO = scenario
	process.env.STUB_COUNTER = path.join(dir, "stub-counter.txt")
	try {
		return await validate(dir, CFG, cand)
	} finally {
		delete process.env.STUB_SCENARIO
		delete process.env.STUB_COUNTER
		fs.rmSync(dir, {recursive: true, force: true})
	}
}

// Rename builder: a true `git mv` (R100) plus the source fix, so harvest reports a
// rename entry that carries `old_path`.
function makeRenameRepo() {
	const dir = makeRepo("rename")
	commit(dir, "initial buggy source and oracle test", {"src/lib.js": BUGGY_SRC, "test/old.test.js": NEW_TEST}, DATE1)
	fs.writeFileSync(path.join(dir, "src/lib.js"), FIXED_SRC)
	git(dir, ["mv", "test/old.test.js", "test/new.test.js"])
	git(dir, ["add", "-A"])
	execFileSync("git", ["commit", "-q", "-m", "fix add and rename oracle test"], {
		cwd: dir,
		env: {...process.env, GIT_AUTHOR_DATE: DATE2, GIT_COMMITTER_DATE: DATE2}
	})
	const sha = git(dir, ["rev-parse", "HEAD"]).trim()
	return {dir, sha}
}

async function runRename(scenario) {
	const {dir, sha} = makeRenameRepo()
	// Keep the stub log OUTSIDE the repo: validate() runs `git clean -fdq`, which
	// would delete an untracked log file between runs.
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "spike-nc-log-"))
	const logPath = path.join(logDir, "stub-log.txt")
	process.env.STUB_SCENARIO = scenario
	process.env.STUB_LOG = logPath
	let out = null
	let cand = null
	let log = []
	try {
		const h = await harvest(dir, "main")
		cand = h.candidates.find(c => c.sha === sha) || null
		out = cand ? await validate(dir, CFG, cand) : null
		log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n") : []
	} finally {
		delete process.env.STUB_SCENARIO
		delete process.env.STUB_LOG
		fs.rmSync(dir, {recursive: true, force: true})
		fs.rmSync(logDir, {recursive: true, force: true})
	}
	return {out, cand, log}
}

const reasonIs = (out, reason, label) =>
	check(
		out.reason === reason,
		`${label}: reason "${out.reason}" === "${reason}"${out.reason === reason ? "" : ` (detail: ${out.detail})`}`
	)

// ---------------------------------------------------------------- cases 1-5, 7

async function main() {
	// 1. Collection error only at parent+oracle => not validated.
	{
		const out = await runScenario("collection")
		reasonIs(out, "parent_fail_not_assertion", "case1 collection error rejects")
		check(!out.validated, "case1 not validated")
	}

	// 2. Fix exits 0 but collects zero tests => not validated.
	{
		const out = await runScenario("zero_fix")
		reasonIs(out, "zero_tests_collected", "case2 zero-test fix rejects")
		check(!out.validated, "case2 not validated")
	}

	// 3. Parent already failing before oracle injection => not validated.
	{
		const out = await runScenario("pre_existing")
		reasonIs(out, "pre_existing_failure", "case3 pre-existing failure rejects")
		check(!out.validated, "case3 not validated")
	}

	// 4. Positive control: green parent, assertion-red parent+oracle, green fix.
	{
		const out = await runScenario("positive")
		check(out.validated === true && out.reason === "validated", "case4 positive control validates")
		const runs = ["parent_clean_run", "parent_oracle_run", "parent_oracle_run_2", "fix_run"].map(k => out[k])
		check(
			runs.every(r => r && ["exit", "passed", "failed", "total"].every(f => typeof r[f] === "number")),
			"case4 records four {exit,passed,failed,total} run tuples"
		)
		const inv =
			out.parent_clean_run.exit === 0 &&
			out.parent_clean_run.failed === 0 &&
			out.parent_oracle_run.exit !== 0 &&
			out.parent_oracle_run.failed >= 1 &&
			out.parent_oracle_run.total >= 1 &&
			out.fix_run.exit === 0 &&
			out.fix_run.failed === 0 &&
			out.fix_run.total >= 1
		check(inv, "case4 evidence invariant holds")
	}

	// 5. Two parent+oracle runs disagree => not validated.
	{
		const out = await runScenario("flaky")
		reasonIs(out, "flaky", "case5 flaky parent+oracle rejects")
		check(!out.validated, "case5 not validated")
	}

	// 7. Oracle diff fails to apply => not validated.
	{
		const out = await runScenario("apply_fail")
		reasonIs(out, "oracle_apply_failed", "case7 unappliable oracle rejects")
		check(!out.validated, "case7 not validated")
	}

	// 8. Unparseable runner output => not validated (extra guard for F1).
	{
		const out = await runScenario("unparseable")
		reasonIs(out, "unparseable_test_output", "case8 unparseable output rejects")
		check(!out.validated, "case8 not validated")
	}

	// 6. Path classification (F3/F4).
	{
		check(classify("src/__snapshots__/foo.test.ts.snap") === "support", "case6 snapshot classified as support")
		check(classify("test/__fixtures__/data.json") === "support", "case6 fixture classified as support")
		check(classify("vitest.config.ts") === "infra", "case6 vitest config classified as infra")
		check(classify("test/app.test.ts") === "test", "case6 real test classified as test")

		const dir = makeRepo("infra")
		commit(dir, "initial source", {"src/app.js": "export const x = 1\n"}, DATE1)
		const infraSha = commit(
			dir,
			"enable coverage thresholds in test config",
			{"vitest.config.ts": "export default {test: {coverage: {thresholds: {lines: 90}}}}\n"},
			"2026-01-15T12:00:00+00:00"
		)
		const mixedSha = commit(
			dir,
			"add feature and tune the test config",
			{
				"src/app.js": "export const x = 2\n",
				"vitest.config.ts": "export default {test: {coverage: {thresholds: {lines: 91}}}}\n"
			},
			"2026-01-16T12:00:00+00:00"
		)
		const supportOnlySha = commit(
			dir,
			"update snapshot without a real test change",
			{"src/app.js": "export const x = 3\n", "test/__snapshots__/app.snap": "snapshot-v2\n"},
			"2026-01-17T12:00:00+00:00"
		)
		const supportCandidateSha = commit(
			dir,
			"add a real test plus its fixture",
			{
				"src/app.js": "export const x = 4\n",
				"test/app.test.js": "test('x', () => {})\n",
				"test/__fixtures__/app.fixture.json": "{}\n"
			},
			"2026-01-18T12:00:00+00:00"
		)
		const h = await harvest(dir, "main")
		fs.rmSync(dir, {recursive: true, force: true})
		const infra = h.rejected.find(r => r.sha === infraSha)
		const mixed = h.rejected.find(r => r.sha === mixedSha)
		const supportOnly = h.rejected.find(r => r.sha === supportOnlySha)
		const supportCandidate = h.candidates.find(r => r.sha === supportCandidateSha)
		check(infra && infra.reason === "infra_only", `case6 infra-only rejected as infra_only (got ${infra && infra.reason})`)
		check(
			infra && /vitest\.config\.ts/.test(infra.detail),
			"case6 infra-only detail records the offending path"
		)
		check(
			mixed && mixed.reason === "touches_test_infra",
			`case6 source+infra rejected as touches_test_infra (got ${mixed && mixed.reason})`
		)
		check(
			mixed && /vitest\.config\.ts/.test(mixed.detail),
			"case6 source+infra detail records the offending path"
		)
		check(
			supportOnly && supportOnly.reason === "no_tests",
			`case6 support-only commit rejected as no_tests (got ${supportOnly && supportOnly.reason})`
		)
		check(
			supportCandidate && supportCandidate.test_paths.includes("test/app.test.js"),
			"case6 support+real-test commit classified as a candidate with a real test"
		)
		check(
			supportCandidate && supportCandidate.support_paths.includes("test/__fixtures__/app.fixture.json"),
			"case6 support file is carried on the candidate for oracle injection"
		)
	}

	// ------------------------------------------------------------ Change B

	// B1. Oracle is entirely new test files absent at the parent => the control
	// is legitimately skipped and the task still validates.
	{
		const out = await runWith(makeAddedOnlyRepo, "positive")
		check(out.validated === true && out.reason === "validated", "B1 added-only oracle validates")
		check(
			out.parent_clean_run && out.parent_clean_run.skipped === true,
			"B1 clean-parent control recorded as skipped"
		)
		check(
			out.parent_clean_run && out.parent_clean_run.reason === "oracle_files_absent_at_parent",
			"B1 skip reason is oracle_files_absent_at_parent"
		)
		check(
			(out.oracle_files_status || []).some(e => e.status === "A"),
			"B1 oracle_files_status records an A (absent at parent) entry"
		)
		check(
			out.parent_oracle_run.exit !== 0 && out.parent_oracle_run.failed >= 1 && out.parent_oracle_run.total >= 1,
			"B1 skipped control still requires assertion-level red post-injection"
		)
	}

	// B2. Mixed oracle: an added file plus a modified file that is already red at
	// the parent => reject `pre_existing_failure`. The skip path cannot dodge it.
	{
		const out = await runWith(makeMixedRepo, "pre_existing")
		reasonIs(out, "pre_existing_failure", "B2 mixed oracle with pre-existing red test rejects")
		check(!out.validated, "B2 not validated")
		check(
			out.parent_clean_run && out.parent_clean_run.skipped !== true && out.parent_clean_run.failed >= 1,
			"B2 control ran over the modified test file and was red"
		)
	}

	// B3. A path claimed `A` but actually present at the parent => the git check
	// corrects it to M and the control runs (never silently skipped).
	{
		const out = await runWith(makeMislabeledRepo, "positive")
		check(
			out.parent_clean_run && out.parent_clean_run.skipped !== true,
			"B3 claimed-A-but-present test file forces the control to run"
		)
		check(
			(out.oracle_files_status || []).some(e => e.path === "test/lib.test.js" && e.status === "M"),
			"B3 git-corrected status for the claimed-A path is M"
		)
		check(out.validated === true, "B3 candidate still validates after the control runs")
	}

	// B4. Skipped-control task whose post-injection run is a collection error
	// only => still rejected. The relaxation must not weaken the red-side rule.
	{
		const out = await runWith(makeAddedOnlyRepo, "collection")
		reasonIs(out, "parent_fail_not_assertion", "B4 skipped control + collection-only stays rejected")
		check(!out.validated, "B4 not validated")
		check(out.parent_clean_run && out.parent_clean_run.skipped === true, "B4 control was skipped")
	}

	// B5. R100 rename whose OLD path is red at the parent. The renamed test's
	// content existed at the parent under the old path, so the control must run
	// there and reject `pre_existing_failure` — never skip the control and record
	// the task as validated.
	{
		const {out, cand, log} = await runRename("positive")
		check(!!cand, "B5 rename commit is a harvest candidate")
		check(
			!!cand &&
				(cand.oracle_files_status || []).some(
					e => e.status === "R" && e.old_path === "test/old.test.js"
				),
			"B5 harvest carries the rename old_path"
		)
		reasonIs(out || {}, "pre_existing_failure", "B5 rename with red old path rejects")
		check(out && !out.validated, "B5 not validated")
		check(
			out && out.parent_clean_run && out.parent_clean_run.skipped !== true && out.parent_clean_run.failed >= 1,
			"B5 control actually ran and was red"
		)
		check(log[0] === "test/old.test.js", `B5 control ran against the OLD path (got ${log[0]})`)
	}

	// B6. R100 rename whose OLD path is green at the parent and whose oracle goes
	// red once moved. The control executes against the old path and `R` (with
	// old_path) is retained, so the rename is a modified test, not a new file.
	{
		const {out, cand, log} = await runRename("rename_path")
		check(!!cand, "B6 rename commit is a harvest candidate")
		reasonIs(out || {}, "validated", "B6 rename with green old path validates")
		check(out && out.validated === true, "B6 validated is true")
		check(
			out && out.parent_clean_run && out.parent_clean_run.skipped !== true && out.parent_clean_run.exit === 0,
			"B6 clean-parent control actually executed"
		)
		check(log[0] === "test/old.test.js", `B6 control executed against the OLD path (got ${log[0]})`)
		check(
			(out && out.oracle_files_status || []).some(
				e => e.path === "test/new.test.js" && e.status === "R" && e.old_path === "test/old.test.js"
			),
			"B6 R retained in oracle_files_status with old_path"
		)
		check(
			testDeltaOf((out && out.oracle_files_status) || []).test_delta !== "new-test-file",
			"B6 a rename is not test_delta new-test-file"
		)
	}

	// B8. A failing git command while probing parent existence must be recorded as
	// `git_error` and must never be read as "absent at parent" (which would skip
	// the control).
	{
		const {dir, cand} = makeAddedOnlyRepo()
		const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim()
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "spike-nc-shim-"))
		const shim = path.join(shimDir, "git")
		fs.writeFileSync(
			shim,
			`#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "ls-tree" ]; then\n    echo "fatal: simulated git failure" >&2\n    exit 128\n  fi\ndone\nexec "${realGit}" "$@"\n`
		)
		fs.chmodSync(shim, 0o755)
		const oldPath = process.env.PATH
		process.env.STUB_SCENARIO = "positive"
		process.env.PATH = `${shimDir}${path.delimiter}${oldPath}`
		let out
		try {
			out = await validate(dir, CFG, cand)
		} finally {
			process.env.PATH = oldPath
			delete process.env.STUB_SCENARIO
			fs.rmSync(shimDir, {recursive: true, force: true})
			fs.rmSync(dir, {recursive: true, force: true})
		}
		reasonIs(out || {}, "git_error", "B8 failing git existence probe is git_error")
		check(!out || !out.parent_clean_run || out.parent_clean_run.skipped !== true, "B8 control was not skipped")
		check(/ls-tree/.test((out && out.detail) || ""), "B8 detail names the failing git operation")
	}

	// ------------------------------------------------------------ Change A

	// A1. Prefix and heuristic category mapping.
	{
		const cases = [
			["fix: correct the thing", "bugfix", "prefix"],
			["feat: add the thing", "feature", "prefix"],
			["perf: speed up the thing", "perf", "prefix"],
			["refactor: move the thing", "refactor", "prefix"],
			["make the parser bug out less", "bugfix", "heuristic"]
		]
		for (const [subject, cat, src] of cases) {
			const got = categoryOf(subject)
			check(
				got.category === cat && got.category_source === src,
				`A1 "${subject}" -> ${cat}/${src} (got ${got.category}/${got.category_source})`
			)
		}
	}

	// A2. Security overrides the fix prefix.
	{
		const got = categoryOf("fix: patch prototype pollution (CVE-2026-1234)")
		check(
			got.category === "security" && got.category_source === "heuristic",
			`A2 CVE subject overrides fix prefix to security (got ${got.category}/${got.category_source})`
		)
	}

	// A3. size_bucket boundaries exactly at 10/11, 50/51, 150/151, 400/401.
	{
		const bounds = [
			[10, "XS"],
			[11, "S"],
			[50, "S"],
			[51, "M"],
			[150, "M"],
			[151, "L"],
			[400, "L"],
			[401, "XL"]
		]
		for (const [n, b] of bounds) check(sizeBucketOf(n) === b, `A3 ${n} lines -> ${b}`)
	}

	// A4. Subsystem counting for plain, monorepo, and multi-subsystem paths.
	{
		check(
			subsystemOf("src/plugins/foo.ts") === "src/plugins",
			`A4 plain path subsystem (got ${subsystemOf("src/plugins/foo.ts")})`
		)
		check(
			subsystemOf("packages/x/src/y.ts") === "packages/x",
			`A4 monorepo path subsystem (got ${subsystemOf("packages/x/src/y.ts")})`
		)
		const subs = subsystemsOf(["src/a/f.ts", "src/b/g.ts", "src/a/h.ts"])
		check(
			subs.length === 2 && subs[0] === "src/a" && subs[1] === "src/b",
			`A4 multi-subsystem sorted distinct (got ${JSON.stringify(subs)})`
		)
	}

	// A5. test_delta for added-only / modified-only / mixed.
	{
		const added = testDeltaOf([{path: "a", status: "A"}])
		const modified = testDeltaOf([
			{path: "a", status: "M"},
			{path: "b", status: "R"}
		])
		const mixed = testDeltaOf([
			{path: "a", status: "A"},
			{path: "b", status: "M"}
		])
		check(
			added.test_delta === "new-test-file" && added.tests_added === 1 && added.tests_modified === 0,
			"A5 added-only -> new-test-file"
		)
		check(
			modified.test_delta === "modified-test" && modified.tests_modified === 2 && modified.tests_added === 0,
			"A5 modified-only -> modified-test"
		)
		check(
			mixed.test_delta === "mixed" && mixed.tests_added === 1 && mixed.tests_modified === 1,
			"A5 mixed -> mixed"
		)
	}

	// A6. Measurement artifacts are separated from the semantic breakdown.
	{
		const {semantic, artifacts} = splitOutcomes({
			version_bump: 70,
			not_attempted_cap: 3,
			not_attempted_budget: 1,
			no_tests: 54,
			validated: 50
		})
		check(
			artifacts.version_bump === 70 && artifacts.not_attempted_cap === 3 && artifacts.not_attempted_budget === 1,
			"A6 artifact bucket holds version_bump / not_attempted_cap / not_attempted_budget"
		)
		check(
			!("version_bump" in semantic) && !("not_attempted_cap" in semantic),
			"A6 artifact codes are absent from the semantic bucket"
		)
		check(semantic.no_tests === 54 && semantic.validated === 50, "A6 semantic bucket keeps real outcomes")
		check(
			MEASUREMENT_ARTIFACTS.has("version_bump") && MEASUREMENT_ARTIFACTS.has("not_attempted_cap"),
			"A6 MEASUREMENT_ARTIFACTS membership"
		)
	}

	console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`)
	if (fail > 0) process.exit(1)
}

main().catch(err => {
	console.error(`FATAL: ${err && err.stack ? err.stack : err}`)
	process.exit(1)
})
