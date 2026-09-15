import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {buildLeaderboard, discoverRuns, fmtLift, liftAgainst, renderLeaderboard} from "../leaderboard.mjs"
import {wilson} from "../report.mjs"
import {TELEMETRY_FIELDS} from "../../harness/registry.mjs"

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
function eq(actual, expected, msg) {
	const a = JSON.stringify(actual)
	const b = JSON.stringify(expected)
	ok(a === b, `${msg} (got ${a}, want ${b})`)
}

const PRICED_MODEL = "us.openai.gpt-6-astra"
// The real codex token counts, so an estimate is computable.
const PRICED_TOKENS = {input_tokens: 1068873, output_tokens: 9424, cache_read_tokens: 955804, cache_write_tokens: 113035}

function telemetry(overrides = {}) {
	const t = {}
	for (const f of TELEMETRY_FIELDS) t[f] = null
	return Object.assign(t, overrides)
}

function line({repo = "immer", sha, harness = "pi", model = "m1", resolved = true, tel = {}, trial = 0, trials = 1, leak, graded, reason}) {
	const extra = {}
	if (leak !== undefined) extra.leak = leak
	if (graded !== undefined) extra.graded = graded
	return {
		...extra,
		repo,
		sha,
		parent_sha: `${sha}^`,
		adapter: harness,
		model,
		trial,
		trials,
		resolved,
		reason: reason || (resolved ? "resolved" : "f2p_failed"),
		patch: {applied: true, empty: false, files: [], deletions: [], error: null},
		tamper: {clean: true, findings: []},
		f2p: {required: 1, passed: resolved ? 1 : 0, failed: resolved ? [] : ["f2p x"]},
		p2p: {required: 2, passed: 2, failed: []},
		partial: {},
		runs: {baseline: {exit: 1, passed: 0, failed: 0, total: 0}, candidate: {exit: 0, passed: 0, failed: 0, total: 0}},
		timing: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0},
		telemetry: telemetry(tel),
		adapter_run: {
			harness,
			model,
			exit_code: 0,
			timed_out: false,
			wall_ms: 1000,
			failure_mode: "none",
			telemetry: telemetry(tel),
			transcript_path: "",
			turns: 5,
			notes: ""
		}
	}
}

function writeRun(runsDir, name, {manifest, results}) {
	const dir = path.join(runsDir, name)
	fs.mkdirSync(dir, {recursive: true})
	if (manifest !== null) fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
	if (results !== null) fs.writeFileSync(path.join(dir, "results.jsonl"), results.map(r => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""))
	return dir
}

const manifestFor = (id, {tasks = 1, adapters = 1} = {}) => ({
	id,
	started_at: "2026-01-01T00:00:00Z",
	ended_at: "2026-01-01T00:10:00Z",
	config: {adapter: Array.from({length: adapters}, (_, i) => `a${i}`)},
	tasks: Array.from({length: tasks}, (_, i) => `t${i}`)
})

const tmpRoots = []
function mkRuns(label) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `lb-${label}-`))
	tmpRoots.push(root)
	const runsDir = path.join(root, "runs")
	fs.mkdirSync(runsDir, {recursive: true})
	return runsDir
}

const findGroup = (lb, harness, model) => lb.groups.find(g => g.harness === harness && g.model === model)

