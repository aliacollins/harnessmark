#!/usr/bin/env node
// Re-score an existing run under the answer-lookup audit.
//   node tools/audit-leaks.mjs <runid|path> [--apply]
// Without --apply: print, per harness, how many trials looked up the answer and
// what the resolve figures become. With --apply: rewrite results.jsonl in place
// (backup kept beside it) adding `leak`, `graded` and the adjusted
// resolved/reason, and record the audit in manifest.audits.
import fs from "node:fs"
import path from "node:path"
import * as REGISTRY from "../harness/registry.mjs"
import {LEAK_AUDIT_VERSION, auditTranscript, identityFromSpec} from "../harness/leak.mjs"

const {REPOS, RUNS_DIR} = REGISTRY

function usage() {
	console.error("usage: node tools/audit-leaks.mjs <runid|path> [--apply]")
	process.exit(2)
}

const argv = process.argv.slice(2)
const apply = argv.includes("--apply")
const target = argv.find(a => !a.startsWith("--"))
if (!target) usage()
const runDir = fs.existsSync(target) ? path.resolve(target) : path.join(RUNS_DIR, target)
const resultsPath = path.join(runDir, "results.jsonl")
const manifestPath = path.join(runDir, "manifest.json")
if (!fs.existsSync(resultsPath)) {
	console.error(`audit-leaks: no results.jsonl in ${runDir}`)
	process.exit(2)
}
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {}

function identityFor(repoName) {
	const spec = REPOS[repoName] || {name: repoName, url: manifest.repo && manifest.repo.url}
	if (typeof REGISTRY.repoIdentity === "function") {
		try {
			const id = REGISTRY.repoIdentity(spec)
			if (id && typeof id === "object") return id
		} catch {}
	}
	return identityFromSpec(spec)
}

function transcriptFor(line) {
	const rec = line.adapter_run && typeof line.adapter_run.transcript_path === "string" ? line.adapter_run.transcript_path : null
	if (rec && fs.existsSync(rec)) return rec
	const trials = Number.isInteger(line.trials) ? line.trials : 1
	const trial = Number.isInteger(line.trial) ? line.trial : 0
	const tdir = trials > 1 ? [`t${trial}`] : []
	const candidates = []
	if (typeof line.chain_id === "string") {
		candidates.push(path.join(runDir, line.chain_id, line.adapter, ...tdir, `step-${line.chain_step}`, "transcript.txt"))
	}
	candidates.push(path.join(runDir, line.sha, line.adapter, ...tdir, "transcript.txt"))
	candidates.push(path.join(runDir, line.sha, line.adapter, "transcript.txt"))
	return candidates.find(p => fs.existsSync(p)) || null
}

const raw = fs.readFileSync(resultsPath, "utf8").split("\n").filter(l => l.trim())
const out = []
const table = new Map()
let changed = 0
let missing = 0
for (const text of raw) {
	let line
	try {
		line = JSON.parse(text)
	} catch {
		out.push(text)
		continue
	}
	const label = (line.adapter_run && line.adapter_run.harness) || line.adapter || "?"
	const row = table.get(label) || {trials: 0, fatal: 0, external: 0, web: 0, resolved_before: 0, resolved_after: 0, no_transcript: 0}
	table.set(label, row)
	row.trials++
	const before = line.resolved === true || (line.graded && line.graded.resolved === true)
	if (before) row.resolved_before++
	const tp = transcriptFor(line)
	let leak
	if (!tp) {
		row.no_transcript++
		missing++
		leak = {version: LEAK_AUDIT_VERSION, commands_scanned: 0, clean: true, findings: [], counts: {upstream_lookup: 0, external_network: 0, web_tool: 0}, note: "no transcript found"}
	} else {
		leak = auditTranscript(fs.readFileSync(tp, "utf8"), {adapter: line.adapter, identity: identityFor(line.repo)})
	}
	if (!leak.clean) row.fatal++
	if (leak.counts.external_network) row.external++
	if (leak.counts.web_tool) row.web++
	// re-derive from the evaluator's verdict, so a re-audit is idempotent
	const gradedResolved = line.graded ? line.graded.resolved === true : line.resolved === true
	const gradedReason = line.graded ? line.graded.reason : line.reason
	const next = {...line, leak}
	delete next.graded
	if (!leak.clean) {
		next.graded = {resolved: gradedResolved, reason: gradedReason}
		next.resolved = false
		next.reason = "answer_lookup"
	} else {
		next.resolved = gradedResolved
		next.reason = gradedReason
	}
	if (next.resolved) row.resolved_after++
	if (JSON.stringify(next) !== text) changed++
	out.push(JSON.stringify(next))
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`audit-leaks v${LEAK_AUDIT_VERSION}: ${runDir}`)
console.log(`${pad("harness", 16)} ${pad("trials", 7)} ${pad("lookup", 7)} ${pad("extnet", 7)} ${pad("webtool", 8)} ${pad("resolved before", 16)} ${pad("resolved after", 15)} no-transcript`)
for (const [label, r] of table) {
	console.log(`${pad(label, 16)} ${pad(r.trials, 7)} ${pad(r.fatal, 7)} ${pad(r.external, 7)} ${pad(r.web, 8)} ${pad(`${r.resolved_before} (${r.trials ? ((100 * r.resolved_before) / r.trials).toFixed(1) : "0"}%)`, 16)} ${pad(`${r.resolved_after} (${r.trials ? ((100 * r.resolved_after) / r.trials).toFixed(1) : "0"}%)`, 15)} ${r.no_transcript}`)
}
if (missing) console.log(`note: ${missing} line(s) had no transcript on disk and were treated as clean`)
if (!apply) {
	console.log(`${changed} line(s) would change; re-run with --apply to rewrite results.jsonl`)
	process.exit(0)
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
fs.copyFileSync(resultsPath, `${resultsPath}.pre-audit-${stamp}`)
fs.writeFileSync(resultsPath, out.length ? `${out.join("\n")}\n` : "")
manifest.audits = Array.isArray(manifest.audits) ? manifest.audits : []
manifest.audits.push({tool: "audit-leaks", version: LEAK_AUDIT_VERSION, at: new Date().toISOString(), changed})
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`)
console.log(`applied: ${changed} line(s) rewritten; backup results.jsonl.pre-audit-${stamp}`)
