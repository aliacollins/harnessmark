import {aggregateTopology, analyzeCodexEvents, analyzePiEvents, bashDumpPaths, contextFromTurns, mergeTopology, normalizeTopology, topologyFromTranscript, analyzeClaudeEvents} from "../topology.mjs"

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

// Minimal pi-shaped event stream: two sub-agent delegations, one failing tool,
// one automatic retry after a provider refusal.
const PI_EVENTS = [
	{type: "turn_start"},
	{type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {command: "ls"}},
	{type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false},
	{type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {path: "a.ts"}},
	{type: "tool_execution_end", toolCallId: "c2", toolName: "read", isError: true},
	{type: "tool_execution_start", toolCallId: "c3", toolName: "subagent", args: {agent: "slop-checker", task: "review the diff"}},
	{type: "tool_execution_end", toolCallId: "c3", toolName: "subagent", isError: false},
	{type: "tool_execution_start", toolCallId: "c4", toolName: "subagent", args: {agent: "slop-checker", task: "review again"}},
	{type: "tool_execution_start", toolCallId: "c5", toolName: "subagent", args: {agent: "deepseek-scout", task: "find the callers"}},
	{type: "auto_retry_start", attempt: 1, delayMs: 1000, errorMessage: "429 rate limited", maxAttempts: 3},
	{type: "auto_retry_end", attempt: 1, success: true}
]

console.log("== pi events: tool mix, delegation, retries ==")
{
	const t = analyzePiEvents(PI_EVENTS)
	eq(t.total_tool_calls, 5, "counts every tool_execution_start")
	eq(t.tool_calls, {bash: 1, read: 1, subagent: 3}, "breaks calls down by tool")
	eq(t.tool_errors, {read: 1}, "records which tools errored")
	eq(t.subagents.calls, 3, "counts sub-agent delegations")
	eq(t.subagents.distinct, 2, "counts distinct sub-agents")
	eq(t.subagents.by_agent, {"slop-checker": 2, "deepseek-scout": 1}, "names which sub-agents were used")
	eq(t.subagents.prompt_chars, "review the diff".length + "review again".length + "find the callers".length, "sums the delegated prompt sizes")
	eq(t.retries, 1, "counts automatic retries after a refusal")
	ok(Math.abs(t.delegation_ratio - 3 / 5) < 1e-9, "delegation ratio is sub-agent calls over total calls")
	// An unnamed delegation must still be counted, not silently dropped.
	eq(analyzePiEvents([{type: "tool_execution_start", toolName: "subagent", args: {}}]).subagents.by_agent, {unnamed: 1}, "an unnamed sub-agent is recorded as unnamed")
}

console.log("== a harness with no sub-agent tool reports 0, not unknown ==")
{
	const t = analyzePiEvents([{type: "tool_execution_start", toolName: "bash", args: {}}])
	eq(t.subagents.calls, 0, "no delegations means zero")
	eq(t.subagents.distinct, 0, "no distinct agents")
	eq(t.delegation_ratio, 0, "a zero ratio, not null")
}

console.log("== codex events ==")
{
	const t = analyzeCodexEvents([
		{type: "item.completed", item: {id: "1", type: "command_execution"}},
		{type: "item.completed", item: {type: "file_change"}},
		// The model's own reply is not a tool call; counting it inflates codex against
		// pi, whose transcript records only real tool executions.
		{type: "item.completed", item: {type: "agent_message", text: "done"}},
		{type: "turn.completed", usage: {input_tokens: 5}}
	])
	eq(t.total_tool_calls, 2, "counts only action items, not the model's own reply")
	eq(t.tool_calls, {command_execution: 1, file_change: 1}, "breaks action items down by kind")
	eq(t.item_types.agent_message, 1, "a chat message is still visible in item_types, never silently dropped")
	eq(t.subagents.calls, 0, "codex has no sub-agent concept, reported as zero")
}

