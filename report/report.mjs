#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {DATASET_DIR, INFRA_FAILURE_MODES, PROVIDER_ERROR_RE, RUNS_DIR, TELEMETRY_FIELDS} from "../harness/registry.mjs"
import {estimateCost, PRICES_AS_OF, PRICES_SOURCE} from "../harness/prices.mjs"
import {aggregateTopology, mergeTopology, normalizeTopology, topologyFromTranscript} from "../harness/topology.mjs"

export const REPORT_SCHEMA = "harness-benchmark/report@1"

const isNum = v => typeof v === "number" && Number.isFinite(v)
const stringOr = v => (typeof v === "string" && v ? v : null)

// Identity of a task across runs. Shared so the per-run report and the
// cross-run leaderboard can never disagree about what "the same task" means.
export const TASK_KEY_SEP = "\u0001"
export const taskKey = e => `${e.repo}${TASK_KEY_SEP}${e.sha == null ? "" : e.sha}`

// ---------------------------------------------------------------- discovery

export function resolveRunDir(target, {runsDir = RUNS_DIR} = {}) {
	if (!target) throw new Error("no run id or path given")
	const direct = path.resolve(target)
	if (fs.existsSync(direct)) return fs.statSync(direct).isFile() ? path.dirname(direct) : direct
	const inRuns = path.join(runsDir, target)
	if (fs.existsSync(inRuns)) return inRuns
	throw new Error(`run not found: ${target} (looked at ${direct} and ${inRuns})`)
}

export function loadManifest(runDir) {
	const file = path.join(runDir, "manifest.json")
	try {
		return {manifest: JSON.parse(fs.readFileSync(file, "utf8")), error: null}
	} catch (e) {
		if (e && e.code === "ENOENT") return {manifest: null, error: "manifest.json missing"}
		return {manifest: null, error: `manifest.json unreadable: ${e.message}`}
	}
}

export function loadResults(runDir) {
	const file = path.join(runDir, "results.jsonl")
	const out = {results: [], malformed: [], missing: false}
	let text
	try {
		text = fs.readFileSync(file, "utf8")
	} catch {
		out.missing = true
		return out
	}
	text.split("\n").forEach((line, i) => {
		const t = line.trim()
		if (!t) return
		try {
			out.results.push(JSON.parse(t))
		} catch (e) {
			out.malformed.push({line: i + 1, error: e.message})
		}
	})
	return out
}

// ---------------------------------------------------------------- task join

function makeTaskIndex(datasetDir) {
	const cache = new Map()
	return function lookup(repo, sha) {
		if (!repo || !sha || repo === "n/a") return null
		let idx = cache.get(repo)
		if (idx === undefined) {
			idx = null
			try {
				const text = fs.readFileSync(path.join(datasetDir, repo, "tasks.jsonl"), "utf8")
				idx = new Map()
				for (const line of text.split("\n")) {
					const t = line.trim()
					if (!t) continue
					const o = JSON.parse(t)
					if (o && o.sha) idx.set(o.sha, o)
				}
			} catch {
				idx = null
			}
			cache.set(repo, idx)
		}
		return idx ? idx.get(sha) || null : null
	}
}

// ---------------------------------------------------------------- extraction

function telemetryOf(r) {
	const top = r && typeof r.telemetry === "object" && r.telemetry ? r.telemetry : null
	const nested = r && r.adapter_run && typeof r.adapter_run.telemetry === "object" ? r.adapter_run.telemetry : null
	const src = top || nested || {}
	const out = {}
	for (const f of TELEMETRY_FIELDS) out[f] = isNum(src[f]) ? src[f] : null
	return out
}

function turnsOf(r) {
	const cands = [r && r.turns, r && r.adapter_run && r.adapter_run.turns, r && r.telemetry && r.telemetry.turns]
	for (const v of cands) if (isNum(v)) return v
	const notes = r && r.adapter_run && r.adapter_run.notes
	if (typeof notes === "string") {
		const m = notes.match(/\bturns=(\d+)\b/)
		if (m) return Number(m[1])
	}
	return null
}

// A harness that reports no cost still has a knowable one when its model is in
// the price table, so legacy rows gain a cost without re-running any agent.
// Reported and estimated values are kept apart: they are never averaged.
function costOf(r) {
	const tel = telemetryOf(r)
	const reported = isNum(tel.cost_usd) ? tel.cost_usd : null
	if (reported != null) return {usd: reported, source: "reported"}
	if (r && r.cost && isNum(r.cost.usd)) return {usd: r.cost.usd, source: stringOr(r.cost.source) || "estimated"}
	const est = estimateCost({model: modelOf(r), telemetry: tel})
	if (est && isNum(est.usd)) return {usd: est.usd, source: "estimated"}
	return null
}

function wallOf(r) {
	const cands = [r && r.adapter_run && r.adapter_run.wall_ms, r && r.wall_ms]
	for (const v of cands) if (isNum(v)) return v
	return null
}

export function harnessOf(r) {
	const h = (r && r.adapter_run && r.adapter_run.harness) || (r && r.adapter) || (r && r.harness)
	return stringOr(h) || "n/a"
}

export function modelOf(r) {
	const m = r ? (r.model ?? (r.adapter_run && r.adapter_run.model)) : null
	return stringOr(m) || "n/a"
}

function failureOf(r) {
	const f = r ? ((r.adapter_run && r.adapter_run.failure_mode) ?? r.failure_mode) : null
	return stringOr(f)
}

