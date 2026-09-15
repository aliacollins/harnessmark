// Delegation topology: how a harness STRUCTURES work, not just whether it
// succeeded. Two harnesses can score identically on the same model while one
// solves the task directly and the other fans out to nine review sub-agents --
// a difference no pass/fail rate can see.
//
// Derived from the adapter's own transcript, because only the adapter knows its
// own event format. A harness that has no sub-agents reports calls: 0, which is
// itself a measurement (it is not "unknown").
//
// This is deliberately outcome-blind: it counts what the harness did, never
// whether it was right.
//
// Beyond delegation it also records READ EFFICIENCY: how many files the harness
// read, how often it re-read one it had already seen, how many characters of
// tool output it pulled into context, and how the per-turn prompt size grew
// over the session. A harness that indexes the codebase once and answers later
// reads from the index should show fewer reads, a lower reread ratio, fewer
// result chars and flatter context growth than one that re-reads files raw.
// Those are the fields that make such a harness measurable at all.

const asNum = v => (typeof v === "number" && Number.isFinite(v) ? v : null)

// Tool names that return file content. `read` is pi's; the rest are common
// spellings in other harnesses that emit pi-compatible events.
const READ_TOOL_NAMES = new Set(["read", "Read", "read_file", "view_file", "view"])

// Bash commands that are plainly a file dump. Kept narrow on purpose: `grep`,
// `ls` and `find` return content too, but they are search, not reads.
const BASH_DUMP_RE = /(?:^|[;&|]\s*)(?:cat|head|tail|bat|more|less)\s+((?:-\S+\s+)*)([^;&|<>]*)/g
const BASH_SED_RE = /(?:^|[;&|]\s*)sed\s+(?:-\S+\s+)*(?:'[^']*'|"[^"]*"|\S+)\s+([^;&|<>\s]+)/g

function emptyReads() {
	return {calls: 0, distinct_files: 0, rereads: 0, reread_ratio: null, result_chars: 0, via_bash: 0, via_bash_files: 0}
}

function emptyTopology(parse) {
	return {
		parse,
		total_tool_calls: 0,
		tool_calls: {},
		tool_errors: {},
		subagents: {calls: 0, distinct: 0, by_agent: {}, prompt_chars: 0, max_prompt_chars: 0},
		retries: 0,
		delegation_ratio: null,
		reads: emptyReads(),
		tool_result_chars: 0,
		tool_result_chars_by_tool: {},
		context: null
	}
}