console.log("== transcript dispatch: unknown formats are unavailable, not zero ==")
{
	eq(topologyFromTranscript("", {adapter: "pi"}), null, "an empty transcript yields nothing rather than an empty topology")
	eq(topologyFromTranscript("not json\nstill not json", {adapter: "claude"}), null, "a format with no per-tool detail yields null")
	const codex = topologyFromTranscript('{"type":"item.completed","item":{"type":"command_execution"}}', {adapter: "codex"})
	eq(codex.total_tool_calls, 1, "codex jsonl lines parse")
	const pi = topologyFromTranscript('{"type":"tool_execution_start","toolName":"bash","args":{}}\nnoise', {adapter: "pi"})
	eq(pi.total_tool_calls, 1, "pi jsonl parses and skips non-JSON noise")
}

console.log("== aggregate: unions agents across trials and averages per trial ==")
{
	const a = analyzePiEvents([
		{type: "tool_execution_start", toolName: "subagent", args: {agent: "slop-checker", task: "x"}},
		{type: "tool_execution_start", toolName: "bash", args: {}}
	])
	const b = analyzePiEvents([{type: "tool_execution_start", toolName: "subagent", args: {agent: "deepseek-worker", task: "y"}}])
	const agg = aggregateTopology([a, b])
	eq(agg.trials, 2, "counts the trials it aggregated")
	eq(agg.subagents.by_agent, {"slop-checker": 1, "deepseek-worker": 1}, "unions the agent mix across trials")
	eq(agg.subagents.distinct, 2, "distinct agents span the whole group")
	eq(agg.subagents.mean_calls, 1, "mean delegations per trial")
	eq(agg.total_tool_calls, 3, "sums tool calls")
	eq(agg.mean_tool_calls, 1.5, "mean tool calls per trial")
	eq(aggregateTopology([null, null]), null, "no usable trials yields nothing rather than zeros")
}

console.log("== normalizeTopology is defensive against partial records ==")
{
	const n = normalizeTopology({total_tool_calls: 5})
	eq(n.subagents.calls, 0, "a record without a subagents block normalizes to zero")
	eq(n.retries, 0, "a record without retries normalizes to zero")
	eq(normalizeTopology(null), null, "null stays null")
	ok(normalizeTopology({total_tool_calls: "5"}) === null, "a record with no numeric count is unavailable, not a zero-delegation harness")
	ok(normalizeTopology({parse: "pi-events"}) === null, "an object with no counts at all is unavailable")
}


// ---------------------------------------------------------------- read efficiency

const readStart = (id, path) => ({type: "tool_execution_start", toolCallId: id, toolName: "read", args: {path}})
const readEnd = (id, text) => ({type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false, result: {content: [{type: "text", text}]}})
const bashStart = (id, command) => ({type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {command}})
const bashEnd = (id, text) => ({type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: {content: [{type: "text", text}]}})
const turnEnd = (input, cacheRead, output) => ({type: "turn_end", message: {role: "assistant", usage: {input, cacheRead, output, cacheWrite: 0}}})

console.log("== reads: calls, distinct files, rereads, result chars ==")
{
	const t = analyzePiEvents([
		readStart("r1", "/wt/src/a.ts"),
		readEnd("r1", "x".repeat(100)),
		readStart("r2", "/wt/src/b.ts"),
		readEnd("r2", "y".repeat(50)),
		readStart("r3", "/wt/src/a.ts"),
		readEnd("r3", "x".repeat(100)),
		readStart("r4", "/wt/src//a.ts"),
		readEnd("r4", "x".repeat(100))
	])
	eq(t.reads.calls, 4, "every read tool call is counted")
	eq(t.reads.distinct_files, 2, "the same file read three times is one distinct file")
	eq(t.reads.rereads, 2, "rereads = calls - distinct files")
	eq(t.reads.reread_ratio, 0.5, "reread ratio is rereads over calls")
	eq(t.reads.result_chars, 350, "read result chars are summed from tool_execution_end")
	eq(t.reads.via_bash, 0, "no bash dumps")
	eq(t.tool_result_chars, 350, "total tool result chars")
	eq(t.tool_result_chars_by_tool, {read: 350}, "result chars are broken down by tool")
	eq(t.total_tool_calls, 4, "reads are still ordinary tool calls in the total")
	eq(t.tool_calls, {read: 4}, "reads appear in the tool mix")
}

