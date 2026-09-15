import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import {buildReport, perResolve, renderMarkdown, resolveRunDir, summarize, summarizeChains, topologyOf, wilson} from "../report.mjs"
import {TELEMETRY_FIELDS} from "../../harness/registry.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, "..", "report.mjs")

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

function mkTmp(label) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `report-${label}-`))
}

function makeTelemetry(overrides = {}) {
	const t = {}
	for (const f of TELEMETRY_FIELDS) t[f] = null
	return Object.assign(t, overrides)
}

function makeResult({
	repo,
	sha,
	harness = "pi",
	adapter = harness,
	model = "m1",
	resolved,
	reason,
	telemetry,
	wall_ms = null,
	turns,
	adapterTurns,
	failure_mode = "none",
	f2p,
	p2p,
	trial,
	trials,
	partial = {},
	leak,
	graded
}) {
	const tel = makeTelemetry(telemetry)
	const res = {
		repo,
		sha,
		parent_sha: `${sha}^`,
		adapter,
		model,
		resolved,
		reason: reason || (resolved ? "resolved" : "f2p_failed"),
		patch: {applied: true, empty: false, files: [], deletions: [], error: null},
		tamper: {clean: true, findings: []},
		f2p: f2p || {required: 1, passed: resolved ? 1 : 0, failed: resolved ? [] : ["f2p x"]},
		p2p: p2p || {required: 2, passed: 2, failed: []},
		partial,
		runs: {baseline: {exit: 1, passed: 0, failed: 0, total: 0}, candidate: {exit: 0, passed: 0, failed: 0, total: 0}},
		timing: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0},
		telemetry: tel,
		adapter_run: {
			harness,
			model,
			exit_code: 0,
			timed_out: false,
			wall_ms,
			failure_mode,
			telemetry: tel,
			transcript_path: "",
			notes: turns == null ? "" : `events=3 turns=${turns}`
		}
	}
	if (turns != null) res.turns = turns
	if (adapterTurns != null) res.adapter_run.turns = adapterTurns
	if (trial !== undefined) res.trial = trial
	if (trials !== undefined) res.trials = trials
	if (leak !== undefined) res.leak = leak
	if (graded !== undefined) res.graded = graded
	return res
}

function writeRun(root, id, {manifest = null, results = [], rawLines = [], dataset = null}) {
	const runDir = path.join(root, "runs", id)
	fs.mkdirSync(runDir, {recursive: true})
	if (manifest != null) fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2))
	const lines = results.map(r => JSON.stringify(r)).concat(rawLines)
	fs.writeFileSync(path.join(runDir, "results.jsonl"), `${lines.join("\n")}\n`)
	if (dataset) {
		for (const [repo, tasks] of Object.entries(dataset)) {
			const dir = path.join(root, "dataset", repo)
			fs.mkdirSync(dir, {recursive: true})
			fs.writeFileSync(path.join(dir, "tasks.jsonl"), `${tasks.map(t => JSON.stringify(t)).join("\n")}\n`)
		}
	}
	return runDir
}

function findGroup(report, harness, model) {
	return report.groups.find(g => g.harness === harness && g.model === model)
}

// ---------------------------------------------------------------- fixtures

const mixedRoot = mkTmp("mixed")
const mixedRun = writeRun(mixedRoot, "mixed", {
	manifest: {
		id: "mixed",
		started_at: "2026-01-01T00:00:00Z",
		ended_at: "2026-01-01T01:00:00Z",
		config: {budget_ms: 600000, adapters: ["pi"]}
	},
	dataset: {
		immer: [
			{sha: "aaaaaaaaaa", category: "bugfix"},
			{sha: "bbbbbbbbbb", category: "feature"}
		]
	},
	results: [
		makeResult({
			repo: "immer",
			sha: "aaaaaaaaaa",
			resolved: true,
			telemetry: {input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cost_usd: 0.5},
			wall_ms: 1000,
			turns: 2
		}),
		makeResult({
			repo: "immer",
			sha: "bbbbbbbbbb",
			resolved: false,
			reason: "f2p_failed",
			failure_mode: "agent_timeout",
			telemetry: {},
			wall_ms: 2000
		})
	]
})

const allNullRoot = mkTmp("allnull")
const allNullRun = writeRun(allNullRoot, "allnull", {
	manifest: {id: "allnull", started_at: "2026-01-02T00:00:00Z", ended_at: "2026-01-02T00:10:00Z", config: {}},
	results: [
		makeResult({repo: "immer", sha: "cccccccccc", resolved: true, telemetry: {}, wall_ms: null}),
		makeResult({repo: "immer", sha: "dddddddddd", resolved: false, telemetry: {}, wall_ms: null})
	]
})

const intrRoot = mkTmp("intr")
const intrRun = writeRun(intrRoot, "intr", {
	manifest: {
		id: "intr",
		started_at: "2026-01-03T00:00:00Z",
		ended_at: "2026-01-03T00:01:00Z",
		mode: "run",
		tasks: ["a", "b", "c", "d", "e"],
		adapter: [{name: "pi", version: "1"}],
		counts: {items: 1, resolved: 1, failed: 0},
		stopped: {reason: "interrupted", signal: "SIGINT", at: "2026-01-03T00:01:00Z"}
	},
	results: [makeResult({repo: "immer", sha: "eeeeeeeeee", resolved: true, telemetry: {input_tokens: 7}, wall_ms: 5})],
	rawLines: ["{not valid json"]
})

const roundRoot = mkTmp("round")
const roundRun = writeRun(roundRoot, "round", {
	manifest: {
		id: "round",
		started_at: "2026-01-04T00:00:00Z",
		ended_at: "2026-01-04T00:05:00Z",
		config: {budget_ms: 1000}
	},
	results: [
		makeResult({
			repo: "zzz-absent-repo",
			sha: "ffffffffff",
			resolved: true,
			telemetry: {input_tokens: 1},
			wall_ms: 3,
			turns: 1
		})
	]
})

