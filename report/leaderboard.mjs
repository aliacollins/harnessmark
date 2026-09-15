#!/usr/bin/env node
// Cross-run leaderboard. report.mjs reports ONE run; this aggregates many.
//
// Two traps this file exists to avoid:
//   1. The same task can appear in several runs. Counting per-run totals and
//      summing them double-counts the task and inflates the denominator, so
//      every group is re-summarized over the MERGED entries instead.
//   2. Groups routinely cover different task sets. Ranking them against each
//      other compares different populations and means nothing, so the coverage
//      is computed and a common-subset table is emitted alongside.
import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {BENCHMARK_VERSION, ROOT, RUNS_DIR} from "../harness/registry.mjs"
import {
	EFFICIENCY_HEADERS,
	TASK_KEY_SEP,
	buildReport,
	efficiencyCells,
	fmtCi,
	fmtCost,
	fmtFailures,
	fmtMean,
	fmtRateCell,
	harnessCell,
	isInfraFailure,
	summarize,
	taskKey
} from "./report.mjs"

export const LEADERBOARD_SCHEMA = "harness-benchmark/leaderboard@1"

const SEP = "\u0001"

const groupKey = e => `${e.harness}${SEP}${e.model}`
const labelTask = key => {
	const i = key.indexOf(TASK_KEY_SEP)
	const repo = i >= 0 ? key.slice(0, i) : key
	const sha = i >= 0 ? key.slice(i + 1) : ""
	return `${repo}@${sha ? sha.slice(0, 8) : "?"}`
}

// A run's manifest records the PROMPT_VERSION its adapters were given. Two runs
// under different versions did not receive the same input, so they are never
// aggregated: only one version is included (the latest present unless the caller
// pins one) and the rest are excluded with a reason, exactly like a missing
// manifest. Manifests written before the field existed are version 1.
function runPromptVersion(dir) {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
		const v = m && m.config ? m.config.prompt_version : undefined
		return Number.isInteger(v) && v > 0 ? v : 1
	} catch {
		return 1
	}
}

export function discoverRuns(runsDir, {promptVersion = null} = {}) {
	const included = []
	const excluded = []
	let dirents
	try {
		dirents = fs.readdirSync(runsDir, {withFileTypes: true})
	} catch (e) {
		return {included, excluded, error: `runs directory unreadable: ${e.message}`}
	}
	for (const dirent of dirents.filter(d => d.isDirectory()).map(d => d.name).sort()) {
		const dir = path.join(runsDir, dirent)
		// A leading underscore marks a run that must never be aggregated (e.g.
		// runs/_invalid, which holds a leak-contaminated run kept only as
		// evidence of a failure mode).
		if (dirent.startsWith("_")) {
			excluded.push({name: dirent, reason: "name begins with _ (excluded by convention)"})
			continue
		}
		if (!fs.existsSync(path.join(dir, "manifest.json"))) {
			excluded.push({name: dirent, reason: "no manifest.json"})
			continue
		}
		const results = path.join(dir, "results.jsonl")
		if (!fs.existsSync(results)) {
			excluded.push({name: dirent, reason: "no results.jsonl"})
			continue
		}
		if (!fs.readFileSync(results, "utf8").split("\n").some(l => l.trim())) {
			excluded.push({name: dirent, reason: "results.jsonl has no result lines"})
			continue
		}
		included.push({name: dirent, dir, prompt_version: runPromptVersion(dir)})
	}
	const present = [...new Set(included.map(r => r.prompt_version))].sort((a, b) => a - b)
	const chosen = promptVersion ?? (present.length ? present[present.length - 1] : null)
	const kept = []
	for (const r of included) {
		if (chosen !== null && r.prompt_version !== chosen) {
			excluded.push({name: r.name, reason: `prompt version ${r.prompt_version} != ${chosen} (runs under different task prompts are not comparable)`})
		} else {
			kept.push(r)
		}
	}
	return {included: kept, excluded, prompt_version: chosen, prompt_versions_present: present}
}