console.log("== reads: a read with no path still counts and never collapses into another ==")
{
	const t = analyzePiEvents([readStart("r1", undefined), readStart("r2", undefined), readStart("r3", "/a")])
	eq(t.reads.calls, 3, "three calls")
	eq(t.reads.distinct_files, 3, "pathless reads are each distinct, not merged")
	eq(t.reads.rereads, 0, "no rereads inferred from missing paths")
}

console.log("== reads: no reads is zero, not unknown ==")
{
	const t = analyzePiEvents([bashStart("b1", "ls -la"), bashEnd("b1", "total 0")])
	eq(t.reads.calls, 0, "zero read calls")
	eq(t.reads.reread_ratio, null, "no ratio without calls")
	eq(t.reads.via_bash, 0, "ls is not a file dump")
	eq(t.tool_result_chars, 7, "bash output still counts toward result chars")
	eq(t.tool_result_chars_by_tool, {bash: 7}, "attributed to bash")
}

console.log("== reads: bash file dumps are counted separately from the read tool ==")
{
	const t = analyzePiEvents([
		bashStart("b1", "cat src/a.ts"),
		bashEnd("b1", "abc"),
		bashStart("b2", 'cd "/wt" && sed -n 1,80p src/b.ts'),
		bashEnd("b2", "def"),
		bashStart("b3", "head -n 20 src/a.ts | grep foo"),
		bashEnd("b3", "g"),
		bashStart("b4", "grep -rn foo src/"),
		bashEnd("b4", "h"),
		readStart("r1", "src/c.ts"),
		readEnd("r1", "ij")
	])
	eq(t.reads.via_bash, 3, "cat, sed -n and head are file dumps; grep is not")
	eq(t.reads.via_bash_files, 2, "distinct dumped paths (src/a.ts twice)")
	eq(t.reads.calls, 1, "bash dumps do not inflate read-tool calls")
	eq(t.reads.distinct_files, 1, "nor read-tool distinct files")
	eq(t.reads.result_chars, 2, "read result chars come from the read tool only")
	eq(t.tool_result_chars, 10, "all tool output counts toward the total")
	eq(bashDumpPaths("cat a.ts b.ts"), ["a.ts", "b.ts"], "multiple paths on one cat")
	eq(bashDumpPaths("tail -n 5 log.txt"), ["log.txt"], "a numeric flag operand is not a path")
	eq(bashDumpPaths("ls && git log --oneline"), [], "not a dump")
	eq(bashDumpPaths(undefined), [], "no command, no paths")
}

console.log("== context: per-turn prompt size, growth and cache ratio ==")
{
	const t = analyzePiEvents([
		turnEnd(1000, 0, 50),
		turnEnd(200, 1000, 40),
		turnEnd(300, 1200, 30),
		// A refused turn reports all-zero usage and must not become input_last.
		turnEnd(0, 0, 0),
		// message_update repeats usage while streaming and must be ignored.
		{type: "message_update", usage: {input: 999999, cacheRead: 0, output: 0}}
	])
	eq(t.context.turns, 3, "one sample per served turn; refused and streaming events are skipped")
	eq(t.context.input_first, 1000, "first prompt = input + cacheRead")
	eq(t.context.input_last, 1500, "last prompt = input + cacheRead")
	eq(t.context.input_max, 1500, "max prompt")
	eq(t.context.input_mean, (1000 + 1200 + 1500) / 3, "mean prompt")
	eq(t.context.input_total, 3700, "total prompt tokens")
	eq(t.context.output_total, 120, "total output tokens")
	eq(t.context.growth, 1.5, "growth = last / first")
	ok(Math.abs(t.context.cache_read_ratio - 2200 / 3700) < 1e-9, "cache ratio = cacheRead / (input + cacheRead) over the session")
	eq(analyzePiEvents([bashStart("b", "ls")]).context, null, "no usage events means context is unknown, not zero")
	eq(contextFromTurns([]), null, "no turns, no context")
	eq(contextFromTurns([{input: 0, cache_read: 0, output: 0}]).growth, null, "a zero first prompt has no growth")
}

