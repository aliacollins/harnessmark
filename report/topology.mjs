#!/usr/bin/env node
// Harness topology report: who the harness DELEGATES to, and how much.
//
// A pass rate cannot distinguish a harness that solves a task directly from one
// that fans out to nine review sub-agents and lands on the same answer. This
// reads the transcripts the runner already stored and reports that structure, so
// two harnesses on the SAME model can be compared on how they work, not only on
// whether they succeeded.
//
// Trials a provider refused are excluded, exactly as in the rate: a refused
// request produces no tool calls, and averaging those zeroes in would make every
// harness look like it does less work than it does.
//
// The MEASUREMENT is outcome-blind -- nothing here conditions a count on whether
// a trial succeeded, so topology can never smuggle in a pass/fail signal. The
// per-trial table does print `resolved` beside the counts, solely so a reader can
// see whether delegation correlated with the outcome.
import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {RUNS_DIR} from "../harness/registry.mjs"
import {aggregateTopology} from "../harness/topology.mjs"
import {classifiedFailure, harnessOf, isInfraFailure, modelOf, resolveRunDir, topologyOf} from "./report.mjs"

export const TOPOLOGY_SCHEMA = "harness-benchmark/topology@1"

const isNum = v => typeof v === "number" && Number.isFinite(v)

function readResults(runDir) {
	const file = path.join(runDir, "results.jsonl")
	if (!fs.existsSync(file)) return []
	const out = []
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const s = line.trim()
		if (!s) continue
		try {
			out.push(JSON.parse(s))
		} catch {}
	}
	return out
}

// topologyOf lives in report.mjs so the rate report, the leaderboard and this
// view derive the same record from the same row.

export function buildTopologyReport(runDirs) {
	const perHarness = new Map()
	const runs = []
	for (const runDir of runDirs) {
		let id = path.basename(runDir)
		for (const row of readResults(runDir)) {
			// Same extraction as the rate report, so the two views cannot disagree
			// about what counts as the same harness.
			const harness = harnessOf(row)
			const model = modelOf(row)
			const key = `${harness}\u0001${model}`
			if (!perHarness.has(key)) {
				perHarness.set(key, {harness, model, scored: [], excluded: 0, unavailable: 0, trials: []})
			}
			const g = perHarness.get(key)
			// Reclassify on read exactly as the rate does: rows recorded before
			// provider_error existed are still filed as "unknown", and those trials
			// produced no tool calls, so counting them would halve every mean below.
			const infra = isInfraFailure({failure_mode: classifiedFailure(row), resolved: row.resolved === true})
			if (infra) {
				g.excluded++
				continue
			}
			const t = topologyOf(row)
			if (!t) {
				g.unavailable++
				continue
			}
			g.scored.push(t)
			g.trials.push({
				run: id,
				sha: typeof row.sha === "string" ? row.sha.slice(0, 10) : null,
				trial: isNum(row.trial) ? row.trial : 0,
				resolved: row.resolved === true,
				tool_calls: t.total_tool_calls,
				subagent_calls: t.subagents.calls,
				by_agent: t.subagents.by_agent,
				retries: t.retries,
				reads: t.reads ? t.reads.calls : null,
				rereads: t.reads ? t.reads.rereads : null,
				via_bash: t.reads ? t.reads.via_bash : null,
				result_chars: t.tool_result_chars,
				ctx_first: t.context ? t.context.input_first : null,
				ctx_last: t.context ? t.context.input_last : null
			})
		}
		runs.push({id, dir: runDir})
	}
	const groups = [...perHarness.values()].map(g => ({...g, aggregate: aggregateTopology(g.scored)}))
	groups.sort((a, b) => `${a.harness}/${a.model}`.localeCompare(`${b.harness}/${b.model}`))
	return {schema: TOPOLOGY_SCHEMA, generated_at: new Date().toISOString(), runs, groups}
}

