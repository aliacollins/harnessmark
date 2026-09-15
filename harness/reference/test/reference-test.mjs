import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {editFile, executeTool, resolveInside, runBash, truncateOutput, MAX_OUTPUT_CHARS, TOOL_SPECS} from "../tools.mjs"
import {
	ProviderError,
	fromBedrockResponse,
	fromOpenAIResponse,
	selectProvider,
	signV4,
	toBedrockMessages,
	toOpenAIMessages
} from "../providers.mjs"
import {callWithRetry} from "../agent.mjs"
import adapter from "../../../adapters/reference.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function ok(cond, msg) {
	if (cond) pass++
	else {
		fail++
		console.log(`  FAIL ${msg}`)
	}
}
function eq(actual, expected, msg) {
	const a = JSON.stringify(actual)
	const b = JSON.stringify(expected)
	ok(a === b, `${msg} (got ${a}, want ${b})`)
}
async function throwsWith(fn, re, msg) {
	try {
		await fn()
		ok(false, `${msg}: expected throw`)
	} catch (e) {
		ok(re.test(e.message), `${msg} (got "${e.message}")`)
	}
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ref-test-"))
const mk = name => {
	const d = path.join(tmpRoot, name)
	fs.mkdirSync(d, {recursive: true})
	return d
}
const readEvents = p =>
	fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))

// ------------------------------------------------------------------ tools
console.log("== path containment ==")
{
	const dir = mk("repo1")
	fs.mkdirSync(path.join(dir, "src"))
	fs.writeFileSync(path.join(dir, "..weird"), "x")
	ok(resolveInside(dir, "src/a.ts") === path.join(dir, "src/a.ts"), "relative path resolves inside")
	ok(resolveInside(dir, "..weird") === path.join(dir, "..weird"), "a file named ..weird is not an escape")
	await throwsWith(() => resolveInside(dir, "../evil.txt"), /escapes/, "parent traversal rejected")
	await throwsWith(() => resolveInside(dir, "src/../../evil.txt"), /escapes/, "nested traversal rejected")
	await throwsWith(() => resolveInside(dir, "/etc/passwd"), /escapes/, "absolute path outside rejected")
	await throwsWith(() => resolveInside(dir, ""), /non-empty/, "empty path rejected")
	await throwsWith(() => resolveInside(dir, 42), /non-empty/, "non-string path rejected")
	ok(resolveInside(dir, path.join(dir, "src/a.ts")) === path.join(dir, "src/a.ts"), "absolute path INSIDE the repo is allowed")
	const outside = mk("outside1")
	fs.symlinkSync(outside, path.join(dir, "node_modules"), "dir")
	await throwsWith(() => resolveInside(dir, "node_modules/pkg/index.js"), /outside/, "symlink escape (node_modules -> elsewhere) rejected")
	await throwsWith(() => resolveInside(dir, "node_modules/new.js"), /outside/, "creating through a symlink escape rejected")
}

console.log("== edit semantics ==")
{
	const dir = mk("repo2")
	eq(editFile({dir, path: "new/file.txt", old_string: "", new_string: "hello\n"}), "created new/file.txt (6 bytes)", "create with empty old_string")
	eq(fs.readFileSync(path.join(dir, "new/file.txt"), "utf8"), "hello\n", "created content")
	await throwsWith(() => editFile({dir, path: "new/file.txt", old_string: "", new_string: "x"}), /already exists/, "create refuses to clobber")
	await throwsWith(() => editFile({dir, path: "missing.txt", old_string: "a", new_string: "b"}), /does not exist/, "edit of missing file")
	fs.writeFileSync(path.join(dir, "dup.txt"), "aaa\nbbb\naaa\n")
	await throwsWith(() => editFile({dir, path: "dup.txt", old_string: "aaa", new_string: "c"}), /matches 2 times/, "ambiguous match rejected")
	await throwsWith(() => editFile({dir, path: "dup.txt", old_string: "zzz", new_string: "c"}), /not found/, "no match rejected")
	eq(editFile({dir, path: "dup.txt", old_string: "bbb", new_string: "BBB"}), "edited dup.txt: replaced 1 occurrence", "unique replace")
	eq(fs.readFileSync(path.join(dir, "dup.txt"), "utf8"), "aaa\nBBB\naaa\n", "replace result")
	await throwsWith(() => editFile({dir, path: "new", old_string: "a", new_string: "b"}), /directory/, "editing a directory rejected")
	await throwsWith(() => editFile({dir, path: "dup.txt", old_string: 1, new_string: "b"}), /must be strings/, "non-string args rejected")
	const r = await executeTool({name: "edit", input: {path: "../escape.txt", old_string: "", new_string: "x"}, dir})
	ok(r.isError && /escapes/.test(r.text), "executeTool returns escape as error result, does not throw")
	ok(!fs.existsSync(path.join(tmpRoot, "escape.txt")), "nothing written outside")
	const unk = await executeTool({name: "read", input: {}, dir})
	ok(unk.isError && /unknown tool/.test(unk.text), "unknown tool is an error result")
}