function costSortKey(s) {
	if (s.cost && s.cost.reported && typeof s.cost.reported.mean === "number") return s.cost.reported.mean
	if (s.cost && s.cost.estimated && typeof s.cost.estimated.mean === "number") return s.cost.estimated.mean
	return Number.POSITIVE_INFINITY
}

// One comparator, used for BOTH tables. The common-subset table is the only
// apples-to-apples comparison, so it must be ranked on its own rates rather
// than inheriting the ordering of the incomparable full-pool table above it.
function byRank(a, b) {
	const ra = typeof a.rate === "number" ? a.rate : -1
	const rb = typeof b.rate === "number" ? b.rate : -1
	if (rb !== ra) return rb - ra
	const ca = costSortKey(a)
	const cb = costSortKey(b)
	if (ca !== cb) return ca - cb
	return `${a.harness}/${a.model}`.localeCompare(`${b.harness}/${b.model}`)
}

function subset(entries, taskKeys) {
	return entries.filter(e => taskKeys.has(taskKey(e)))
}

// The harness whose score is the zero point. A deliberately minimal agent (one
// loop, shell and edit tools, no planning, no sub-agents) run on the same model:
// whatever a harness scores above it is what the SCAFFOLD contributed.
export const REFERENCE_HARNESS = "reference"

function perTaskRates(entries) {
	const byTask = new Map()
	for (const e of entries) {
		if (isInfraFailure(e)) continue
		const k = taskKey(e)
		if (!byTask.has(k)) byTask.set(k, {resolved: 0, n: 0})
		const t = byTask.get(k)
		t.n++
		if (e.resolved) t.resolved++
	}
	const out = new Map()
	for (const [k, t] of byTask) out.set(k, t.resolved / t.n)
	return out
}

// Paired lift: for every task BOTH groups scored, the group's per-task resolve
// rate minus the reference's, averaged over those tasks. Pairing on tasks is
// what makes the number about the harness: each task's difficulty cancels out
// of the difference. Only a reference on the SAME model is a valid zero point;
// a different model is a different experiment.
export function liftAgainst(entries, referenceEntries) {
	const mine = perTaskRates(entries)
	const ref = perTaskRates(referenceEntries)
	const deltas = []
	for (const [k, r] of mine) if (ref.has(k)) deltas.push(r - ref.get(k))
	if (!deltas.length) return {status: "no paired tasks", delta: null, n_tasks: 0}
	return {status: "ok", delta: deltas.reduce((a, b) => a + b, 0) / deltas.length, n_tasks: deltas.length}
}

function attachLift(rows) {
	const refs = new Map()
	for (const g of rows) if (g.harness === REFERENCE_HARNESS) refs.set(g.model, g)
	return rows.map(g => {
		if (g.harness === REFERENCE_HARNESS) return {...g, lift: {status: "is reference", delta: 0, n_tasks: g.scored_tasks}}
		const ref = refs.get(g.model)
		if (!ref) return {...g, lift: {status: "no reference", delta: null, n_tasks: 0}}
		return {...g, lift: {...liftAgainst(g.entries, ref.entries), reference: `${ref.harness}/${ref.model}`}}
	})
}

export function fmtLift(l) {
	if (!l) return "n/a"
	if (l.status === "is reference") return "reference (0)"
	if (l.status === "no reference") return "no reference"
	if (l.status !== "ok" || l.delta == null) return `n/a (${l.status})`
	const pts = (l.delta * 100).toFixed(1)
	return `${l.delta >= 0 ? "+" : ""}${pts} pts (paired n=${l.n_tasks})`
}