// A result line may already carry topology (adapters write it going forward);
// otherwise it is derived from the stored transcript, which covers every run
// recorded before the field existed. A recorded record that predates the
// efficiency fields (reads, result chars, context) is completed from the
// transcript without disturbing the counts the adapter recorded.
export function topologyOf(row) {
	const recorded = row && row.adapter_run && row.adapter_run.topology
	const normalizedRecorded = recorded && typeof recorded === "object" ? normalizeTopology(recorded) : null
	const needsTranscript = !normalizedRecorded || normalizedRecorded.reads == null || normalizedRecorded.context == null
	let derived = null
	if (needsTranscript) {
		const p = row && row.adapter_run && row.adapter_run.transcript_path
		if (typeof p === "string" && p && fs.existsSync(p)) {
			try {
				derived = topologyFromTranscript(fs.readFileSync(p, "utf8"), {adapter: stringOr(row.adapter) || harnessOf(row)})
			} catch {
				derived = null
			}
		}
	}
	return mergeTopology(normalizedRecorded, derived)
}

// Chain identity, written by the runner in --chain mode: chain_id, chain_step
// (1-based ordinal), chain_length, chain_resolved (every step of the chain
// resolved). Flat runs carry none of these.
function chainOf(r) {
	const id = stringOr(r && r.chain_id)
	if (!id) return null
	return {
		id,
		step: isNum(r.chain_step) ? r.chain_step : null,
		length: isNum(r.chain_length) ? r.chain_length : null,
		resolved: r.chain_resolved === true
	}
}

// Answer-lookup audit, written by the runner from the commands the harness
// executed. Absent on lines recorded before the audit existed: that is "not
// audited" and must render n/a, never as clean. A fatal finding means the
// harness fetched the upstream fix (or could have) and the runner re-filed the
// line as reason "answer_lookup" with the evaluator's own verdict kept under
// `graded`. Lookup trials are FAILURES, not infra: reaching for the answer is
// the harness's choice, so they stay in the denominator.
export function leakOf(r) {
	const l = r && r.leak
	if (!l || typeof l !== "object") return null
	const findings = Array.isArray(l.findings) ? l.findings.filter(f => f && typeof f === "object") : []
	const counts = l.counts && typeof l.counts === "object" ? l.counts : {}
	const fatal = l.clean === false || findings.some(f => f.fatal === true)
	return {
		clean: !fatal,
		fatal,
		findings: findings.map(f => ({
			kind: stringOr(f.kind) || "unknown",
			fatal: f.fatal === true,
			tool: stringOr(f.tool) || null,
			command: typeof f.command === "string" ? f.command : null,
			via_subagent: f.via_subagent === true
		})),
		counts: {
			upstream_lookup: isNum(counts.upstream_lookup) ? counts.upstream_lookup : findings.filter(f => f.kind === "upstream_lookup").length,
			external_network: isNum(counts.external_network) ? counts.external_network : findings.filter(f => f.kind === "external_network").length,
			web_tool: isNum(counts.web_tool) ? counts.web_tool : findings.filter(f => f.kind === "web_tool").length
		}
	}
}

export function gradedOf(r) {
	const g = r && r.graded
	if (!g || typeof g !== "object") return null
	return {resolved: g.resolved === true, reason: stringOr(g.reason) || "n/a"}
}

// Only harness-level error channels may be consulted. claude records the agent's
// own final message as `result=` and codex records stdout as `output tail:`, and
// an agent failing on an HTTP task prints status codes that must not be mistaken
// for the provider refusing to serve.
function providerEvidence(r) {
	const ar = (r && r.adapter_run) || {}
	const segments = []
	for (const raw of [ar.notes, ar.error, r && r.error]) {
		if (typeof raw !== "string") continue
		for (const part of raw.split("; ")) {
			const text = part.trim()
			if (/^(error=|agent error:)/.test(text)) segments.push(text)
		}
	}
	return segments
}

// Runs recorded before provider_error existed filed a refusal as "unknown",
// indistinguishable from the agent genuinely failing. The raw notes are stored
// unchanged and still carry the signature, so reclassify on read rather than
// re-running: only the adapter's own "could not tell" fallback is reinterpreted,
// never a mode an adapter set deliberately.
export function classifiedFailure(r) {
	const mode = failureOf(r)
	if (mode !== "unknown") return mode
	for (const text of providerEvidence(r)) {
		if (PROVIDER_ERROR_RE.test(text)) return "provider_error"
	}
	return mode
}

function ratioOf(obj, explicit) {
	const passed = obj && isNum(obj.passed) ? obj.passed : null
	const required = obj && isNum(obj.required) ? obj.required : null
	let ratio = null
	if (isNum(explicit)) ratio = explicit
	else if (passed != null && required != null && required > 0) ratio = passed / required
	return {passed, required, ratio}
}

function normalizeTask(r, lookup) {
	const repo = stringOr(r && r.repo) || "n/a"
	const sha = stringOr(r && r.sha)
	const task = lookup(repo, sha)
	const partial = r && typeof r.partial === "object" && r.partial ? r.partial : {}
	return {
		repo,
		sha,
		trial: isNum(r && r.trial) ? r.trial : 0,
		trials: isNum(r && r.trials) ? r.trials : 1,
		category: task && typeof task.category === "string" && task.category ? task.category : "n/a",
		harness: harnessOf(r),
		adapter: stringOr(r && r.adapter) || harnessOf(r),
		model: modelOf(r),
		resolved: !!(r && r.resolved === true),
		reason: stringOr(r && r.reason) || "n/a",
		failure_mode: classifiedFailure(r),
		telemetry: telemetryOf(r),
		cost: costOf(r),
		turns: turnsOf(r),
		wall_ms: wallOf(r),
		f2p: ratioOf(r && r.f2p, partial.f2p_ratio),
		p2p: ratioOf(r && r.p2p, partial.p2p_ratio),
		topology: topologyOf(r),
		chain: chainOf(r),
		leak: leakOf(r),
		graded: gradedOf(r)
	}
}

// ---------------------------------------------------------------- statistics

export function meanStat(values) {
	const present = values.filter(isNum)
	const total = values.length
	if (!present.length) return {mean: null, n: 0, total}
	return {mean: present.reduce((a, b) => a + b, 0) / present.length, n: present.length, total}
}