const notesRoot = mkTmp("notes")
const notesRun = writeRun(notesRoot, "notes", {
	manifest: {id: "notes", started_at: "2026-01-05T00:00:00Z", ended_at: "2026-01-05T00:05:00Z"},
	results: [
		(() => {
			const r = makeResult({repo: "immer", sha: "9999999999", resolved: true, telemetry: {}, wall_ms: 1})
			delete r.turns
			r.adapter_run.notes = "events=9 turns=7 tools=bash"
			return r
		})()
	]
})

// A line whose only turns source is the first-class `adapter_run.turns` field:
// no top-level `turns` key and empty notes, so the notes regex cannot help.
const adapterTurnsRoot = mkTmp("adapter-turns")
const adapterTurnsRun = writeRun(adapterTurnsRoot, "adapter-turns", {
	manifest: {id: "adapter-turns", started_at: "2026-01-11T00:00:00Z", ended_at: "2026-01-11T00:05:00Z"},
	results: [
		makeResult({repo: "immer", sha: "1212121212", resolved: true, telemetry: {}, wall_ms: 1, adapterTurns: 5}),
		makeResult({repo: "immer", sha: "1313131313", resolved: false, telemetry: {}, wall_ms: 2, adapterTurns: 3})
	]
})

// --- trials fixtures --------------------------------------------------------

// (a) One task x one adapter, 3 trials, exactly one resolves.
const trialsRoot = mkTmp("trials")
const trialsRun = writeRun(trialsRoot, "trials", {
	manifest: {
		id: "trials",
		started_at: "2026-01-06T00:00:00Z",
		ended_at: "2026-01-06T00:30:00Z",
		mode: "run",
		tasks: ["1111111111"],
		adapter: [{name: "pi", version: "1"}]
	},
	results: [
		makeResult({repo: "immer", sha: "1111111111", resolved: true, trial: 0, trials: 3, telemetry: {}, wall_ms: 1}),
		makeResult({repo: "immer", sha: "1111111111", resolved: false, trial: 1, trials: 3, telemetry: {}, wall_ms: 2}),
		makeResult({repo: "immer", sha: "1111111111", resolved: false, trial: 2, trials: 3, telemetry: {}, wall_ms: 3})
	]
})

// (b) A truncated run: the manifest plans 2 tasks x 1 adapter = 2 items, but
// only task 1 emitted its 3 trial lines. Counting result LINES (3 >= 2) would
// call this complete; counting distinct (sha, adapter) pairs must not.
const partialTrialsRoot = mkTmp("partial-trials")
const partialTrialsRun = writeRun(partialTrialsRoot, "partial-trials", {
	manifest: {
		id: "partial-trials",
		started_at: "2026-01-07T00:00:00Z",
		ended_at: "2026-01-07T00:05:00Z",
		mode: "run",
		tasks: ["1111111111", "2222222222"],
		adapter: [{name: "pi", version: "1"}]
	},
	results: [
		makeResult({repo: "immer", sha: "1111111111", resolved: true, trial: 0, trials: 3, telemetry: {}, wall_ms: 1}),
		makeResult({repo: "immer", sha: "1111111111", resolved: false, trial: 1, trials: 3, telemetry: {}, wall_ms: 2}),
		makeResult({repo: "immer", sha: "1111111111", resolved: false, trial: 2, trials: 3, telemetry: {}, wall_ms: 3})
	]
})

// (c) Legacy lines carry no trial/trials keys and must normalise to 0/1.
const legacyRoot = mkTmp("legacy")
const legacyRun = writeRun(legacyRoot, "legacy", {
	manifest: {
		id: "legacy",
		started_at: "2026-01-08T00:00:00Z",
		ended_at: "2026-01-08T00:05:00Z",
		mode: "run",
		tasks: ["aaaaaaaaaa", "bbbbbbbbbb"],
		adapter: [{name: "pi", version: "1"}]
	},
	results: [
		makeResult({repo: "immer", sha: "aaaaaaaaaa", resolved: true, telemetry: {}, wall_ms: 1}),
		makeResult({repo: "immer", sha: "bbbbbbbbbb", resolved: false, telemetry: {}, wall_ms: 2})
	]
})

// (d) Two adapters that self-report the SAME harness string. The manifest plans
// 2 adapter items; completeness must key on the adapter NAME, not the
// self-reported harness, or a complete run collapses to one distinct pair.
const pairRoot = mkTmp("adapter-pairs")
const pairRun = writeRun(pairRoot, "adapter-pairs", {
	manifest: {
		id: "adapter-pairs",
		started_at: "2026-01-09T00:00:00Z",
		ended_at: "2026-01-09T00:05:00Z",
		mode: "run",
		tasks: ["1111111111"],
		adapter: [{name: "stub", version: "1"}, {name: "stub2", version: "1"}]
	},
	results: [
		makeResult({repo: "immer", sha: "1111111111", adapter: "stub", harness: "stub", resolved: true, telemetry: {}, wall_ms: 1}),
		makeResult({repo: "immer", sha: "1111111111", adapter: "stub2", harness: "stub", resolved: false, telemetry: {}, wall_ms: 2})
	]
})

// (e) Same, truncated: only one of the two adapters reported an item.
const pairPartialRoot = mkTmp("adapter-pairs-partial")
const pairPartialRun = writeRun(pairPartialRoot, "adapter-pairs-partial", {
	manifest: {
		id: "adapter-pairs-partial",
		started_at: "2026-01-10T00:00:00Z",
		ended_at: "2026-01-10T00:05:00Z",
		mode: "run",
		tasks: ["1111111111"],
		adapter: [{name: "stub", version: "1"}, {name: "stub2", version: "1"}]
	},
	results: [
		makeResult({repo: "immer", sha: "1111111111", adapter: "stub", harness: "stub", resolved: true, telemetry: {}, wall_ms: 1})
	]
})

// ---------------------------------------------------------------- tests

console.log("== resolveRunDir ==")
{
	const root = mkTmp("resolve")
	const byId = writeRun(root, "abc", {manifest: {id: "abc"}, results: []})
	eq(resolveRunDir("abc", {runsDir: path.join(root, "runs")}), byId, "run id resolves under runsDir")
	eq(resolveRunDir(byId), byId, "absolute path resolves")
	const fileArg = path.join(byId, "results.jsonl")
	eq(resolveRunDir(fileArg), byId, "results.jsonl path resolves to its directory")
	let threw = false
	try {
		resolveRunDir("does-not-exist", {runsDir: path.join(root, "runs")})
	} catch {
		threw = true
	}
	ok(threw, "missing run id throws")
}

