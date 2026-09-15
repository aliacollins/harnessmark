// Model providers for the reference harness. Two wire protocols, one neutral
// message shape in between so the agent loop is provider-blind:
//   {role:"user",      content:[{type:"text",text} | {type:"tool_result",tool_use_id,text,is_error}]}
//   {role:"assistant", content:[{type:"text",text} | {type:"tool_use",id,name,input}]}
// A provider call returns {content, stop_reason, usage, raw}; usage fields are
// null when the wire did not carry them (never 0).
import {createHash, createHmac} from "node:crypto"
import {execFileSync} from "node:child_process"

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
const BEDROCK_ID_RE = /^(?:arn:aws|(?:us|eu|global|apac|jp|au|ca|sa)\.[a-z0-9-]+\.)|:\d+$/

export class ProviderError extends Error {
	constructor(message, {status = null, retryable = false, provider = null, body = null} = {}) {
		super(message)
		this.name = "ProviderError"
		this.status = status
		this.retryable = retryable
		this.provider = provider
		this.body = body
	}
}

// `openrouter/<id>` and `bedrock/<id>` pick a provider explicitly and are
// stripped before the wire call. Otherwise REF_PROVIDER decides, and failing
// that the id's shape does: Bedrock ids carry a region prefix or a `:N` suffix.
// Passing the bare id is what makes the reference's `model` column identical to
// pi's or claude's for the same model, which is what the lift comparison keys on.
export function selectProvider(model, env = process.env) {
	if (typeof model !== "string" || !model.trim()) throw new ProviderError("model is required (e.g. openrouter/deepseek/deepseek-v4.1-flash or bedrock/<modelId>)")
	const m = model.trim()
	if (m.startsWith("openrouter/")) return {provider: "openrouter", modelId: m.slice("openrouter/".length)}
	if (m.startsWith("bedrock/")) return {provider: "bedrock", modelId: m.slice("bedrock/".length)}
	const forced = (env.REF_PROVIDER || "").trim().toLowerCase()
	if (forced === "openrouter" || forced === "bedrock") return {provider: forced, modelId: m}
	if (forced) throw new ProviderError(`REF_PROVIDER must be openrouter or bedrock, got ${forced}`)
	return {provider: BEDROCK_ID_RE.test(m) ? "bedrock" : "openrouter", modelId: m}
}

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null)

async function readBody(res) {
	try {
		return await res.text()
	} catch (e) {
		// A budget abort can land while the body is streaming; that is a timeout,
		// not a malformed provider response.
		if (e && e.name === "AbortError") throw e
		return ""
	}
}

function classifyHttp(status, text, provider) {
	const retryable = RETRYABLE_STATUS.has(status)
	return new ProviderError(`${provider} HTTP ${status}: ${(text || "").slice(0, 2000)}`, {status, retryable, provider, body: text})
}

async function doFetch(fetchImpl, url, init, provider) {
	let res
	try {
		res = await fetchImpl(url, init)
	} catch (e) {
		if (e && e.name === "AbortError") throw e
		// "error sending request" is the framing PROVIDER_ERROR_RE recognises; this text
		// is provider-level by construction (never agent output), so it is safe to use.
		throw new ProviderError(`${provider} error sending request: ${e && e.message ? e.message : String(e)}`, {retryable: true, provider})
	}
	const text = await readBody(res)
	if (!res.ok) throw classifyHttp(res.status, text, provider)
	let json
	try {
		json = JSON.parse(text)
	} catch {
		throw new ProviderError(`${provider} returned non-JSON body: ${text.slice(0, 300)}`, {retryable: true, provider, body: text})
	}
	return json
}

// ------------------------------------------------------------- OpenRouter