export function normalizePath(p) {
	if (typeof p !== "string" || !p.trim()) return null
	let s = p.trim().replace(/^['"]|['"]$/g, "")
	s = s.replace(/\/{2,}/g, "/")
	while (s.startsWith("./")) s = s.slice(2)
	if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
	return s || null
}

// Paths a bash command dumps to stdout, or [] when it is not a file dump.
export function bashDumpPaths(command) {
	if (typeof command !== "string") return []
	const out = []
	const looksLikePath = t => t && !t.startsWith("-") && !t.startsWith("$(") && /[./\w]/.test(t)
	for (const m of command.matchAll(BASH_DUMP_RE)) {
		for (const tok of m[2].trim().split(/\s+/)) {
			// head -n 20 / tail -c 100: the flag's numeric operand is not a path.
			if (/^\d+$/.test(tok)) continue
			if (looksLikePath(tok)) out.push(normalizePath(tok))
		}
	}
	for (const m of command.matchAll(BASH_SED_RE)) {
		if (looksLikePath(m[1])) out.push(normalizePath(m[1]))
	}
	return out.filter(Boolean)
}

function resultText(result) {
	if (result == null) return ""
	if (typeof result === "string") return result
	if (Array.isArray(result)) return result.map(resultText).join("")
	if (typeof result === "object") {
		if (Array.isArray(result.content)) return result.content.map(resultText).join("")
		if (typeof result.text === "string") return result.text
		if (typeof result.output === "string") return result.output
	}
	return ""
}

function readPathOf(args) {
	if (!args || typeof args !== "object") return null
	for (const k of ["path", "file_path", "filePath", "file", "filename"]) {
		if (typeof args[k] === "string") return normalizePath(args[k])
	}
	return null
}

// Per-turn prompt size. Both sources are reduced to the same shape:
// {input, cache_read, output}. `input` is the FRESH input tokens the provider
// billed; the prompt the model actually saw is input + cache_read, and that sum
// is what "context" tracks below, so a harness that caches well is not mistaken
// for one that sends a small prompt.
function usageFromPi(usage) {
	if (!usage || typeof usage !== "object") return null
	const input = asNum(usage.input)
	if (input == null) return null
	const cache_read = asNum(usage.cacheRead) ?? 0
	// A turn the provider refused reports all-zero usage; it saw no prompt, so it
	// is not a context sample (it would drag input_last to 0 and growth with it).
	if (input + cache_read === 0) return null
	return {input, cache_read, output: asNum(usage.output) ?? 0}
}

function usageFromModelCall(usage) {
	if (!usage || typeof usage !== "object") return null
	const input = asNum(usage.input) ?? asNum(usage.input_tokens)
	if (input == null) return null
	const cache_read = asNum(usage.cache_read) ?? asNum(usage.cache_read_tokens) ?? 0
	if (input + cache_read === 0) return null
	return {input, cache_read, output: asNum(usage.output) ?? asNum(usage.output_tokens) ?? 0}
}

export function contextFromTurns(turns) {
	const list = turns.filter(Boolean)
	if (!list.length) return null
	const prompts = list.map(t => t.input + t.cache_read)
	const sumInput = list.reduce((a, t) => a + t.input, 0)
	const sumCache = list.reduce((a, t) => a + t.cache_read, 0)
	const first = prompts[0]
	const last = prompts[prompts.length - 1]
	return {
		turns: list.length,
		input_first: first,
		input_last: last,
		input_mean: prompts.reduce((a, b) => a + b, 0) / prompts.length,
		input_max: Math.max(...prompts),
		input_total: prompts.reduce((a, b) => a + b, 0),
		output_total: list.reduce((a, t) => a + t.output, 0),
		growth: first > 0 ? last / first : null,
		cache_read_ratio: sumInput + sumCache > 0 ? sumCache / (sumInput + sumCache) : null
	}
}

function finishReads(t, seen, bashSeen) {
	t.reads.distinct_files = seen.size
	t.reads.rereads = t.reads.calls - seen.size
	t.reads.reread_ratio = t.reads.calls ? t.reads.rereads / t.reads.calls : null
	t.reads.via_bash_files = bashSeen.size
}

// pi emits one JSON object per line; tool_execution_start carries the tool name
// and, for the subagent tool, the target agent and the exact prompt handed to it.
// tool_execution_end carries the result the model saw. turn_end carries the
// provider's usage for that turn. The reference harness emits the same events
// plus {type:"model_call", usage:{input,output,cache_read,cache_write}} and
// {type:"retry"}.
export function analyzePiEvents(events, {parse = "pi-events"} = {}) {
	const t = emptyTopology(parse)
	const seen = new Set()
	const bashSeen = new Set()
	const turns = []
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue
		if (ev.type === "tool_execution_start") {
			t.total_tool_calls++
			const name = typeof ev.toolName === "string" ? ev.toolName : "unknown"
			t.tool_calls[name] = (t.tool_calls[name] || 0) + 1
			const args = ev.args && typeof ev.args === "object" ? ev.args : {}
			if (name === "subagent") {
				const agent = typeof args.agent === "string" && args.agent ? args.agent : "unnamed"
				t.subagents.calls++
				t.subagents.by_agent[agent] = (t.subagents.by_agent[agent] || 0) + 1
				const chars = typeof args.task === "string" ? args.task.length : 0
				t.subagents.prompt_chars += chars
				if (chars > t.subagents.max_prompt_chars) t.subagents.max_prompt_chars = chars
			} else if (READ_TOOL_NAMES.has(name)) {
				t.reads.calls++
				const p = readPathOf(args)
				// A read with no recoverable path still counts as a call; key it on
				// the call so it can never collapse into another file.
				seen.add(p || `\u0000unknown:${t.reads.calls}`)
			} else if (name.toLowerCase() === "bash") {
				const paths = bashDumpPaths(args.command)
				if (paths.length) {
					t.reads.via_bash++
					for (const p of paths) bashSeen.add(p)
				}
			}
		} else if (ev.type === "tool_execution_end") {
			const name = typeof ev.toolName === "string" ? ev.toolName : "unknown"
			if (ev.isError === true) t.tool_errors[name] = (t.tool_errors[name] || 0) + 1
			const chars = resultText(ev.result).length
			t.tool_result_chars += chars
			t.tool_result_chars_by_tool[name] = (t.tool_result_chars_by_tool[name] || 0) + chars
			if (READ_TOOL_NAMES.has(name)) t.reads.result_chars += chars
		} else if (ev.type === "auto_retry_start" || ev.type === "retry") {
			// A harness that retries a refused request recovers on its own; one that
			// does not surfaces the refusal as a failure. That is a harness property.
			t.retries++
		} else if (ev.type === "turn_end") {
			// One event per assistant turn. message_update repeats the same usage
			// many times while streaming, so it is deliberately not consulted.
			const u = usageFromPi(ev.message && ev.message.usage)
			if (u) turns.push(u)
		} else if (ev.type === "model_call") {
			const u = usageFromModelCall(ev.usage)
			if (u) turns.push(u)
		}
	}
	t.subagents.distinct = Object.keys(t.subagents.by_agent).length
	t.delegation_ratio = t.total_tool_calls ? t.subagents.calls / t.total_tool_calls : null
	finishReads(t, seen, bashSeen)
	t.context = contextFromTurns(turns)
	return t
}

// Claude Code's --output-format stream-json (print mode, --verbose) is JSONL:
// "assistant" events carry the model's content blocks (tool_use with name/input,
// text, thinking) and per-message usage, "user" events carry tool_result blocks
// keyed by tool_use_id, and a final "result" object repeats the totals. One API
// message is split across several assistant events (one per block, same
// message.id), so usage is de-duplicated by id. Events emitted from INSIDE a
// sub-agent carry parent_tool_use_id; those are the sub-agent's work, not the
// harness's own tool calls, so they are counted separately (pi's transcript never
// shows sub-agent internals, and the comparison must stay like-for-like). The
// sub-agent tool is "Task", with input.subagent_type and input.prompt.
//
// The events are translated into pi-shaped events and run through the pi
// analyzer so every derived field (reads, rereads, result chars, context) is
// computed by exactly the same code for both harnesses.
export function analyzeClaudeEvents(events) {
	const piEvents = []
	const nameById = new Map()
	const usageById = new Map()
	const usageOrder = []
	let internalToolCalls = 0
	const tasks = []
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue
		const internal = typeof ev.parent_tool_use_id === "string" && ev.parent_tool_use_id !== ""
		const msg = ev.message && typeof ev.message === "object" ? ev.message : null
		const content = msg && Array.isArray(msg.content) ? msg.content : []
		if (ev.type === "assistant") {
			for (const block of content) {
				if (!block || block.type !== "tool_use") continue
				if (internal) {
					internalToolCalls++
					continue
				}
				const name = typeof block.name === "string" ? block.name : "unknown"
				const input = block.input && typeof block.input === "object" ? block.input : {}
				if (typeof block.id === "string") nameById.set(block.id, name)
				if (name === "Task") {
					tasks.push({
						agent: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "unnamed",
						chars: typeof input.prompt === "string" ? input.prompt.length : 0
					})
				}
				piEvents.push({type: "tool_execution_start", toolName: name, args: input})
			}
			if (!internal && msg && msg.usage && typeof msg.usage === "object") {
				const id = typeof msg.id === "string" ? msg.id : `anon:${usageOrder.length}`
				if (!usageById.has(id)) usageOrder.push(id)
				usageById.set(id, msg.usage)
			}
		} else if (ev.type === "user") {
			if (internal) continue
			for (const block of content) {
				if (!block || block.type !== "tool_result") continue
				const name = nameById.get(block.tool_use_id) || "unknown"
				let text = ""
				if (typeof block.content === "string") text = block.content
				else if (Array.isArray(block.content)) text = block.content.map(c => (c && typeof c.text === "string" ? c.text : "")).join("")
				piEvents.push({
					type: "tool_execution_end",
					toolName: name,
					isError: block.is_error === true,
					result: {content: [{type: "text", text}]}
				})
			}
		}
	}
	// One turn_end per API message, in order, in pi's usage shape.
	for (const id of usageOrder) {
		const u = usageById.get(id)
		piEvents.push({
			type: "turn_end",
			message: {
				usage: {
					input: asNum(u.input_tokens) ?? 0,
					output: asNum(u.output_tokens) ?? 0,
					cacheRead: asNum(u.cache_read_input_tokens) ?? 0,
					cacheWrite: asNum(u.cache_creation_input_tokens) ?? 0
				}
			}
		})
	}
	const t = analyzePiEvents(piEvents, {parse: "claude-stream-json"})
	// The pi analyzer keys delegation on a tool literally named "subagent"; Claude
	// Code's is "Task", so its delegation is accounted for here.
	for (const task of tasks) {
		t.subagents.calls++
		t.subagents.by_agent[task.agent] = (t.subagents.by_agent[task.agent] || 0) + 1
		t.subagents.prompt_chars += task.chars
		if (task.chars > t.subagents.max_prompt_chars) t.subagents.max_prompt_chars = task.chars
	}
	t.subagents.distinct = Object.keys(t.subagents.by_agent).length
	t.delegation_ratio = t.total_tool_calls ? t.subagents.calls / t.total_tool_calls : null
	t.subagent_internal_tool_calls = internalToolCalls
	return t
}