console.log("== reference harness events: model_call usage and retry ==")
{
	const text = [
		JSON.stringify({type: "model_call", usage: {input: 500, output: 20, cache_read: 0, cache_write: 500}}),
		JSON.stringify(readStart("r1", "a.ts")),
		JSON.stringify(readEnd("r1", "body")),
		JSON.stringify({type: "retry", attempt: 1, error: "429"}),
		JSON.stringify({type: "model_call", usage: {input: 100, output: 10, cache_read: 500, cache_write: 0}}),
		"plain log line that is not json"
	].join("\n")
	const t = topologyFromTranscript(text, {adapter: "reference"})
	eq(t.parse, "reference-events", "labelled as the reference format")
	eq(t.retries, 1, "a {type:retry} event counts as a retry")
	eq(t.context.turns, 2, "each model_call is a turn sample")
	eq(t.context.input_first, 500, "first prompt")
	eq(t.context.input_last, 600, "last prompt = input + cache_read")
	eq(t.context.growth, 1.2, "growth")
	eq(t.reads.calls, 1, "reads are parsed with the pi analyzer")
	eq(t.subagents.calls, 0, "the reference harness delegates nothing, and that is a measurement")
	eq(analyzePiEvents([{type: "model_call", usage: {input_tokens: 7, output_tokens: 1}}]).context.input_first, 7, "snake_case token names are accepted")
}

console.log("== codex: result chars, bash dumps and turn usage ==")
{
	const t = analyzeCodexEvents([
		{type: "item.completed", item: {type: "command_execution", command: "cat src/a.ts", aggregated_output: "abcd", exit_code: 0}},
		{type: "item.completed", item: {type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 1}},
		{type: "item.completed", item: {type: "agent_message", text: "x".repeat(1000)}},
		{type: "turn.completed", usage: {input_tokens: 100, cached_input_tokens: 0, output_tokens: 5}},
		{type: "turn.completed", usage: {input_tokens: 20, cached_input_tokens: 100, output_tokens: 5}}
	])
	eq(t.tool_result_chars, 6, "aggregated_output is the tool result; the model's own message is not")
	eq(t.tool_result_chars_by_tool, {command_execution: 6}, "attributed to command_execution")
	eq(t.reads.via_bash, 1, "cat through the shell is a bash dump")
	eq(t.reads.calls, 0, "codex has no read tool")
	eq(t.tool_errors, {command_execution: 1}, "a non-zero exit is a tool error")
	eq(t.context.turns, 2, "turn.completed usage feeds the context series")
	eq(t.context.input_last, 120, "input + cached")
}

console.log("== normalize: legacy records carry null for the new fields, never zero ==")
{
	const legacy = normalizeTopology({total_tool_calls: 5, subagents: {calls: 0}})
	eq(legacy.reads, null, "a record without reads did not measure reads")
	eq(legacy.tool_result_chars, null, "a record without result chars did not measure them")
	eq(legacy.context, null, "a record without context did not measure it")
	const fresh = normalizeTopology(analyzePiEvents([bashStart("b", "ls")]))
	eq(fresh.reads.calls, 0, "a measured zero survives normalization as zero")
	eq(fresh.tool_result_chars, 0, "a measured zero of result chars stays zero")
	const partial = normalizeTopology({total_tool_calls: 1, reads: {calls: 4, distinct_files: 3}})
	eq(partial.reads.rereads, 1, "rereads are derived when absent")
	eq(partial.reads.reread_ratio, 0.25, "and so is the ratio")
	eq(normalizeTopology({total_tool_calls: 1, context: {turns: 2}}).context, null, "a context without first/last is unusable")
}