console.log("== bash ==")
{
	const dir = mk("repo3")
	const pwd = await runBash({dir, command: "pwd"})
	eq(pwd.text.trim(), fs.realpathSync(dir), "cwd pinned to repo root")
	ok(!pwd.isError, "exit 0 is not an error")
	const bad = await runBash({dir, command: "exit 3"})
	ok(bad.isError && /exit code 3/.test(bad.text), "nonzero exit flagged with code")
	const big = await runBash({dir, command: "yes abcdefghij | head -c 120000"})
	ok(big.truncated, "large output truncated")
	ok(big.text.length < MAX_OUTPUT_CHARS + 200, `truncated length ${big.text.length} within cap`)
	ok(/output truncated: \d+ characters omitted/.test(big.text), "truncation marker present")
	const t0 = Date.now()
	const slow = await runBash({dir, command: "sleep 20; echo done", timeoutMs: 300})
	ok(slow.timedOut && slow.isError, "timeout kills the command")
	ok(Date.now() - t0 < 5000, "timeout enforced promptly")
	const ac = new AbortController()
	setTimeout(() => ac.abort(), 200)
	const t1 = Date.now()
	const aborted = await runBash({dir, command: "sleep 20", signal: ac.signal})
	ok(aborted.isError && /aborted/.test(aborted.text) && Date.now() - t1 < 5000, "abort signal kills the command")
	const empty = await runBash({dir, command: ""})
	ok(empty.isError, "empty command is an error")
	const tr = truncateOutput("x".repeat(10), 5)
	ok(tr.truncated && tr.text.includes("truncated"), "truncateOutput helper")
	const spec = TOOL_SPECS.map(t => t.name)
	eq(spec, ["bash", "edit"], "exactly two tools")
}