// Wilson score interval: the rate's 95% confidence interval, which unlike the
// normal approximation stays inside [0, 1] and does not collapse to a point at
// 0/N or N/N. A rate is meaningless without it at the sample sizes runs have.
export function wilson(k, n, z = 1.959963984540054) {
	if (!isNum(k) || !isNum(n) || n <= 0) return null
	const p = k / n
	const z2 = z * z
	const denom = 1 + z2 / n
	const center = (p + z2 / (2 * n)) / denom
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
	// At 0/N and N/N the algebra lands on exactly 0 or 1 up to floating-point
	// residue; pin the bound so a zero never prints as 5e-17.
	return {low: k === 0 ? 0 : Math.max(0, center - half), high: k === n ? 1 : Math.min(1, center + half), n}
}

// Cost (or tokens) per resolved task: total spend over the trials that report a
// figure, divided by how many of THOSE trials resolved. Reported and estimated
// costs are never mixed: a group whose costs come from both sources gets null
// with the reason stated, rather than a number that means nothing.
export function perResolve(entries, valueOf) {
	const priced = entries.filter(e => valueOf(e) != null)
	if (!priced.length) return {value: null, total: 0, resolved: 0, n: 0, of: entries.length, note: "no data"}
	const total = priced.reduce((a, e) => a + valueOf(e), 0)
	const resolved = priced.filter(e => e.resolved).length
	return {
		value: resolved ? total / resolved : null,
		total,
		resolved,
		n: priced.length,
		of: entries.length,
		note: resolved ? null : "nothing resolved"
	}
}

function costPerResolve(scored) {
	const sources = new Set(scored.filter(e => e.cost).map(e => e.cost.source))
	if (sources.size > 1) return {value: null, source: "mixed", n: 0, of: scored.length, resolved: 0, total: 0, note: "reported and estimated costs are never combined"}
	const source = sources.size ? [...sources][0] : null
	return {...perResolve(scored, e => (e.cost ? e.cost.usd : null)), source}
}

// A trial the provider refused to serve says nothing about the harness, so it is
// excluded from every rate. A run that hit a provider error but still resolved
// IS a valid measurement and stays in: the exclusion applies only when the run
// also failed, otherwise dropping it would inflate the rate.
export const isInfraFailure = e => INFRA_FAILURE_MODES.includes(e.failure_mode) && !e.resolved

export function summarize(entries) {
	const scored = entries.filter(e => !isInfraFailure(e))
	const infra_failures = entries.length - scored.length
	const resolved = entries.filter(e => e.resolved).length
	// Task-level outcomes are computed over SCORED trials only, so a task whose
	// every trial was refused by the provider is neither a pass nor a failure.
	const byTask = new Map()
	for (const e of scored) {
		const key = taskKey(e)
		if (!byTask.has(key)) byTask.set(key, [])
		byTask.get(key).push(e)
	}
	let resolved_tasks_all = 0
	let resolved_tasks_any = 0
	for (const rows of byTask.values()) {
		if (rows.some(e => e.resolved)) resolved_tasks_any++
		if (rows.every(e => e.resolved)) resolved_tasks_all++
	}
	const allTaskKeys = new Set(entries.map(taskKey))
	const means = {}
	// Means use the SCORED trials, matching the rate's population: a refused
	// request fails in ~0ms with ~0 tokens, so mixing it in would drag the mean
	// wall-time and token means toward zero.
	for (const f of TELEMETRY_FIELDS) means[f] = meanStat(scored.map(e => e.telemetry[f]))
	means.wall_ms = meanStat(scored.map(e => e.wall_ms))
	means.turns = meanStat(scored.map(e => e.turns))
	const cost = {
		reported: meanStat(scored.map(e => e.cost && e.cost.source === "reported" ? e.cost.usd : null)),
		estimated: meanStat(scored.map(e => e.cost && e.cost.source === "estimated" ? e.cost.usd : null))
	}
	const failure_modes = {}
	for (const e of entries) {
		const k = e.failure_mode || "n/a"
		failure_modes[k] = (failure_modes[k] || 0) + 1
	}
	// Topology is outcome-blind and aggregated over the same scored population as
	// every other mean; trials with no interpretable transcript are counted as
	// unavailable rather than as a harness that did nothing.
	const topologies = scored.map(e => e.topology)
	const topology = aggregateTopology(topologies)
	const tokensOf = e => (isNum(e.telemetry.input_tokens) && isNum(e.telemetry.output_tokens) ? e.telemetry.input_tokens + e.telemetry.output_tokens : null)
	// Fewer than three trials per task is too few to separate the harness from
	// the dice: a single trial cannot tell a 60% harness from a 90% one.
	const trials_per_task = byTask.size ? scored.length / byTask.size : null
	const lookup = summarizeLookup(scored)
	return {
		lookup,
		tasks: allTaskKeys.size,
		scored_tasks: byTask.size,
		trials: entries.length,
		scored_trials: scored.length,
		infra_failures,
		resolved,
		rate: scored.length ? resolved / scored.length : null,
		rate_ci: wilson(resolved, scored.length),
		resolved_tasks_all,
		resolved_tasks_any,
		cost,
		cost_per_resolve: costPerResolve(scored),
		tokens_per_resolve: perResolve(scored, tokensOf),
		means,
		failure_modes,
		topology,
		topology_unavailable: topologies.filter(t => !t).length,
		trials_per_task,
		provisional: trials_per_task != null && trials_per_task < 3
	}
}

