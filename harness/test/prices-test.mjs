import {PRICE_TABLE, PRICES_AS_OF, PRICES_SOURCE, estimateCost, TOKENS_PER_MILLION} from "../prices.mjs"

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

// The real codex trial-0 row from runs/codex-trials/results.jsonl. Its wire
// convention is OpenAI-style: input_tokens already contains the cache buckets
// (34 residual tokens), so a disjoint-bucket formula would be wrong by ~4.6x.
const CODEX_ROW = {
	input_tokens: 1068873,
	output_tokens: 9424,
	cache_read_tokens: 955804,
	cache_write_tokens: 113035
}

function testInclusive() {
	const r = estimateCost({model: "us.openai.gpt-6-astra", telemetry: CODEX_ROW})
	const residual = 1068873 - 955804 - 113035
	const expected = (residual * 10 + 955804 * 1 + 113035 * 12.5 + 9424 * 50) / TOKENS_PER_MILLION
	eq(r.usd, expected, "gpt-6-astra charges full price only on the input residual")
	eq(residual, 34, "the residual is the 34 tokens not served from or written to cache")
	eq(r.source, "estimated", "a computed value is labelled estimated")
	eq(r.price_as_of, PRICES_AS_OF, "the estimate carries the price table date")
	ok(!("matched" in r), "an exact model id reports no fuzzy match")
}

function testExclusive() {
	// claude-fable-5.1 is Anthropic-style: buckets are disjoint and additive.
	const r = estimateCost({model: "claude-fable-5.1", telemetry: CODEX_ROW})
	const expected = (1068873 * 10 + 955804 * 0.25 + 113035 * 12.5 + 9424 * 50) / TOKENS_PER_MILLION
	eq(r.usd, expected, "an exclusive entry charges input_tokens in full as well as the cache buckets")
	ok(r.usd > estimateCost({model: "us.openai.gpt-6-astra", telemetry: CODEX_ROW}).usd, "the same tokens cost more under the exclusive convention")
}

function testClamp() {
	// cache buckets exceeding input_tokens must clamp at zero, never go negative.
	const r = estimateCost({
		model: "us.openai.gpt-6-astra",
		telemetry: {input_tokens: 100, output_tokens: 0, cache_read_tokens: 900, cache_write_tokens: 900}
	})
	const expected = (0 + 900 * 1 + 900 * 12.5) / TOKENS_PER_MILLION
	eq(r.usd, expected, "full-price input clamps to zero instead of going negative")
	ok(r.usd > 0, "a fully cached prompt still costs the cache rates")
}

function testRefusesToFabricate() {
	eq(estimateCost({model: "us.openai.gpt-6-astra", telemetry: null}), null, "no telemetry estimates nothing")
	eq(estimateCost({model: "us.openai.gpt-6-astra", telemetry: {}}), null, "all-null telemetry estimates nothing, never $0")
	eq(estimateCost({model: "us.openai.gpt-6-astra", telemetry: {input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null}}), null, "explicit nulls estimate nothing")
	eq(estimateCost({model: "some/unlisted-model", telemetry: CODEX_ROW}), null, "an unpriced model estimates nothing")
	eq(estimateCost({telemetry: CODEX_ROW}), null, "a missing model estimates nothing")
}

function testPartialTelemetry() {
	// Only output was reported: the absent buckets must count as zero, not abort
	// the estimate, and must not be invented.
	const r = estimateCost({model: "us.openai.gpt-6-astra", telemetry: {output_tokens: 1000}})
	eq(r.usd, (1000 * 50) / TOKENS_PER_MILLION, "unreported buckets contribute nothing and are not fabricated")
}

function testAliasesAndPrefixes() {
	const exact = estimateCost({model: "us.openai.gpt-6-astra", telemetry: CODEX_ROW}).usd
	eq(estimateCost({model: "gpt-6-astra", telemetry: CODEX_ROW}).usd, exact, "a bare alias resolves to the same entry")
	eq(estimateCost({model: "openai/gpt-6-astra", telemetry: CODEX_ROW}).usd, exact, "a provider-prefixed alias resolves")
	const sonnet = estimateCost({model: "claude-sonnet-5", telemetry: CODEX_ROW})
	const dated = estimateCost({model: "claude-sonnet-5-20260101", telemetry: CODEX_ROW})
	eq(dated.usd, sonnet.usd, "a date-suffixed model id resolves to its family entry")
	eq(dated.matched, "claude-sonnet-5", "a fuzzy match reports which entry it used")
}

function testSeparatorGuard() {
	eq(estimateCost({model: "claude-sonnet-50", telemetry: CODEX_ROW}), null, "a longer id is not treated as a version suffix")
	eq(estimateCost({model: "claude-sonnet-500", telemetry: CODEX_ROW}), null, "a numeric suffix without a separator does not match")
}

function testTableShape() {
	for (const [key, entry] of Object.entries(PRICE_TABLE)) {
		ok(typeof entry.input === "number" && typeof entry.output === "number", `${key} declares input and output rates`)
		ok(typeof entry.cache_read === "number" && typeof entry.cache_write === "number", `${key} declares both cache rates`)
		ok(entry.cached_in_input === true || entry.cached_in_input === false, `${key} declares its wire convention explicitly`)
	}
	ok(/^\d{4}-\d{2}-\d{2}$/.test(PRICES_AS_OF), "the table carries an ISO as-of date")
	ok(/^https:\/\//.test(PRICES_SOURCE), "the table states where its numbers came from")
}

function testBedrockIds() {
	const tel = {input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0}
	const haiku = estimateCost({model: "us.anthropic.claude-haiku-4-5-20251001-v1:0", telemetry: tel})
	ok(haiku && Math.abs(haiku.usd - 1) < 1e-9, "a Bedrock haiku id prices at the haiku input rate")
	eq(haiku && haiku.matched, "claude-haiku-4.5", "the Bedrock haiku id resolves to the haiku entry")
	const sonnet = estimateCost({model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", telemetry: tel})
	ok(sonnet && Math.abs(sonnet.usd - 3) < 1e-9, "a Bedrock sonnet 4.5 id prices at the sonnet 4.5 input rate")
	const fable = estimateCost({model: "us.anthropic.claude-fable-5-1", telemetry: tel})
	ok(fable && Math.abs(fable.usd - 10) < 1e-9, "the Bedrock fable 5.1 id prices at the fable input rate")
	eq(estimateCost({model: "us.anthropic.claude-sonnet-4-50", telemetry: tel}), null, "a Bedrock id with a longer version does not prefix-match")
	const sonnet5 = estimateCost({model: "us.anthropic.claude-sonnet-5", telemetry: tel})
	ok(sonnet5 && Math.abs(sonnet5.usd - 2) < 1e-9, "the Bedrock sonnet 5 id prices at the sonnet 5 input rate")
	const opus5 = estimateCost({model: "global.anthropic.claude-opus-5", telemetry: tel})
	ok(opus5 && Math.abs(opus5.usd - 5) < 1e-9, "the Bedrock opus 5 id prices at the opus 5 input rate")
}

testBedrockIds()
testInclusive()
testExclusive()
testClamp()
testRefusesToFabricate()
testPartialTelemetry()
testAliasesAndPrefixes()
testSeparatorGuard()
testTableShape()

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)