console.log("== merge: a recorded topology keeps its counts and gains the efficiency fields ==")
{
	const recorded = {parse: "pi-events", total_tool_calls: 99, subagents: {calls: 4, by_agent: {x: 4}}, retries: 0}
	const derived = analyzePiEvents([readStart("r1", "a"), readEnd("r1", "abc"), turnEnd(10, 0, 1)])
	const m = mergeTopology(recorded, derived)
	eq(m.total_tool_calls, 99, "the recorded count is authoritative")
	eq(m.subagents.by_agent, {x: 4}, "the recorded agent mix is kept")
	eq(m.reads.calls, 1, "reads are filled from the transcript")
	eq(m.tool_result_chars, 3, "result chars are filled from the transcript")
	eq(m.context.input_first, 10, "context is filled from the transcript")
	eq(mergeTopology(null, derived).reads.calls, 1, "no recorded record: the derived one is used")
	eq(mergeTopology(recorded, null).reads, null, "no transcript: the gap stays null")
	const complete = analyzePiEvents([readStart("r1", "z")])
	eq(mergeTopology(complete, derived).reads.distinct_files, 1, "a recorded record that already has reads keeps its own")
}

console.log("== aggregate: ratios of sums, not means of ratios ==")
{
	// Trial A: 1 read, 1 reread (ratio 0.5). Trial B: 10 reads, 0 rereads (0).
	// A mean of ratios says 0.25; the population reread rate is 1/12.
	const a = analyzePiEvents([readStart("1", "f"), readStart("2", "f"), turnEnd(100, 0, 1), turnEnd(200, 0, 1)])
	const b = analyzePiEvents([...Array.from({length: 10}, (_, i) => readStart(String(i), `f${i}`)), turnEnd(100, 0, 1), turnEnd(100, 0, 1)])
	const agg = aggregateTopology([a, b])
	eq(agg.reads.calls, 12, "read calls summed")
	eq(agg.reads.mean_calls, 6, "mean reads per trial")
	eq(agg.reads.rereads, 1, "rereads summed")
	ok(Math.abs(agg.reads.reread_ratio - 1 / 12) < 1e-9, "reread ratio is the ratio of sums")
	eq(agg.context.trials, 2, "both trials carry context")
	eq(agg.context.growth, 300 / 200, "growth is sum(last)/sum(first), not the mean of per-trial growth (1.5 vs 1.25)")
	eq(agg.context.mean_input_first, 100, "mean first prompt")
	eq(agg.context.mean_input_last, 150, "mean last prompt")
	eq(agg.tool_result_chars, 0, "no tool_execution_end events means zero chars measured")
	eq(agg.mean_retries, 0, "no retries")
}

console.log("== aggregate: unknown efficiency fields stay unknown ==")
{
	const legacy = {total_tool_calls: 3, subagents: {calls: 0}, retries: 0}
	const agg = aggregateTopology([legacy, legacy])
	eq(agg.trials, 2, "both legacy trials aggregate on the fields they have")
	eq(agg.reads, null, "no trial measured reads")
	eq(agg.tool_result_chars, null, "no trial measured result chars")
	eq(agg.context, null, "no trial measured context")
	const mixed = aggregateTopology([legacy, analyzePiEvents([readStart("1", "f"), readEnd("1", "ab")])])
	eq(mixed.reads.trials, 1, "reads aggregate over the trials that measured them")
	eq(mixed.reads.mean_calls, 1, "and divide by that count, not by all trials")
	eq(mixed.tool_result_chars, 2, "result chars likewise")
	eq(mixed.trials, 2, "while the delegation fields still cover both")
}

console.log("== outcome never enters any count ==")
{
	const events = [readStart("1", "a"), readEnd("1", "xyz"), turnEnd(5, 0, 1)]
	const t1 = analyzePiEvents(events)
	const t2 = analyzePiEvents([...events, {type: "agent_end", resolved: false}, {type: "turn_end", message: {usage: {input: 0, cacheRead: 0, output: 0}}}])
	eq(t1.reads, t2.reads, "reads are identical regardless of any outcome-shaped event")
	eq(t1.context, t2.context, "context is identical")
}