let cachedOpenRouterKey = null
export function openRouterKey(env = process.env) {
	if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY
	if (cachedOpenRouterKey) return cachedOpenRouterKey
	for (const sub of ["print-api-key", "print-bearer-token"]) {
		try {
			const out = execFileSync("pi", ["auth", sub, "--provider", "openrouter"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim()
			if (out) {
				cachedOpenRouterKey = out
				return out
			}
		} catch {}
	}
	throw new ProviderError("no OpenRouter credential: set OPENROUTER_API_KEY or authenticate pi with openrouter", {status: 401, provider: "openrouter"})
}

export function toOpenAIMessages(system, messages) {
	const out = [{role: "system", content: system}]
	for (const m of messages) {
		if (m.role === "assistant") {
			const text = m.content.filter(b => b.type === "text").map(b => b.text).join("")
			const calls = m.content.filter(b => b.type === "tool_use")
			const msg = {role: "assistant", content: text || null}
			if (calls.length) msg.tool_calls = calls.map(c => ({id: c.id, type: "function", function: {name: c.name, arguments: JSON.stringify(c.input ?? {})}}))
			out.push(msg)
			continue
		}
		const texts = m.content.filter(b => b.type === "text")
		const results = m.content.filter(b => b.type === "tool_result")
		for (const r of results) out.push({role: "tool", tool_call_id: r.tool_use_id, content: r.text ?? ""})
		if (texts.length) out.push({role: "user", content: texts.map(b => b.text).join("\n")})
	}
	return out
}

export function fromOpenAIResponse(json) {
	if (json && json.error) {
		const code = num(json.error.code) ?? num(json.error.status) ?? null
		throw new ProviderError(`openrouter error: ${JSON.stringify(json.error).slice(0, 2000)}`, {
			status: code,
			retryable: code !== null && RETRYABLE_STATUS.has(code),
			provider: "openrouter",
			body: JSON.stringify(json)
		})
	}
	const choice = json && Array.isArray(json.choices) ? json.choices[0] : null
	if (!choice || !choice.message) throw new ProviderError(`openrouter response had no choices: ${JSON.stringify(json).slice(0, 500)}`, {retryable: true, provider: "openrouter"})
	const msg = choice.message
	const content = []
	if (typeof msg.content === "string" && msg.content) content.push({type: "text", text: msg.content})
	for (const tc of msg.tool_calls || []) {
		let input
		const raw = tc.function && tc.function.arguments
		try {
			input = raw ? JSON.parse(raw) : {}
		} catch {
			// Hand the parse failure back to the model as a tool error instead of dying.
			input = {__invalid_json: String(raw).slice(0, 2000)}
		}
		content.push({type: "tool_use", id: tc.id || `call_${content.length}`, name: tc.function ? tc.function.name : "unknown", input})
	}
	const fr = choice.finish_reason
	const stop_reason = fr === "tool_calls" || (content.some(b => b.type === "tool_use") && fr !== "length") ? "tool_use" : fr === "length" ? "max_tokens" : "end_turn"
	const u = json.usage || {}
	// OpenRouter's prompt_tokens INCLUDES the cached prefix. The benchmark's
	// convention (pi, Bedrock Converse) is disjoint buckets, so the cached part is
	// subtracted here: input = fresh, uncached prompt tokens. Otherwise the
	// leaderboard's "in tokens" column would compare inclusive against disjoint.
	const prompt = num(u.prompt_tokens)
	const cached = num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
	const usage = {
		input: prompt === null ? null : Math.max(0, prompt - (cached ?? 0)),
		output: num(u.completion_tokens),
		cache_read: cached,
		cache_write: null,
		cost: num(u.cost)
	}
	return {content, stop_reason, usage, model: typeof json.model === "string" ? json.model : null, raw: json}
}

export async function callOpenRouter({modelId, system, messages, tools, signal, fetchImpl = globalThis.fetch, apiKey, maxTokens = 8192}) {
	const key = apiKey || openRouterKey()
	const body = {
		model: modelId,
		messages: toOpenAIMessages(system, messages),
		tools: tools.map(t => ({type: "function", function: {name: t.name, description: t.description, parameters: t.input_schema}})),
		tool_choice: "auto",
		max_tokens: maxTokens,
		usage: {include: true}
	}
	const json = await doFetch(
		fetchImpl,
		OPENROUTER_URL,
		{
			method: "POST",
			headers: {"content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "harness-benchmark reference"},
			body: JSON.stringify(body),
			signal
		},
		"openrouter"
	)
	return fromOpenAIResponse(json)
}

// ---------------------------------------------------------------- Bedrock

export function awsCredentials(env = process.env) {
	if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
		return {accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || null}
	}
	try {
		const out = execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]})
		const j = JSON.parse(out)
		if (j.AccessKeyId && j.SecretAccessKey) return {accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.SessionToken || null}
	} catch {}
	throw new ProviderError("no AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or configure an aws profile", {status: 401, provider: "bedrock"})
}

const sha256 = s => createHash("sha256").update(s, "utf8").digest("hex")
const hmac = (k, s) => createHmac("sha256", k).update(s, "utf8").digest()

// RFC 3986 escape, as SigV4 requires (encodeURIComponent leaves !'()* alone).
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

// AWS SigV4 for a POST with a JSON body. Non-S3 services canonicalize the path
// with each segment escaped a second time, which is why the canonical URI and
// the request URI differ.
export function signV4({method = "POST", host, path, body, region, service = "bedrock", creds, now = new Date()}) {
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
	const dateStamp = amzDate.slice(0, 8)
	const canonicalUri = path
		.split("/")
		.map(seg => rfc3986(seg))
		.join("/")
	const headers = {"content-type": "application/json", host, "x-amz-date": amzDate}
	if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken
	const signedHeaderNames = Object.keys(headers).sort()
	const canonicalHeaders = signedHeaderNames.map(h => `${h}:${headers[h].trim()}\n`).join("")
	const signedHeaders = signedHeaderNames.join(";")
	const payloadHash = sha256(body)
	const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n")
	const scope = `${dateStamp}/${region}/${service}/aws4_request`
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n")
	const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), service), "aws4_request")
	const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
	}
}

