#!/usr/bin/env node
// Named, frozen task sets. A leaderboard is only comparable over time if every
// run graded the SAME tasks, so a set pins (repo, sha) and (repo, chain_id)
// lists in sets/<name>.json. The selection is code, not a hand-picked list:
// `--generate <name>` re-derives the file from a rule recorded in the json, so
// anyone can audit why a task is in or out.
//
// usage: node harness/sets.mjs --generate <name> [--out DIR]
//        node harness/sets.mjs --show <name>
//        node harness/sets.mjs --list
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {DATASET_DIR, ROOT, loadTasks} from "./registry.mjs"

export const SETS_DIR = path.join(ROOT, "sets")

const readJsonl = file =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))

export function loadChainsFor(repo) {
	const file = path.join(DATASET_DIR, repo, "chains.jsonl")
	return fs.existsSync(file) ? readJsonl(file) : []
}

const isSha = s => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)

// ---------------------------------------------------------------- rules

// Ordered so the headroom-bearing buckets come first. Within a bucket, sha
// order: reproducible and blind to anything about the task.
const BUCKET_ORDER = ["XL", "L", "M", "S", "XS"]

function bySizeThenSha(tasks, excludeCategories) {
	const rank = new Map(BUCKET_ORDER.map((b, i) => [b, i]))
	return tasks
		.filter(t => !excludeCategories.includes(t.category))
		.filter(t => rank.has(t.size_bucket))
		.sort((a, b) => rank.get(a.size_bucket) - rank.get(b.size_bucket) || a.sha.localeCompare(b.sha))
}

export const RULES = {
	"dev-hono-50": {
		version: 1,
		describe: {
			kind: "headroom-biased",
			repo: "hono",
			count: 50,
			bucket_order: BUCKET_ORDER,
			within_bucket: "sha ascending",
			exclude_categories: ["unknown"],
			chains: "every hono chain with >= 3 steps, chain_id ascending",
			min_chain_steps: 3
		},
		select({tasks, chains}) {
			const picked = bySizeThenSha(tasks("hono"), ["unknown"]).slice(0, 50)
			const picked_chains = chains("hono")
				.filter(c => Array.isArray(c.steps) && c.steps.length >= 3)
				.sort((a, b) => a.chain_id.localeCompare(b.chain_id))
			return {
				tasks: picked.map(t => ({repo: "hono", sha: t.sha, size_bucket: t.size_bucket, category: t.category})),
				chains: picked_chains.map(c => ({repo: "hono", chain_id: c.chain_id, length: c.steps.length}))
			}
		}
	},
	"dev-immer-12": {
		version: 1,
		describe: {
			kind: "all-tasks",
			repo: "immer",
			within_bucket: "sha ascending",
			chains: "every immer chain, chain_id ascending"
		},
		select({tasks, chains}) {
			const all = tasks("immer").slice().sort((a, b) => a.sha.localeCompare(b.sha))
			const cs = chains("immer").slice().sort((a, b) => a.chain_id.localeCompare(b.chain_id))
			return {
				tasks: all.map(t => ({repo: "immer", sha: t.sha, size_bucket: t.size_bucket, category: t.category})),
				chains: cs.map(c => ({repo: "immer", chain_id: c.chain_id, length: (c.steps || []).length}))
			}
		}
	}
}

export function generateSet(name, {tasks = loadTasks, chains = loadChainsFor, now = new Date()} = {}) {
	const rule = RULES[name]
	if (!rule) throw new Error(`no generation rule for set ${JSON.stringify(name)} (known: ${Object.keys(RULES).join(", ")})`)
	const picked = rule.select({tasks, chains})
	if (!picked.tasks.length) throw new Error(`set ${name}: rule selected zero tasks`)
	return {
		name,
		version: rule.version,
		frozen_at: now.toISOString(),
		selection: rule.describe,
		tasks: picked.tasks,
		chains: picked.chains
	}
}

// ---------------------------------------------------------------- load

export function setPath(name, dir = SETS_DIR) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name))) throw new Error(`invalid set name ${JSON.stringify(name)}`)
	return path.join(dir, `${name}.json`)
}

export function listSets(dir = SETS_DIR) {
	if (!fs.existsSync(dir)) return []
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".json"))
		.map(f => f.slice(0, -5))
		.sort()
}