// Answer lookup over the SCORED trials: audited = trials carrying a leak
// record; fatal = trials whose harness fetched the answer (filed as
// answer_lookup failures); rate = fatal / audited, with the audited sample
// stated because older lines were never audited. resolved_before is what the
// evaluator alone would have credited (the graded verdict where present, the
// line's own otherwise) and resolved_after is what stands once lookups are
// invalidated; the gap is how much of the score was looked up rather than
// engineered.
export function summarizeLookup(scored) {
	const audited = scored.filter(e => e.leak)
	const fatalRows = audited.filter(e => e.leak.fatal)
	let nonfatal = 0
	let extNet = 0
	const cmdCount = new Map()
	for (const e of audited) {
		extNet += e.leak.counts && isNum(e.leak.counts.external_network) ? e.leak.counts.external_network : 0
		for (const f of Array.isArray(e.leak.findings) ? e.leak.findings : []) {
			if (!f.fatal) nonfatal++
			if (f.command) {
				const c = f.command.replace(/\s+/g, " ").trim().slice(0, 120)
				cmdCount.set(c, (cmdCount.get(c) || 0) + 1)
			}
		}
	}
	const resolvedBefore = audited.filter(e => (e.graded ? e.graded.resolved : e.resolved)).length
	const resolvedAfter = audited.filter(e => e.resolved).length
	const top_commands = [...cmdCount.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([command, count]) => ({command, count}))
	return {
		audited: audited.length,
		scored: scored.length,
		fatal: fatalRows.length,
		nonfatal_findings: nonfatal,
		rate: audited.length ? fatalRows.length / audited.length : null,
		ext_network_per_trial: audited.length ? extNet / audited.length : null,
		resolved_before: audited.length ? resolvedBefore : null,
		resolved_after: audited.length ? resolvedAfter : null,
		top_commands
	}
}

// ---------------------------------------------------------------- chains

// One row per step of every chain trial, and per (harness, model) the ratio of
// what steps >= 2 cost against step 1. A harness that indexes the repo on first
// contact and serves later reads from that index should show a warm-up ratio
// below 1 on tokens and on tool result chars; one that re-reads raw files will
// not, and the difference is invisible in a flat per-task table.
function chainSteps(entries) {
	return entries.filter(e => e.chain && e.chain.step != null)
}

function warmUp(steps, valueOf) {
	const first = meanStat(steps.filter(s => s.chain.step === 1).map(valueOf))
	const later = meanStat(steps.filter(s => s.chain.step >= 2).map(valueOf))
	return {
		step1: first,
		later,
		ratio: isNum(first.mean) && first.mean > 0 && isNum(later.mean) ? later.mean / first.mean : null
	}
}

export function summarizeChains(entries) {
	const steps = chainSteps(entries)
	if (!steps.length) return []
	const byGroup = new Map()
	for (const e of steps) {
		const key = `${e.harness}\u0001${e.model}`
		if (!byGroup.has(key)) byGroup.set(key, {harness: e.harness, model: e.model, rows: []})
		byGroup.get(key).rows.push(e)
	}
	const out = []
	for (const g of byGroup.values()) {
		const scored = g.rows.filter(e => !isInfraFailure(e))
		const chains = new Map()
		for (const e of g.rows) {
			const ck = `${e.chain.id}\u0001${e.trial}`
			if (!chains.has(ck)) chains.set(ck, {chain_id: e.chain.id, trial: e.trial, length: e.chain.length, chain_resolved: e.chain.resolved, steps: []})
			chains.get(ck).steps.push(e)
		}
		const list = [...chains.values()].sort((a, b) => a.chain_id.localeCompare(b.chain_id) || a.trial - b.trial)
		for (const c of list) {
			c.steps.sort((a, b) => a.chain.step - b.chain.step)
			c.steps = c.steps.map(e => ({
				step: e.chain.step,
				sha: e.sha,
				trial: e.trial,
				resolved: e.resolved,
				reason: e.reason,
				failure_mode: e.failure_mode,
				infra: isInfraFailure(e),
				input_tokens: e.telemetry.input_tokens,
				cache_read_tokens: e.telemetry.cache_read_tokens,
				input_first: e.topology && e.topology.context ? e.topology.context.input_first : null,
				input_last: e.topology && e.topology.context ? e.topology.context.input_last : null,
				reads: e.topology && e.topology.reads ? e.topology.reads.calls : null,
				reread_ratio: e.topology && e.topology.reads ? e.topology.reads.reread_ratio : null,
				tool_result_chars: e.topology ? e.topology.tool_result_chars : null,
				wall_ms: e.wall_ms,
				cost: e.cost
			}))
		}
		const ctxOf = e => (e.topology && e.topology.context ? e.topology.context.input_total : null)
		out.push({
			harness: g.harness,
			model: g.model,
			chains: list,
			steps_scored: scored.length,
			steps_total: g.rows.length,
			warm_up: {
				input_tokens: warmUp(scored, e => e.telemetry.input_tokens),
				prompt_tokens: warmUp(scored, ctxOf),
				tool_result_chars: warmUp(scored, e => (e.topology ? e.topology.tool_result_chars : null)),
				reads: warmUp(scored, e => (e.topology && e.topology.reads ? e.topology.reads.calls : null)),
				wall_ms: warmUp(scored, e => e.wall_ms)
			}
		})
	}
	return out.sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model))
}

function groupAndSummarize(entries, keyFn, make) {
	const m = new Map()
	for (const e of entries) {
		const k = keyFn(e)
		if (!m.has(k)) m.set(k, [])
		m.get(k).push(e)
	}
	return [...m.entries()].map(([k, rows]) => make(k, rows))
}

function firstDefined(obj, keys) {
	for (const k of keys) {
		const v = obj[k]
		if (v !== undefined && v !== null && v !== "") return v
	}
	return null
}

function firstNumber(obj, keys) {
	for (const k of keys) if (isNum(obj[k])) return obj[k]
	return null
}

function runDate(m) {
	const v = firstDefined(m, [
		"date",
		"ended_at",
		"endedAt",
		"end_time",
		"end",
		"finished_at",
		"started_at",
		"startedAt",
		"start_time",
		"start"
	])
	return typeof v === "string" ? v : null
}

