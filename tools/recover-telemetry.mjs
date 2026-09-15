#!/usr/bin/env node
// Backfill telemetry for Claude Code trials that were killed before the CLI
// printed its final "result" object (budget kills). The stream-json transcript
// still carries the harness's own per-message usage; sum it exactly as the
// adapter now does (adapters/claude.mjs telemetryFromStream) and record where
// the numbers came from. Cost stays null and is estimated by prices.mjs.
//
//   node tools/recover-telemetry.mjs <runid|path> [--apply]
//
// Never run --apply on a run that is still writing results.jsonl.
import fs from "node:fs"
import path from "node:path"
import {RUNS_DIR} from "../harness/registry.mjs"
import {telemetryFromStream} from "../adapters/claude.mjs"
import {estimateCost} from "../harness/prices.mjs"

const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const target = argv.find(a => !a.startsWith("--"))
if (!target) {
	console.error("usage: node tools/recover-telemetry.mjs <runid|path> [--apply]")
	process.exit(2)
}
const dir = fs.existsSync(target) ? path.resolve(target) : path.join(RUNS_DIR, target)
const resultsPath = path.join(dir, "results.jsonl")
const raw = fs.readFileSync(resultsPath, "utf8")
const lines = raw.split("\n").filter(l => l.trim())
let changed = 0
let candidates = 0
const out = []
for (const l of lines) {
	const r = JSON.parse(l)
	const isClaude = r.adapter === "claude" || /^claude/.test(r.adapter_run && r.adapter_run.harness)
	if (!isClaude || !r.telemetry || r.telemetry.input_tokens !== null) {
		out.push(l)
		continue
	}
	candidates++
	const tp = r.adapter_run && r.adapter_run.transcript_path
	if (!tp || !fs.existsSync(tp)) {
		out.push(l)
		continue
	}
	const rec = telemetryFromStream(fs.readFileSync(tp, "utf8"))
	if (!rec.telemetry) {
		out.push(l)
		continue
	}
	const next = {...r, telemetry: rec.telemetry}
	next.adapter_run = {...r.adapter_run, telemetry: rec.telemetry, telemetry_source: `stream-sum(${rec.messages} messages)`, stream_cutoffs: rec.stream_cutoffs}
	if (next.adapter_run.turns == null) next.adapter_run.turns = rec.messages
	next.cost = estimateCost({model: r.model, telemetry: rec.telemetry})
	changed++
	console.log(`${r.sha.slice(0, 8)} t${r.trial ?? 0}: in=${rec.telemetry.input_tokens} cache_read=${rec.telemetry.cache_read_tokens} cache_write=${rec.telemetry.cache_write_tokens} out=${rec.telemetry.output_tokens} messages=${rec.messages} cutoffs=${rec.stream_cutoffs} est=${next.cost ? "$" + next.cost.usd.toFixed(2) : "n/a"}`)
	out.push(JSON.stringify(next))
}
console.log("note: per-message output_tokens in stream-json are partial, so recovered output (and the cost estimate) is a lower bound")
console.log(`${changed} of ${candidates} telemetry-less Claude lines recoverable${apply ? ", applied" : " (dry run; add --apply)"}`)
if (apply && changed) {
	fs.copyFileSync(resultsPath, `${resultsPath}.pre-recover-${Date.now()}`)
	fs.writeFileSync(resultsPath, `${out.join("\n")}\n`)
	const mp = path.join(dir, "manifest.json")
	const m = JSON.parse(fs.readFileSync(mp, "utf8"))
	m.audits = [...(m.audits || []), {tool: "recover-telemetry", at: new Date().toISOString(), changed}]
	fs.writeFileSync(mp, `${JSON.stringify(m, null, "\t")}\n`)
}
