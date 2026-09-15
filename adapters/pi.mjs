import {spawn} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {FAILURE_MODES, PROVIDER_ERROR_RE} from "../harness/registry.mjs"
import {armBudget, awaitExit} from "../harness/proc.mjs"
import {analyzePiEvents} from "../harness/topology.mjs"

// Headless invocation, discovered from `pi --help` (pi 0.85.1):
//   --mode json   -> all session events as JSON lines on stdout
//   --print       -> non-interactive, process prompt and exit
//   --no-session  -> no session file side effects
//   --no-approve  -> ignore project-local .pi resources (non-interactive mode would
//                    otherwise use defaultProjectTrust, which is user-settable)
//   --model <m>   -> pin provider/model
// The prompt is delivered on stdin: `@foo` at the start of a positional argument is
// treated as a file reference by pi, and long prompts would hit ARG_MAX.
const AUTH_RE =
	/401|403|unauthorized|authentication|authenticate|invalid api key|api key.{0,20}(invalid|missing|not)|missing api key|no api key|not logged in|not authenticated|credential|\bauth\b/i
const CONTEXT_RE =
	/context (length|window|limit)|too many tokens|maximum context|prompt is too long|token limit|exceeds the (maximum )?context/i

function whichSync(cmd) {
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
	for (const d of dirs) {
		const p = path.join(d, cmd)
		try {
			fs.accessSync(p, fs.constants.X_OK)
			return p
		} catch {}
	}
	return null
}

// The harness CONFIGURATION is part of what is being measured: the same pi binary
// with delegation disabled is a different harness, and merging its rows into the
// default arm's would hide the very difference the comparison exists to find. So
// the policy comes from the environment and the label is recorded on the line.
function toolPolicyArgs() {
	const extra = []
	const only = (process.env.PI_TOOLS || "").trim()
	const exclude = (process.env.PI_EXCLUDE_TOOLS || "").trim()
	if (only) extra.push("--tools", only)
	if (exclude) extra.push("--exclude-tools", exclude)
	return extra
}

function harnessLabel() {
	const label = (process.env.PI_HARNESS_LABEL || "").trim()
	return label || "pi"
}

function toolPolicyNote() {
	const only = (process.env.PI_TOOLS || "").trim()
	const exclude = (process.env.PI_EXCLUDE_TOOLS || "").trim()
	if (!only && !exclude) return ""
	return `tool_policy=${only ? `only[${only}]` : "all"}${exclude ? ` exclude[${exclude}]` : ""}`
}

function resolveBin() {
	if (process.env.PI_BIN) return process.env.PI_BIN
	return whichSync("pi") || "pi"
}

function uniqueInOrder(a) {
	return [...new Set(a)]
}

function parseEvents(stdout) {
	const events = []
	let unparsed = 0
	for (const line of stdout.split("\n")) {
		const t = line.trim()
		if (!t) continue
		try {
			const o = JSON.parse(t)
			if (o && typeof o === "object") events.push(o)
			else unparsed++
		} catch {
			unparsed++
		}
	}
	return {events, unparsed}
}

function extractTelemetry(events) {
	const sum = {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0}
	const seen = {input_tokens: false, output_tokens: false, cache_read_tokens: false, cache_write_tokens: false, cost_usd: false}
	let usageMessages = 0
	// Only message_end carries the authoritative per-message usage; turn_end and
	// agent_end repeat the same objects and would double count.
	for (const ev of events) {
		if (ev.type !== "message_end") continue
		const u = ev.message && ev.message.usage
		if (!u || typeof u !== "object") continue
		usageMessages++
		if (typeof u.input === "number") (sum.input_tokens += u.input), (seen.input_tokens = true)
		if (typeof u.output === "number") (sum.output_tokens += u.output), (seen.output_tokens = true)
		if (typeof u.cacheRead === "number") (sum.cache_read_tokens += u.cacheRead), (seen.cache_read_tokens = true)
		if (typeof u.cacheWrite === "number") (sum.cache_write_tokens += u.cacheWrite), (seen.cache_write_tokens = true)
		if (u.cost && typeof u.cost.total === "number") (sum.cost_usd += u.cost.total), (seen.cost_usd = true)
	}
	const telemetry = {}
	for (const k of Object.keys(sum)) telemetry[k] = seen[k] ? sum[k] : null
	return {telemetry, usageMessages}
}