// codex emits item.completed events for several kinds of item, only some of which
// are actions the harness took. `agent_message` is the model's own reply, so
// counting it as a tool call would inflate codex against pi, whose transcript
// records only real tool executions -- and the comparison of tool-call counts is
// the whole point. Types seen in this repo's runs: command_execution,
// agent_message, file_change. Non-action items are still reported in item_types
// so nothing is hidden.
const CODEX_ACTION_ITEMS = new Set(["command_execution", "file_change", "patch_apply", "mcp_tool_call", "web_search"])

export function analyzeCodexEvents(events) {
	const t = emptyTopology("codex-events")
	t.item_types = {}
	const bashSeen = new Set()
	const turns = []
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue
		if (ev.type === "item.completed" && ev.item && typeof ev.item === "object") {
			const kind = typeof ev.item.type === "string" ? ev.item.type : "unknown"
			t.item_types[kind] = (t.item_types[kind] || 0) + 1
			if (!CODEX_ACTION_ITEMS.has(kind)) continue
			t.total_tool_calls++
			t.tool_calls[kind] = (t.tool_calls[kind] || 0) + 1
			if (kind === "command_execution") {
				const chars = typeof ev.item.aggregated_output === "string" ? ev.item.aggregated_output.length : 0
				t.tool_result_chars += chars
				t.tool_result_chars_by_tool[kind] = (t.tool_result_chars_by_tool[kind] || 0) + chars
				// codex has no read tool: every file it looks at goes through a shell
				// command, so its reads are all via_bash by construction.
				const paths = bashDumpPaths(ev.item.command)
				if (paths.length) {
					t.reads.via_bash++
					for (const p of paths) bashSeen.add(p)
				}
				if (ev.item.exit_code != null && ev.item.exit_code !== 0) t.tool_errors[kind] = (t.tool_errors[kind] || 0) + 1
			}
		} else if (ev.type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
			const input = asNum(ev.usage.input_tokens)
			if (input != null) {
				turns.push({input, cache_read: asNum(ev.usage.cached_input_tokens) ?? 0, output: asNum(ev.usage.output_tokens) ?? 0})
			}
		}
	}
	t.delegation_ratio = t.total_tool_calls ? t.subagents.calls / t.total_tool_calls : null
	finishReads(t, new Set(), bashSeen)
	t.context = contextFromTurns(turns)
	return t
}