console.log("== mixed telemetry / rate / category join ==")
{
	const report = buildReport(mixedRun, {datasetDir: path.join(mixedRoot, "dataset")})
	eq(report.run.id, "mixed", "run id from manifest")
	eq(report.run.date, "2026-01-01T01:00:00Z", "run date from manifest")
	eq(report.run.config, {budget_ms: 600000, adapters: ["pi"]}, "config from manifest")
	eq(report.run.partial, false, "complete run is not partial")
	eq(report.run.status, "complete", "status complete")

	const g = findGroup(report, "pi", "m1")
	ok(!!g, "harness x model group present")
	eq(g.tasks, 2, "group tasks")
	eq(g.resolved, 1, "group resolved")
	eq(g.rate, 0.5, "resolution rate is 1/2 = 0.5 (not 1)")

	eq(g.means.input_tokens.mean, 100, "mean in-tokens averages only real values (100, not 50)")
	eq(g.means.input_tokens.n, 1, "in-tokens sample size 1")
	eq(g.means.input_tokens.total, 2, "in-tokens denominator 2")
	eq(g.means.output_tokens.mean, 10, "mean out-tokens")
	eq(g.means.cache_read_tokens.mean, 5, "mean cache-read")
	eq(g.means.cache_write_tokens.mean, null, "mean cache-write is null, not 0")
	eq(g.means.cache_write_tokens.n, 0, "cache-write sample size 0")
	eq(g.means.cost_usd.mean, 0.5, "mean cost")
	eq(g.means.wall_ms.mean, 1500, "mean wall ms over 2 samples")
	eq(g.means.wall_ms.n, 2, "wall sample size 2")
	eq(g.means.turns.mean, 2, "mean turns over the 1 task that reported it")
	eq(g.means.turns.n, 1, "turns sample size 1")
	eq(g.means.turns.total, 2, "turns denominator 2")
	eq(g.failure_modes, {none: 1, agent_timeout: 1}, "failure-mode breakdown")

	const cat = Object.fromEntries(report.categories.map(c => [c.category, c]))
	eq(cat.bugfix.tasks, 1, "category join: bugfix has 1 task")
	eq(cat.bugfix.resolved, 1, "category join: bugfix resolved")
	eq(cat.feature.tasks, 1, "category join: feature has 1 task")
	eq(cat.feature.resolved, 0, "category join: feature unresolved")
	eq(report.repos.map(x => x.repo), ["immer"], "per-repo breakdown")

	eq(report.tasks[0].f2p, {passed: 1, required: 1, ratio: 1}, "per-task f2p ratio")
	eq(report.tasks[1].p2p, {passed: 2, required: 2, ratio: 1}, "per-task p2p ratio")

	const md = renderMarkdown(report)
	ok(md.includes("100 (n=1/2)"), "markdown shows mean with sample size")
	ok(md.includes("n/a (n=0/2)"), "markdown renders missing cache-write as n/a")
	ok(md.includes("50.0%"), "markdown shows resolution rate")
	ok(md.includes("agent_timeout:1"), "markdown shows failure-mode breakdown")
	ok(/^# Run report: mixed$/m.test(md), "markdown title includes run id")
}

console.log("== all telemetry null: nothing fabricated ==")
{
	const report = buildReport(allNullRun)
	const g = findGroup(report, "pi", "m1")
	for (const f of TELEMETRY_FIELDS) {
		eq(g.means[f].mean, null, `all-null: mean ${f} stays null`)
		eq(g.means[f].n, 0, `all-null: ${f} sample size 0`)
	}
	eq(g.means.turns.mean, null, "all-null: turns mean null when unreported")
	eq(g.means.wall_ms.mean, null, "all-null: wall mean null when unreported")
	const md = renderMarkdown(report)
	ok(md.includes("n/a (n=0/2)"), "all-null markdown renders n/a with sample size")
	ok(!JSON.stringify(report).includes('"mean":0'), "no number fabricated as 0")
	const occurrences = md.split("n/a (n=0/2)").length - 1
	ok(occurrences >= TELEMETRY_FIELDS.length, "every null telemetry mean cell is n/a")
}

console.log("== interrupted / partial run ==")
{
	const report = buildReport(intrRun)
	eq(report.run.partial, true, "interrupted run flagged partial")
	eq(report.run.status, "partial", "interrupted run status partial")
	ok(report.run.partial_reasons.length >= 1, "partial reasons recorded")
	eq(report.run.malformed_lines, 1, "malformed result line counted")
	const md = renderMarkdown(report)
	ok(/partial|interrupt/i.test(md), "markdown labels the run partial/interrupted")
	ok(md.includes("1 malformed result line(s)"), "markdown states malformed lines")
	ok(md.includes("only 1/5 adapter results present"), "markdown states the shortfall")
	ok(report.run.partial_reasons.some(x => x.includes("manifest.stopped=interrupted")), "stopped reason recorded")
}

console.log("== turns fallback from adapter notes ==")
{
	const report = buildReport(notesRun)
	eq(report.tasks[0].turns, 7, "turns parsed from adapter_run notes")
}

console.log("== mean turns from adapter_run.turns without a notes scrape ==")
{
	const report = buildReport(adapterTurnsRun)
	// Prove the notes regex and the legacy top-level key are not what supply these values.
	const raw = fs
		.readFileSync(path.join(adapterTurnsRun, "results.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
	ok(raw.every(r => r.turns === undefined && r.adapter_run.notes === ""), "fixture lines have no top-level turns and empty notes")
	eq(report.tasks.map(t => t.turns), [5, 3], "per-task turns come from adapter_run.turns")
	const g = findGroup(report, "pi", "m1")
	eq(g.means.turns.mean, 4, "mean turns is the mean of adapter_run.turns (5 and 3)")
	eq(g.means.turns.n, 2, "turns sample size is 2")
	eq(g.means.turns.total, 2, "turns denominator is 2")
	eq(g.means.turns.n, g.means.turns.total, "n === total === 2")
}

console.log("== trials: per-task trial aggregation ==")
{
	const report = buildReport(trialsRun, {datasetDir: path.join(trialsRoot, "dataset")})
	eq(report.run.partial, false, "complete 3-trial run is not partial")
	eq(report.run.results, 3, "trials run records 3 result lines")
	const g = findGroup(report, "pi", "m1")
	ok(!!g, "trials group present")
	eq(g.tasks, 1, "one distinct task despite three result lines")
	eq(g.trials, 3, "trials counts result lines (3)")
	eq(g.resolved, 1, "exactly one trial resolved")
	eq(g.rate, 1 / 3, "per-trial rate is 1/3")
	eq(g.resolved_tasks_all, 0, "not all trials resolved")
	eq(g.resolved_tasks_any, 1, "at least one trial resolved")
	eq(report.tasks.map(t => `${t.trial}/${t.trials}`), ["0/3", "1/3", "2/3"], "each line carries its trial index")
}

console.log("== partial run under --trials (line count must not mask missing items) ==")
{
	const report = buildReport(partialTrialsRun, {datasetDir: path.join(partialTrialsRoot, "dataset")})
	// 3 result lines >= 2 planned items; the old line-count logic would have
	// declared this complete. Only distinct item counting catches the truncation.
	eq(report.run.results, 3, "truncated run still has 3 result lines")
	eq(report.run.partial, true, "truncated run is flagged partial")
	eq(report.run.status, "partial", "truncated run status partial")
	ok(
		report.run.partial_reasons.some(x => x.includes("only 1/2 adapter results present")),
		"partial reasons count distinct items, not lines"
	)
	const md = renderMarkdown(report)
	ok(md.includes("only 1/2 adapter results present"), "markdown states the distinct-item shortfall")
	const g = findGroup(report, "pi", "m1")
	eq(g.tasks, 1, "only the one task that ran is present")
	eq(g.trials, 3, "its three trial lines are counted")
}

console.log("== completeness keys on adapter name, not self-reported harness ==")
{
	const report = buildReport(pairRun, {datasetDir: path.join(pairRoot, "dataset")})
	eq(report.run.results, 2, "two adapter items present")
	eq(report.run.partial, false, "two adapters sharing a harness string still count as 2 items")
	eq(report.run.status, "complete", "complete run is not falsely partial")

	const truncated = buildReport(pairPartialRun, {datasetDir: path.join(pairPartialRoot, "dataset")})
	eq(truncated.run.results, 1, "truncated run has one result line")
	eq(truncated.run.partial, true, "one of two adapters is flagged partial")
	ok(
		truncated.run.partial_reasons.some(x => x.includes("only 1/2 adapter results present")),
		"truncated run reports the missing adapter item"
	)
}

console.log("== backward compatibility: lines without trial/trials ==")
{
	const report = buildReport(legacyRun, {datasetDir: path.join(legacyRoot, "dataset")})
	for (const t of report.tasks) {
		eq(t.trial, 0, "legacy line normalises to trial 0")
		eq(t.trials, 1, "legacy line normalises to trials 1")
	}
	const g = findGroup(report, "pi", "m1")
	eq(g.tasks, 2, "legacy run has two distinct tasks")
	eq(g.trials, 2, "legacy run has two result lines")
	eq(g.tasks, g.trials, "legacy run reports tasks === trials")
	eq(g.resolved, 1, "legacy resolved count")
	eq(g.resolved_tasks_all, 1, "legacy per-task all")
	eq(g.resolved_tasks_any, 1, "legacy per-task any")
}

console.log("== cost: reported vs estimated, never averaged ==")
{
	const root = mkTmp("cost")
	// The real codex trial-0 token counts.
	const priced = {input_tokens: 1068873, output_tokens: 9424, cache_read_tokens: 955804, cache_write_tokens: 113035}
	const runDir = writeRun(root, "cost", {
		manifest: {id: "cost", started_at: "2026-01-20T00:00:00Z", ended_at: "2026-01-20T00:10:00Z", config: {}},
		results: [
			// priced model, tokens present, no reported cost -> estimated
			makeResult({repo: "immer", sha: "a1", harness: "codex", model: "us.openai.gpt-6-astra", resolved: true, telemetry: priced}),
			// same group, but this line DID report dollars -> must not be averaged with the estimate
			makeResult({repo: "immer", sha: "a2", harness: "codex", model: "us.openai.gpt-6-astra", resolved: false, telemetry: Object.assign({}, priced, {cost_usd: 0.5})}),
			// purely estimated group: round numbers keep the expectation obvious
			makeResult({repo: "immer", sha: "b1", harness: "sonnet", model: "claude-sonnet-5", resolved: true, telemetry: {input_tokens: 1000000, output_tokens: 1000000}}),
			// purely reported group on a model with no price entry
			makeResult({repo: "immer", sha: "c1", harness: "pi", model: "deepseek/deepseek-v4.1-flash", resolved: true, telemetry: {input_tokens: 100, output_tokens: 10, cost_usd: 0.01}}),
			// unpriced model with no reported cost -> nothing can be known
			makeResult({repo: "immer", sha: "d1", harness: "ghost", model: "totally/unpriced", resolved: false, telemetry: {input_tokens: 1000}})
		]
	})

	// The fixture never writes a `cost` key, so every assertion below runs on the
	// legacy path where the report must estimate for itself.
	const raw = JSON.parse(fs.readFileSync(path.join(runDir, "results.jsonl"), "utf8").split("\n")[0])
	ok(!("cost" in raw), "fixture line carries no cost key, exercising report-side estimation")

	const report = buildReport(runDir)
	const md = renderMarkdown(report)
	const expectedEst = (34 * 10 + 955804 * 1 + 113035 * 12.5 + 9424 * 50) / 1e6

	const codex = findGroup(report, "codex", "us.openai.gpt-6-astra")
	eq(codex.cost.estimated.mean, expectedEst, "priced model with unreported cost is estimated")
	eq(codex.cost.estimated.n, 1, "only the unreported line contributes an estimate")
	eq(codex.cost.estimated.total, 2, "the estimate sample size is the whole group")
	eq(codex.cost.reported.mean, 0.5, "reported figures are averaged separately")
	eq(codex.cost.reported.n, 1, "reported and estimated sample sizes stay independent")
	ok(
		codex.cost.reported.mean !== (0.5 + expectedEst) / 2,
		"reported and estimated costs are never averaged together"
	)

	const sonnet = findGroup(report, "sonnet", "claude-sonnet-5")
	eq(sonnet.cost.estimated.mean, 12, "1M in + 1M out on claude-sonnet-5 estimates $12")
	eq(sonnet.cost.reported.mean, null, "a purely estimated group has no reported mean")

	const pi = findGroup(report, "pi", "deepseek/deepseek-v4.1-flash")
	eq(pi.cost.reported.mean, 0.01, "a harness-reported cost is used as-is")
	eq(pi.cost.estimated.n, 0, "an unpriced model is never estimated")

	const ghost = findGroup(report, "ghost", "totally/unpriced")
	eq(ghost.cost.reported.mean, null, "no reported cost")
	eq(ghost.cost.estimated.mean, null, "no estimate for an unpriced model")

	ok(md.includes("~$12.0000 (est, n=1/1)"), "an estimated-only group is marked with ~ and est")
	ok(md.includes("$0.0100 (n=1/1)"), "a reported-only group carries no estimate marker")
	ok(!md.includes("~$0.0100"), "a reported cost is not mislabelled as an estimate")
	ok(md.includes("$0.5000 (n=1/2) + ~$2.8403 est for 1 row"), "a mixed group shows the reported mean and discloses the estimate separately")
	ok(!md.includes("$1.6701"), "the mixed group's cost is not a blend of reported and estimated")
	ok(md.includes("n/a (n=0/1)"), "an unknowable cost renders n/a rather than $0")
}

console.log("== provider failures are excluded from the rate, not counted as agent failures ==")
{
	const root = mkTmp("infra")
	const runDir = writeRun(root, "infra", {
		manifest: {id: "infra", started_at: "2026-01-21T00:00:00Z", ended_at: "2026-01-21T00:10:00Z", config: {}},
		results: [
			// resolved normally
			makeResult({repo: "immer", sha: "ok", harness: "pi", model: "m1", resolved: true}),
			// failed for a real reason
			makeResult({repo: "immer", sha: "bad", harness: "pi", model: "m1", resolved: false, failure_mode: "harness_crash"}),
			// the provider refused: not the harness's fault
			makeResult({repo: "immer", sha: "rate", harness: "pi", model: "m1", resolved: false, failure_mode: "provider_error"}),
			makeResult({repo: "immer", sha: "quota", harness: "pi", model: "m1", resolved: false, failure_mode: "provider_error"}),
			// provider errored but the run still resolved: a valid measurement
			makeResult({repo: "immer", sha: "lucky", harness: "pi", model: "m1", resolved: true, failure_mode: "provider_error"})
		]
	})
	const report = buildReport(runDir)
	const g = findGroup(report, "pi", "m1")
	eq(g.trials, 5, "every result line is still counted as a trial")
	eq(g.infra_failures, 2, "only unresolved provider errors are excluded")
	eq(g.scored_trials, 3, "the rate is computed over the scored trials")
	eq(g.rate, 2 / 3, "the rate excludes provider failures")
	eq(g.resolved, 2, "resolved is still a raw count of resolved lines")
	eq(g.tasks, 5, "attempted tasks are still counted")
	eq(g.scored_tasks, 3, "tasks with no scored trial drop out of the per-task figures")
	eq(g.resolved_tasks_all, 2, "only fully-resolved scored tasks count toward all-trials")
	eq(g.failure_modes.provider_error, 3, "provider errors are still visible in the breakdown")
	const md = renderMarkdown(report)
	ok(md.includes("66.7% (n=3/5)"), "the rate states the sample it was computed over")
	ok(md.includes("infra failures"), "the excluded count is a column")
}

console.log("== historical rows recorded before provider_error existed are reclassified ==")
{
	const root = mkTmp("legacy-infra")
	// Same shape the runner stored before the mode existed: failure_mode "unknown"
	// with the provider's error text sitting in the notes.
	const legacy = makeResult({repo: "immer", sha: "old", harness: "pi", model: "m1", resolved: false, failure_mode: "unknown"})
	legacy.adapter_run.notes = 'error=429: {"message":"Provider returned error","code":429}'
	const quota = makeResult({repo: "immer", sha: "old2", harness: "pi", model: "m1", resolved: false, failure_mode: "unknown"})
	quota.adapter_run.notes = "error=402: This request requires more credits"
	// An "unknown" that is genuinely not infrastructure must stay unknown.
	const genuine = makeResult({repo: "immer", sha: "old3", harness: "pi", model: "m1", resolved: false, failure_mode: "unknown"})
	genuine.adapter_run.notes = "agent gave up after 3 turns"
	const runDir = writeRun(root, "legacy-infra", {
		manifest: {id: "legacy-infra", started_at: "2026-01-22T00:00:00Z", ended_at: "2026-01-22T00:10:00Z", config: {}},
		results: [legacy, quota, genuine]
	})
	const g = findGroup(buildReport(runDir), "pi", "m1")
	eq(g.infra_failures, 2, "429 and 402 in the stored notes are reclassified as provider errors")
	eq(g.failure_modes.unknown, 1, "a genuine unknown failure is not reclassified")
	eq(g.scored_trials, 1, "only the genuine failure remains scored")
	eq(g.rate, 0, "the reclassified rows no longer drag the rate down")
}

console.log("== --json round trip ==")
{
	const report = buildReport(roundRun)
	let stdout
	try {
		stdout = execFileSync(process.execPath, [SCRIPT, roundRun, "--json"], {encoding: "utf8"})
	} catch (e) {
		ok(false, `cli --json failed: ${e.message}`)
		stdout = ""
	}
	let parsed = null
	try {
		parsed = JSON.parse(stdout)
	} catch (e) {
		ok(false, `stdout is not valid JSON: ${e.message}`)
	}
	const expected = JSON.parse(JSON.stringify(report))
	eq(parsed, expected, "--json stdout round-trips to the in-process report")
	eq(JSON.parse(JSON.stringify(parsed)), parsed, "parsed JSON re-serializes identically")

	const jsonFile = path.join(roundRun, "report.json")
	ok(fs.existsSync(jsonFile), "report.json written with --json")
	eq(fs.readFileSync(jsonFile, "utf8"), stdout, "report.json matches stdout")
	ok(fs.existsSync(path.join(roundRun, "report.md")), "report.md written")
	eq(parsed.tasks[0].category, "n/a", "unknown repo joins to n/a category")
	eq(parsed.schema, "harness-benchmark/report@1", "schema stamped")
}


// ---------------------------------------------------------------- efficiency

const piEvents = ({reads = [], turns = [], chars = 10} = {}) =>
	[
		...reads.flatMap((p, i) => [
			{type: "tool_execution_start", toolCallId: `r${i}`, toolName: "read", args: {path: p}},
			{type: "tool_execution_end", toolCallId: `r${i}`, toolName: "read", result: {content: [{type: "text", text: "x".repeat(chars)}]}}
		]),
		...turns.map(([input, cacheRead]) => ({type: "turn_end", message: {usage: {input, cacheRead, output: 1, cacheWrite: 0}}}))
	]
		.map(e => JSON.stringify(e))
		.join("\n")

function withTranscript(root, res, text) {
	const dir = path.join(root, "transcripts")
	fs.mkdirSync(dir, {recursive: true})
	const file = path.join(dir, `${res.sha}-${res.trial ?? 0}-${res.adapter}.txt`)
	fs.writeFileSync(file, text)
	res.adapter_run.transcript_path = file
	return res
}

console.log("== topology is derived per entry and aggregated into the group ==")
{
	const root = mkTmp("eff")
	const a = withTranscript(root, makeResult({repo: "immer", sha: "e1", resolved: true, telemetry: {input_tokens: 100, output_tokens: 10, cost_usd: 0.5}, wall_ms: 1}), piEvents({reads: ["/w/a.ts", "/w/a.ts", "/w/b.ts"], turns: [[100, 0], [50, 100], [50, 200]]}))
	const b = withTranscript(root, makeResult({repo: "immer", sha: "e2", resolved: false, telemetry: {input_tokens: 300, output_tokens: 30, cost_usd: 1.5}, wall_ms: 1}), piEvents({reads: ["/w/c.ts"], turns: [[100, 0], [100, 0]]}))
	// A refused trial carries a transcript too, but is excluded from every mean.
	const refused = withTranscript(root, makeResult({repo: "immer", sha: "e3", resolved: false, failure_mode: "provider_error", telemetry: {}, wall_ms: 1}), piEvents({reads: ["/w/z.ts", "/w/z.ts", "/w/z.ts", "/w/z.ts"]}))
	// claude-style: no per-tool detail.
	const opaque = withTranscript(root, makeResult({repo: "immer", sha: "e4", adapter: "claude", harness: "claude", resolved: true, telemetry: {}, wall_ms: 1}), '{"result":"done","num_turns":3}')
	const run = writeRun(root, "eff", {manifest: {id: "eff", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z"}, results: [a, b, refused, opaque]})
	const report = buildReport(run)
	const g = findGroup(report, "pi", "m1")
	eq(g.topology.trials, 2, "two scored pi trials carry topology; the refused one is excluded")
	eq(g.topology.reads.calls, 4, "read calls summed over scored trials (3 + 1), not the refused trial's 4")
	eq(g.topology.reads.mean_calls, 2, "mean reads per scored trial")
	eq(g.topology.reads.rereads, 1, "one reread")
	eq(g.topology.reads.reread_ratio, 0.25, "ratio of sums")
	eq(g.topology.tool_result_chars, 40, "result chars summed")
	eq(g.topology.context.growth, (250 + 100) / (100 + 100), "context growth is sum(last)/sum(first)")
	eq(g.topology_unavailable, 0, "both pi transcripts parsed")
	const c = findGroup(report, "claude", "m1")
	eq(c.topology, null, "claude's format yields no topology")
	eq(c.topology_unavailable, 1, "and is counted unavailable, not zero")
	// cost per resolve: $2.0 total over 1 resolved among 2 priced trials
	eq(g.cost_per_resolve.value, 2, "cost/resolve = total reported cost / resolved trials among priced trials")
	eq(g.cost_per_resolve.source, "reported", "source is tracked")
	eq(g.cost_per_resolve.n, 2, "two priced trials")
	eq(g.tokens_per_resolve.value, 440, "tokens/resolve = (110 + 330) / 1")
	eq(c.cost_per_resolve.value, null, "no cost data, no figure")
	eq(c.cost_per_resolve.note, "no data", "and the reason is stated")
	// CI + provisional
	eq(g.rate, 0.5, "rate 1/2")
	ok(Math.abs(g.rate_ci.low - 0.0945) < 0.001 && Math.abs(g.rate_ci.high - 0.9055) < 0.001, "1/2 has a Wilson interval of roughly [9%, 91%]")
	eq(g.provisional, true, "one trial per task is provisional")
	eq(g.trials_per_task, 1, "trials per task computed over scored trials and scored tasks")
	const md = renderMarkdown(report)
	ok(md.includes("## Harness efficiency"), "the efficiency section renders")
	ok(md.includes("| pi † |"), "the provisional dagger is on the harness cell")
	ok(md.includes("† provisional"), "and explained")
	ok(md.includes("$2.0000 (n=2/2)"), "cost/resolve renders with its sample")
	ok(md.includes("0.25 (n=2/2)"), "reread ratio renders with its sample")
	ok(md.includes("n/a (n=0/1)"), "the opaque harness renders n/a with its sample, never 0")
	eq(report.tasks[0].topology.reads.calls, 3, "per-task rows carry their topology")
	eq(report.tasks[3].topology, null, "an opaque row carries null")
	// Round-trips: no Sets, no NaN.
	eq(JSON.parse(JSON.stringify(report)).groups.find(x => x.harness === "pi").topology.reads.calls, g.topology.reads.calls, "the report serializes cleanly")
}

console.log("== a recorded legacy topology is completed from the transcript ==")
{
	const root = mkTmp("merge")
	const res = withTranscript(root, makeResult({repo: "immer", sha: "m1", resolved: true, telemetry: {}, wall_ms: 1}), piEvents({reads: ["/w/a.ts", "/w/a.ts"], turns: [[10, 0], [20, 0]]}))
	res.adapter_run.topology = {parse: "pi-events", total_tool_calls: 42, tool_calls: {bash: 42}, tool_errors: {}, subagents: {calls: 1, distinct: 1, by_agent: {x: 1}, prompt_chars: 0, max_prompt_chars: 0}, retries: 0, delegation_ratio: 1 / 42}
	const t = topologyOf(res)
	eq(t.total_tool_calls, 42, "the recorded count stands")
	eq(t.subagents.by_agent, {x: 1}, "the recorded agent mix stands")
	eq(t.reads.calls, 2, "reads come from the transcript")
	eq(t.reads.rereads, 1, "including rereads")
	eq(t.context.growth, 2, "context comes from the transcript")
	res.adapter_run.transcript_path = ""
	const alone = topologyOf(res)
	eq(alone.reads, null, "without a transcript the gap stays null, never 0")
	eq(alone.total_tool_calls, 42, "and the recorded counts still stand")
}

console.log("== mixed reported and estimated costs never produce a cost/resolve ==")
{
	const entries = [
		{resolved: true, cost: {usd: 1, source: "reported"}, telemetry: {}, failure_mode: "none", repo: "r", sha: "a", topology: null},
		{resolved: true, cost: {usd: 1, source: "estimated"}, telemetry: {}, failure_mode: "none", repo: "r", sha: "b", topology: null}
	]
	const s = summarize(entries)
	eq(s.cost_per_resolve.value, null, "no combined figure")
	eq(s.cost_per_resolve.source, "mixed", "flagged as mixed")
	ok(s.cost_per_resolve.note.includes("never combined"), "the reason is stated")
	const pr = perResolve([{resolved: false, v: 3}, {resolved: false, v: 1}], e => e.v)
	eq(pr.value, null, "nothing resolved, no per-resolve")
	eq(pr.total, 4, "but the spend is still reported")
	eq(pr.note, "nothing resolved", "with the reason")
}

console.log("== chains: step curves and warm-up ratios ==")
{
	const root = mkTmp("chains")
	const step = (sha, n, {resolved = true, input = 1000, reads = [], turns = [[100, 0], [200, 0]], chars = 10, failure_mode = "none", trial = 0} = {}) => {
		const r = withTranscript(root, makeResult({repo: "immer", sha, resolved, telemetry: {input_tokens: input, output_tokens: 10}, wall_ms: 1000 * n, failure_mode, trial, trials: 1}), piEvents({reads, turns, chars}))
		Object.assign(r, {chain_id: "c1", chain_step: n, chain_length: 3, chain_resolved: false})
		return r
	}
	// Step 1 cold: 4 reads, 1000 in tokens. Steps 2-3 warm: 1 read each, 500 in tokens each.
	const results = [
		step("s1", 1, {input: 1000, reads: ["/a", "/b", "/c", "/d"], turns: [[100, 0], [400, 0]]}),
		step("s2", 2, {input: 500, reads: ["/a"], turns: [[300, 0], [350, 0]]}),
		step("s3", 3, {input: 500, reads: ["/b"], turns: [[300, 0], [300, 0]], resolved: false}),
		// A second, refused chain trial must be listed but excluded from warm-up.
		step("s1", 1, {input: 1, reads: [], failure_mode: "provider_error", resolved: false, trial: 1})
	]
	// Flat (non-chain) rows must not enter the chain section.
	results.push(makeResult({repo: "immer", sha: "flat", resolved: true, telemetry: {}, wall_ms: 1}))
	const run = writeRun(root, "chains", {manifest: {id: "chains", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:01:00Z", mode: "chain"}, results})
	const report = buildReport(run)
	eq(report.chains.length, 1, "one (harness, model) chain group")
	const g = report.chains[0]
	eq(g.chains.length, 2, "two chain trials (trial 0 and the refused trial 1)")
	eq(g.chains[0].steps.map(s => s.step), [1, 2, 3], "steps are ordered")
	eq(g.chains[0].steps[0].reads, 4, "step 1 read four files")
	eq(g.chains[0].steps[1].reads, 1, "step 2 read one")
	eq(g.chains[0].steps[0].input_first, 100, "first prompt of step 1")
	eq(g.chains[0].steps[0].input_last, 400, "last prompt of step 1")
	eq(g.chains[1].steps[0].infra, true, "the refused step is marked")
	eq(g.steps_scored, 3, "three scored steps")
	eq(g.steps_total, 4, "four in total")
	eq(g.warm_up.input_tokens.step1.mean, 1000, "step-1 mean input tokens over scored steps only (refused step 1 excluded)")
	eq(g.warm_up.input_tokens.later.mean, 500, "later mean")
	eq(g.warm_up.input_tokens.ratio, 0.5, "warm-up ratio 0.5: later steps cost half")
	eq(g.warm_up.reads.ratio, 0.25, "reads warm-up: 1 vs 4")
	eq(g.warm_up.tool_result_chars.ratio, 0.25, "result chars warm-up")
	eq(g.warm_up.prompt_tokens.step1.mean, 500, "prompt tokens per step from the context series (100 + 400)")
	ok(!g.chains.some(c => c.steps.some(s => s.sha === "flat")), "flat rows are not in the chain section")
	const md = renderMarkdown(report)
	ok(md.includes("## Long-horizon chains"), "the chains section renders")
	ok(md.includes("1,000 -> 500 (x0.50, n=1+2)"), "warm-up renders step1 -> later with ratio and samples")
	ok(md.includes("excluded (infra)"), "the refused step is rendered as excluded")
	ok(md.includes("### pi / m1 / c1 (trial 0, 3/3 steps, chain not resolved)"), "each chain trial gets its own table")
	eq(summarizeChains([]), [], "no chain rows, no section")
	const flat = buildReport(mixedRun, {datasetDir: path.join(mixedRoot, "dataset")})
	eq(flat.chains, [], "a flat run has no chain section")
	ok(!renderMarkdown(flat).includes("Long-horizon"), "and does not render one")
}

console.log("== outcome does not change any efficiency count ==")
{
	const root = mkTmp("blind")
	const text = piEvents({reads: ["/a", "/a"], turns: [[10, 0], [30, 0]]})
	const won = withTranscript(root, makeResult({repo: "immer", sha: "w", resolved: true, telemetry: {}, wall_ms: 1}), text)
	const lost = withTranscript(root, makeResult({repo: "immer", sha: "w", resolved: false, telemetry: {}, wall_ms: 1, failure_mode: "harness_crash"}), text)
	eq(topologyOf(won), topologyOf(lost), "identical activity yields identical topology regardless of outcome")
}

console.log("== answer lookup audit ==")
{
	const fatalLeak = cmd => ({
		clean: false,
		findings: [{kind: "upstream_lookup", fatal: true, tool: "Bash", command: cmd, via_subagent: false}],
		counts: {upstream_lookup: 1, external_network: 0, web_tool: 0}
	})
	const root = mkTmp("leak")
	const runDir = writeRun(root, "leak", {
		manifest: {id: "leak", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z", config: {adapter: ["pi"]}},
		results: [
			// A: fetched the fix; evaluator would have credited it; filed as answer_lookup
			makeResult({repo: "immer", sha: "a1", resolved: false, reason: "answer_lookup", leak: fatalLeak("gh pr view 4717 --repo honojs/hono --json files"), graded: {resolved: true, reason: "resolved"}}),
			// B: non-fatal external network only; resolved stands
			makeResult({repo: "immer", sha: "b2", resolved: true, leak: {clean: true, findings: [{kind: "external_network", fatal: false, tool: "Bash", command: "curl https://registry.npmjs.org/hono", via_subagent: false}], counts: {upstream_lookup: 0, external_network: 1, web_tool: 0}}}),
			// C: recorded before the audit existed: no leak field at all
			makeResult({repo: "immer", sha: "c3", resolved: true}),
			// D: fetched the fix and STILL failed the tests
			makeResult({repo: "immer", sha: "d4", resolved: false, reason: "answer_lookup", leak: fatalLeak("gh pr view 4717 --repo honojs/hono --json files"), graded: {resolved: false, reason: "f2p_failed"}}),
			// E: provider refused: infra, excluded from the scored population entirely
			makeResult({repo: "immer", sha: "e5", resolved: false, failure_mode: "provider_error", leak: {clean: true, findings: [], counts: {upstream_lookup: 0, external_network: 0, web_tool: 0}}})
		]
	})
	const report = buildReport(runDir, {datasetDir: path.join(root, "dataset")})
	const g = findGroup(report, "pi", "m1")
	eq(g.infra_failures, 1, "the provider refusal is infra")
	eq(g.scored_trials, 4, "lookup trials stay in the scored population (they are failures, not infra)")
	eq(g.resolved, 2, "B and C resolve; the two lookup trials do not")
	eq(g.rate, 0.5, "the rate falls because of lookups; the sample does not shrink")
	eq(g.lookup.audited, 3, "audited counts scored trials carrying a leak record (A, B, D), not C, not the infra line")
	eq(g.lookup.scored, 4, "the audited sample is stated against the scored population")
	eq(g.lookup.fatal, 2, "two fatal lookups")
	eq(g.lookup.nonfatal_findings, 1, "one non-fatal finding")
	ok(Math.abs(g.lookup.rate - 2 / 3) < 1e-12, "lookup rate is fatal over audited")
	ok(Math.abs(g.lookup.ext_network_per_trial - 1 / 3) < 1e-12, "ext network per audited trial")
	eq(g.lookup.resolved_before, 2, "before the audit the evaluator credited A (graded) and B")
	eq(g.lookup.resolved_after, 1, "after the audit only B stands")
	eq(g.lookup.top_commands, [{command: "gh pr view 4717 --repo honojs/hono --json files", count: 2}, {command: "curl https://registry.npmjs.org/hono", count: 1}], "top commands by frequency, gh first")
	const taskA = report.tasks.find(x => x.sha === "a1")
	eq(taskA.graded, {resolved: true, reason: "resolved"}, "the evaluator's verdict is preserved on the task line")
	eq(taskA.leak && taskA.leak.fatal, true, "the task line carries the leak summary")
	eq(report.tasks.find(x => x.sha === "c3").leak, null, "a line without a leak record is null (not audited), never clean")
	const md = renderMarkdown(report)
	ok(md.includes("## Answer lookup"), "the Answer lookup section renders")
	ok(md.includes("| lookup rate |") || md.includes("lookup rate |"), "lookup rate is a column")
	ok(md.includes("ext. network/trial"), "ext. network/trial is an efficiency column")
	ok(md.includes("66.7% (n=3/4 audited)"), "the lookup rate states its audited sample")
	ok(md.includes("answer_lookup:2"), "the failure-mode summary shows the answer_lookup count")
	ok(md.includes("gh pr view 4717 --repo honojs/hono --json files (x2)"), "top commands are listed with counts")
	ok(md.includes("count as failures, not as infra"), "the note explains lookup trials are failures")
	// A group nobody audited renders n/a, never 0%.
	const root2 = mkTmp("noaudit")
	const run2 = writeRun(root2, "noaudit", {manifest: {id: "noaudit", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z", config: {}}, results: [makeResult({repo: "immer", sha: "z9", resolved: true})]})
	const r2 = buildReport(run2, {datasetDir: path.join(root2, "dataset")})
	const g2 = findGroup(r2, "pi", "m1")
	eq(g2.lookup.audited, 0, "no line audited")
	eq(g2.lookup.rate, null, "rate is null, not 0, when nothing was audited")
	ok(renderMarkdown(r2).includes("n/a (n=0/1 audited)"), "an unaudited group renders n/a with the sample")
	ok(!renderMarkdown(r2).includes("answer_lookup:"), "no answer_lookup count is invented for an unaudited group")
	// JSON round trip keeps the lookup block
	const j = JSON.parse(JSON.stringify(report))
	eq(j.groups[0].lookup.fatal, 2, "lookup survives JSON serialisation")
}

console.log("== wilson ==")
{
	const w = wilson(8, 10)
	ok(Math.abs(w.low - 0.49) < 0.001 && Math.abs(w.high - 0.9433) < 0.001, "8/10 -> [0.490, 0.943]")
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)
