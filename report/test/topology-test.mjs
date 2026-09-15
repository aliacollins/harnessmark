import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {buildTopologyReport, renderTopology} from "../topology.mjs"

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

const roots = []
function mkRun(label, rows, transcripts) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `topo-${label}-`))
	roots.push(root)
	const runDir = path.join(root, "runs", label)
	fs.mkdirSync(runDir, {recursive: true})
	const written = rows.map((r, i) => {
		const file = path.join(runDir, `${r.adapter}-${i}.txt`)
		const body = transcripts && transcripts[i] != null ? transcripts[i] : ""
		if (body !== null) fs.writeFileSync(file, body)
		const adapterRun = {harness: r.adapter, failure_mode: r.failure_mode ?? "none", transcript_path: body === null ? null : file}
		if (r.topology !== undefined) adapterRun.topology = r.topology
		if (r.notes) adapterRun.notes = r.notes
		return {repo: "immer", sha: r.sha ?? "aaa", adapter: r.adapter, model: r.model ?? "m", resolved: r.resolved === true, trial: 0, adapter_run: adapterRun}
	})
	fs.writeFileSync(path.join(runDir, "results.jsonl"), written.map(w => JSON.stringify(w)).join("\n") + "\n")
	return runDir
}

const piTranscript = [
	JSON.stringify({type: "tool_execution_start", toolName: "bash", args: {}}),
	JSON.stringify({type: "tool_execution_start", toolName: "subagent", args: {agent: "slop-checker", task: "review"}})
].join("\n")

console.log("== topology is read from the transcript when the row predates the field ==")
{
	const runDir = mkRun("legacy", [{adapter: "pi", resolved: true}], [piTranscript])
	const g = buildTopologyReport([runDir]).groups[0]
	eq(g.scored.length, 1, "the trial contributes a topology")
	eq(g.scored[0].total_tool_calls, 2, "tool calls come from the stored transcript")
	eq(g.scored[0].subagents.by_agent, {"slop-checker": 1}, "the delegated agent is recovered from the transcript")
	eq(g.unavailable, 0, "a parseable transcript is not counted unavailable")
}

console.log("== a recorded topology wins over the transcript ==")
{
	// The recorded field claims work the transcript does not show; the recorded
	// value must win, because the adapter knows its own format best.
	const recorded = {parse: "pi-events", total_tool_calls: 99, tool_calls: {}, tool_errors: {}, subagents: {calls: 4, distinct: 1, by_agent: {"x-agent": 4}, prompt_chars: 0, max_prompt_chars: 0}, retries: 0, delegation_ratio: 0.04}
	const runDir = mkRun("recorded", [{adapter: "pi", resolved: true, topology: recorded}], [piTranscript])
	const g = buildTopologyReport([runDir]).groups[0]
	eq(g.scored[0].total_tool_calls, 99, "the adapter-recorded topology is authoritative")
	eq(g.scored[0].subagents.by_agent, {"x-agent": 4}, "the recorded agent mix is used, not the transcript's")
}

console.log("== a refused trial is excluded, using the same reclassification as the rate ==")
{
	// Recorded before provider_error existed: filed "unknown" with the provider's
	// error sitting in the notes. It produced no tool calls, so counting it would
	// halve the mean.
	const runDir = mkRun(
		"refused",
		[
			{adapter: "pi", resolved: true},
			{adapter: "pi", resolved: false, failure_mode: "unknown", notes: 'error=429: {"message":"Provider returned error","code":429}'}
		],
		[piTranscript, ""]
	)
	const g = buildTopologyReport([runDir]).groups[0]
	eq(g.excluded, 1, "the provider-refused trial is excluded from the topology means")
	eq(g.scored.length, 1, "only the served trial contributes")
	eq(g.aggregate.mean_tool_calls, 2, "the mean is over served trials only, not dragged toward zero")
	ok(renderTopology(buildTopologyReport([runDir])).includes("| 1 |"), "the excluded count is rendered")
}

console.log("== a format with no per-tool detail is unavailable, never zero ==")
{
	const runDir = mkRun("claude", [{adapter: "claude", resolved: true}], ['{"result":"done","num_turns":3}'])
	const report = buildTopologyReport([runDir])
	const g = report.groups[0]
	eq(g.unavailable, 1, "claude's single-JSON output has no per-tool detail")
	eq(g.scored.length, 0, "it contributes no topology")
	ok(renderTopology(report).includes("n/a"), "it renders n/a rather than a zero-delegation harness")
}

console.log("== agents are unioned across trials while means divide by trials ==")
{
	const t1 = [JSON.stringify({type: "tool_execution_start", toolName: "subagent", args: {agent: "alpha", task: "a"}})].join("\n")
	const t2 = [
		JSON.stringify({type: "tool_execution_start", toolName: "subagent", args: {agent: "beta", task: "b"}}),
		JSON.stringify({type: "tool_execution_start", toolName: "bash", args: {}})
	].join("\n")
	const runDir = mkRun("union", [{adapter: "pi", resolved: true}, {adapter: "pi", resolved: false}], [t1, t2])
	const g = buildTopologyReport([runDir]).groups[0]
	eq(g.aggregate.subagents.distinct, 2, "distinct agents span the whole group")
	eq(g.aggregate.subagents.by_agent, {alpha: 1, beta: 1}, "the agent mix is unioned across trials")
	eq(g.aggregate.total_tool_calls, 3, "tool calls are summed")
	eq(g.aggregate.mean_tool_calls, 1.5, "the mean divides by served trials, not by tool calls")
	eq(g.aggregate.subagents.mean_calls, 1, "mean delegations per served trial")
}

console.log("== a missing transcript file does not throw ==")
{
	const runDir = mkRun("missing", [{adapter: "pi", resolved: true}], [null])
	const g = buildTopologyReport([runDir]).groups[0]
	eq(g.unavailable, 1, "an unreadable transcript is unavailable")
}

console.log("== outcome does not change any count ==")
{
	const won = mkRun("won", [{adapter: "pi", resolved: true}], [piTranscript])
	const lost = mkRun("lost", [{adapter: "pi", resolved: false, failure_mode: "harness_crash"}], [piTranscript])
	eq(buildTopologyReport([won]).groups[0].scored[0].total_tool_calls, buildTopologyReport([lost]).groups[0].scored[0].total_tool_calls, "the same activity yields the same count whether or not the trial passed")
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
for (const r of roots) {
	try {
		fs.rmSync(r, {recursive: true, force: true})
	} catch {}
}
process.exit(fail ? 1 : 0)
