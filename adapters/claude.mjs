import {spawn} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {FAILURE_MODES, PROVIDER_ERROR_RE} from "../harness/registry.mjs"
import {topologyFromTranscript} from "../harness/topology.mjs"
import {armBudget, awaitExit} from "../harness/proc.mjs"

// Claude Code injects a synthetic user turn when the provider cut the response
// stream ("Your response above was cut off mid-stream"). One such trial then
// hung for 33 minutes with no further event: the provider dropped the stream and
// the harness never recovered. That is provider framing (isSynthetic events are
// harness-level text, never the agent's), so a FAILED run carrying it is a
// provider_error, excluded from rates like any other infra failure.
const STREAM_CUTOFF_RE = /cut off mid-stream|response was truncated by the provider|stream (was )?(interrupted|disconnected)/i

// When the CLI is killed before it prints its final "result" object, the
// per-message usage in the stream-json events is still the harness's own report,
// at a finer grain. Sum it (one API message is split across several assistant
// events with the same message.id, so de-duplicate by id, keeping the last).
// cost stays null: the events carry no dollar figure, and prices.mjs estimates.
export function telemetryFromStream(stdout) {
	const byId = new Map()
	const order = []
	let synthetic = 0
	for (const line of String(stdout || "").split("\n")) {
		const t = line.trim()
		if (!t.startsWith("{")) continue
		let e
		try {
			e = JSON.parse(t)
		} catch {
			continue
		}
		if (e && e.type === "user" && e.isSynthetic === true) {
			const txt = JSON.stringify(e.message && e.message.content)
			if (STREAM_CUTOFF_RE.test(txt)) synthetic++
		}
		if (!e || e.type !== "assistant" || !e.message || typeof e.message !== "object") continue
		const u = e.message.usage
		if (!u || typeof u !== "object") continue
		const id = typeof e.message.id === "string" ? e.message.id : `anon:${order.length}`
		if (!byId.has(id)) order.push(id)
		byId.set(id, u)
	}
	if (!order.length) return {telemetry: null, messages: 0, stream_cutoffs: synthetic}
	const sum = {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0}
	for (const id of order) {
		const u = byId.get(id)
		sum.input_tokens += num(u.input_tokens) ?? 0
		sum.output_tokens += num(u.output_tokens) ?? 0
		sum.cache_read_tokens += num(u.cache_read_input_tokens) ?? 0
		sum.cache_write_tokens += num(u.cache_creation_input_tokens) ?? 0
	}
	return {telemetry: {...sum, cost_usd: null}, messages: order.length, stream_cutoffs: synthetic}
}

// Headless invocation, discovered from `claude --help` (Claude Code 2.1.261):
//   -p, --print                    non-interactive: print the response and exit
//   --output-format json           single JSON result object on stdout
//                                  (documented as only working with --print)
//   --model <model>                pin an alias or a full model name
//   --permission-mode acceptEdits  auto-approve edits
//   --permission-prompts none      nothing answers a prompt: anything that is not
//                                  auto-approved is denied instead of hanging
//   --setting-sources user         do not load project/local settings from the worktree
//   --no-session-persistence       do not persist the session transcript
//
// Containment (verified against 2.1.261): with `--permission-mode acceptEdits
// --permission-prompts none` and no `--add-dir`, out-of-cwd Write/Edit are denied and
// recorded in `permission_denials`. Bash is pre-approved via `--allowedTools Bash`
// (see the args below), so shell containment is the sandbox's job, as it is for pi and
// codex: the worktree is disposable and the fix commit is unreachable from it.
// `--dangerously-skip-permissions` / `bypassPermissions` are still never used, and
// `--add-dir` is never passed.
//
// The prompt is delivered on stdin instead of argv: prompts carry whole commit
// messages and can exceed ARG_MAX.
const AUTH_RE =
	/not logged in|please run \/login|oauth token|invalid api key|api key.{0,20}(invalid|missing|expired)|authentication_error|unauthorized|no credentials|credentials.{0,20}(missing|expired|invalid)|\b(401|403)\b.{0,40}(unauthorized|forbidden|auth)/i
const CONTEXT_RE =
	/prompt is too long|input length and `max_tokens` exceed context limit|context limit( reached)?|exceeds? (the )?(model'?s )?maximum context|too many tokens|token limit exceeded|conversation.{0,20}too long/i

// Real values observed from a successful 2.1.261 run, e.g.
// {"usage":{"input_tokens":22,"cache_creation_input_tokens":21615,
//           "cache_read_input_tokens":21338,"output_tokens":234},"total_cost_usd":0.09103365}
const FIELD_MAP = {
	input_tokens: ["usage", "input_tokens"],
	output_tokens: ["usage", "output_tokens"],
	cache_read_tokens: ["usage", "cache_read_input_tokens"],
	cache_write_tokens: ["usage", "cache_creation_input_tokens"],
	cost_usd: []
}

function whichSync(cmd) {
	for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
		const p = path.join(d, cmd)
		try {
			fs.accessSync(p, fs.constants.X_OK)
			return p
		} catch {}
	}
	return null
}