export default {
	name: "pi",
	version: "1",

	async run({prompt, dir, model, budgetMs, outDir}) {
		const started = Date.now()
		const bin = resolveBin()
		const args = ["--mode", "json", "--print", "--no-session", "--no-approve", ...toolPolicyArgs()]
		if (model) args.push("--model", String(model))
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

		// Whole process tree, and no waiting on pipes a grandchild still holds.
		const budgetArm = armBudget(child, hasBudget ? budget : null, {onTimeout: () => (timedOut = true)})

		child.stdout.on("data", c => (stdout += c.toString("utf8")))
		child.stderr.on("data", c => (stderr += c.toString("utf8")))
		child.stdout.on("error", () => {})
		child.stderr.on("error", () => {})
		// pi can exit before consuming stdin; EPIPE must not crash the adapter.
		child.stdin.on("error", () => {})
		if (prompt != null) child.stdin.end(String(prompt), "utf8")
		else child.stdin.end()

		const exited = await awaitExit(child, {onError: err => (spawnError = err)})
		exitCode = exited.code
		signal = exited.signal
		budgetArm.cancel()
		const wallMs = Date.now() - started

		const transcript = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")
		let transcriptError = null
		try {
			fs.writeFileSync(transcriptPath, transcript, "utf8")
		} catch (e) {
			transcriptError = e.message
		}

		const {events, unparsed} = parseEvents(stdout)
		const {telemetry, usageMessages} = extractTelemetry(events)

		let authDetected = false
		let contextDetected = false
		let providerDetected = false
		let assistantError = null
		let turns = 0
		const toolCalls = []
		const observedModels = []
		const stopReasons = []
		for (const ev of events) {
			if (ev.type === "turn_start") turns++
			if (ev.type === "tool_execution_start" && ev.toolName) toolCalls.push(ev.toolName)
			const msg = ev.type === "message_end" ? ev.message : null
			if (!msg) continue
			if (msg.role === "assistant") {
				if (msg.stopReason) stopReasons.push(msg.stopReason)
				if (msg.provider && msg.model) observedModels.push(`${msg.provider}/${msg.model}`)
				if (msg.errorMessage) {
					if (!assistantError) assistantError = String(msg.errorMessage)
					if (AUTH_RE.test(msg.errorMessage)) authDetected = true
					if (CONTEXT_RE.test(msg.errorMessage)) contextDetected = true
					if (PROVIDER_ERROR_RE.test(msg.errorMessage)) providerDetected = true
				}
				if (msg.stopReason === "error" && !msg.errorMessage) assistantError = assistantError || "assistant message ended with stopReason=error"
			}
		}
		if (!authDetected && AUTH_RE.test(stderr)) authDetected = true
		if (!contextDetected && CONTEXT_RE.test(stderr)) contextDetected = true
		if (!providerDetected && PROVIDER_ERROR_RE.test(stderr)) providerDetected = true

		let failureMode
		if (timedOut) failureMode = "agent_timeout"
		// A provider refusal is checked before auth: 402 quota and 429 rate limits
		// are the provider refusing to serve, not the harness failing. Gated on the
		// run having failed, so a stray stderr warning cannot label a success.
		else if (providerDetected && (assistantError || exitCode !== 0)) failureMode = "provider_error"
		else if (authDetected) failureMode = "auth_error"
		else if (contextDetected) failureMode = "context_limit"
		else if (spawnError) failureMode = "harness_crash"
		// Nonzero exit with nothing parseable (or no assistant-side error to explain it).
		else if (exitCode !== 0 && (events.length === 0 || !assistantError)) failureMode = "harness_crash"
		else if (assistantError) failureMode = "unknown"
		else failureMode = "none"
		if (!FAILURE_MODES.includes(failureMode)) failureMode = "unknown"

		const observedModel = uniqueInOrder(observedModels).join(",")
		const notes = [
			`cmd: ${bin} ${args.join(" ")} (prompt via stdin, cwd=${dir})`,
			`telemetry: sum of message_end usage.{input,output,cacheRead,cacheWrite,cost.total} over ${usageMessages} message(s)`,
			`events=${events.length} unparsed_lines=${unparsed} turns=${turns}`,
			`tools=[${uniqueInOrder(toolCalls).join(",")}] stop=[${stopReasons.join(",")}]`,
			observedModel ? `observed_model=${observedModel}` : "observed_model=none",
			toolPolicyNote(),
			signal ? `signal=${signal}` : "",
			assistantError ? `error=${assistantError.slice(0, 300)}` : "",
			spawnError ? `spawn_error=${spawnError.message}` : "",
			transcriptError ? `transcript_error=${transcriptError}` : ""
		]
			.filter(Boolean)
			.join("; ")
			.slice(0, 1200)

		return {
			harness: harnessLabel(),
			model: model ? String(model) : observedModel || null,
			exit_code: exitCode,
			timed_out: timedOut,
			wall_ms: wallMs,
			failure_mode: failureMode,
			telemetry,
			turns,
			topology: analyzePiEvents(events),
			transcript_path: transcriptPath,
			notes
		}
	}
}
