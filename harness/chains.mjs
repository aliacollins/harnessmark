// Find maximal runs of contiguous validated tasks: step k+1's parent IS step k's
// fix commit, which is what makes chained replay possible. A run only counts if
// every adjacent pair is genuinely parent->child, not merely adjacent in log
// order (commits from merged branches interleave).
import fs from "node:fs"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import {DATASET_DIR, REPOS, loadTasks} from "./registry.mjs"

const SINCE = "2025-09-01"

function git(cwd, args) {
	try {
		return execFileSync("git", args, {cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024}).trim()
	} catch {
		return ""
	}
}

function chronologicalCommits(cloneDir) {
	const out = git(cloneDir, ["log", "--no-merges", `--since=${SINCE}`, "--format=%H"])
	return out.split("\n").filter(Boolean).reverse()
}

// Split a run wherever adjacency fails, so a chain is only ever parent->child.
function contiguousSegments(shas, cloneDir) {
	const segments = []
	let current = []
	for (const sha of shas) {
		if (current.length === 0) {
			current = [sha]
			continue
		}
		const parent = git(cloneDir, ["rev-parse", "--verify", "-q", `${sha}^`])
		if (parent && parent === current[current.length - 1]) {
			current.push(sha)
		} else {
			segments.push(current)
			current = [sha]
		}
	}
	if (current.length) segments.push(current)
	return segments
}

// Contiguity alone does not make a long-horizon task. A run of unrelated
// bugfixes measures endurance; a run where step k+1 edits what step k just
// changed measures BUILDING on prior work, which is the property a context or
// retrieval system actually has to earn. Score that directly: of the adjacent
// step pairs, how many share a source path or a subsystem?
function chainCoherence(steps) {
	const sources = steps.map(s => new Set(s.source_paths || []))
	const subsystems = steps.map(s => new Set(s.subsystems || []))
	const pairs = steps.length - 1
	let adjacentHits = 0
	for (let i = 1; i < steps.length; i++) {
		const sharesSource = [...sources[i]].some(p => sources[i - 1].has(p))
		const sharesSubsystem = [...subsystems[i]].some(p => subsystems[i - 1].has(p))
		if (sharesSource || sharesSubsystem) adjacentHits++
	}
	const pathSteps = new Map()
	for (const set of sources) for (const p of set) pathSteps.set(p, (pathSteps.get(p) || 0) + 1)
	const shared = [...pathSteps.entries()]
		.filter(([, n]) => n > 1)
		.map(([p, n]) => ({path: p, steps: n}))
		.sort((a, b) => b.steps - a.steps || a.path.localeCompare(b.path))
	const features = steps.filter(s => s.category === "feature").length
	const adjacent_overlap = pairs > 0 ? adjacentHits / pairs : 0
	let kind = "mixed"
	if (features >= 2 && adjacentHits > 0) kind = "feature-rollout"
	else if (adjacent_overlap >= 0.5) kind = "same-module"
	return {
		kind,
		adjacent_overlap,
		features,
		shared_source_count: shared.length,
		shared_source_paths: shared.slice(0, 8)
	}
}

export function findChains(repo, {minLength = 2, cloneDir} = {}) {
	const cfg = REPOS[repo]
	const dir = cloneDir || cfg.cloneDir
	if (!fs.existsSync(path.join(dir, ".git"))) throw new Error(`no git clone at ${dir}`)
	const tasks = loadTasks(repo)
	const bySha = new Map(tasks.map(t => [t.sha, t]))
	const order = chronologicalCommits(dir)
	const validatedInOrder = order.filter(sha => bySha.has(sha))

	const runs = []
	let current = []
	for (const sha of order) {
		if (bySha.has(sha)) current.push(sha)
		else if (current.length) {
			runs.push(current)
			current = []
		}
	}
	if (current.length) runs.push(current)

	const chains = []
	for (const run of runs) {
		for (const segment of contiguousSegments(run, dir)) {
			if (segment.length < minLength) continue
			const steps = segment.map((sha, i) => {
				const t = bySha.get(sha)
				return {
					ordinal: i + 1,
					sha,
					parent_sha: t.parent_sha,
					subject: t.subject,
					category: t.category,
					test_paths: t.test_paths,
					source_paths: t.source_paths || [],
					subsystems: t.subsystems || [],
					diffstat: t.diffstat
				}
			})
			chains.push({
				repo,
				chain_id: `${repo}:${segment[0].slice(0, 10)}`,
				length: segment.length,
				lines: steps.reduce((a, s) => a + (s.diffstat ? s.diffstat.lines : 0), 0),
				coherence: chainCoherence(steps),
				steps
			})
		}
	}
	return {chains, commits: order.length, validated: validatedInOrder.length, cloneDir: dir}
}

function main() {
	const repo = process.argv[2]
	const minLength = Number(process.argv.includes("--min-length") ? process.argv[process.argv.indexOf("--min-length") + 1] : 2)
	if (!repo || !REPOS[repo]) {
		console.error(`usage: node harness/chains.mjs <${Object.keys(REPOS).join("|")}> [--min-length N]`)
		process.exit(1)
	}
	const {chains, commits, validated} = findChains(repo, {minLength})
	// Longest first, then most coherent: a long run of unrelated fixes is worth
	// less than a shorter run that genuinely builds on itself.
	const sorted = chains.sort((a, b) => b.length - a.length || b.coherence.adjacent_overlap - a.coherence.adjacent_overlap)
	const outPath = path.join(DATASET_DIR, repo, "chains.jsonl")
	fs.writeFileSync(outPath, sorted.map(c => JSON.stringify(c)).join("\n") + (sorted.length ? "\n" : ""))

	console.log(`${repo}: ${commits} commits, ${validated} validated, ${sorted.length} chain(s) of length >= ${minLength}`)
	for (const c of sorted) {
		const co = c.coherence
		console.log(
			`  ${c.chain_id} len=${c.length} lines=${c.lines} kind=${co.kind} overlap=${(co.adjacent_overlap * 100).toFixed(0)}% shared_src=${co.shared_source_count} :: ${c.steps[0].subject.slice(0, 44)}`
		)
	}
	const byKind = sorted.reduce((a, c) => ((a[c.coherence.kind] = (a[c.coherence.kind] || 0) + 1), a), {})
	console.log(`  kinds: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(" ")}`)
	const longest = sorted[0]
	if (longest) {
		const inChain = new Set(sorted.flatMap(c => c.steps.map(s => s.sha)))
		console.log(`  tasks in chains: ${inChain.size}/${validated} (steps total ${sorted.reduce((a, c) => a + c.length, 0)})`)
	}
	console.log(`  wrote ${path.relative(process.cwd(), outPath)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
