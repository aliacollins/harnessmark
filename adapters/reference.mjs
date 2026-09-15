import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {FAILURE_MODES, PROVIDER_ERROR_RE} from "../harness/registry.mjs"
import {analyzePiEvents} from "../harness/topology.mjs"
import {runAgent} from "../harness/reference/agent.mjs"

// The zero-point harness. Everything another harness adds -- planning, file
// readers, search, sub-agents, retries, context compaction -- is measured as
// its lift over this adapter on the same model and task set. It talks to the
// model directly (OpenRouter or Bedrock), so the model string is the bare id
// the other adapters report, e.g. `deepseek/deepseek-v4.1-flash` or
// `us.anthropic.claude-haiku-4-5-20251001-v1:0`; an explicit `openrouter/` or
// `bedrock/` prefix overrides the provider choice.
//
// Env: REF_MAX_TURNS (default 60), REF_PROVIDER (openrouter|bedrock),
// REF_RETRY_BASE_MS, REF_BASH_TIMEOUT_MS, REF_BEDROCK_VIA_CLI=1,
// REF_FETCH_MODULE (test hook: module whose default export replaces fetch),
// OPENROUTER_API_KEY (else pi's openrouter credential), AWS_* credentials.
const AUTH_RE =
	/\b(401|403)\b|unauthorized|forbidden|authentication|invalid api key|api key.{0,20}(invalid|missing|not)|no openrouter credential|no aws credentials|security token.{0,30}invalid|expired token|UnrecognizedClientException|AccessDeniedException|InvalidSignatureException/i
const CONTEXT_RE =
	/context (length|window|limit)|too many tokens|maximum context|prompt is too long|token limit|exceeds the (maximum )?context|input is too long|too long for requested model|max_tokens.{0,40}context/i

async function resolveFetch(env) {
	if (!env.REF_FETCH_MODULE) return globalThis.fetch
	const mod = await import(pathToFileURL(path.resolve(env.REF_FETCH_MODULE)).href)
	return mod.default
}

function classify({summary, exitCodeHint}) {
	const errText = summary.error ? String(summary.error.message || summary.error) : ""
	let mode
	if (summary.reason === "timeout") mode = "agent_timeout"
	else if (summary.reason === "max_turns") mode = "budget_exceeded"
	else if (summary.reason === "end_turn") mode = "none"
	else if (summary.reason === "provider_error") {
		// Only provider-level error text is consulted, and only because the run
		// already failed: an agent printing "503" in its own tool output never
		// reaches this branch.
		if (AUTH_RE.test(errText) && !/\b(429|402|5\d\d)\b/.test(errText)) mode = "auth_error"
		else if (CONTEXT_RE.test(errText)) mode = "context_limit"
		else if (PROVIDER_ERROR_RE.test(errText)) mode = "provider_error"
		else if (AUTH_RE.test(errText)) mode = "auth_error"
		else mode = "unknown"
	} else if (summary.reason === "crash") mode = "harness_crash"
	else mode = "unknown"
	if (!FAILURE_MODES.includes(mode)) mode = "unknown"
	void exitCodeHint
	return mode
}

export default {
	name: "reference",
	version: "1",

	async run({prompt, dir, model, budgetMs, outDir}) {
		const started = Date.now()
		const env = process.env
		const transcriptPath = path.resolve(outDir || ".", "transcript.txt")
		fs.mkdirSync(path.dirname(transcriptPath), {recursive: true})
		fs.writeFileSync(transcriptPath, "", "utf8")
		const events = []
		let transcriptError = null
		const emit = ev => {
			const e = {...ev, ts: new Date().toISOString()}
			events.push(e)
			try {
				fs.appendFileSync(transcriptPath, `${JSON.stringify(e)}\n`, "utf8")
			} catch (err) {
				transcriptError = transcriptError || err.message
			}
		}

		let summary
		try {
			const fetchImpl = await resolveFetch(env)
			summary = await runAgent({prompt, dir, model, budgetMs, emit, fetchImpl, env})
		} catch (e) {
			// runAgent already contains its own failures; this is for setup errors
			// (bad model string, missing fetch module).
			emit({type: "agent_end", reason: "crash", turns: 0, error: String(e && e.message ? e.message : e)})
			summary = {reason: "provider_error", error: e, turns: 0, toolCalls: 0, toolNames: [], retries: 0, stopReasons: [], usage: {}, timedOut: false, provider: null, modelId: null, observedModel: null}
			if (!(e && e.name === "ProviderError")) summary.reason = "crash"
		}

		const failureMode = classify({summary})
		const exitCode = summary.reason === "end_turn" ? 0 : summary.reason === "max_turns" ? 2 : 1
		const u = summary.usage || {}
		const asTel = v => (typeof v === "number" && Number.isFinite(v) ? v : null)
		const telemetry = {
			input_tokens: asTel(u.input),
			output_tokens: asTel(u.output),
			cache_read_tokens: asTel(u.cache_read),
			cache_write_tokens: asTel(u.cache_write),
			cost_usd: asTel(u.cost)
		}
		const topology = analyzePiEvents(events)
		topology.parse = "reference-events"

		const errText = summary.error ? String(summary.error.message || summary.error) : ""
		const notes = [
			`provider=${summary.provider ?? "n/a"} model_id=${summary.modelId ?? "n/a"}${summary.observedModel ? ` observed_model=${summary.observedModel}` : ""}`,
			`reason=${summary.reason} turns=${summary.turns} tool_calls=${summary.toolCalls} retries=${summary.retries}`,
			`tools=[${[...new Set(summary.toolNames || [])].join(",")}] stop=[${(summary.stopReasons || []).join(",")}]`,
			summary.provider === "openrouter" ? "telemetry: sum of per-call usage; input_tokens is uncached only (openrouter prompt_tokens minus cached_tokens, disjoint like pi/bedrock); cost_usd from usage.cost when reported" : "",
			summary.provider === "bedrock" ? "telemetry: sum of per-call Converse usage (disjoint buckets); cost_usd not reported by Bedrock" : "",
			errText ? `error=${errText.slice(0, 300)}` : "",
			transcriptError ? `transcript_error=${transcriptError}` : ""
		]
			.filter(Boolean)
			.join("; ")
			.slice(0, 1200)

		return {
			harness: "reference",
			model: model ? String(model) : summary.observedModel || null,
			exit_code: exitCode,
			timed_out: Boolean(summary.timedOut),
			wall_ms: Date.now() - started,
			failure_mode: failureMode,
			telemetry,
			turns: summary.turns ?? null,
			topology,
			transcript_path: transcriptPath,
			notes
		}
	}
}
