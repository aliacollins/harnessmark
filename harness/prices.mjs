// Checked-in price table used to ESTIMATE cost when a harness reports tokens
// but no dollar amount. An estimate is never written back into `telemetry`:
// the raw telemetry stays exactly as the harness reported it.
//
// Two wire conventions are in play and they are NOT interchangeable:
//   cached_in_input: true  (OpenAI-style) input_tokens ALREADY CONTAINS the
//       cache-read and cache-write buckets, so the full-price input is the
//       residual after subtracting them.
//   cached_in_input: false (Anthropic/OpenRouter-style) input_tokens,
//       cache_read_tokens and cache_write_tokens are disjoint additive buckets.
// A single formula applied to both conventions produces garbage.

export const PRICES_AS_OF = "2026-09-11"
export const PRICES_SOURCE = "https://openrouter.ai/api/v1/models"

// USD per MILLION tokens. cache_write is the 5-minute cache-write rate.
export const PRICE_TABLE = {
	"us.openai.gpt-6-astra": {
		input: 10,
		output: 50,
		cache_read: 1,
		cache_write: 12.5,
		cached_in_input: true,
		aliases: ["gpt-6-astra", "openai/gpt-6-astra"]
	},
	"claude-fable-5.1": {
		input: 10,
		output: 50,
		cache_read: 0.25,
		cache_write: 12.5,
		cached_in_input: false,
		aliases: ["anthropic/claude-fable-5.1", "claude-fable-5-1", "us.anthropic.claude-fable-5-1", "global.anthropic.claude-fable-5-1"]
	},
	"claude-opus-5": {
		input: 5,
		output: 25,
		cache_read: 0.5,
		cache_write: 6.25,
		cached_in_input: false,
		aliases: ["anthropic/claude-opus-5", "us.anthropic.claude-opus-5", "global.anthropic.claude-opus-5"]
	},
	"claude-sonnet-5": {
		input: 2,
		output: 10,
		cache_read: 0.2,
		cache_write: 2.5,
		cached_in_input: false,
		aliases: ["anthropic/claude-sonnet-5", "claude-sonnet-5-latest", "us.anthropic.claude-sonnet-5", "global.anthropic.claude-sonnet-5"]
	},
	"claude-haiku-4.5": {
		input: 1,
		output: 5,
		cache_read: 0.1,
		cache_write: 1.25,
		cached_in_input: false,
		aliases: ["anthropic/claude-haiku-4.5", "claude-haiku-4-5", "us.anthropic.claude-haiku-4-5", "global.anthropic.claude-haiku-4-5"]
	},
	// Anthropic list price at launch (2025-09-29), unchanged on Bedrock; Bedrock ids
	// carry a region prefix and a date/version suffix, hence the prefix aliases.
	"claude-sonnet-4.5": {
		input: 3,
		output: 15,
		cache_read: 0.3,
		cache_write: 3.75,
		cached_in_input: false,
		aliases: ["anthropic/claude-sonnet-4.5", "claude-sonnet-4-5", "us.anthropic.claude-sonnet-4-5", "global.anthropic.claude-sonnet-4-5"]
	}
}

export const TOKENS_PER_MILLION = 1_000_000

const isFiniteNumber = v => typeof v === "number" && Number.isFinite(v)

// A model id may be an exact key, an alias, or a date/version-suffixed variant
// of one ("claude-sonnet-5-20260101"). Suffixes cannot be enumerated, so a
// unique, separator-delimited prefix match is accepted. Two table entries
// matching the same id is ambiguous and resolves to nothing rather than a
// guess, and the separator requirement stops "claude-sonnet-50" from matching
// "claude-sonnet-5".
const SEPARATORS = "-./:@"

function matchModel(model) {
	if (typeof model !== "string" || model === "") return null
	const ids = []
	for (const [key, entry] of Object.entries(PRICE_TABLE)) {
		ids.push({id: key, key, exactKey: true})
		for (const alias of entry.aliases || []) ids.push({id: alias, key, exactKey: false})
	}
	for (const entry of ids) if (entry.id === model) return {key: entry.key, exact: entry.exactKey}
	const keys = new Set()
	for (const entry of ids) {
		if (!model.startsWith(entry.id)) continue
		const next = model[entry.id.length]
		if (next !== undefined && !SEPARATORS.includes(next)) continue
		keys.add(entry.key)
	}
	if (keys.size !== 1) return null
	return {key: [...keys][0], exact: false}
}

// `telemetry` is the raw adapter telemetry: fields the harness did not report
// are null/undefined, never a guessed 0. Returns null when there is nothing to
// estimate from, so a caller can never turn "unknown" into a fabricated "$0".
export function estimateCost({model, telemetry} = {}) {
	if (!telemetry || typeof telemetry !== "object") return null
	const matched = matchModel(model)
	if (!matched) return null
	const input = isFiniteNumber(telemetry.input_tokens) ? telemetry.input_tokens : null
	const output = isFiniteNumber(telemetry.output_tokens) ? telemetry.output_tokens : null
	const cacheRead = isFiniteNumber(telemetry.cache_read_tokens) ? telemetry.cache_read_tokens : null
	const cacheWrite = isFiniteNumber(telemetry.cache_write_tokens) ? telemetry.cache_write_tokens : null
	if (input === null && output === null && cacheRead === null && cacheWrite === null) return null

	const entry = PRICE_TABLE[matched.key]
	const i = input ?? 0
	const o = output ?? 0
	const cr = cacheRead ?? 0
	const cw = cacheWrite ?? 0
	let usd
	if (entry.cached_in_input === true) {
		// input_tokens already includes the cache buckets; only the residual
		// pays full input price.
		const fullPriceInput = Math.max(0, i - cr - cw)
		usd = fullPriceInput * entry.input + cr * entry.cache_read + cw * entry.cache_write + o * entry.output
	} else {
		// Disjoint additive buckets.
		usd = i * entry.input + cr * entry.cache_read + cw * entry.cache_write + o * entry.output
	}
	const result = {usd: usd / TOKENS_PER_MILLION, source: "estimated", price_as_of: PRICES_AS_OF}
	if (!matched.exact) result.matched = matched.key
	return result
}