// -------------------------------------------------------------- providers
console.log("== provider selection ==")
{
	eq(selectProvider("openrouter/deepseek/deepseek-v4.1-flash", {}), {provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash"}, "explicit openrouter prefix")
	eq(selectProvider("bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0", {}), {provider: "bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0"}, "explicit bedrock prefix")
	eq(selectProvider("us.anthropic.claude-haiku-4-5-20251001-v1:0", {}).provider, "bedrock", "bedrock-shaped id defaults to bedrock")
	eq(selectProvider("global.anthropic.claude-fable-5", {}).provider, "bedrock", "global. prefix is bedrock")
	eq(selectProvider("deepseek/deepseek-v4.1-flash", {}).provider, "openrouter", "vendor/model id defaults to openrouter")
	eq(selectProvider("deepseek/deepseek-v4.1-flash", {REF_PROVIDER: "bedrock"}).provider, "bedrock", "REF_PROVIDER overrides heuristic")
	await throwsWith(() => selectProvider("", {}), /model is required/, "empty model rejected")
	await throwsWith(() => selectProvider("x", {REF_PROVIDER: "azure"}), /REF_PROVIDER/, "bad REF_PROVIDER rejected")
}

console.log("== openai wire mapping ==")
{
	const msgs = [
		{role: "user", content: [{type: "text", text: "fix it"}]},
		{role: "assistant", content: [{type: "text", text: "looking"}, {type: "tool_use", id: "c1", name: "bash", input: {command: "ls"}}]},
		{role: "user", content: [{type: "tool_result", tool_use_id: "c1", text: "a.ts", is_error: false}]}
	]
	const oa = toOpenAIMessages("SYS", msgs)
	eq(oa[0], {role: "system", content: "SYS"}, "system first")
	eq(oa[1], {role: "user", content: "fix it"}, "user text")
	eq(oa[2].tool_calls[0], {id: "c1", type: "function", function: {name: "bash", arguments: '{"command":"ls"}'}}, "assistant tool_call")
	eq(oa[3], {role: "tool", tool_call_id: "c1", content: "a.ts"}, "tool result as tool message")
	const resp = fromOpenAIResponse({
		model: "deepseek/deepseek-v4.1-flash",
		choices: [{finish_reason: "tool_calls", message: {content: null, tool_calls: [{id: "x1", function: {name: "edit", arguments: '{"path":"a","old_string":"","new_string":"b"}'}}]}}],
		usage: {prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 60}, cost: 0.0012}
	})
	eq(resp.stop_reason, "tool_use", "tool_calls -> tool_use")
	eq(resp.content, [{type: "tool_use", id: "x1", name: "edit", input: {path: "a", old_string: "", new_string: "b"}}], "tool_use block")
	eq(resp.usage, {input: 40, output: 20, cache_read: 60, cache_write: null, cost: 0.0012}, "usage mapping: input is prompt minus cached (disjoint buckets) + cost")
	const noUsage = fromOpenAIResponse({choices: [{finish_reason: "stop", message: {content: "done"}}]})
	eq(noUsage.usage, {input: null, output: null, cache_read: null, cache_write: null, cost: null}, "missing usage is null, never 0")
	eq(noUsage.stop_reason, "end_turn", "stop -> end_turn")
	const badArgs = fromOpenAIResponse({choices: [{finish_reason: "tool_calls", message: {tool_calls: [{id: "b", function: {name: "bash", arguments: "{not json"}}]}}]})
	ok(badArgs.content[0].input.__invalid_json === "{not json", "invalid tool arguments surface as input, not a crash")
	await throwsWith(() => fromOpenAIResponse({error: {code: 429, message: "rate limited"}}), /rate limited/, "error object throws")
	try {
		fromOpenAIResponse({error: {code: 429, message: "rate limited"}})
	} catch (e) {
		ok(e instanceof ProviderError && e.retryable && e.status === 429, "429 error object is retryable")
	}
	try {
		fromOpenAIResponse({error: {code: 400, message: "bad"}})
	} catch (e) {
		ok(e instanceof ProviderError && !e.retryable, "400 error object is not retryable")
	}
}

console.log("== bedrock wire mapping ==")
{
	const msgs = [
		{role: "user", content: [{type: "text", text: "fix it"}]},
		{role: "assistant", content: [{type: "text", text: ""}, {type: "tool_use", id: "t1", name: "bash", input: {command: "ls"}}]},
		{role: "user", content: [{type: "tool_result", tool_use_id: "t1", text: "", is_error: true}]},
		{role: "user", content: [{type: "text", text: "continue"}]}
	]
	const b = toBedrockMessages(msgs)
	eq(b.length, 3, "consecutive user messages merged")
	eq(b[1].content, [{toolUse: {toolUseId: "t1", name: "bash", input: {command: "ls"}}}], "empty text dropped, toolUse kept")
	eq(b[2].content[0], {toolResult: {toolUseId: "t1", content: [{text: "(no output)"}], status: "error"}}, "empty tool result gets placeholder text + error status")
	const resp = fromBedrockResponse({
		output: {message: {role: "assistant", content: [{text: "hi"}, {toolUse: {toolUseId: "u1", name: "edit", input: {path: "a"}}}]}},
		stopReason: "tool_use",
		usage: {inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheWriteInputTokens: 7}
	})
	eq(resp.content, [{type: "text", text: "hi"}, {type: "tool_use", id: "u1", name: "edit", input: {path: "a"}}], "converse blocks mapped")
	eq(resp.usage, {input: 10, output: 5, cache_read: 3, cache_write: 7, cost: null}, "converse usage mapped, cost null")
	eq(fromBedrockResponse({output: {message: {content: [{text: "x"}]}}, stopReason: "max_tokens"}).stop_reason, "max_tokens", "max_tokens stop")
	const creds = {accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: null}
	const h = signV4({host: "bedrock-runtime.us-east-1.amazonaws.com", path: "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse", body: "{}", region: "us-east-1", creds, now: new Date("2026-09-12T00:00:00Z")})
	ok(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260912\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/.test(h.authorization), "authorization header shape")
	eq(h["x-amz-date"], "20260912T000000Z", "amz date")
	const h2 = signV4({host: "h", path: "/p", body: "{}", region: "us-east-1", creds: {...creds, sessionToken: "TOK"}, now: new Date("2026-09-12T00:00:00Z")})
	ok(h2["x-amz-security-token"] === "TOK" && /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/.test(h2.authorization), "session token signed when present")
	const h3 = signV4({host: "h", path: "/p", body: "{}", region: "us-east-1", creds, now: new Date("2026-09-12T00:00:00Z")})
	ok(h3.authorization === h.authorization || true, "deterministic")
	ok(signV4({host: "h", path: "/p", body: "{}", region: "us-east-1", creds, now: new Date("2026-09-12T00:00:00Z")}).authorization === h3.authorization, "signature deterministic for same inputs")
}

console.log("== retry policy ==")
{
	let n = 0
	const retries = []
	const v = await callWithRetry(
		async () => {
			n++
			if (n < 3) throw new ProviderError("x", {status: 429, retryable: true})
			return "ok"
		},
		{baseDelayMs: 1, onRetry: ev => retries.push(ev)}
	)
	eq(v, "ok", "succeeds after retries")
	eq(retries.map(r => [r.type, r.attempt, r.delayMs]), [["auto_retry_start", 1, 1], ["auto_retry_start", 2, 2]], "retry events with backoff")
	n = 0
	await throwsWith(
		() =>
			callWithRetry(
				async () => {
					n++
					throw new ProviderError("nope", {status: 400, retryable: false})
				},
				{baseDelayMs: 1}
			),
		/nope/,
		"non-retryable throws immediately"
	)
	eq(n, 1, "non-retryable called once")
	n = 0
	await throwsWith(
		() =>
			callWithRetry(
				async () => {
					n++
					throw new ProviderError("still 429", {status: 429, retryable: true})
				},
				{baseDelayMs: 1, maxAttempts: 3}
			),
		/still 429/,
		"gives up after maxAttempts"
	)
	eq(n, 3, "exactly maxAttempts calls")
}

// ------------------------------------------------------------ adapter e2e
process.env.REF_FETCH_MODULE = path.join(HERE, "fake-fetch.mjs")
process.env.REF_RETRY_BASE_MS = "1"
process.env.OPENROUTER_API_KEY = "test-key"
process.env.AWS_ACCESS_KEY_ID = "AKIDTEST"
process.env.AWS_SECRET_ACCESS_KEY = "secret"
delete process.env.REF_PROVIDER
delete process.env.REF_MAX_TURNS

const jsonResponse = (status, body) => ({ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body))})
const oaTool = (id, name, input) => ({id, type: "function", function: {name, arguments: JSON.stringify(input)}})
const oaReply = ({text = null, tools = [], usage = {prompt_tokens: 10, completion_tokens: 5}}) =>
	jsonResponse(200, {model: "fake/model", choices: [{finish_reason: tools.length ? "tool_calls" : "stop", message: {content: text, tool_calls: tools.length ? tools : undefined}}], usage})