// (1) THE REGRESSION: one task present in two runs must count once.
console.log("== a task in two runs counts once, but both trials count ==")
{
	const runsDir = mkRuns("dupe")
	writeRun(runsDir, "r1", {manifest: manifestFor("r1"), results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	writeRun(runsDir, "r2", {manifest: manifestFor("r2"), results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	const lb = buildLeaderboard(runsDir)
	const g = findGroup(lb, "pi", "m1")
	eq(g.tasks, 1, "the same task in two runs is one distinct task")
	eq(g.trials, 2, "both result lines are counted as trials")
	eq(g.runs, ["r1", "r2"], "both runs are credited to the group")
	eq(lb.runs.length, 2, "both runs are included")
}

// (1b) Prompt versions: runs under different task prompts are never aggregated.
console.log("== prompt version gating ==")
{
	const runsDir = mkRuns("pv")
	const old = manifestFor("old")
	old.config = {...(old.config || {}), prompt_version: 1}
	const legacy = manifestFor("legacy")
	if (legacy.config) delete legacy.config.prompt_version
	const v2a = manifestFor("v2a")
	v2a.config = {...(v2a.config || {}), prompt_version: 2}
	const v2b = manifestFor("v2b")
	v2b.config = {...(v2b.config || {}), prompt_version: 2}
	writeRun(runsDir, "old", {manifest: old, results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	writeRun(runsDir, "legacy", {manifest: legacy, results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	writeRun(runsDir, "v2a", {manifest: v2a, results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	writeRun(runsDir, "v2b", {manifest: v2b, results: [line({sha: "bbb", harness: "reference", model: "m1"})]})

	const d = discoverRuns(runsDir)
	eq(d.included.map(r => r.name).sort(), ["v2a", "v2b"], "only the latest prompt version is included by default")
	eq(d.prompt_version, 2, "the chosen version is reported")
	eq(d.prompt_versions_present, [1, 2], "every version present is reported; a manifest without the field is version 1")
	const reasons = Object.fromEntries(d.excluded.map(e => [e.name, e.reason]))
	ok(/prompt version 1 != 2/.test(reasons.old), "an older-prompt run is excluded with the version mismatch as the reason")
	ok(/prompt version 1 != 2/.test(reasons.legacy), "a manifest predating the field counts as version 1 and is excluded")

	const pinned = discoverRuns(runsDir, {promptVersion: 1})
	eq(pinned.included.map(r => r.name).sort(), ["legacy", "old"], "pinning a version selects exactly those runs")

	const lb = buildLeaderboard(runsDir)
	eq(lb.prompt_version, 2, "the leaderboard carries the prompt version")
	eq(lb.runs.map(r => r.name).sort(), ["v2a", "v2b"], "the leaderboard aggregates only one prompt version")
	const md = renderLeaderboard(lb)
	ok(md.includes("Task prompt version: 2"), "the rendered leaderboard states the prompt version")
	ok(/version\(s\) 1 excluded/.test(md), "the rendered leaderboard names the excluded versions")
	ok(md.includes("prompt version 1 != 2"), "excluded runs list the mismatch reason")
}

// (2) Exclusions, each with a reason.
console.log("== exclusions are explicit, never silent ==")
{
	const runsDir = mkRuns("excl")
	writeRun(runsDir, "_invalid", {manifest: manifestFor("bad"), results: [line({sha: "leak"})]})
	writeRun(runsDir, "no-manifest", {manifest: null, results: [line({sha: "x"})]})
	writeRun(runsDir, "no-results", {manifest: manifestFor("noresults"), results: null})
	writeRun(runsDir, "empty-results", {manifest: manifestFor("empty"), results: []})
	writeRun(runsDir, "good", {manifest: manifestFor("good"), results: [line({sha: "aaa"})]})

	const {included, excluded} = discoverRuns(runsDir)
	eq(included.map(r => r.name), ["good"], "only the complete run is included")
	const reasons = Object.fromEntries(excluded.map(e => [e.name, e.reason]))
	ok(reasons._invalid.includes("_"), "a _-prefixed run is excluded by convention")
	ok(reasons["no-manifest"].includes("manifest"), "a run without a manifest is excluded with a reason")
	ok(reasons["no-results"].includes("results.jsonl"), "a run without results is excluded with a reason")
	ok(reasons["empty-results"].includes("no result lines"), "an empty results file is excluded with a reason")

	const lb = buildLeaderboard(runsDir)
	eq(lb.groups.length, 1, "excluded runs contribute no group")
	ok(
		renderLeaderboard(lb).includes("_invalid"),
		"the excluded run and its reason are reported in the output"
	)
	ok(!lb.groups.some(g => g.entries.some(e => e.sha === "leak")), "the leak-contaminated run never reaches the leaderboard")
}

// (3) Different task sets are flagged and a common subset is computed.
console.log("== differing coverage is flagged, not ranked blindly ==")
{
	const runsDir = mkRuns("cover")
	writeRun(runsDir, "wide", {
		manifest: manifestFor("wide", {tasks: 3}),
		results: [line({sha: "aaa", harness: "pi", model: "m1"}), line({sha: "bbb", harness: "pi", model: "m1"}), line({sha: "ccc", harness: "pi", model: "m1"})]
	})
	writeRun(runsDir, "narrow", {
		manifest: manifestFor("narrow"),
		results: [line({sha: "aaa", harness: "codex", model: "m2"})]
	})
	const lb = buildLeaderboard(runsDir)
	eq(lb.comparable, false, "differing task sets are not comparable")
	eq(lb.common_task_count, 1, "the common subset is the intersection")
	eq(lb.common_groups.length, 2, "both groups appear in the common-subset table")
	for (const g of lb.common_groups) eq(g.tasks, 1, "the common table is restricted to the shared task")
	const md = renderLeaderboard(lb)
	ok(md.includes("Comparability warning"), "the warning is rendered")
	ok(md.includes("codex/m2 is missing 2 task(s)"), "the missing-task count is named")
	ok(md.includes("Common task set (1 task(s)"), "the common-subset table states its size")
}

// (4) Identical coverage needs no warning and no second table.
console.log("== identical coverage is fully comparable ==")
{
	const runsDir = mkRuns("same")
	writeRun(runsDir, "a", {
		manifest: manifestFor("a", {tasks: 2}),
		results: [line({sha: "aaa", harness: "pi", model: "m1"}), line({sha: "bbb", harness: "pi", model: "m1"})]
	})
	writeRun(runsDir, "b", {
		manifest: manifestFor("b", {tasks: 2}),
		results: [line({sha: "aaa", harness: "codex", model: "m2"}), line({sha: "bbb", harness: "codex", model: "m2", resolved: false})]
	})
	const lb = buildLeaderboard(runsDir)
	eq(lb.comparable, true, "identical coverage is comparable")
	eq(lb.common_groups, [], "no second table is needed")
	const md = renderLeaderboard(lb)
	ok(!md.includes("Comparability warning"), "no warning when coverage matches")
	ok(!md.includes("Common task set"), "no common-subset table when coverage matches")
}

// (5) A truncated run is surfaced.
console.log("== partial runs are disclosed ==")
{
	const runsDir = mkRuns("partial")
	writeRun(runsDir, "trunc", {
		manifest: manifestFor("trunc", {tasks: 4}),
		results: [line({sha: "aaa", harness: "pi", model: "m1"})]
	})
	const lb = buildLeaderboard(runsDir)
	eq(lb.runs[0].partial, true, "a run missing planned items is flagged partial")
	eq(findGroup(lb, "pi", "m1").partial_runs, ["trunc"], "the group names its partial runs")
	const md = renderLeaderboard(lb)
	ok(md.includes("Partial runs"), "partial runs are disclosed in the output")
	ok(md.includes("trunc"), "the partial run is named")
}

// (6) Cost keeps reported and estimated apart across runs.
console.log("== reported and estimated cost stay separate across runs ==")
{
	const runsDir = mkRuns("cost")
	writeRun(runsDir, "reported", {
		manifest: manifestFor("reported"),
		results: [line({sha: "aaa", harness: "pi", model: "deepseek/x", tel: {input_tokens: 100, output_tokens: 10, cost_usd: 0.02}})]
	})
	writeRun(runsDir, "estimated", {
		manifest: manifestFor("estimated"),
		results: [line({sha: "bbb", harness: "codex", model: PRICED_MODEL, tel: PRICED_TOKENS})]
	})
	const lb = buildLeaderboard(runsDir)
	const reported = findGroup(lb, "pi", "deepseek/x")
	eq(reported.cost.reported.mean, 0.02, "a reported cost is used as reported")
	eq(reported.cost.estimated.n, 0, "an unpriced model is never estimated")
	const estimated = findGroup(lb, "codex", PRICED_MODEL)
	eq(estimated.cost.reported.n, 0, "no reported cost for the codex-style row")
	eq(estimated.cost.estimated.mean, (34 * 10 + 955804 * 1 + 113035 * 12.5 + 9424 * 50) / 1e6, "the estimate matches the price table")
	const md = renderLeaderboard(lb)
	ok(md.includes("~$"), "an estimated cost is marked with ~")
	ok(md.includes("$0.0200 (n=1/1)"), "a reported cost carries no estimate marker")
}

// (7) Deterministic ordering.
console.log("== ordering is deterministic ==")
{
	const runsDir = mkRuns("order")
	writeRun(runsDir, "a", {
		manifest: manifestFor("a", {tasks: 2}),
		results: [line({sha: "aaa", harness: "zzz", model: "m"}), line({sha: "bbb", harness: "aaa", model: "m"})]
	})
	const first = buildLeaderboard(runsDir)
	const second = buildLeaderboard(runsDir)
	eq(
		first.groups.map(g => `${g.harness}/${g.model}`),
		second.groups.map(g => `${g.harness}/${g.model}`),
		"repeated builds order the groups identically"
	)
	eq(first.groups[0].rate, 1, "both groups resolved their single task")
	eq(first.groups[0].rate, first.groups[1].rate, "the two groups are tied on pass rate")
	eq(first.groups[0].harness, "aaa", "ties break deterministically on harness name")
}

// (8) The common-subset table must be ranked on ITS OWN rates. This fixture is
// built so the subset order differs from the full-pool order, which is exactly
// what breaks if the subset table inherits the incomparable table's sort.
console.log("== the common-subset table is ranked on its own rates ==")
{
	const runsDir = mkRuns("three")
	// hA: resolves bbb+ccc but NOT aaa -> full 2/3, subset 0/1  (high overall, worst on the common task)
	// hB: resolves only aaa          -> full 1/2, subset 1/1
	// hC: resolves aaa+ccc           -> full 2/2, subset 1/1
	writeRun(runsDir, "ra", {
		manifest: manifestFor("ra", {tasks: 3}),
		results: [
			line({sha: "aaa", harness: "hA", model: "m", resolved: false}),
			line({sha: "bbb", harness: "hA", model: "m", resolved: true}),
			line({sha: "ccc", harness: "hA", model: "m", resolved: true})
		]
	})
	writeRun(runsDir, "rb", {
		manifest: manifestFor("rb", {tasks: 2}),
		results: [line({sha: "aaa", harness: "hB", model: "m", resolved: true}), line({sha: "bbb", harness: "hB", model: "m", resolved: false})]
	})
	writeRun(runsDir, "rc", {
		manifest: manifestFor("rc", {tasks: 2}),
		results: [line({sha: "aaa", harness: "hC", model: "m", resolved: true}), line({sha: "ccc", harness: "hC", model: "m", resolved: true})]
	})

	const lb = buildLeaderboard(runsDir)
	eq(lb.comparable, false, "three differing task sets are not comparable")
	eq(lb.common_task_count, 1, "a three-way intersection is computed, not just a pair")
	eq(lb.common_groups.map(g => g.harness), ["hB", "hC", "hA"], "the subset table is ranked by its own rates, not the full-pool order")
	for (const g of lb.common_groups) {
		eq(g.tasks, 1, "every subset row is restricted to the one shared task")
		eq(g.trials, 1, "every subset row has one trial")
	}
	const subsetRate = Object.fromEntries(lb.common_groups.map(g => [g.harness, g.rate]))
	eq(subsetRate.hA, 0, "the group that fails the shared task is last despite a strong overall rate")
	eq(subsetRate.hB, 1, "the shared task is resolved by hB")
	const fullOrder = lb.groups.map(g => g.harness)
	ok(
		JSON.stringify(fullOrder) !== JSON.stringify(lb.common_groups.map(g => g.harness)),
		"the fixture genuinely distinguishes the two orderings"
	)
}

// (9) Disjoint task sets share nothing, so there is nothing to compare.
console.log("== an empty intersection yields no comparison table ==")
{
	const runsDir = mkRuns("disjoint")
	writeRun(runsDir, "left", {manifest: manifestFor("left"), results: [line({sha: "aaa", harness: "hL", model: "m"})]})
	writeRun(runsDir, "right", {manifest: manifestFor("right"), results: [line({sha: "bbb", harness: "hR", model: "m"})]})
	const lb = buildLeaderboard(runsDir)
	eq(lb.comparable, false, "disjoint sets are not comparable")
	eq(lb.common_task_count, 0, "the intersection is empty")
	eq(lb.common_groups, [], "no phantom subset rows are produced")
	const md = renderLeaderboard(lb)
	ok(md.includes("Empty: the groups share no tasks"), "the empty intersection is stated plainly")
	ok(!md.includes("Common task set (0"), "no zero-task table is emitted")
}


// (10) Lift: paired per-task delta against the reference harness on the same model.
console.log("== lift is paired against the reference harness on the same model ==")
{
	const runsDir = mkRuns("lift")
	// reference/m1: aaa 0/2, bbb 1/1, ccc 1/1 (ccc not covered by pi)
	writeRun(runsDir, "ref", {
		manifest: manifestFor("ref", {tasks: 3}),
		results: [
			line({sha: "aaa", harness: "reference", model: "m1", resolved: false, trial: 0, trials: 2}),
			line({sha: "aaa", harness: "reference", model: "m1", resolved: false, trial: 1, trials: 2}),
			line({sha: "bbb", harness: "reference", model: "m1", resolved: true}),
			line({sha: "ccc", harness: "reference", model: "m1", resolved: true})
		]
	})
	// pi/m1: aaa 1/1, bbb 0/1, ddd 1/1 (ddd not covered by reference)
	writeRun(runsDir, "pi", {
		manifest: manifestFor("pi", {tasks: 3}),
		results: [
			line({sha: "aaa", harness: "pi", model: "m1", resolved: true}),
			line({sha: "bbb", harness: "pi", model: "m1", resolved: false}),
			line({sha: "ddd", harness: "pi", model: "m1", resolved: true})
		]
	})
	// codex on a DIFFERENT model: no reference for m2, so no lift.
	writeRun(runsDir, "codex", {
		manifest: manifestFor("codex"),
		results: [line({sha: "aaa", harness: "codex", model: "m2", resolved: true})]
	})
	const lb = buildLeaderboard(runsDir)
	const pi = findGroup(lb, "pi", "m1")
	eq(pi.lift.status, "ok", "pi has a reference on its model")
	eq(pi.lift.n_tasks, 2, "paired over the two tasks both scored (aaa, bbb), not ccc or ddd")
	// aaa: 1 - 0 = +1; bbb: 0 - 1 = -1; mean 0.
	eq(pi.lift.delta, 0, "per-task deltas are averaged: (+1 + -1) / 2")
	eq(pi.lift.reference, "reference/m1", "the zero point is named")
	eq(findGroup(lb, "reference", "m1").lift.status, "is reference", "the reference is its own zero")
	eq(findGroup(lb, "codex", "m2").lift.status, "no reference", "a model with no reference run has no lift")
	eq(lb.has_reference, true, "the leaderboard knows a reference was run")
	const md = renderLeaderboard(lb)
	ok(md.includes("+0.0 pts (paired n=2)"), "lift renders with sign and paired n")
	ok(md.includes("no reference"), "a group without a reference says so")
	ok(md.includes("reference (0)"), "the reference row is labelled")
	ok(!md.includes("cannot be computed"), "no missing-reference warning when a reference exists")
}

console.log("== lift: direction and infra exclusion ==")
{
	const ref = [
		{repo: "r", sha: "a", resolved: false, failure_mode: "none"},
		{repo: "r", sha: "b", resolved: false, failure_mode: "none"}
	]
	const mine = [
		{repo: "r", sha: "a", resolved: true, failure_mode: "none"},
		{repo: "r", sha: "a", resolved: false, failure_mode: "none"},
		{repo: "r", sha: "b", resolved: true, failure_mode: "none"},
		// A provider-refused failed trial is not a measurement and must not dilute the rate.
		{repo: "r", sha: "b", resolved: false, failure_mode: "provider_error"}
	]
	const l = liftAgainst(mine, ref)
	eq(l.n_tasks, 2, "two paired tasks")
	eq(l.delta, (0.5 + 1) / 2, "a: 0.5-0, b: 1-0 (refused trial excluded) -> mean 0.75")
	eq(fmtLift(l), "+75.0 pts (paired n=2)", "positive lift renders with a plus sign")
	eq(fmtLift(liftAgainst(ref, mine)), "-75.0 pts (paired n=2)", "the reverse comparison is the negative")
	eq(liftAgainst([{repo: "r", sha: "z", resolved: true, failure_mode: "none"}], ref).status, "no paired tasks", "disjoint tasks cannot be paired")
	eq(fmtLift(null), "n/a", "no lift record renders n/a")
}

console.log("== no reference run: the leaderboard says so instead of ranking silently ==")
{
	const runsDir = mkRuns("noref")
	writeRun(runsDir, "a", {manifest: manifestFor("a"), results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	const lb = buildLeaderboard(runsDir)
	eq(lb.has_reference, false, "no reference group")
	const md = renderLeaderboard(lb)
	ok(md.includes("cannot be computed"), "the missing zero point is stated")
	ok(md.includes("| no reference |"), "every row shows no reference")
}

console.log("== Wilson interval ==")
{
	const w = wilson(8, 10)
	ok(Math.abs(w.low - 0.49) < 0.001, `8/10 lower bound ~0.490 (got ${w.low.toFixed(4)})`)
	ok(Math.abs(w.high - 0.9433) < 0.001, `8/10 upper bound ~0.943 (got ${w.high.toFixed(4)})`)
	const full = wilson(3, 3)
	eq(full.high, 1, "3/3 tops out at 1")
	ok(full.low > 0.4 && full.low < 0.45, `3/3 lower bound ~0.44, not 1 (got ${full.low.toFixed(4)})`)
	const none = wilson(0, 3)
	eq(none.low, 0, "0/3 bottoms out at 0")
	ok(none.high > 0.5 && none.high < 0.6, `0/3 upper bound ~0.56, not 0 (got ${none.high.toFixed(4)})`)
	eq(wilson(0, 0), null, "no trials, no interval")
	eq(wilson(null, 5), null, "no count, no interval")
	const runsDir = mkRuns("ci")
	writeRun(runsDir, "a", {manifest: manifestFor("a"), results: [line({sha: "aaa", harness: "pi", model: "m1"})]})
	const md = renderLeaderboard(buildLeaderboard(runsDir))
	ok(md.includes("[20.7%, 100.0%]"), "1/1 renders its Wilson interval, exposing how little one trial says")
}

console.log("== provisional groups are marked ==")
{
	const runsDir = mkRuns("prov")
	writeRun(runsDir, "thin", {manifest: manifestFor("thin"), results: [line({sha: "aaa", harness: "thin", model: "m1"})]})
	writeRun(runsDir, "thick", {
		manifest: manifestFor("thick"),
		results: [0, 1, 2].map(i => line({sha: "aaa", harness: "thick", model: "m1", trial: i, trials: 3}))
	})
	const lb = buildLeaderboard(runsDir)
	eq(findGroup(lb, "thin", "m1").provisional, true, "one trial per task is provisional")
	eq(findGroup(lb, "thick", "m1").provisional, false, "three trials per task is not")
	const md = renderLeaderboard(lb)
	ok(md.includes("| thin † |"), "the provisional group carries the dagger")
	ok(md.includes("| thick |"), "the full group does not")
	ok(md.includes("† provisional: fewer than 3 scored trials per task."), "the footnote explains the mark")
}

console.log("== the common-subset table carries lift and efficiency too ==")
{
	const runsDir = mkRuns("common-lift")
	writeRun(runsDir, "ref", {
		manifest: manifestFor("ref", {tasks: 2}),
		results: [line({sha: "aaa", harness: "reference", model: "m1", resolved: false}), line({sha: "bbb", harness: "reference", model: "m1", resolved: false})]
	})
	writeRun(runsDir, "pi", {manifest: manifestFor("pi"), results: [line({sha: "aaa", harness: "pi", model: "m1", resolved: true})]})
	const lb = buildLeaderboard(runsDir)
	eq(lb.comparable, false, "coverage differs")
	const pi = lb.common_groups.find(g => g.harness === "pi")
	eq(pi.lift.n_tasks, 1, "lift on the subset pairs the one common task")
	eq(pi.lift.delta, 1, "+100 pts on that task")
	ok(!("entries" in pi), "subset rows do not leak their entries into the JSON")
	const md = renderLeaderboard(lb)
	ok(md.includes("Efficiency on the common task set"), "the subset gets its own efficiency table")
	ok(md.includes("cost/resolve"), "efficiency headers are rendered")
}

console.log("== answer lookup: column, failure-mode count, n/a for unaudited rows ==")
{
	const runsDir = mkRuns("lookup")
	const fatal = {clean: false, findings: [{kind: "upstream_lookup", fatal: true, tool: "Bash", command: "curl https://github.com/honojs/hono/pull/5166.diff", via_subagent: false}], counts: {upstream_lookup: 1, external_network: 0, web_tool: 0}}
	const clean = {clean: true, findings: [], counts: {upstream_lookup: 0, external_network: 0, web_tool: 0}}
	writeRun(runsDir, "audited", {
		manifest: manifestFor("audited"),
		results: [
			line({sha: "aaa", harness: "pi", model: "m1", resolved: false, reason: "answer_lookup", leak: fatal, graded: {resolved: true, reason: "resolved"}}),
			line({sha: "bbb", harness: "pi", model: "m1", resolved: true, leak: clean}),
			line({sha: "aaa", harness: "reference", model: "m1", resolved: true}),
			line({sha: "bbb", harness: "reference", model: "m1", resolved: true})
		]
	})
	const lb = buildLeaderboard(runsDir)
	const pi = findGroup(lb, "pi", "m1")
	const ref = findGroup(lb, "reference", "m1")
	eq([pi.scored_trials, pi.resolved, pi.rate], [2, 1, 0.5], "the lookup trial is a scored failure, lowering the rate not the sample")
	eq([pi.lookup.audited, pi.lookup.fatal, pi.lookup.rate], [2, 1, 0.5], "lookup rate over audited trials")
	eq([ref.lookup.audited, ref.lookup.rate], [0, null], "an unaudited group has no lookup rate")
	ok(pi.lift && pi.lift.status === "ok" && Math.abs(pi.lift.delta - -0.5) < 1e-12, "the invalidated lookup trial counts against lift")
	const md = renderLeaderboard(lb)
	ok(md.includes("| lookup rate | ext. network/trial |"), "the efficiency table gains lookup rate and ext. network columns")
	ok(md.includes("50.0% (n=2/2 audited)"), "pi's lookup rate renders with its audited sample")
	ok(md.includes("n/a (n=0/2 audited)"), "reference renders n/a, never 0%, when unaudited")
	ok(/\| pi[^\n]*answer_lookup:1/.test(md), "the main table's failure-mode summary shows answer_lookup:1 on the pi row")
	ok(!/\| reference[^\n]*answer_lookup/.test(md), "no answer_lookup count is invented for the reference row")
	ok(md.includes("filed as `answer_lookup`"), "the notes explain the lookup column")
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
for (const root of tmpRoots) {
	try {
		fs.rmSync(root, {recursive: true, force: true})
	} catch {}
}
process.exit(fail ? 1 : 0)