console.log("== claude stream-json events ==")
{
	const A = (id, blocks, usage, extra = {}) => ({type: "assistant", message: {id, role: "assistant", content: blocks, usage}, parent_tool_use_id: null, ...extra})
	const U = (results, extra = {}) => ({type: "user", message: {role: "user", content: results}, parent_tool_use_id: null, ...extra})
	const use = (id, name, input) => ({type: "tool_use", id, name, input})
	const res = (id, content, is_error = false) => ({type: "tool_result", tool_use_id: id, content, is_error})
	const usage1 = {input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50}
	const usage2 = {input_tokens: 5, cache_read_input_tokens: 3000, cache_creation_input_tokens: 100, output_tokens: 20}
	const events = [
		{type: "system", subtype: "init", tools: ["Task", "Bash", "Read"]},
		A("m1", [{type: "thinking", thinking: "..."}], usage1),
		A("m1", [use("t1", "Read", {file_path: "/w/src/a.ts"}), use("t2", "Bash", {command: "cat src/b.ts"})], usage1),
		U([res("t1", "file a contents"), res("t2", "file b contents", false)]),
		A("m2", [use("t3", "Read", {file_path: "/w/src/a.ts"}), use("t4", "Task", {subagent_type: "Explore", prompt: "find the router"})], usage2),
		A("sub1", [use("s1", "Bash", {command: "ls"})], {input_tokens: 1, output_tokens: 1}, {parent_tool_use_id: "t4"}),
		U([res("s1", "src")], {parent_tool_use_id: "t4"}),
		U([res("t3", "file a again"), res("t4", [{type: "text", text: "the router is in src/r.ts"}])]),
		A("m3", [use("t5", "Bash", {command: "npx vitest run"})], usage2),
		U([res("t5", "1 failed", true)]),
		{type: "result", subtype: "success", num_turns: 3}
	]
	const t = analyzeClaudeEvents(events)
	eq(t.parse, "claude-stream-json", "parse label names the format")
	eq(t.total_tool_calls, 5, "five top-level tool calls; the sub-agent's own call is excluded")
	eq(t.subagent_internal_tool_calls, 1, "the sub-agent's internal call is reported separately")
	eq(t.tool_calls, {Read: 2, Bash: 2, Task: 1}, "tool calls keyed by Claude Code's tool names")
	eq(t.tool_errors, {Bash: 1}, "an is_error tool_result counts as a tool error for that tool")
	eq(t.subagents.calls, 1, "Task is the sub-agent tool")
	eq(t.subagents.by_agent, {Explore: 1}, "sub-agent keyed by subagent_type")
	eq(t.subagents.prompt_chars, "find the router".length, "sub-agent prompt chars measured")
	eq(t.delegation_ratio, 1 / 5, "delegation ratio is sub-agent calls over top-level tool calls")
	eq(t.reads.calls, 2, "two Read calls")
	eq(t.reads.distinct_files, 1, "the same file read twice is one distinct file")
	eq(t.reads.rereads, 1, "one re-read")
	eq(t.reads.via_bash, 1, "cat through Bash is a shell dump, detected regardless of capitalisation")
	eq(t.tool_result_chars, "file a contents".length + "file b contents".length + "file a again".length + "the router is in src/r.ts".length + "1 failed".length, "tool result chars summed over top-level results only")
	eq(t.context.turns, 3, "three API messages -> three context samples, the split message counted once")
	ok(t.context.input_first === 1010 && t.context.input_last === 3005, `context input is fresh + cache read per message (got ${t.context.input_first}, ${t.context.input_last})`)
	eq(topologyFromTranscript(JSON.stringify({type: "result", num_turns: 3}), {adapter: "claude"}), null, "legacy json transcript has no per-tool detail -> null")
	const stream = events.map(e => JSON.stringify(e)).join("\n") + "\n--- stderr ---\nwarning: something"
	eq(topologyFromTranscript(stream, {adapter: "claude"}).total_tool_calls, 5, "stream-json transcript with trailing stderr parses")
	const t2 = analyzeClaudeEvents(events.map(e => (e.type === "result" ? {...e, subtype: "error", is_error: true} : e)))
	eq(t2.total_tool_calls, t.total_tool_calls, "outcome does not change tool counts")
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)