function partialReasons(m, manifestError, distinctCount, malformedCount, missing) {
	const reasons = []
	if (manifestError) reasons.push(manifestError)
	if (missing) reasons.push("results.jsonl missing")
	if (malformedCount) reasons.push(`${malformedCount} malformed result line(s)`)
	if (m) {
		if (m.interrupted === true) reasons.push("manifest.interrupted=true")
		const status = String(m.status ?? m.state ?? "").toLowerCase()
		if (status && /interrupt|partial|abort|running|fail|error/.test(status)) reasons.push(`manifest.status=${m.status}`)
		const started = firstDefined(m, ["started_at", "startedAt", "start_time", "start"])
		const ended = firstDefined(m, ["ended_at", "endedAt", "end_time", "end", "finished_at"])
		if (started && !ended) reasons.push("manifest records a start but no end")
		const expected = firstNumber(m, ["expected", "expected_results", "task_count", "total_tasks", "planned", "planned_tasks"])
		if (isNum(expected) && distinctCount < expected) reasons.push(`only ${distinctCount}/${expected} results present`)
		if (m.stopped && typeof m.stopped === "object") reasons.push(`manifest.stopped=${m.stopped.reason || "unknown"}`)
		// Real runner manifest: tasks[] (already limit-sliced) x adapter[] must all report an item.
		if (m.mode !== "baseline-only") {
			const taskList = Array.isArray(m.tasks) ? m.tasks.length : null
			const adapterList = Array.isArray(m.adapter)
				? m.adapter.length
				: m.config && Array.isArray(m.config.adapter)
					? m.config.adapter.length
					: null
			// Count DISTINCT (sha, adapter) pairs, not result lines: with --trials
			// one (task, adapter) emits N lines, so a line count would hide a
			// truncated run that is missing whole task/adapter items.
			if (taskList != null && adapterList != null && adapterList > 0) {
				const planned = taskList * adapterList
				if (distinctCount < planned) reasons.push(`only ${distinctCount}/${planned} adapter results present`)
			}
		}
	}
	return reasons
}

// ---------------------------------------------------------------- report build

export function buildReport(runDir, opts = {}) {
	const dir = path.resolve(runDir)
	const datasetDir = opts.datasetDir || DATASET_DIR
	const {manifest, error: manifestError} = loadManifest(dir)
	const {results, malformed, missing} = loadResults(dir)
	const lookup = makeTaskIndex(datasetDir)
	const entries = results.map(r => normalizeTask(r, lookup))

	const groups = groupAndSummarize(entries, e => `${e.harness}\u0001${e.model}`, (k, rows) => ({
		harness: rows[0].harness,
		model: rows[0].model,
		...summarize(rows)
	})).sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model))

	const categories = groupAndSummarize(entries, e => e.category, (k, rows) => ({
		category: k,
		...summarize(rows)
	})).sort((a, b) => a.category.localeCompare(b.category))

	const repos = groupAndSummarize(entries, e => e.repo, (k, rows) => ({
		repo: k,
		...summarize(rows)
	})).sort((a, b) => a.repo.localeCompare(b.repo))

	const chains = summarizeChains(entries)

	const adapterPairs = new Set(entries.map(e => `${e.sha == null ? "" : e.sha}\u0001${e.adapter}`)).size
	const reasons = partialReasons(manifest, manifestError, adapterPairs, malformed.length, missing)
	const partial = reasons.length > 0
	const m = manifest || {}

	return {
		schema: REPORT_SCHEMA,
		run: {
			id: stringOr(m.id || m.run_id || m.runId) || path.basename(dir),
			dir,
			date: runDate(m),
			config: m.config !== undefined ? m.config : null,
			partial,
			status: partial ? "partial" : "complete",
			partial_reasons: reasons,
			results: results.length,
			malformed_lines: malformed.length,
			failure_modes: summarize(entries).failure_modes
		},
		honesty: {
			note: "Telemetry the harness did not report is null and renders as n/a, never 0. A mean uses only tasks where the value exists and always prints n=x/y. `tasks` counts distinct (repo, sha); `trials` counts result lines. A trial whose provider refused to serve it (rate limit, quota, 5xx, dropped connection) is counted in `infra failures` and EXCLUDED from the rate, from every mean and from every per-task figure, because a refused request says nothing about the harness; the rate always prints the sample it used as n=`scored`/`total`. `resolved (per-trial)`/`rate (scored)` are line rates, NOT per-task success rates. `resolved tasks (all trials)` counts tasks that passed every trial and `pass@N (any trial)` counts tasks that passed at least one trial, where N is the per-task trial count recorded for that task and may vary within a group. A cost prefixed with `~` and marked `est` is an ESTIMATE computed from the checked-in price table (as of " + PRICES_AS_OF + ", " + PRICES_SOURCE + "), not a figure the harness reported; reported and estimated costs are never averaged together, and a cell with both shows the reported mean first followed by the estimated one.",
			telemetry_fields: [...TELEMETRY_FIELDS],
			mean_sample_sizes: "x = scored trials with a value, y = scored trials in the group",
			trial_semantics: "resolved/rate are per-trial; resolved tasks all/any are per-task over distinct (repo, sha)",
			lookup: "`lookup rate` is the share of AUDITED scored trials in which the harness fetched the upstream answer (the fix's pull request, diff or post-fix source) during the run. Such a trial is filed as reason `answer_lookup`, counts as a FAILURE in the rate's denominator and is never treated as infra: reaching for the answer is the harness's choice, not the provider's. The evaluator's own verdict is kept as `graded` so the looked-up share of the score is visible. Lines recorded before the audit existed carry no leak record and render n/a, never clean. `ext. network/trial` counts non-fatal external network calls (registries, unrelated hosts) per audited trial.",
			efficiency: "Topology (tool calls, reads, rereads, tool result chars, per-turn prompt size) is derived from the harness's own transcript and is outcome-blind. `reads` counts read-tool calls; `via_bash` counts shell file dumps separately. `ctx growth` is the last turn's prompt (fresh input + cache read) over the first turn's. Records with no interpretable transcript are `n/a`, never 0. `cost/resolve` divides total cost by resolved trials among the trials that report a cost. `†` marks a provisional group with fewer than 3 scored trials per task."
		},
		groups,
		categories,
		repos,
		chains,
		tasks: entries.map(e => ({
			repo: e.repo,
			sha: e.sha,
			trial: e.trial,
			trials: e.trials,
			category: e.category,
			harness: e.harness,
			model: e.model,
			resolved: e.resolved,
			reason: e.reason,
			failure_mode: e.failure_mode,
			telemetry: e.telemetry,
			cost: e.cost,
			wall_ms: e.wall_ms,
			turns: e.turns,
			f2p: e.f2p,
			p2p: e.p2p,
			chain: e.chain,
			// Kept in full (not compacted): the leaderboard re-summarizes these entries.
			leak: e.leak,
			graded: e.graded,
			topology: e.topology
				? {
						total_tool_calls: e.topology.total_tool_calls,
						subagent_calls: e.topology.subagents.calls,
						retries: e.topology.retries,
						reads: e.topology.reads,
						tool_result_chars: e.topology.tool_result_chars,
						context: e.topology.context
					}
				: null
		}))
	}
}