function parseJsonl(text) {
	const out = []
	for (const line of text.split("\n")) {
		const s = line.trim()
		if (!s) continue
		try {
			out.push(JSON.parse(s))
		} catch {
			// Transcripts interleave human-readable noise with events; skip it.
		}
	}
	return out
}

// Returns null when the transcript cannot be interpreted, so a caller can render
// n/a rather than inventing a zero. Zero is a real finding (no delegation).
export function topologyFromTranscript(text, {adapter} = {}) {
	if (typeof text !== "string" || !text.trim()) return null
	if (adapter === "pi") return analyzePiEvents(parseJsonl(text))
	// The reference harness emits pi-compatible events plus model_call/retry.
	if (adapter === "reference") return analyzePiEvents(parseJsonl(text), {parse: "reference-events"})
	if (adapter === "codex") return analyzeCodexEvents(parseJsonl(text))
	// claude's --output-format stream-json carries per-message tool_use blocks;
	// the older single-object json output has none and stays null: no per-tool
	// detail is "unknown", not "zero calls".
	if (adapter === "claude") {
		const events = parseJsonl(text)
		if (!events.some(e => e && e.type === "assistant")) return null
		return analyzeClaudeEvents(events)
	}
	return null
}

function normalizeReads(r) {
	if (!r || typeof r !== "object") return null
	const calls = asNum(r.calls)
	if (calls == null) return null
	const distinct = asNum(r.distinct_files) ?? calls
	const rereads = asNum(r.rereads) ?? calls - distinct
	return {
		calls,
		distinct_files: distinct,
		rereads,
		reread_ratio: calls ? rereads / calls : null,
		result_chars: asNum(r.result_chars) ?? 0,
		via_bash: asNum(r.via_bash) ?? 0,
		via_bash_files: asNum(r.via_bash_files) ?? 0
	}
}