export function buildLeaderboard(runsDir = RUNS_DIR, {promptVersion = null} = {}) {
	const {included, excluded, error, prompt_version, prompt_versions_present} = discoverRuns(runsDir, {promptVersion})
	const runs = []
	const excludedRuns = [...excluded]
	const tagged = []

	for (const run of included) {
		let report
		try {
			report = buildReport(run.dir)
		} catch (e) {
			excludedRuns.push({name: run.name, reason: `unreadable: ${e.message}`})
			continue
		}
		const partial = report.run.partial === true
		runs.push({
			name: run.name,
			id: report.run.id,
			partial,
			partial_reasons: report.run.partial_reasons || [],
			tasks: new Set(report.tasks.map(taskKey)).size,
			trials: report.tasks.length
		})
		for (const e of report.tasks) tagged.push({...e, run: run.name})
	}

	const grouped = new Map()
	for (const e of tagged) {
		const key = groupKey(e)
		if (!grouped.has(key)) grouped.set(key, {harness: e.harness, model: e.model, entries: [], runs: new Set()})
		const g = grouped.get(key)
		g.entries.push(e)
		g.runs.add(e.run)
	}

	let groups = [...grouped.values()].map(g => {
		const summary = summarize(g.entries)
		return {
			...summary,
			harness: g.harness,
			model: g.model,
			entries: g.entries,
			runs: [...g.runs].sort(),
			task_keys: new Set(g.entries.map(taskKey)),
			partial_runs: [...new Set(g.entries.filter(e => runs.find(r => r.name === e.run)?.partial).map(e => e.run))].sort()
		}
	})

	groups = attachLift(groups)
	groups.sort(byRank)

	// The tasks every group covers — the only population on which the groups are
	// genuinely comparable.
	let common = null
	if (groups.length) {
		common = new Set(groups[0].task_keys)
		for (const g of groups.slice(1)) {
			for (const k of [...common]) if (!g.task_keys.has(k)) common.delete(k)
		}
	}
	const comparable = groups.length <= 1 || groups.every(g => g.task_keys.size === common.size)

	// An empty intersection has no comparable population, so no subset rows are
	// computed at all rather than shipping zero-filled phantom groups.
	const commonGroups = comparable || common.size === 0
		? []
		: attachLift(
				groups.map(g => {
					const rows = subset(g.entries, common)
					return {...summarize(rows), harness: g.harness, model: g.model, runs: g.runs, entries: rows}
				})
			)
				.map(({entries: _entries, ...rest}) => rest)
				.sort(byRank)

	return {
		schema: LEADERBOARD_SCHEMA,
		benchmark_version: BENCHMARK_VERSION,
		generated_at: new Date().toISOString(),
		runs_dir: path.relative(ROOT, runsDir) || ".",
		error: error || null,
		prompt_version: prompt_version ?? null,
		prompt_versions_present: prompt_versions_present || [],
		comparable,
		common_task_count: common ? common.size : 0,
		runs,
		excluded_runs: excludedRuns,
		groups,
		common_groups: commonGroups,
		reference_harness: REFERENCE_HARNESS,
		has_reference: groups.some(g => g.harness === REFERENCE_HARNESS)
	}
}

// ---------------------------------------------------------------- rendering