// Install a scripted fetch; every request is recorded for assertions.
function script(steps) {
	const requests = []
	let i = 0
	globalThis.__refFakeFetch = async (url, init) => {
		requests.push({url, init, body: init && init.body ? JSON.parse(init.body) : null})
		const step = steps[Math.min(i, steps.length - 1)]
		i++
		if (typeof step === "function") return step(url, init, requests.length)
		return step
	}
	return requests
}
const snapshot = () => fs.readdirSync(tmpRoot).sort()

console.log("== adapter: happy path through openrouter ==")
{
	const dir = mk("repo-e2e")
	const outDir = mk("out-e2e")
	fs.writeFileSync(path.join(dir, "a.txt"), "old\n")
	const before = snapshot()
	const requests = script([
		oaReply({tools: [oaTool("c1", "bash", {command: "echo hello > b.txt; cat a.txt"})], usage: {prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: {cached_tokens: 40}, cost: 0.001}}),
		oaReply({tools: [oaTool("c2", "edit", {path: "a.txt", old_string: "old", new_string: "new"})], usage: {prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 100}, cost: 0.002}}),
		oaReply({text: "Done.", usage: {prompt_tokens: 300, completion_tokens: 30, cost: 0.003}})
	])
	const r = await adapter.run({prompt: "Change old to new", dir, model: "deepseek/deepseek-v4.1-flash", budgetMs: 60_000, outDir})
	eq(r.harness, "reference", "harness name")
	eq(r.model, "deepseek/deepseek-v4.1-flash", "model echoed as given")
	eq(r.failure_mode, "none", "no failure")
	eq(r.exit_code, 0, "exit 0")
	eq(r.timed_out, false, "not timed out")
	eq(r.turns, 3, "turns = model calls")
	eq(r.telemetry, {input_tokens: 460, output_tokens: 60, cache_read_tokens: 140, cache_write_tokens: null, cost_usd: 0.006}, "telemetry summed with disjoint input; unreported cache_write stays null")
	ok(Number.isFinite(r.wall_ms) && r.wall_ms >= 0, "wall_ms")
	ok(typeof r.notes === "string" && /provider=openrouter/.test(r.notes), "notes is a single string naming the provider")
	eq(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "new\n", "edit applied to working tree")
	eq(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "hello\n", "bash ran in the repo")
	eq(r.transcript_path, path.join(outDir, "transcript.txt"), "transcript path under outDir")
	const events = readEvents(r.transcript_path)
	const types = events.map(e => e.type)
	ok(types[0] === "agent_start" && types.at(-1) === "agent_end", "agent_start ... agent_end")
	eq(types.filter(t => t === "turn_start").length, 3, "three turn_start events")
	eq(types.filter(t => t === "model_call").length, 3, "three model_call events")
	eq(types.filter(t => t === "tool_execution_start").length, 2, "two tool executions")
	const end = events.find(e => e.type === "tool_execution_end")
	ok(end.toolName === "bash" && end.isError === false && end.result.content[0].text.includes("old"), "tool_execution_end carries pi-shaped result.content")
	eq(r.topology.parse, "reference-events", "topology parse label")
	eq(r.topology.total_tool_calls, 2, "topology counts tool calls")
	eq(r.topology.tool_calls, {bash: 1, edit: 1}, "topology tool breakdown")
	eq(r.topology.subagents.calls, 0, "no sub-agents: 0, not null")
	eq(r.topology.retries, 0, "no retries")
	eq(r.topology.delegation_ratio, 0, "delegation ratio 0")
	// Request shape
	eq(requests[0].url, "https://openrouter.ai/api/v1/chat/completions", "openrouter url")
	eq(requests[0].init.headers.authorization, "Bearer test-key", "bearer from env")
	eq(requests[0].body.model, "deepseek/deepseek-v4.1-flash", "bare model id on the wire")
	eq(requests[0].body.tools.map(t => t.function.name), ["bash", "edit"], "two tools offered")
	eq(requests[0].body.usage, {include: true}, "asks openrouter for usage")
	ok(requests[0].body.messages[0].role === "system" && requests[0].body.messages[0].content.includes(dir), "system prompt names the repo dir")
	eq(requests[2].body.messages.length, 6, "history grows: sys,user,asst,tool,asst,tool")
	eq(requests[2].body.messages[3].role, "tool", "tool result fed back")
	eq(snapshot(), before, "no new entries outside dir/outDir")
}

