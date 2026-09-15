import {telemetryFromStream} from "../claude.mjs"

let pass = 0
let fail = 0
const failures = []
const ok = (c, m) => { if (c) pass++; else { fail++; failures.push(m); console.log(`  FAIL ${m}`) } }
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const A = (id, usage, blocks = [{type: "text", text: "x"}]) => JSON.stringify({type: "assistant", message: {id, role: "assistant", content: blocks, usage}})
const u = (i, o, cr, cw) => ({input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw})

console.log("== telemetryFromStream ==")
{
	const s = [
		JSON.stringify({type: "system", subtype: "init"}),
		A("m1", u(10, 5, 100, 20), [{type: "thinking", thinking: "..."}]),
		A("m1", u(10, 50, 100, 20), [{type: "tool_use", id: "t1", name: "Bash", input: {command: "ls"}}]), // same message, later event wins
		"not json noise",
		A("m2", u(3, 7, 400, 0)),
		"--- stderr ---",
		"warning: something"
	].join("\n")
	const r = telemetryFromStream(s)
	eq(r.messages, 2, "two API messages after de-duplicating by message id")
	eq(r.telemetry, {input_tokens: 13, output_tokens: 57, cache_read_tokens: 500, cache_write_tokens: 20, cost_usd: null}, "usage summed with the last event per id; cost stays null")
	eq(r.stream_cutoffs, 0, "no synthetic cut-off turns")
}
{
	const r = telemetryFromStream("")
	eq(r, {telemetry: null, messages: 0, stream_cutoffs: 0}, "empty stdout -> null telemetry, never zeros")
}
{
	const s = [
		A("m1", u(2, 5, 0, 27985), [{type: "thinking", thinking: ""}]),
		JSON.stringify({type: "user", isSynthetic: true, message: {role: "user", content: [{type: "text", text: "Your response above was cut off mid-stream. Resume directly from where it stops."}]}})
	].join("\n")
	const r = telemetryFromStream(s)
	eq(r.stream_cutoffs, 1, "a synthetic cut-off turn is counted")
	eq(r.messages, 1, "the truncated message still contributes its usage")
	eq(r.telemetry.cache_write_tokens, 27985, "cache write from the truncated message is kept")
}
{
	const s = JSON.stringify({type: "user", isSynthetic: false, message: {role: "user", content: [{type: "text", text: "cut off mid-stream"}]}})
	eq(telemetryFromStream(s).stream_cutoffs, 0, "the agent's own words are never provider framing: only isSynthetic turns count")
}
console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) for (const f of failures) console.log(` - ${f}`)
process.exit(fail ? 1 : 0)