export function toBedrockMessages(messages) {
	const out = []
	for (const m of messages) {
		const content = []
		for (const b of m.content) {
			if (b.type === "text") {
				if (b.text) content.push({text: b.text})
			} else if (b.type === "tool_use") {
				content.push({toolUse: {toolUseId: b.id, name: b.name, input: b.input && typeof b.input === "object" ? b.input : {}}})
			} else if (b.type === "tool_result") {
				content.push({toolResult: {toolUseId: b.tool_use_id, content: [{text: b.text || "(no output)"}], status: b.is_error ? "error" : "success"}})
			}
		}
		if (!content.length) content.push({text: "(empty)"})
		// Converse rejects consecutive same-role messages; merge them.
		const last = out[out.length - 1]
		if (last && last.role === m.role) last.content.push(...content)
		else out.push({role: m.role, content})
	}
	return out
}

export function fromBedrockResponse(json) {
	const msg = json && json.output && json.output.message
	if (!msg) throw new ProviderError(`bedrock response had no output.message: ${JSON.stringify(json).slice(0, 500)}`, {retryable: true, provider: "bedrock"})
	const content = []
	for (const b of msg.content || []) {
		if (typeof b.text === "string") content.push({type: "text", text: b.text})
		else if (b.toolUse) content.push({type: "tool_use", id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {}})
	}
	const sr = json.stopReason
	const stop_reason = sr === "tool_use" ? "tool_use" : sr === "max_tokens" ? "max_tokens" : "end_turn"
	const u = json.usage || {}
	const usage = {
		input: num(u.inputTokens),
		output: num(u.outputTokens),
		cache_read: num(u.cacheReadInputTokens),
		cache_write: num(u.cacheWriteInputTokens),
		cost: null
	}
	return {content, stop_reason, usage, model: null, raw: json}
}

function bedrockBody({system, messages, tools, maxTokens}) {
	return {
		messages: toBedrockMessages(messages),
		system: [{text: system}],
		toolConfig: {tools: tools.map(t => ({toolSpec: {name: t.name, description: t.description, inputSchema: {json: t.input_schema}}}))},
		inferenceConfig: {maxTokens}
	}
}

// Fallback path: the installed aws CLI, for when SigV4 by hand is in doubt.
function callBedrockViaCli({modelId, region, body}) {
	try {
		const out = execFileSync(
			"aws",
			[
				"bedrock-runtime", "converse", "--region", region, "--model-id", modelId,
				"--messages", JSON.stringify(body.messages),
				"--system", JSON.stringify(body.system),
				"--tool-config", JSON.stringify(body.toolConfig),
				"--inference-config", JSON.stringify(body.inferenceConfig),
				"--output", "json"
			],
			{encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024}
		)
		return JSON.parse(out)
	} catch (e) {
		const text = (e.stderr || e.message || "").toString()
		const throttled = /Throttling|ServiceUnavailable|InternalServer|ModelNotReady|Timeout/i.test(text)
		throw new ProviderError(`bedrock cli: ${text.slice(0, 2000)}`, {status: throttled ? 429 : null, retryable: throttled, provider: "bedrock", body: text})
	}
}

export async function callBedrock({modelId, system, messages, tools, signal, fetchImpl = globalThis.fetch, creds, region, maxTokens = 8192, viaCli = process.env.REF_BEDROCK_VIA_CLI === "1"}) {
	const rgn = region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
	const body = bedrockBody({system, messages, tools, maxTokens})
	if (viaCli) return fromBedrockResponse(callBedrockViaCli({modelId, region: rgn, body}))
	const c = creds || awsCredentials()
	const host = `bedrock-runtime.${rgn}.amazonaws.com`
	const path = `/model/${rfc3986(modelId)}/converse`
	const payload = JSON.stringify(body)
	const headers = signV4({host, path, body: payload, region: rgn, creds: c})
	const json = await doFetch(fetchImpl, `https://${host}${path}`, {method: "POST", headers, body: payload, signal}, "bedrock")
	return fromBedrockResponse(json)
}

export async function callModel({provider, modelId, ...rest}) {
	if (provider === "openrouter") return callOpenRouter({modelId, ...rest})
	if (provider === "bedrock") return callBedrock({modelId, ...rest})
	throw new ProviderError(`unknown provider ${provider}`)
}