// ---------------------------------------------------------------- rendering

function fmtInt(n) {
	return isNum(n) ? Math.round(n).toLocaleString("en-US") : "n/a"
}

export function fmtRate(rate) {
	return isNum(rate) ? `${(rate * 100).toFixed(1)}%` : "n/a"
}

// Rates are always shown with the sample they were computed over, so a rate that
// silently dropped refused trials cannot be mistaken for one over the full set.
export function fmtRateCell(s) {
	return `${fmtRate(s.rate)} (n=${s.scored_trials}/${s.trials})`
}

export function fmtMean(stat, kind) {
	if (!stat || !isNum(stat.mean)) return `n/a (n=0/${stat ? stat.total : 0})`
	let v
	if (kind === "cost") v = `$${stat.mean.toFixed(4)}`
	else if (kind === "ms") v = Math.round(stat.mean).toLocaleString("en-US")
	else v = stat.mean.toLocaleString("en-US", {maximumFractionDigits: 2})
	return `${v} (n=${stat.n}/${stat.total})`
}

export function fmtCost(s) {
	const rep = s && s.cost ? s.cost.reported : null
	const est = s && s.cost ? s.cost.estimated : null
	const hasRep = rep && isNum(rep.mean)
	const hasEst = est && isNum(est.mean)
	const total = s && isNum(s.trials) ? s.trials : 0
	if (hasRep && hasEst) return `$${rep.mean.toFixed(4)} (n=${rep.n}/${rep.total}) + ~$${est.mean.toFixed(4)} est for ${est.n} row${est.n === 1 ? "" : "s"}`
	if (hasRep) return `$${rep.mean.toFixed(4)} (n=${rep.n}/${rep.total})`
	if (hasEst) return `~$${est.mean.toFixed(4)} (est, n=${est.n}/${est.total})`
	return `n/a (n=0/${total})`
}

export function fmtCi(s) {
	const ci = s && s.rate_ci
	if (!ci) return "n/a"
	return `[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`
}

export function fmtPerResolve(pr, kind) {
	if (!pr) return "n/a"
	if (pr.source === "mixed") return `n/a (${pr.note})`
	if (!isNum(pr.value)) return `n/a (n=${pr.n}/${pr.of}${pr.note ? `, ${pr.note}` : ""})`
	let v
	if (kind === "cost") v = `${pr.source === "estimated" ? "~" : ""}$${pr.value.toFixed(4)}${pr.source === "estimated" ? " est" : ""}`
	else v = Math.round(pr.value).toLocaleString("en-US")
	return `${v} (n=${pr.n}/${pr.of})`
}

export function fmtRatio(v, digits = 2) {
	return isNum(v) ? v.toFixed(digits) : "n/a"
}

// Topology cells always state how many scored trials carried the measurement,
// so a harness whose transcript format hides its tool calls reads as n/a.
export function fmtTopo(s, pick, {digits = 2, int = false} = {}) {
	const t = s && s.topology
	if (!t) return `n/a (n=0/${s ? s.scored_trials : 0})`
	const picked = pick(t)
	if (!picked || !isNum(picked.value)) return `n/a (n=0/${s.scored_trials})`
	const v = int ? Math.round(picked.value).toLocaleString("en-US") : picked.value.toFixed(digits)
	return `${v} (n=${picked.n}/${s.scored_trials})`
}

export const topoReads = t => (t.reads ? {value: t.reads.mean_calls, n: t.reads.trials} : null)
export const topoReread = t => (t.reads ? {value: t.reads.reread_ratio, n: t.reads.trials} : null)
export const topoChars = t => (t.tool_result_chars != null ? {value: t.mean_tool_result_chars, n: t.trials} : null)
export const topoGrowth = t => (t.context ? {value: t.context.growth, n: t.context.trials} : null)
export const topoRetries = t => ({value: t.mean_retries, n: t.trials})
export const topoToolCalls = t => ({value: t.mean_tool_calls, n: t.trials})

export function harnessCell(s) {
	return `${inline(s.harness)}${s.provisional ? " †" : ""}`
}