function normalizeContext(c) {
	if (!c || typeof c !== "object") return null
	const turns = asNum(c.turns)
	const first = asNum(c.input_first)
	const last = asNum(c.input_last)
	if (turns == null || first == null || last == null) return null
	return {
		turns,
		input_first: first,
		input_last: last,
		input_mean: asNum(c.input_mean),
		input_max: asNum(c.input_max),
		input_total: asNum(c.input_total),
		output_total: asNum(c.output_total),
		growth: asNum(c.growth) ?? (first > 0 ? last / first : null),
		cache_read_ratio: asNum(c.cache_read_ratio)
	}
}

export function normalizeTopology(t) {
	if (!t || typeof t !== "object") return null
	const sub = t.subagents && typeof t.subagents === "object" ? t.subagents : {}
	// A record carrying no numeric count anywhere is not a measurement. Coercing it
	// to zeros would claim the harness does no work, which is exactly the
	// zero-versus-unknown confusion this module exists to keep apart.
	if (asNum(t.total_tool_calls) == null && asNum(t.retries) == null && asNum(sub.calls) == null) return null
	return {
		parse: typeof t.parse === "string" ? t.parse : "unknown",
		total_tool_calls: asNum(t.total_tool_calls) ?? 0,
		tool_calls: t.tool_calls && typeof t.tool_calls === "object" ? t.tool_calls : {},
		tool_errors: t.tool_errors && typeof t.tool_errors === "object" ? t.tool_errors : {},
		subagents: {
			calls: asNum(sub.calls) ?? 0,
			distinct: asNum(sub.distinct) ?? 0,
			by_agent: sub.by_agent && typeof sub.by_agent === "object" ? sub.by_agent : {},
			prompt_chars: asNum(sub.prompt_chars) ?? 0,
			max_prompt_chars: asNum(sub.max_prompt_chars) ?? 0
		},
		retries: asNum(t.retries) ?? 0,
		delegation_ratio: asNum(t.delegation_ratio) ?? null,
		// Records written before these fields existed carry null here, never 0:
		// "we did not measure reads" is not "the harness read nothing".
		reads: normalizeReads(t.reads),
		tool_result_chars: asNum(t.tool_result_chars),
		tool_result_chars_by_tool: t.tool_result_chars_by_tool && typeof t.tool_result_chars_by_tool === "object" ? t.tool_result_chars_by_tool : {},
		context: normalizeContext(t.context)
	}
}

// A recorded topology that predates the efficiency fields can be completed from
// the transcript-derived one without disturbing the counts the adapter recorded.
export function mergeTopology(recorded, derived) {
	const r = normalizeTopology(recorded)
	const d = normalizeTopology(derived)
	if (!r) return d
	if (!d) return r
	return {
		...r,
		reads: r.reads ?? d.reads,
		tool_result_chars: r.tool_result_chars ?? d.tool_result_chars,
		tool_result_chars_by_tool: Object.keys(r.tool_result_chars_by_tool).length ? r.tool_result_chars_by_tool : d.tool_result_chars_by_tool,
		context: r.context ?? d.context
	}
}