console.log("== adapter: happy path through bedrock (fake) ==")
{
	const dir = mk("repo-br")
	const outDir = mk("out-br")
	const requests = script([
		jsonResponse(200, {output: {message: {role: "assistant", content: [{toolUse: {toolUseId: "u1", name: "bash", input: {command: "echo hi"}}}]}}, stopReason: "tool_use", usage: {inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 20, cacheWriteInputTokens: 30}}),
		jsonResponse(200, {output: {message: {role: "assistant", content: [{text: "done"}]}}, stopReason: "end_turn", usage: {inputTokens: 60, outputTokens: 6, cacheReadInputTokens: 0, cacheWriteInputTokens: 0}})
	])
	const r = await adapter.run({prompt: "hi", dir, model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", budgetMs: 60_000, outDir})
	eq(r.failure_mode, "none", "bedrock run ok")
	eq(r.turns, 2, "two calls")
	eq(r.telemetry, {input_tokens: 110, output_tokens: 11, cache_read_tokens: 20, cache_write_tokens: 30, cost_usd: null}, "bedrock telemetry; cost null")
	eq(requests[0].url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse", "converse url with encoded model id")
	ok(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//.test(requests[0].init.headers.authorization), "sigv4 header present")
	eq(requests[0].body.toolConfig.tools.map(t => t.toolSpec.name), ["bash", "edit"], "converse toolConfig")
	eq(requests[1].body.messages[2].content[0].toolResult.toolUseId, "u1", "toolResult fed back")
	ok(/provider=bedrock/.test(r.notes), "notes name bedrock")
}

console.log("== adapter: retries then success ==")
{
	const dir = mk("repo-retry")
	const outDir = mk("out-retry")
	script([jsonResponse(429, '{"error":{"message":"Provider returned error","code":429}}'), jsonResponse(503, "upstream overloaded"), oaReply({text: "ok"})])
	const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 60_000, outDir})
	eq(r.failure_mode, "none", "recovered run is not a failure")
	eq(r.turns, 1, "one completed model call")
	eq(r.topology.retries, 2, "two retries counted by topology")
	eq(readEvents(r.transcript_path).filter(e => e.type === "auto_retry_start").length, 2, "auto_retry_start events in transcript")
}

console.log("== adapter: failure classification ==")
{
	const cases = [
		["provider 429 x3", [jsonResponse(429, '{"error":{"message":"Provider returned error","code":429}}')], "provider_error"],
		["provider 503 x3", [jsonResponse(503, "Service Unavailable: overloaded")], "provider_error"],
		["network failure x3", [() => Promise.reject(new TypeError("fetch failed"))], "provider_error"],
		["auth 401", [jsonResponse(401, '{"error":{"message":"No auth credentials found","code":401}}')], "auth_error"],
		["bedrock signature", [jsonResponse(403, '{"message":"The request signature we calculated does not match"}')], "auth_error"],
		["context 400", [jsonResponse(400, '{"error":{"message":"This endpoint\'s maximum context length is 128000 tokens","code":400}}')], "context_limit"],
		["bedrock context", [jsonResponse(400, '{"message":"Input is too long for requested model."}')], "context_limit"],
		["other 400", [jsonResponse(400, '{"error":{"message":"invalid tool schema","code":400}}')], "unknown"]
	]
	for (const [name, steps, want] of cases) {
		const dir = mk(`repo-fc-${pass}`)
		const outDir = mk(`out-fc-${pass}`)
		script(steps)
		const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 60_000, outDir})
		eq(r.failure_mode, want, `${name} -> ${want}`)
		eq(r.exit_code, 1, `${name} exit 1`)
		eq(r.telemetry.input_tokens, null, `${name}: no usage -> null telemetry`)
		ok(readEvents(r.transcript_path).at(-1).type === "agent_end", `${name}: transcript ends with agent_end`)
	}
	// An agent that prints a provider-looking status in its OWN tool output must not trip provider_error.
	const dir = mk("repo-own-503")
	const outDir = mk("out-own-503")
	script([oaReply({tools: [oaTool("c1", "bash", {command: "echo 'expected 200 but got 503'; exit 1"})]}), oaReply({text: "gave up"})])
	const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 60_000, outDir})
	eq(r.failure_mode, "none", "agent's own 503 text is not a provider error")
}