// `lookup` is optional: when given and any trial was filed as answer_lookup,
// that count is appended so a table of failure modes never hides a looked-up
// answer behind failure_mode "none".
export function fmtFailures(fm, lookup) {
	const parts = Object.entries(fm || {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
	if (lookup && isNum(lookup.fatal) && lookup.fatal > 0) parts.push(`answer_lookup:${lookup.fatal}`)
	return parts.length ? parts.join(", ") : "n/a"
}

export function fmtLookupRate(s) {
	const l = s && s.lookup
	if (!l || !l.audited) return `n/a (n=0/${l ? l.scored : 0} audited)`
	return `${(l.rate * 100).toFixed(1)}% (n=${l.audited}/${l.scored} audited)`
}

export function fmtExtNetwork(s) {
	const l = s && s.lookup
	if (!l || !l.audited || !isNum(l.ext_network_per_trial)) return "n/a"
	return `${l.ext_network_per_trial.toFixed(2)} (n=${l.audited}/${l.scored})`
}

function ratioCell(r) {
	if (!r || r.passed == null || r.required == null) return "n/a"
	return `${r.passed}/${r.required} ${r.ratio != null ? `(${(r.ratio * 100).toFixed(1)}%)` : "(n/a)"}`
}

function inline(s) {
	const text = typeof s === "string" ? s : JSON.stringify(s)
	return String(text).replace(/\n/g, " ").replace(/\|/g, "\\|").replace(/`/g, "'")
}

function row(cells) {
	return `| ${cells.join(" | ")} |`
}

function table(headers, rows) {
	return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n")
}

const SUMMARY_HEADERS = [
	"tasks",
	"trials",
	"infra failures",
	"resolved (per-trial)",
	"rate (scored)",
	"resolved tasks (all trials)",
	"pass@N (any trial)",
	"mean in tokens",
	"mean out tokens",
	"mean cache-read",
	"mean cache-write",
	"mean cost usd",
	"mean wall ms",
	"mean turns",
	"lookup rate",
	"failure modes"
]

export const EFFICIENCY_HEADERS = ["95% CI", "cost/resolve", "tokens/resolve", "tool calls/trial", "reads/trial", "reread ratio", "result chars/trial", "ctx growth", "retries/trial", "lookup rate", "ext. network/trial"]

export function efficiencyCells(s) {
	return [
		fmtCi(s),
		fmtPerResolve(s.cost_per_resolve, "cost"),
		fmtPerResolve(s.tokens_per_resolve),
		fmtTopo(s, topoToolCalls),
		fmtTopo(s, topoReads),
		fmtTopo(s, topoReread),
		fmtTopo(s, topoChars, {int: true}),
		fmtTopo(s, topoGrowth),
		fmtTopo(s, topoRetries),
		fmtLookupRate(s),
		fmtExtNetwork(s)
	]
}

function summaryCells(s) {
	return [
		String(s.tasks),
		String(s.trials),
		String(s.infra_failures),
		String(s.resolved),
		fmtRateCell(s),
		String(s.resolved_tasks_all),
		String(s.resolved_tasks_any),
		fmtMean(s.means.input_tokens),
		fmtMean(s.means.output_tokens),
		fmtMean(s.means.cache_read_tokens),
		fmtMean(s.means.cache_write_tokens),
		fmtCost(s),
		fmtMean(s.means.wall_ms, "ms"),
		fmtMean(s.means.turns),
		fmtLookupRate(s),
		fmtFailures(s.failure_modes, s.lookup)
	]
}

function fmtStepCost(c) {
	if (!c || !isNum(c.usd)) return "n/a"
	return `${c.source === "estimated" ? "~" : ""}$${c.usd.toFixed(4)}`
}

function fmtWarm(w) {
	if (!w) return "n/a"
	const s1 = isNum(w.step1.mean) ? Math.round(w.step1.mean).toLocaleString("en-US") : "n/a"
	const later = isNum(w.later.mean) ? Math.round(w.later.mean).toLocaleString("en-US") : "n/a"
	return `${s1} -> ${later} (x${fmtRatio(w.ratio)}, n=${w.step1.n}+${w.later.n})`
}

export function renderChains(chains) {
	const lines = []
	lines.push("## Long-horizon chains")
	lines.push("")
	lines.push("Each chain is one session: step k+1 starts from the sandbox step k left behind. `warm-up` compares the mean of steps >= 2 against step 1 over scored steps; a harness that indexes the repo on first contact should show a ratio below 1 on reads and result chars, and flatter prompt growth. `input_first`/`input_last` are the first and last turn's prompt size (fresh input + cache read) within that step.")
	lines.push("")
	lines.push(
		table(
			["harness", "model", "chains", "steps (scored/total)", "warm-up: in tokens", "warm-up: prompt tokens", "warm-up: result chars", "warm-up: reads", "warm-up: wall ms"],
			chains.map(g => [
				inline(g.harness),
				inline(g.model),
				String(g.chains.length),
				`${g.steps_scored}/${g.steps_total}`,
				fmtWarm(g.warm_up.input_tokens),
				fmtWarm(g.warm_up.prompt_tokens),
				fmtWarm(g.warm_up.tool_result_chars),
				fmtWarm(g.warm_up.reads),
				fmtWarm(g.warm_up.wall_ms)
			])
		)
	)
	lines.push("")
	for (const g of chains) {
		for (const c of g.chains) {
			lines.push(`### ${inline(g.harness)} / ${inline(g.model)} / ${inline(c.chain_id)} (trial ${c.trial}, ${c.steps.length}/${c.length ?? "?"} steps, chain ${c.chain_resolved ? "resolved" : "not resolved"})`)
			lines.push("")
			lines.push(
				table(
					["step", "sha", "resolved", "reason", "in tokens", "input_first", "input_last", "reads", "reread ratio", "result chars", "wall ms", "cost"],
					c.steps.map(st => [
						String(st.step),
						inline(st.sha ? st.sha.slice(0, 10) : "n/a"),
						st.infra ? "excluded (infra)" : st.resolved ? "yes" : "no",
						inline(st.reason),
						fmtInt(st.input_tokens),
						fmtInt(st.input_first),
						fmtInt(st.input_last),
						fmtInt(st.reads),
						fmtRatio(st.reread_ratio),
						fmtInt(st.tool_result_chars),
						fmtInt(st.wall_ms),
						fmtStepCost(st.cost)
					])
				)
			)
			lines.push("")
		}
	}
	return lines
}

export const LOOKUP_HEADERS = ["harness", "model", "audited trials", "fatal (answer_lookup)", "non-fatal findings", "lookup rate", "resolved before audit", "resolved after audit", "top commands"]

function lookupCells(g) {
	const l = g.lookup || {audited: 0, scored: g.scored_trials, fatal: 0, nonfatal_findings: 0, rate: null, resolved_before: null, resolved_after: null, top_commands: []}
	const na = !l.audited
	return [
		harnessCell(g),
		inline(g.model),
		`${l.audited}/${l.scored}`,
		na ? "n/a" : String(l.fatal),
		na ? "n/a" : String(l.nonfatal_findings),
		fmtLookupRate(g),
		na ? "n/a" : String(l.resolved_before),
		na ? "n/a" : String(l.resolved_after),
		l.top_commands.length ? l.top_commands.map(c => `${inline(c.command)} (x${c.count})`).join("; ") : "n/a"
	]
}

export function renderLookup(groups, note) {
	const lines = []
	lines.push("## Answer lookup")
	lines.push("")
	lines.push(`> ${note}`)
	lines.push("")
	lines.push(table(LOOKUP_HEADERS, groups.map(lookupCells)))
	lines.push("")
	lines.push("Lookup trials count as failures, not as infra failures: reaching for the answer is the harness's choice. `resolved before audit` is what the evaluator alone credited; `resolved after audit` is what stands once looked-up answers are invalidated.")
	lines.push("")
	return lines
}

export function renderMarkdown(report) {
	const r = report.run
	const lines = []
	lines.push(`# Run report: ${r.id}`)
	lines.push("")
	lines.push(`- Run id: \`${inline(r.id)}\``)
	lines.push(`- Run directory: \`${inline(r.dir)}\``)
	lines.push(`- Date: ${r.date ? inline(r.date) : "n/a"}`)
	lines.push(`- Config: ${r.config == null ? "n/a (not in manifest)" : `\`${inline(r.config)}\``}`)
	lines.push(`- Results: ${r.results} (malformed lines: ${r.malformed_lines})`)
	lines.push(
		`- Status: ${r.partial ? `**PARTIAL / INTERRUPTED** — ${r.partial_reasons.map(inline).join("; ")}` : "complete"}`
	)
	lines.push("")
	lines.push(`> ${report.honesty.note}`)
	lines.push(`> Sample size: ${report.honesty.mean_sample_sizes}.`)
	lines.push("")

	lines.push("## Harness x model")
	lines.push("")
	lines.push(
		table(
			["harness", "model", ...SUMMARY_HEADERS],
			report.groups.map(g => [harnessCell(g), inline(g.model), ...summaryCells(g)])
		)
	)
	lines.push("")
	if (report.groups.some(g => g.provisional)) {
		lines.push("† provisional: fewer than 3 scored trials per task.")
		lines.push("")
	}

	lines.push("## Harness efficiency")
	lines.push("")
	lines.push(`> ${report.honesty.efficiency}`)
	lines.push("")
	lines.push(table(["harness", "model", ...EFFICIENCY_HEADERS], report.groups.map(g => [harnessCell(g), inline(g.model), ...efficiencyCells(g)])))
	lines.push("")

	lines.push(...renderLookup(report.groups, report.honesty.lookup))

	if (report.chains && report.chains.length) {
		lines.push(...renderChains(report.chains))
	}

	lines.push("## Per category")
	lines.push("")
	lines.push(
		table(["category", ...SUMMARY_HEADERS], report.categories.map(c => [inline(c.category), ...summaryCells(c)]))
	)
	lines.push("")

	lines.push("## Per repo")
	lines.push("")
	lines.push(table(["repo", ...SUMMARY_HEADERS], report.repos.map(x => [inline(x.repo), ...summaryCells(x)])))
	lines.push("")

	lines.push("## Per task")
	lines.push("")
	lines.push(
		table(
			["repo", "sha", "trial", "harness", "model", "resolved", "reason", "f2p", "p2p", "failure mode"],
			report.tasks.map(t => [
				inline(t.repo),
				inline(t.sha ? t.sha.slice(0, 10) : "n/a"),
				`${t.trial}/${t.trials}`,
				inline(t.harness),
				inline(t.model),
				t.resolved ? "yes" : "no",
				inline(t.reason),
				ratioCell(t.f2p),
				ratioCell(t.p2p),
				inline(t.failure_mode || "n/a")
			])
		)
	)
	lines.push("")
	return lines.join("\n")
}

// ---------------------------------------------------------------- cli

function main(argv) {
	const json = argv.includes("--json")
	const positional = argv.filter(a => !a.startsWith("--"))
	const target = positional[0]
	if (!target) {
		console.error("usage: node report/report.mjs <runid|path> [--json]")
		return 2
	}
	let runDir
	try {
		runDir = resolveRunDir(target)
	} catch (e) {
		console.error(`report: ${e.message}`)
		return 1
	}
	const report = buildReport(runDir)
	fs.mkdirSync(runDir, {recursive: true})
	fs.writeFileSync(path.join(runDir, "report.md"), renderMarkdown(report))
	if (json) {
		const out = `${JSON.stringify(report, null, 2)}\n`
		fs.writeFileSync(path.join(runDir, "report.json"), out)
		process.stdout.write(out)
	} else {
		process.stdout.write(`wrote ${path.join(runDir, "report.md")}\n`)
	}
	return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exit(main(process.argv.slice(2)))
}