export function loadSet(name, {dir = SETS_DIR} = {}) {
	const file = setPath(name, dir)
	if (!fs.existsSync(file)) throw new Error(`unknown set ${JSON.stringify(name)}: ${file} does not exist (available: ${listSets(dir).join(", ") || "none"})`)
	let set
	try {
		set = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (e) {
		throw new Error(`set ${name}: unreadable json: ${e.message}`)
	}
	if (set.name !== name) throw new Error(`set ${name}: file names itself ${JSON.stringify(set.name)}`)
	if (!Number.isInteger(set.version) || set.version < 1) throw new Error(`set ${name}: version must be a positive integer`)
	if (typeof set.frozen_at !== "string" || Number.isNaN(Date.parse(set.frozen_at))) throw new Error(`set ${name}: frozen_at must be an ISO date`)
	if (!Array.isArray(set.tasks)) throw new Error(`set ${name}: tasks must be an array`)
	if (!Array.isArray(set.chains)) throw new Error(`set ${name}: chains must be an array`)
	const seen = new Set()
	set.tasks.forEach((t, i) => {
		if (!t || typeof t.repo !== "string" || !t.repo) throw new Error(`set ${name}: tasks[${i}] has no repo`)
		if (!isSha(t.sha)) throw new Error(`set ${name}: tasks[${i}] sha is not a full 40-hex sha: ${JSON.stringify(t.sha)}`)
		const key = `${t.repo}@${t.sha}`
		if (seen.has(key)) throw new Error(`set ${name}: duplicate task ${key}`)
		seen.add(key)
	})
	const seenChains = new Set()
	set.chains.forEach((c, i) => {
		if (!c || typeof c.repo !== "string" || !c.repo) throw new Error(`set ${name}: chains[${i}] has no repo`)
		if (typeof c.chain_id !== "string" || !c.chain_id) throw new Error(`set ${name}: chains[${i}] has no chain_id`)
		const key = `${c.repo}@${c.chain_id}`
		if (seenChains.has(key)) throw new Error(`set ${name}: duplicate chain ${key}`)
		seenChains.add(key)
	})
	if (!set.selection || typeof set.selection !== "object") throw new Error(`set ${name}: selection rule missing`)
	return set
}

export function setRepos(set) {
	return [...new Set([...set.tasks.map(t => t.repo), ...set.chains.map(c => c.repo)])].sort()
}

// Join the pinned ids back to full task/chain records. A pinned sha that no
// longer exists in the dataset is a broken set, not a task to skip: the whole
// point of a frozen set is that every run graded exactly the same tasks.
export function resolveSet(name, {dir = SETS_DIR, tasks = loadTasks, chains = loadChainsFor, repo = null} = {}) {
	const set = typeof name === "string" ? loadSet(name, {dir}) : name
	const repos = setRepos(set).filter(r => repo === null || r === repo)
	if (repo !== null && !repos.length) throw new Error(`set ${set.name}: has no tasks or chains for repo ${JSON.stringify(repo)} (repos: ${setRepos(set).join(", ")})`)
	const byRepo = {}
	const missing = []
	for (const r of repos) {
		const records = new Map(tasks(r).map(t => [t.sha, t]))
		const chainRecords = new Map(chains(r).map(c => [c.chain_id, c]))
		const rTasks = []
		for (const t of set.tasks.filter(t => t.repo === r)) {
			const rec = records.get(t.sha)
			if (!rec) missing.push(`${r}@${t.sha}`)
			else rTasks.push(rec)
		}
		const rChains = []
		for (const c of set.chains.filter(c => c.repo === r)) {
			const rec = chainRecords.get(c.chain_id)
			if (!rec) missing.push(`${r} chain ${c.chain_id}`)
			else rChains.push(rec)
		}
		byRepo[r] = {tasks: rTasks, chains: rChains}
	}
	if (missing.length) {
		throw new Error(`set ${set.name}: ${missing.length} pinned id(s) not found in the dataset: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`)
	}
	return {set, repos, byRepo}
}

// ---------------------------------------------------------------- cli

function main(argv) {
	const usage = "usage: node harness/sets.mjs --generate <name> [--out DIR] | --show <name> | --list"
	const args = [...argv]
	const flag = args.shift()
	if (flag === "--list") {
		for (const n of listSets()) console.log(n)
		return 0
	}
	if (flag === "--show") {
		const set = loadSet(args.shift())
		const buckets = {}
		for (const t of set.tasks) buckets[t.size_bucket || "?"] = (buckets[t.size_bucket || "?"] || 0) + 1
		console.log(JSON.stringify({name: set.name, version: set.version, frozen_at: set.frozen_at, repos: setRepos(set), tasks: set.tasks.length, buckets, chains: set.chains.length, selection: set.selection}, null, 2))
		return 0
	}
	if (flag === "--generate") {
		const name = args.shift()
		let out = SETS_DIR
		while (args.length) {
			const a = args.shift()
			if (a === "--out") out = path.resolve(args.shift())
			else throw new Error(`unknown argument ${a}`)
		}
		const set = generateSet(name)
		fs.mkdirSync(out, {recursive: true})
		const file = setPath(name, out)
		fs.writeFileSync(file, `${JSON.stringify(set, null, "\t")}\n`)
		console.log(`wrote ${path.relative(process.cwd(), file)}: ${set.tasks.length} task(s), ${set.chains.length} chain(s)`)
		return 0
	}
	console.error(usage)
	return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exit(main(process.argv.slice(2)))
	} catch (e) {
		console.error(`sets: ${e.message}`)
		process.exit(1)
	}
}
