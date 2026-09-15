#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md from the repo registry. The corpus under
// spike/out/ is harvested from other people's projects: their patches, commit
// messages and test output. That material keeps its upstream license, so every
// active repo must declare `license` in harness/registry.mjs and carry the
// upstream LICENSE text verbatim under third_party/<repo>/LICENSE.
//
//   node tools/notices.mjs           # rewrite THIRD_PARTY_NOTICES.md
//   node tools/notices.mjs --check   # exit 1 if the checked-in file is stale
import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {REPOS, ROOT} from "../harness/registry.mjs"

export const NOTICES_PATH = path.join(ROOT, "THIRD_PARTY_NOTICES.md")
export const THIRD_PARTY_DIR = path.join(ROOT, "third_party")

export function licenseFile(repo) {
	return path.join(THIRD_PARTY_DIR, repo.name, "LICENSE")
}

export function renderNotices(repos = REPOS) {
	const active = Object.values(repos).filter(r => r.status === "active")
	const candidates = Object.values(repos).filter(r => r.status !== "active")
	const out = []
	out.push("# Third-party notices")
	out.push("")
	out.push("HarnessMark's own code, documentation, frozen sets and results are licensed under the Apache")
	out.push("License 2.0 (see `LICENSE` and `NOTICE`). The task corpus is different: every task is a real")
	out.push("commit harvested from an")
	out.push("open-source project, and the repository ships the parts of those commits the grader needs:")
	out.push("the patch (`spike/out/<repo>/patches/<sha>.patch`), the commit subject and body, file lists")
	out.push("and test-runner output (`spike/out/<repo>/tasks.jsonl`, `chains.jsonl`, `rejected.jsonl`,")
	out.push("`deferred.jsonl`, `report.md`). That material is the work of the upstream authors. It is")
	out.push("redistributed here under its original license, unchanged and not relicensed, with the")
	out.push("notices below. HarnessMark is not affiliated with or endorsed by any of these projects.")
	out.push("")
	out.push("A benchmark run checks out the upstream repository itself at the task's parent commit. Those")
	out.push("checkouts, and anything an agent produces from them, are governed by the upstream license too.")
	out.push("")
	out.push("## Projects in the corpus")
	out.push("")
	out.push("| project | upstream | license | tasks | notice |")
	out.push("| --- | --- | --- | --- | --- |")
	for (const r of active) {
		const tasks = countLines(path.join(ROOT, "spike/out", r.name, "tasks.jsonl"))
		out.push(`| ${r.name} | ${r.url} | ${r.license} | ${tasks} | \`third_party/${r.name}/LICENSE\` |`)
	}
	out.push("")
	for (const r of active) {
		const file = licenseFile(r)
		if (!fs.existsSync(file)) throw new Error(`${r.name} is active but ${path.relative(ROOT, file)} is missing; copy the upstream LICENSE verbatim`)
		out.push(`### ${r.name}`)
		out.push("")
		out.push(`Source: ${r.url} (${r.license}). Verbatim upstream license:`)
		out.push("")
		out.push("```")
		out.push(fs.readFileSync(file, "utf8").trimEnd())
		out.push("```")
		out.push("")
	}
	out.push("## Registered, not yet harvested")
	out.push("")
	out.push("These repos are registered as candidates in `harness/registry.mjs`. No material from them")
	out.push("is in this repository yet. When one is harvested, its upstream license text must be added")
	out.push("under `third_party/<repo>/LICENSE` and this file regenerated with `node tools/notices.mjs`.")
	out.push("Projects under Apache-2.0 also require their `NOTICE` file, if they ship one, to be copied")
	out.push("alongside.")
	out.push("")
	out.push("| project | upstream | license |")
	out.push("| --- | --- | --- |")
	for (const r of candidates) out.push(`| ${r.name} | ${r.url} | ${r.license} |`)
	out.push("")
	return out.join("\n")
}

function countLines(file) {
	if (!fs.existsSync(file)) return 0
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length
}

function main(argv) {
	const rendered = renderNotices()
	if (argv.includes("--check")) {
		const current = fs.existsSync(NOTICES_PATH) ? fs.readFileSync(NOTICES_PATH, "utf8") : ""
		if (current !== rendered) {
			console.error("THIRD_PARTY_NOTICES.md is stale; run `node tools/notices.mjs`")
			return 1
		}
		console.log("THIRD_PARTY_NOTICES.md is current")
		return 0
	}
	fs.writeFileSync(NOTICES_PATH, rendered)
	console.log(`wrote ${path.relative(ROOT, NOTICES_PATH)}`)
	return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exit(main(process.argv.slice(2)))
}