function resolveBin() {
	if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
	return whichSync("claude") || "claude"
}

function pick(obj, keys) {
	let cur = obj
	for (const k of keys) {
		if (cur == null || typeof cur !== "object") return null
		cur = cur[k]
	}
	return cur
}

// A field is null unless the CLI actually reported a finite number for it.
function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null
}

// `--output-format json` prints one JSON object. Tolerate leading noise (warnings
// written to stdout) by scanning for the first parseable object line too.
function parseResult(stdout) {
	const trimmed = stdout.trim()
	if (!trimmed) return {result: null, parseError: "empty stdout"}
	try {
		const o = JSON.parse(trimmed)
		if (o && typeof o === "object") return {result: o, parseError: null}
	} catch {}
	for (const line of trimmed.split("\n")) {
		const t = line.trim()
		if (!t.startsWith("{")) continue
		try {
			const o = JSON.parse(t)
			if (o && typeof o === "object" && (o.type === "result" || "usage" in o || "is_error" in o)) {
				return {result: o, parseError: null}
			}
		} catch {}
	}
	return {result: null, parseError: "no parseable JSON result object on stdout"}
}

function extractTelemetry(result) {
	const telemetry = {}
	for (const [field, keys] of Object.entries(FIELD_MAP)) {
		const raw = keys.length ? pick(result, keys) : result && result.total_cost_usd
		telemetry[field] = num(raw)
	}
	return telemetry
}