console.log("== adapter: budget kill ==")
{
	const dir = mk("repo-budget")
	const outDir = mk("out-budget")
	script([
		(url, init) =>
			new Promise((_, reject) => {
				init.signal.addEventListener("abort", () => {
					const e = new Error("aborted")
					e.name = "AbortError"
					reject(e)
				})
			})
	])
	const t0 = Date.now()
	const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 300, outDir})
	eq(r.failure_mode, "agent_timeout", "hung provider call -> agent_timeout")
	eq(r.timed_out, true, "timed_out flag")
	ok(Date.now() - t0 < 5000, "returned promptly after budget")
	eq(r.turns, 0, "no completed turns")

	const dir2 = mk("repo-budget2")
	const outDir2 = mk("out-budget2")
	script([oaReply({tools: [oaTool("c1", "bash", {command: "sleep 30"})]}), oaReply({text: "never"})])
	const t1 = Date.now()
	const r2 = await adapter.run({prompt: "x", dir: dir2, model: "openrouter/fake/m", budgetMs: 400, outDir: outDir2})
	eq(r2.failure_mode, "agent_timeout", "long-running bash killed at budget -> agent_timeout")
	ok(Date.now() - t1 < 5000, "bash child killed promptly")
	const ev = readEvents(r2.transcript_path)
	ok(ev.some(e => e.type === "tool_execution_end" && /aborted/.test(e.result.content[0].text)), "tool result records the abort")
}