const inline = s => String(s == null ? "" : s).replace(/\n/g, " ").replace(/\|/g, "\\|")
const row = cells => `| ${cells.join(" | ")} |`
const table = (headers, rows) => [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n")

function agentMix(byAgent) {
	const parts = Object.entries(byAgent || {}).sort((a, b) => b[1] - a[1])
	if (!parts.length) return "none"
	return parts.map(([k, v]) => `${k}:${v}`).join(", ")
}

function fmt(n, digits = 2) {
	return isNum(n) ? n.toFixed(digits) : "n/a"
}

const fmtInt = n => (isNum(n) ? Math.round(n).toLocaleString("en-US") : "n/a")

export function renderTopology(report) {
	const lines = []
	lines.push("# Harness topology")
	lines.push("")
	lines.push(`- Generated: ${report.generated_at}`)
	lines.push(`- Runs: ${report.runs.map(r => r.id).join(", ") || "none"}`)
	lines.push("")
	lines.push("Delegation structure per harness, derived from the stored transcripts. Trials the")
	lines.push("provider refused are excluded (they produce no tool calls).")
	lines.push("")
	lines.push(
		table(
			["harness", "model", "trials", "excluded", "unavailable", "mean tool calls", "sub-agent calls", "distinct agents", "agent mix", "delegation ratio", "retries", "reads/trial", "reread ratio", "bash dumps/trial", "result chars/trial", "ctx growth", "cache-read ratio"],
			report.groups.map(g => {
				const a = g.aggregate
				return [
					inline(g.harness),
					inline(g.model ?? "n/a"),
					String(a ? a.trials : 0),
					String(g.excluded),
					String(g.unavailable),
					a ? fmt(a.mean_tool_calls) : "n/a",
					a ? fmt(a.subagents.mean_calls) : "n/a",
					a ? String(a.subagents.distinct) : "n/a",
					a ? inline(agentMix(a.subagents.by_agent)) : "n/a",
					a ? fmt(a.delegation_ratio) : "n/a",
					a ? String(a.retries) : "n/a",
					a && a.reads ? fmt(a.reads.mean_calls) : "n/a",
					a && a.reads ? fmt(a.reads.reread_ratio) : "n/a",
					a && a.reads ? fmt(a.reads.mean_via_bash) : "n/a",
					a ? fmtInt(a.mean_tool_result_chars) : "n/a",
					a && a.context ? fmt(a.context.growth) : "n/a",
					a && a.context ? fmt(a.context.cache_read_ratio) : "n/a"
				]
			})
		)
	)
	lines.push("")
	for (const g of report.groups) {
		if (!g.trials.length) continue
		lines.push(`## ${inline(g.harness)} / ${inline(g.model ?? "n/a")}`)
		lines.push("")
		lines.push(
			table(
				["run", "sha", "trial", "resolved", "tool calls", "sub-agent calls", "agents", "retries", "reads", "rereads", "bash dumps", "result chars", "ctx first", "ctx last"],
				g.trials.map(t => [
					inline(t.run),
					inline(t.sha),
					String(t.trial),
					t.resolved ? "yes" : "no",
					String(t.tool_calls),
					String(t.subagent_calls),
					inline(agentMix(t.by_agent)),
					String(t.retries),
					fmtInt(t.reads),
					fmtInt(t.rereads),
					fmtInt(t.via_bash),
					fmtInt(t.result_chars),
					fmtInt(t.ctx_first),
					fmtInt(t.ctx_last)
				])
			)
		)
		lines.push("")
	}
	lines.push("## Notes")
	lines.push("")
	lines.push("- Sub-agent calls are counted from the harness's own transcript. A harness with no sub-agent tool reports 0, which is a measurement, not missing data.")
	lines.push("- `delegation ratio` = sub-agent calls / total tool calls.")
	lines.push("- `retries` counts automatic retries after a provider refusal: a harness that retries recovers on its own where one that does not surfaces a failure.")
	lines.push("- `unavailable` counts trials whose transcript format carries no per-tool detail (claude's single-JSON output); those are reported as n/a rather than zero.")
	lines.push("- `reads` counts read-tool calls and `rereads` those whose file had already been read in the same trial; `bash dumps` counts shell commands that print a file (cat, head, tail, sed -n) and is kept separate. `result chars` is every character of tool output the model saw. `ctx first/last` is the prompt size (fresh input + cache read) of the first and last turn; `ctx growth` is their ratio, aggregated as a ratio of sums.")
	lines.push("")
	return lines.join("\n")
}

function main(argv) {
	const json = argv.includes("--json")
	const targets = argv.filter(a => !a.startsWith("--"))
	let runDirs
	if (targets.length) {
		runDirs = []
		for (const t of targets) {
			try {
				runDirs.push(resolveRunDir(t))
			} catch (e) {
				console.error(`topology: ${e.message}`)
				return 1
			}
		}
	} else {
		runDirs = fs
			.existsSync(RUNS_DIR)
			? fs
					.readdirSync(RUNS_DIR, {withFileTypes: true})
					.filter(d => d.isDirectory() && !d.name.startsWith("_"))
					.map(d => path.join(RUNS_DIR, d.name))
					.filter(d => fs.existsSync(path.join(d, "results.jsonl")))
					.sort()
			: []
	}
	const report = buildTopologyReport(runDirs)
	if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	else process.stdout.write(`${renderTopology(report)}\n`)
	return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exit(main(process.argv.slice(2)))
}