function inline(s) {
	const text = typeof s === "string" ? s : JSON.stringify(s)
	return String(text).replace(/\n/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'")
}

const row = cells => `| ${cells.join(" | ")} |`
const table = (headers, rows) => [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n")

const HEADERS = [
	"harness",
	"model",
	"runs",
	"tasks",
	"trials",
	"infra failures",
	"rate (scored)",
	"95% CI",
	"lift vs reference",
	"resolved tasks (all trials)",
	"pass@N (any trial)",
	"mean in tokens",
	"mean out tokens",
	"mean cache-read",
	"mean cache-write",
	"mean cost",
	"mean wall ms",
	"mean turns",
	"failure modes"
]

function cells(s) {
	return [
		harnessCell(s),
		inline(s.model),
		String(s.runs.length),
		String(s.tasks),
		String(s.trials),
		String(s.infra_failures),
		fmtRateCell(s),
		fmtCi(s),
		fmtLift(s.lift),
		String(s.resolved_tasks_all),
		String(s.resolved_tasks_any),
		fmtMean(s.means.input_tokens),
		fmtMean(s.means.output_tokens),
		fmtMean(s.means.cache_read_tokens),
		fmtMean(s.means.cache_write_tokens),
		fmtCost(s),
		fmtMean(s.means.wall_ms, "ms"),
		fmtMean(s.means.turns),
		fmtFailures(s.failure_modes, s.lookup)
	]
}

export function renderLeaderboard(lb) {
	const lines = []
	lines.push("# Leaderboard")
	lines.push("")
	lines.push(`- HarnessMark version: ${lb.benchmark_version ?? BENCHMARK_VERSION}`)
	lines.push(`- Generated: ${lb.generated_at}`)
	lines.push(`- Runs directory: \`${inline(lb.runs_dir)}\``)
	lines.push(`- Runs included: ${lb.runs.length}`)
	if (lb.prompt_version !== null && lb.prompt_version !== undefined) {
		const others = (lb.prompt_versions_present || []).filter(v => v !== lb.prompt_version)
		lines.push(`- Task prompt version: ${lb.prompt_version}${others.length ? ` (runs under version(s) ${others.join(", ")} excluded: different input, not comparable)` : ""}`)
	}
	lines.push(`- Groups: ${lb.groups.length}`)
	lines.push(`- Fully comparable: ${lb.comparable ? "yes" : `NO - groups cover different task sets (${lb.common_task_count} task(s) in common)`}`)
	if (lb.error) lines.push(`- WARNING: ${lb.error}`)
	lines.push("")

	lines.push("## Included runs")
	lines.push("")
	if (!lb.runs.length) {
		lines.push("No runs were included.")
	} else {
		lines.push(
			table(
				["run", "tasks", "trials", "partial", "notes"],
				lb.runs.map(r => [
					inline(r.name),
					String(r.tasks),
					String(r.trials),
					r.partial ? "yes" : "no",
					inline(r.partial ? (r.partial_reasons.join("; ") || "flagged incomplete") : "")
				])
			)
		)
	}
	lines.push("")

	lines.push("## Excluded runs")
	lines.push("")
	if (!lb.excluded_runs.length) {
		lines.push("None.")
	} else {
		lines.push(table(["run", "reason"], lb.excluded_runs.map(r => [inline(r.name), inline(r.reason)])))
	}
	lines.push("")

	const provisionalNote = rows => {
		if (rows.some(r => r.provisional)) {
			lines.push("† provisional: fewer than 3 scored trials per task.")
			lines.push("")
		}
	}
	const efficiencyTable = rows => {
		lines.push(table(["harness", "model", ...EFFICIENCY_HEADERS], rows.map(s => [harnessCell(s), inline(s.model), ...efficiencyCells(s)])))
		lines.push("")
	}

	lines.push("## Leaderboard")
	lines.push("")
	lines.push("Ranked by pass rate. Groups covering different task sets are NOT comparable - see the common-subset table below.")
	lines.push("")
	lines.push(table(HEADERS, lb.groups.map(cells)))
	lines.push("")
	provisionalNote(lb.groups)
	if (!lb.has_reference) {
		lines.push(`No \`${lb.reference_harness}\` harness has been run, so \`lift vs reference\` cannot be computed: a resolve rate on its own confounds the harness with the model. Run the reference harness on the same model and tasks to get the zero point.`)
		lines.push("")
	}

	lines.push("## Harness efficiency")
	lines.push("")
	lines.push("How each harness spent its budget, from its own transcript. `cost/resolve` is total cost over resolved trials among trials that report a cost; `reads/trial` counts read-tool calls; `reread ratio` is reads of a file already read over all reads; `ctx growth` is the last turn's prompt over the first turn's. `lookup rate` is the share of audited trials that fetched the upstream answer (filed as answer_lookup failures); `ext. network/trial` counts non-fatal external network calls. Outcome-blind and n/a where the transcript carries no per-tool detail or no audit.")
	lines.push("")
	efficiencyTable(lb.groups)

	if (lb.groups.length > 1 && !lb.comparable) {
		const missing = lb.groups
			.map(g => {
				const others = new Set()
				for (const other of lb.groups) if (other !== g) for (const k of other.task_keys) if (!g.task_keys.has(k)) others.add(k)
				return {group: `${g.harness}/${g.model}`, keys: [...others].sort()}
			})
			.filter(m => m.keys.length > 0)
			.map(m => {
				const shown = m.keys.slice(0, 5).map(labelTask).join(", ")
				const extra = m.keys.length > 5 ? ` (+${m.keys.length - 5} more)` : ""
				return `${m.group} is missing ${m.keys.length} task(s) the others cover: ${shown}${extra}`
			})
		lines.push("## Comparability warning")
		lines.push("")
		lines.push("The groups below do not cover the same tasks, so the ranking above mixes populations:")
		lines.push("")
		for (const m of missing) lines.push(`- ${inline(m)}`)
		lines.push("")
	}

	if (!lb.comparable && lb.common_task_count > 0) {
		lines.push(`## Common task set (${lb.common_task_count} task(s) covered by every group)`)
		lines.push("")
		lines.push("This is the only apples-to-apples comparison.")
		lines.push("")
		lines.push(table(HEADERS, lb.common_groups.map(cells)))
		lines.push("")
		provisionalNote(lb.common_groups)
		lines.push("Efficiency on the common task set:")
		lines.push("")
		efficiencyTable(lb.common_groups)
	} else if (!lb.comparable) {
		lines.push("## Common task set")
		lines.push("")
		lines.push("Empty: the groups share no tasks, so no comparison between them is meaningful.")
		lines.push("")
	}

	const partialGroups = lb.groups.filter(g => g.partial_runs.length)
	if (partialGroups.length) {
		lines.push("## Partial runs")
		lines.push("")
		for (const g of partialGroups) lines.push(`- ${inline(`${g.harness}/${g.model}`)} includes partial run(s): ${g.partial_runs.join(", ")}`)
		lines.push("")
	}

	lines.push("## Notes")
	lines.push("")
	lines.push("- `tasks` counts DISTINCT (repo, sha) across every contributing run; `trials` counts result lines. A task run in several runs is counted once.")
	lines.push("- Costs, telemetry and sample sizes follow report.mjs: unreported telemetry is `n/a`, never 0, and a `~`-prefixed `est` cost is an estimate from the checked-in price table. Reported and estimated costs are never averaged together.")
	lines.push("- Groups covering different task sets are not comparable; use the common-subset table.")
	lines.push("- `95% CI` is a Wilson score interval on the scored rate. `lift vs reference` is the paired per-task resolve-rate delta against the `reference` harness on the SAME model, over the tasks both scored (paired n); a harness on a model with no reference run shows `no reference`.")
	lines.push("- `†` marks a provisional group: fewer than 3 scored trials per task on average, too few to separate the harness from run-to-run variance.")
	lines.push("- `lookup rate` (efficiency table) is the share of audited scored trials in which the harness fetched the upstream answer; such trials are filed as `answer_lookup` (shown in the failure-mode column) and count as failures, never as infra. Rows whose lines predate the audit show n/a.")
	lines.push("")
	return lines.join("\n")
}

// ---------------------------------------------------------------- cli

function main(argv) {
	const json = argv.includes("--json")
	const value = flag => {
		const i = argv.indexOf(flag)
		return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
	}
	const runsDir = path.resolve(value("--runs") || RUNS_DIR)
	const out = path.resolve(value("--out") || "leaderboard.md")
	const pv = value("--prompt-version")
	const promptVersion = pv === null ? null : Number.parseInt(pv, 10)
	if (pv !== null && (!Number.isInteger(promptVersion) || promptVersion <= 0)) {
		console.error("leaderboard: --prompt-version must be a positive integer")
		return 1
	}

	const lb = buildLeaderboard(runsDir, {promptVersion})
	if (lb.error) {
		console.error(`leaderboard: ${lb.error}`)
		return 1
	}
	fs.writeFileSync(out, renderLeaderboard(lb))
	if (json) {
		process.stdout.write(`${JSON.stringify(lb, (k, v) => (v instanceof Set ? [...v] : v), 2)}\n`)
	} else {
		process.stdout.write(`wrote ${out}\n`)
	}
	return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exit(main(process.argv.slice(2)))
}