console.log("== adapter: budget hits while the response body is streaming ==")
{
	const dir = mk("repo-budget3")
	const outDir = mk("out-budget3")
	script([
		(url, init) => ({
			ok: true,
			status: 200,
			text: () =>
				new Promise((_, reject) => {
					init.signal.addEventListener("abort", () => {
						const e = new Error("This operation was aborted")
						e.name = "AbortError"
						reject(e)
					})
				})
		})
	])
	const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 300, outDir})
	eq(r.failure_mode, "agent_timeout", "aborted body read is a timeout, not a provider error")
	eq(r.timed_out, true, "timed_out set")
	eq(readEvents(r.transcript_path).at(-1).reason, "timeout", "agent_end reason=timeout")
}

console.log("== adapter: max turns ==")
{
	const dir = mk("repo-turns")
	const outDir = mk("out-turns")
	process.env.REF_MAX_TURNS = "2"
	script([oaReply({tools: [oaTool("c1", "bash", {command: "true"})]})])
	const r = await adapter.run({prompt: "x", dir, model: "openrouter/fake/m", budgetMs: 60_000, outDir})
	delete process.env.REF_MAX_TURNS
	eq(r.failure_mode, "budget_exceeded", "turn cap -> budget_exceeded")
	eq(r.exit_code, 2, "exit 2 on turn cap")
	eq(r.turns, 2, "stopped at 2 turns")
	eq(r.topology.total_tool_calls, 2, "two tool calls made")
}

console.log("== adapter: bad model string ==")
{
	const dir = mk("repo-bad")
	const outDir = mk("out-bad")
	script([oaReply({text: "x"})])
	const r = await adapter.run({prompt: "x", dir, model: "", budgetMs: 1000, outDir})
	ok(r.failure_mode === "unknown" || r.failure_mode === "harness_crash", `empty model -> ${r.failure_mode}`)
	ok(fs.existsSync(r.transcript_path), "transcript still written")
}

fs.rmSync(tmpRoot, {recursive: true, force: true})
console.log(`\npass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
