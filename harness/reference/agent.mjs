// The reference agent loop: prompt in, one model call per turn, execute every
// tool call the model made, feed the results back, stop when the model stops
// calling tools. No planning, no retries of failed edits, no sub-agents, no
// context management beyond what the provider does. This is the zero point.
import {ProviderError, callModel, selectProvider} from "./providers.mjs"
import {TOOL_SPECS, executeTool} from "./tools.mjs"

export const DEFAULT_MAX_TURNS = 60
export const DEFAULT_RETRY_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_MS = 2000

export function systemPrompt(dir) {
	return [
		`You are a software engineer working in the git repository at ${dir}.`,
		"The user message describes a change to make. Make it directly in the working tree using the two tools available: `bash` runs a shell command from the repository root, `edit` replaces one exact string in a file (or creates a file).",
		"Do not commit, stash, amend or otherwise change git history. Do not touch anything outside the repository.",
		"When the change is complete, reply with a short summary and stop calling tools."
	].join("\n")
}

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal && signal.aborted) return reject(abortError())
		const t = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		function onAbort() {
			clearTimeout(t)
			reject(abortError())
		}
		if (signal) signal.addEventListener("abort", onAbort, {once: true})
	})

function abortError() {
	const e = new Error("aborted")
	e.name = "AbortError"
	return e
}

export async function callWithRetry(fn, {maxAttempts = DEFAULT_RETRY_ATTEMPTS, baseDelayMs = DEFAULT_RETRY_BASE_MS, signal, onRetry} = {}) {
	let attempt = 0
	for (;;) {
		attempt++
		try {
			return await fn()
		} catch (e) {
			const retryable = e instanceof ProviderError && e.retryable
			if (!retryable || attempt >= maxAttempts || (signal && signal.aborted)) throw e
			const delayMs = baseDelayMs * 2 ** (attempt - 1)
			// Same event name as pi's so the shared topology parser counts it.
			if (onRetry) onRetry({type: "auto_retry_start", attempt, maxAttempts, delayMs, errorMessage: String(e.message).slice(0, 2000)})
			await sleep(delayMs, signal)
		}
	}
}

function addUsage(sum, u) {
	for (const k of ["input", "output", "cache_read", "cache_write", "cost"]) {
		if (typeof u[k] === "number" && Number.isFinite(u[k])) {
			sum[k] = (sum[k] ?? 0) + u[k]
		}
	}
}

// Returns a summary; every observable step is also emitted as an event.
export async function runAgent({prompt, dir, model, budgetMs, maxTurns, emit = () => {}, fetchImpl, env = process.env, retryBaseMs, bashTimeoutMs}) {
	const started = Date.now()
	const {provider, modelId} = selectProvider(model, env)
	const turnsMax = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : Number.parseInt(env.REF_MAX_TURNS || "", 10) || DEFAULT_MAX_TURNS
	const retryBase = Number.isFinite(retryBaseMs) ? retryBaseMs : Number.parseInt(env.REF_RETRY_BASE_MS || "", 10) || DEFAULT_RETRY_BASE_MS
	const bashTimeout = Number.isFinite(bashTimeoutMs) ? bashTimeoutMs : Number.parseInt(env.REF_BASH_TIMEOUT_MS || "", 10) || undefined

	const controller = new AbortController()
	const budget = Number(budgetMs)
	const hasBudget = Number.isFinite(budget) && budget > 0
	let timedOut = false
	const budgetTimer = hasBudget
		? setTimeout(() => {
				timedOut = true
				controller.abort()
			}, budget)
		: null

	const system = systemPrompt(dir)
	const messages = [{role: "user", content: [{type: "text", text: String(prompt ?? "")}]}]
	const usage = {input: null, output: null, cache_read: null, cache_write: null, cost: null}
	const stopReasons = []
	const toolNames = []
	let modelCalls = 0
	let toolCalls = 0
	let retries = 0
	let observedModel = null
	let reason = "end_turn"
	let error = null

	emit({type: "agent_start", provider, model: modelId, max_turns: turnsMax, budget_ms: hasBudget ? budget : null})
	try {
		for (let turn = 1; turn <= turnsMax; turn++) {
			emit({type: "turn_start", turn})
			const resp = await callWithRetry(
				() => callModel({provider, modelId, system, messages, tools: TOOL_SPECS, signal: controller.signal, fetchImpl}),
				{
					baseDelayMs: retryBase,
					signal: controller.signal,
					onRetry: ev => {
						retries++
						emit(ev)
					}
				}
			)
			modelCalls++
			addUsage(usage, resp.usage)
			if (resp.model && !observedModel) observedModel = resp.model
			stopReasons.push(resp.stop_reason)
			emit({type: "model_call", turn, usage: resp.usage, stop_reason: resp.stop_reason, model: resp.model, content: resp.content})
			messages.push({role: "assistant", content: resp.content})

			const uses = resp.content.filter(b => b.type === "tool_use")
			if (!uses.length) {
				reason = "end_turn"
				emit({type: "turn_end", turn})
				break
			}
			const results = []
			for (const u of uses) {
				toolCalls++
				toolNames.push(u.name)
				emit({type: "tool_execution_start", toolCallId: u.id, toolName: u.name, args: u.input})
				const r = await executeTool({name: u.name, input: u.input, dir, signal: controller.signal, bashTimeoutMs: bashTimeout})
				emit({type: "tool_execution_end", toolCallId: u.id, toolName: u.name, isError: r.isError, result: {content: [{type: "text", text: r.text}]}})
				results.push({type: "tool_result", tool_use_id: u.id, text: r.text, is_error: r.isError})
				if (controller.signal.aborted) break
			}
			messages.push({role: "user", content: results})
			emit({type: "turn_end", turn})
			if (controller.signal.aborted) throw abortError()
			if (turn === turnsMax) reason = "max_turns"
		}
	} catch (e) {
		// The abort can surface wrapped in a provider error (a body read cut off at
		// the deadline), so the signal is authoritative, not the error's type.
		if ((e && e.name === "AbortError") || controller.signal.aborted) {
			reason = timedOut ? "timeout" : "aborted"
		} else if (e instanceof ProviderError) {
			reason = "provider_error"
			error = e
		} else {
			reason = "crash"
			error = e
		}
	} finally {
		if (budgetTimer) clearTimeout(budgetTimer)
	}
	emit({type: "agent_end", reason, turns: modelCalls, error: error ? String(error.message).slice(0, 2000) : null})
	return {
		reason,
		provider,
		modelId,
		observedModel,
		turns: modelCalls,
		toolCalls,
		toolNames,
		retries,
		stopReasons,
		usage,
		error,
		timedOut,
		wallMs: Date.now() - started
	}
}