export default {
	name: "claude",
	version: "1",

	async run({prompt, dir, model, budgetMs, outDir}) {
		const started = Date.now()
		const bin = resolveBin()
		const args = [
			"--print",
			// stream-json (JSONL, one event per line; needs --verbose in print mode)
			// carries every assistant message with its tool_use blocks and per-message
			// usage, plus the same final "result" object as --output-format json. That
			// is what makes topology (tool calls, sub-agents, reads, context growth)
			// derivable for Claude Code at all; plain json has no per-tool detail.
			"--output-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			"acceptEdits",
			"--permission-prompts",
			"none",
			// No settings sources at all: "user" loaded the operator's personal
			// plugins and SessionStart hooks (observed: a 16 KB plugin context block
			// injected into every session), which is not part of the harness under
			// test. Auth and Bedrock routing come from the environment. Built-in
			// tools and skills remain, since they ARE the harness.
			"--setting-sources",
			"",
			"--no-session-persistence",
			// acceptEdits auto-approves file edits but NOT shell commands; with
			// --permission-prompts none every Bash call was silently denied, so the
			// harness could edit but never run a test (observed: 2 Bash denials per
			// session, and the agent asking for shell access in its final message).
			// A harness without a shell is not the harness being measured. Bash is
			// pre-approved here, which matches what pi (--no-approve) and codex get.
			"--allowedTools",
			"Bash"
		]
		if (model) args.push("--model", String(model))
		// Effort is a harness CONFIGURATION, so a run at a non-default effort is a
		// distinct harness and must be labelled (CLAUDE_HARNESS_LABEL), never merged
		// into the default arm's rows.
		const effort = (process.env.CLAUDE_EFFORT || "").trim()
		if (effort) args.push("--effort", effort)

		const transcriptPath = path.resolve(outDir || ".", "transcript.txt")
		fs.mkdirSync(path.dirname(transcriptPath), {recursive: true})

		let stdout = ""
		let stderr = ""
		let exitCode = -1
		let signal = null
		let spawnError = null
		let timedOut = false

		const budget = Number(budgetMs)
		const hasBudget = Number.isFinite(budget) && budget > 0

		const child = spawn(bin, args, {
			cwd: dir,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env
		})

		// Budget: SIGTERM the whole process TREE (group plus every descendant, since
		// a tool the harness runs may sit in its own group), SIGKILL 5s later, and
		// never wait on a pipe a stray grandchild still holds (harness/proc.mjs).
		const budgetArm = armBudget(child, hasBudget ? budget : null, {onTimeout: () => (timedOut = true)})

		child.stdout.on("data", c => (stdout += c.toString("utf8")))
		child.stderr.on("data", c => (stderr += c.toString("utf8")))
		child.stdout.on("error", () => {})
		child.stderr.on("error", () => {})
		// The CLI can exit before consuming stdin; EPIPE must not crash the adapter.
		child.stdin.on("error", () => {})
		child.stdin.end(prompt == null ? "" : String(prompt), "utf8")

		const exited = await awaitExit(child, {onError: err => (spawnError = err)})
		exitCode = exited.code
		signal = exited.signal
		budgetArm.cancel()
		const wallMs = Date.now() - started

		// Full raw stdout and stderr, always written even when the run was killed.
		const transcript = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")
		let transcriptError = null
		try {
			fs.writeFileSync(transcriptPath, transcript, "utf8")
		} catch (e) {
			transcriptError = e.message
		}

		const {result, parseError} = parseResult(stdout)
		let telemetry = extractTelemetry(result)
		const stream = telemetryFromStream(stdout)
		let telemetrySource = "result"
		if (!result || telemetry.input_tokens === null) {
			if (stream.telemetry) {
				telemetry = stream.telemetry
				telemetrySource = `stream-sum(${stream.messages} messages)`
			}
		}

		const resultText = result && typeof result.result === "string" ? result.result : ""
		const isError = !!(result && result.is_error === true)
		const terminalReason = result && result.terminal_reason ? String(result.terminal_reason) : null
		const numTurns = num(result && result.num_turns)
		const denials = Array.isArray(result && result.permission_denials) ? result.permission_denials.length : null
		const observedModels = result && result.modelUsage && typeof result.modelUsage === "object"
			? Object.keys(result.modelUsage)
			: []

		// Only look for auth/context signatures when the run actually failed, so an
		// agent quoting an error string in its final message cannot misclassify it.
		const failed = !!spawnError || timedOut || !result || isError || exitCode !== 0
		const haystack = `${resultText}\n${stderr}\n${stdout.slice(-4000)}`

		let failureMode
		// A dropped provider stream that the harness never recovered from is the
		// provider's failure even when the budget is what finally ended the run.
		if (failed && stream.stream_cutoffs > 0 && !resultText) failureMode = "provider_error"
		else if (timedOut) failureMode = "agent_timeout"
		else if (spawnError) failureMode = "harness_crash"
		// Only stderr: `haystack` also carries the agent's final message and stdout
		// tail, and an agent failing on an HTTP task can print a status code that
		// would otherwise be mistaken for the provider refusing to serve.
		else if (failed && PROVIDER_ERROR_RE.test(stderr)) failureMode = "provider_error"
		else if (failed && AUTH_RE.test(haystack)) failureMode = "auth_error"
		else if (failed && CONTEXT_RE.test(haystack)) failureMode = "context_limit"
		else if (failed && (isError || result)) failureMode = "unknown"
		else if (failed) failureMode = "harness_crash"
		else failureMode = "none"
		if (!FAILURE_MODES.includes(failureMode)) failureMode = "unknown"

		const notes = [
			`cmd: ${bin} ${args.join(" ")} (prompt via stdin, cwd=${dir})`,
			`telemetry: ${telemetrySource === "result" ? "usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens} + total_cost_usd" : `${telemetrySource}; no result object; per-message output_tokens are partial so output is a LOWER BOUND; cost null (estimated downstream)`}`,
			stream.stream_cutoffs ? `stream_cutoffs=${stream.stream_cutoffs}` : "",
			!exited.closed ? "stdio_not_closed=true (a descendant held the pipe past the grace period)" : "",
			result ? `subtype=${result.subtype ?? "?"} is_error=${isError} terminal_reason=${terminalReason ?? "?"} turns=${numTurns ?? "?"}` : `parse_error=${parseError}`,
			denials != null ? `permission_denials=${denials}` : "",
			observedModels.length ? `observed_model=${observedModels.join(",")}` : "",
			signal ? `signal=${signal}` : "",
			resultText ? `result=${resultText.slice(0, 300)}` : "",
			spawnError ? `spawn_error=${spawnError.message}` : "",
			transcriptError ? `transcript_error=${transcriptError}` : ""
		]
			.filter(Boolean)
			.join("; ")
			.slice(0, 1200)

		return {
			harness: (process.env.CLAUDE_HARNESS_LABEL || "").trim() || "claude",
			model: model ? String(model) : observedModels[0] || null,
			exit_code: exitCode,
			timed_out: timedOut,
			wall_ms: wallMs,
			failure_mode: failureMode,
			telemetry,
			transcript_path: transcriptPath,
			turns: numTurns ?? (stream.messages > 0 && telemetrySource !== "result" ? stream.messages : null),
			topology: topologyFromTranscript(stdout, {adapter: "claude"}),
			notes
		}
	}
}