function meanOf(values) {
	const present = values.filter(v => asNum(v) != null)
	return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null
}

// Aggregate many per-trial topologies into one harness-level signature. Agent
// names are unioned so a harness that uses two different sub-agents is visible
// as exactly that. Ratios are aggregated as RATIOS OF SUMS, never as means of
// per-trial ratios: a trial with one read and one reread would otherwise weigh
// as much as one with fifty reads.
export function aggregateTopology(list) {
	const present = list.filter(Boolean).map(normalizeTopology).filter(Boolean)
	if (!present.length) return null
	const tool_calls = {}
	const tool_errors = {}
	const by_agent = {}
	const result_by_tool = {}
	let total = 0
	let calls = 0
	let retries = 0
	let promptChars = 0
	for (const t of present) {
		total += t.total_tool_calls
		calls += t.subagents.calls
		retries += t.retries
		promptChars += t.subagents.prompt_chars
		for (const [k, v] of Object.entries(t.tool_calls)) tool_calls[k] = (tool_calls[k] || 0) + v
		for (const [k, v] of Object.entries(t.tool_errors)) tool_errors[k] = (tool_errors[k] || 0) + v
		for (const [k, v] of Object.entries(t.subagents.by_agent)) by_agent[k] = (by_agent[k] || 0) + v
		for (const [k, v] of Object.entries(t.tool_result_chars_by_tool)) result_by_tool[k] = (result_by_tool[k] || 0) + v
	}

	const withReads = present.filter(t => t.reads)
	let reads = null
	if (withReads.length) {
		const sum = k => withReads.reduce((a, t) => a + t.reads[k], 0)
		const readCalls = sum("calls")
		reads = {
			trials: withReads.length,
			calls: readCalls,
			mean_calls: readCalls / withReads.length,
			distinct_files: sum("distinct_files"),
			rereads: sum("rereads"),
			reread_ratio: readCalls ? sum("rereads") / readCalls : null,
			result_chars: sum("result_chars"),
			mean_result_chars: sum("result_chars") / withReads.length,
			via_bash: sum("via_bash"),
			mean_via_bash: sum("via_bash") / withReads.length,
			via_bash_files: sum("via_bash_files")
		}
	}

	const withChars = present.filter(t => t.tool_result_chars != null)
	const toolResultChars = withChars.length ? withChars.reduce((a, t) => a + t.tool_result_chars, 0) : null

	const withCtx = present.filter(t => t.context)
	let context = null
	if (withCtx.length) {
		const firsts = withCtx.reduce((a, t) => a + t.context.input_first, 0)
		const lasts = withCtx.reduce((a, t) => a + t.context.input_last, 0)
		const totals = withCtx.map(t => t.context.input_total).filter(v => v != null)
		const cacheNum = withCtx.map(t => (t.context.cache_read_ratio != null && t.context.input_total != null ? t.context.cache_read_ratio * t.context.input_total : null))
		const cachePresent = cacheNum.filter(v => v != null)
		context = {
			trials: withCtx.length,
			mean_turns: meanOf(withCtx.map(t => t.context.turns)),
			mean_input_first: firsts / withCtx.length,
			mean_input_last: lasts / withCtx.length,
			mean_input_mean: meanOf(withCtx.map(t => t.context.input_mean)),
			mean_input_max: meanOf(withCtx.map(t => t.context.input_max)),
			growth: firsts > 0 ? lasts / firsts : null,
			cache_read_ratio: cachePresent.length && totals.length ? cachePresent.reduce((a, b) => a + b, 0) / totals.reduce((a, b) => a + b, 0) : null
		}
	}

	return {
		trials: present.length,
		total_tool_calls: total,
		mean_tool_calls: total / present.length,
		tool_calls,
		tool_errors,
		subagents: {
			calls,
			mean_calls: calls / present.length,
			distinct: Object.keys(by_agent).length,
			by_agent,
			prompt_chars: promptChars
		},
		retries,
		mean_retries: retries / present.length,
		delegation_ratio: total ? calls / total : null,
		reads,
		tool_result_chars: toolResultChars,
		mean_tool_result_chars: toolResultChars != null ? toolResultChars / withChars.length : null,
		tool_result_chars_by_tool: result_by_tool,
		context
	}
}
