#!/usr/bin/env node
// runner/run.mjs — drives adapters over tasks and grades captured patches.
//
// Per (task, adapter) item: isolated `git worktree add` from the repo clone,
// run the adapter, capture the candidate patch with `git diff` (untracked files
// included via an intent-to-add on a throwaway COPY of the index), grade it with
// evaluator/evaluate.mjs against the cached baseline, append one line to
// results.jsonl, drop the worktree. One item failing never aborts the run.
//
// Test/CI injection points (keep the CLI itself frozen):
//   RUNNER_EVALUATOR    path to the evaluator module (default evaluator/evaluate.mjs)
//   RUNNER_ADAPTERS_DIR directory holding <name>.mjs adapters (default adapters/)
//   RUNNER_REPOS_FILE   JSON object merged over REPOS from the registry
//   RUNNER_TASKS_FILE   JSONL task file overriding the registry's loadTasks(repo)
//   RUNNER_CHAINS_FILE  JSONL chains file overriding spike/out/<repo>/chains.jsonl
//   RUNNER_SETS_DIR     directory holding <name>.json task sets (default sets/)
//
// Harness state (--state cold|warm): every adapter invocation receives a state
// directory as `stateDir` and as env BENCH_STATE_DIR. A harness that keeps a
// local code index (a code map, a relationship graph) writes it there, so its
// cost on the first task and its payoff on later ones become measurable. cold
// gives each trial a fresh empty directory; warm keeps one directory alive
// across items so a second read of the same repo can hit whatever the harness
// cached. State never enters the candidate patch: an adapter that writes state
// INSIDE the worktree declares `statePaths` and those paths are excluded from
// capture. The worktree itself is built exactly as before in either mode, so
// the fix commit stays unreadable regardless of state policy.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {fileURLToPath, pathToFileURL} from "node:url"
import {
	DATASET_DIR,
	EVAL_REASONS,
	FAILURE_MODES,
	REPOS,
	ROOT,
	RUNS_DIR,
	TELEMETRY_FIELDS,
	PROMPT_VERSION,
	TASK_INSTRUCTIONS,
	loadTasks,
	taskPrompt,
	taskSpec
} from "../harness/registry.mjs"
import * as REGISTRY from "../harness/registry.mjs"
import {normalizeTopology} from "../harness/topology.mjs"
import {LEAK_AUDIT_VERSION, auditTranscript, identityFromSpec} from "../harness/leak.mjs"
import {estimateCost} from "../harness/prices.mjs"
import {SETS_DIR, resolveSet} from "../harness/sets.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_EVALUATOR = path.join(ROOT, "evaluator", "evaluate.mjs")
const DEFAULT_ADAPTERS_DIR = path.join(ROOT, "adapters")
const USAGE = `usage: node runner/run.mjs --repo <r> --task <sha|all> --adapter <name[,name]> --model <m>
                              [--limit N] [--trials N] [--budget-ms N] [--out runs/<id>] [--baseline-only]
       node runner/run.mjs --repo <r> --chain <chain_id|all> --adapter <name[,name]> --model <m>
                              [--chain-mode incremental|roadmap]
                              [--limit N] [--trials N] [--budget-ms N] [--out runs/<id>]
       node runner/run.mjs --set <name> [--repo <r>] [--chain <chain_id|all>] --adapter <name[,name]> --model <m>
                              [--limit N] [--trials N] [--budget-ms N] [--out runs/<id>]
  common: [--state cold|warm] [--keep-state] [--item-budget-ms N] [--model-for <adapter>=<model>]... [--resume]
  --set picks a frozen task set from sets/<name>.json; --repo then only selects a
  repo slice of a multi-repo set and --task is not allowed. --model-for pairs one
  adapter with its own model; --model is the default for the rest.`

// node_modules is injected as a symlink so worktrees can run tests without a
// per-worktree install; it must never end up in the candidate patch.
const PATCH_EXCLUDES = ["--", ".", ":(exclude)node_modules", ":(exclude).worktrees"]

// An adapter's declared in-tree state directories (e.g. ".codify") are excluded
// the same way: they are harness state, not a candidate change.
function patchExcludes(statePaths) {
	return [...PATCH_EXCLUDES, ...(statePaths || []).map(p => `:(exclude)${p}`)]
}

// statePaths must be relative and stay inside the worktree, or the exclusion
// would silently widen to something that is not harness state.
function validateStatePaths(list, adapterName) {
	if (list === undefined || list === null) return []
	if (!Array.isArray(list)) throw new Error(`adapter ${adapterName}: statePaths must be an array`)
	const out = []
	for (const raw of list) {
		if (typeof raw !== "string" || !raw.trim()) throw new Error(`adapter ${adapterName}: statePaths entries must be non-empty strings`)
		const p = raw.trim().replace(/\/+$/, "")
		if (path.isAbsolute(p) || p.split("/").some(seg => seg === "..") || p === "." || p === "")
			throw new Error(`adapter ${adapterName}: statePaths entry must be a relative path inside the worktree: ${JSON.stringify(raw)}`)
		if (!out.includes(p)) out.push(p)
	}
	return out
}

// Recursive on-disk size, symlinks skipped: a harness that symlinks the repo
// into its state dir would otherwise be credited with the whole checkout.
function dirBytes(dir) {
	let total = 0
	const stack = [dir]
	while (stack.length) {
		const d = stack.pop()
		let ents
		try {
			ents = fs.readdirSync(d, {withFileTypes: true})
		} catch {
			continue
		}
		for (const e of ents) {
			const p = path.join(d, e.name)
			if (e.isSymbolicLink()) continue
			if (e.isDirectory()) stack.push(p)
			else if (e.isFile()) {
				try {
					total += fs.statSync(p).size
				} catch {}
			}
		}
	}
	return total
}

// Hands out state directories under <out>/.state and owns their lifetime.
//   cold: one fresh empty dir per adapter invocation, removed right after.
//   warm: task mode shares one dir per adapter for the whole run; chain mode
//         shares one dir per (adapter, chain, trial) so every step of a chain
//         session sees what the earlier steps built, while trials stay
//         independent repeated measurements.
// Warm dirs are removed when the run ends unless --keep-state.
function makeStateManager({mode, keep, outDir}) {
	const root = path.join(outDir, ".state")
	const warm = new Set()
	const keyFor = ({adapter, scope}) => {
		if (mode === "warm") {
			return scope.kind === "chain" ? path.join(adapter, `chain-${sanitize(scope.chainId)}-t${scope.trial}`) : path.join(adapter, "run")
		}
		const tag = scope.kind === "chain" ? `chain-${sanitize(scope.chainId)}-t${scope.trial}-step${scope.step}` : `${sanitize(String(scope.sha).slice(0, 12))}-t${scope.trial}`
		return path.join(adapter, tag)
	}
	return {
		mode,
		root,
		acquire(req) {
			const dir = path.join(root, keyFor(req))
			const existed = fs.existsSync(dir)
			if (mode !== "warm" && existed) fs.rmSync(dir, {recursive: true, force: true})
			fs.mkdirSync(dir, {recursive: true})
			const reused = mode === "warm" && existed
			if (mode === "warm") warm.add(dir)
			return {dir, mode, reused, bytes_before: reused ? dirBytes(dir) : 0}
		},
		release(handle) {
			const bytes_after = dirBytes(handle.dir)
			if (mode !== "warm") fs.rmSync(handle.dir, {recursive: true, force: true})
			return bytes_after
		},
		finish() {
			if (mode === "warm" && keep) return {kept: [...warm].sort()}
			for (const dir of warm) fs.rmSync(dir, {recursive: true, force: true})
			warm.clear()
			fs.rmSync(root, {recursive: true, force: true})
			return {kept: []}
		}
	}
}

// ---------------------------------------------------------------- primitives

function git(cwd, args, env) {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: env ? {...process.env, ...env} : process.env
	})
	return {
		ok: r.status === 0,
		status: r.status,
		stdout: r.stdout || "",
		stderr: r.stderr || "",
		error: r.error || null
	}
}

function gitOrThrow(cwd, args, env) {
	const r = git(cwd, args, env)
	if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`)
	if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`)
	return r.stdout
}

const sanitize = s => String(s).replace(/[^A-Za-z0-9._-]/g, "-")

function appendLine(file, obj) {
	fs.appendFileSync(file, `${JSON.stringify(obj)}\n`)
}

function writeJsonAtomic(file, obj) {
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, `${JSON.stringify(obj, null, "\t")}\n`)
	fs.renameSync(tmp, file)
}

function readJsonl(file) {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
}

function errText(e) {
	return String((e && e.message) || e).slice(0, 2000)
}

function iso() {
	return new Date().toISOString()
}

async function loadModule(file, what) {
	const abs = path.resolve(file)
	if (!fs.existsSync(abs)) throw new Error(`${what} module not found: ${abs}`)
	const mod = await import(pathToFileURL(abs).href)
	return {abs, mod}
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
	const cfg = {
		repo: null,
		task: "all",
		adapters: [],
		model: null,
		limit: null,
		budgetMs: null,
		// Per adapter invocation. The run budget alone lets one stuck trial eat
		// the whole run; this caps each trial independently of the run.
		itemBudgetMs: 1_200_000,
		// Continue an interrupted run in the same --out: (sha, adapter, trial)
		// items already in results.jsonl are skipped, complete chain trials are
		// skipped, and partial chain trials are dropped and re-run from step 1.
		resume: false,
		trials: 1,
		out: null,
		baselineOnly: false,
		chain: null,
		chainMode: "incremental",
		set: null,
		state: "cold",
		keepState: false,
		modelFor: {},
		help: false
	}
	const need = (i, flag) => {
		if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`)
		return argv[i + 1]
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inline = eq === -1 ? null : arg.slice(eq + 1)
		const take = () => {
			if (inline !== null) return inline
			i++
			return need(i - 1, flag)
		}
		switch (flag) {
			case "-h":
			case "--help":
				cfg.help = true
				break
			case "--repo":
				cfg.repo = take()
				break
			case "--task":
				cfg.task = take()
				cfg.taskGiven = true
				break
			case "--adapter":
				cfg.adapters.push(...take().split(",").map(s => s.trim()).filter(Boolean))
				break
			case "--model":
				cfg.model = take()
				break
			case "--limit":
				cfg.limit = Number.parseInt(take(), 10)
				break
			case "--trials":
				cfg.trials = Number.parseInt(take(), 10)
				break
			case "--budget-ms":
				cfg.budgetMs = Number.parseInt(take(), 10)
				break
			case "--item-budget-ms":
				cfg.itemBudgetMs = Number.parseInt(take(), 10)
				break
			case "--resume":
				cfg.resume = true
				break
			case "--out":
				cfg.out = take()
				break
			case "--baseline-only":
				cfg.baselineOnly = true
				break
			case "--chain":
				cfg.chain = take()
				break
			case "--chain-mode":
				cfg.chainMode = take()
				break
			case "--set":
				cfg.set = take()
				break
			case "--state":
				cfg.state = take()
				break
			case "--keep-state":
				cfg.keepState = true
				break
			case "--model-for": {
				const v = take()
				const at = v.indexOf("=")
				if (at <= 0 || at === v.length - 1) throw new Error(`--model-for expects <adapter>=<model>, got ${JSON.stringify(v)}`)
				const name = v.slice(0, at).trim()
				if (cfg.modelFor[name] !== undefined) throw new Error(`duplicate --model-for for adapter ${name}`)
				cfg.modelFor[name] = v.slice(at + 1)
				break
			}
			default:
				throw new Error(`unknown argument: ${arg}`)
		}
	}
	if (cfg.help) return cfg
	if (cfg.set !== null) {
		if (cfg.taskGiven) throw new Error("--set and --task are mutually exclusive: a set names its own tasks")
		if (cfg.baselineOnly) throw new Error("--set cannot be combined with --baseline-only")
	} else if (!cfg.repo) throw new Error("--repo is required (or --set <name>)")
	if (!cfg.baselineOnly && cfg.adapters.length === 0) throw new Error("--adapter is required")
	if (cfg.adapters.length !== new Set(cfg.adapters).size) throw new Error("duplicate --adapter")
	for (const name of Object.keys(cfg.modelFor)) {
		if (!cfg.adapters.includes(name)) throw new Error(`--model-for names adapter ${name}, which is not in --adapter (${cfg.adapters.join(",") || "none"})`)
	}
	if (cfg.state !== "cold" && cfg.state !== "warm") throw new Error('--state must be "cold" or "warm"')
	if (cfg.keepState && cfg.state !== "warm") throw new Error("--keep-state only applies to --state warm")
	if (cfg.limit !== null && (!Number.isInteger(cfg.limit) || cfg.limit < 0)) throw new Error("--limit must be a non-negative integer")
	if (!Number.isInteger(cfg.trials) || cfg.trials < 1) throw new Error("--trials must be a positive integer")
	if (cfg.budgetMs !== null && (!Number.isInteger(cfg.budgetMs) || cfg.budgetMs <= 0)) throw new Error("--budget-ms must be a positive integer")
	if (!Number.isInteger(cfg.itemBudgetMs) || cfg.itemBudgetMs <= 0) throw new Error("--item-budget-ms must be a positive integer")
	if (cfg.chain && cfg.chainMode !== "incremental" && cfg.chainMode !== "roadmap") throw new Error('--chain-mode must be "incremental" or "roadmap"')
	if (cfg.chain && cfg.baselineOnly) throw new Error("--chain cannot be combined with --baseline-only")
	return cfg
}

function repoSpecs() {
	const specs = {...REPOS}
	const file = process.env.RUNNER_REPOS_FILE
	if (file) {
		const extra = JSON.parse(fs.readFileSync(file, "utf8"))
		for (const [k, v] of Object.entries(extra)) specs[k] = {...(specs[k] || {}), ...v}
	}
	return specs
}

function selectTasks(repo, taskArg) {
	const file = process.env.RUNNER_TASKS_FILE
	const tasks = file ? readJsonl(file) : loadTasks(repo)
	if (taskArg === "all") return tasks
	// Accept full sha, unique sha prefix, or a parent_sha.
	const exact = tasks.filter(t => t.sha === taskArg)
	if (exact.length) return exact
	const prefixed = tasks.filter(t => typeof t.sha === "string" && t.sha.startsWith(taskArg))
	if (prefixed.length === 1) return prefixed
	if (prefixed.length > 1) throw new Error(`ambiguous --task ${taskArg}: ${prefixed.length} matches`)
	const byParent = tasks.filter(t => t.parent_sha === taskArg)
	if (byParent.length === 1) return byParent
	throw new Error(`no task matches ${JSON.stringify(taskArg)} in repo ${repo}`)
}

// Chains are contiguous historical commit runs, one JSON object per line. Each
// step carries only a subject; the full task record (with message_body, used by
// taskPrompt) is joined back in by sha from the same tasks file `--task` uses.
function loadChains(repo) {
	const file = process.env.RUNNER_CHAINS_FILE
	return file ? readJsonl(file) : readJsonl(path.join(DATASET_DIR, repo, "chains.jsonl"))
}

function selectChains(repo, chainArg, tasks, pool = null) {
	const chains = pool ?? loadChains(repo)
	const ids = chains.map(c => c.chain_id)
	let selected
	if (chainArg === "all") selected = chains
	else {
		selected = chains.filter(c => c.chain_id === chainArg)
		if (selected.length === 0) {
			throw new Error(
				`no chain matches ${JSON.stringify(chainArg)} in repo ${repo} (available chains: ${ids.join(", ") || "none"})`
			)
		}
	}
	return joinChainSteps(selected, tasks)
}

function joinChainSteps(selected, tasks) {
	const bySha = new Map(tasks.map(t => [t.sha, t]))
	return selected.map(chain => {
		const raw = chain.steps || []
		if (!raw.length) throw new Error(`chain ${chain.chain_id}: no steps`)
		const steps = raw.map((step, i) => {
			const ordinal = Number.isInteger(step.ordinal) ? step.ordinal : i + 1
			const task = bySha.get(step.sha)
			if (!task) throw new Error(`chain ${chain.chain_id} step ${ordinal}: no task record for ${step.sha}`)
			// Two dataset files describe the same parent commit. If they disagree,
			// the cumulative patch would be diffed against a different commit than
			// the grading base and the result would be silently wrong.
			if (step.parent_sha !== task.parent_sha) {
				throw new Error(
					`chain ${chain.chain_id} step ${ordinal}: parent_sha disagrees between chains.jsonl (${String(step.parent_sha).slice(0, 10)}) and tasks.jsonl (${String(task.parent_sha).slice(0, 10)})`
				)
			}
			return {...step, ordinal, task}
		})
		for (let k = 1; k < steps.length; k++) {
			if (steps[k].parent_sha !== steps[k - 1].sha) {
				throw new Error(
					`chain ${chain.chain_id} step ${steps[k].ordinal}: not contiguous - parent ${String(steps[k].parent_sha).slice(0, 10)} is not the previous step ${String(steps[k - 1].sha).slice(0, 10)}`
				)
			}
		}
		return {...chain, steps}
	})
}

// ---------------------------------------------------------------- worktrees

function worktreeName(runId, sha, tag) {
	return sanitize(`${runId}-${sha.slice(0, 12)}-${tag}`)
}

function addWorktree(cloneDir, root, runId, sha, tag, baseSha) {
	const name = worktreeName(runId, sha, tag)
	const wtPath = path.join(root, ".worktrees", `${sanitize(sha.slice(0, 12))}-${sanitize(tag)}`)
	const branch = `runner/${name}`
	fs.mkdirSync(path.dirname(wtPath), {recursive: true})
	// An interrupted run leaves its worktree and branch behind. Recover instead of
	// dying, so a killed run can be resumed and re-running is idempotent.
	if (fs.existsSync(wtPath)) {
		git(cloneDir, ["worktree", "remove", "--force", wtPath])
		if (fs.existsSync(wtPath)) fs.rmSync(wtPath, {recursive: true, force: true})
	}
	git(cloneDir, ["worktree", "prune"])
	if (git(cloneDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok)
		git(cloneDir, ["branch", "-D", branch])
	gitOrThrow(cloneDir, ["worktree", "add", "-b", branch, wtPath, baseSha])
	return {name, path: wtPath, branch, baseSha}
}

// The agent must not be able to read the fix it is being asked to reproduce.
// A worktree shares the clone's object store, so `git log --all` there exposes
// the very commit that solves the task. Build a truncated repo instead: full
// history up to the parent, every later ref dropped, unreachable objects pruned.
function makeAgentSandbox(spec, outDir, runId, task, tag, guardShas = null) {
	const name = worktreeName(runId, task.sha, tag)
	const dir = path.join(outDir, ".worktrees", `${sanitize(task.sha.slice(0, 12))}-${sanitize(tag)}`)
	fs.mkdirSync(path.dirname(dir), {recursive: true})
	if (fs.existsSync(dir)) fs.rmSync(dir, {recursive: true, force: true})
	gitOrThrow(ROOT, ["clone", "--no-hardlinks", "--quiet", spec.cloneDir, dir])
	gitOrThrow(dir, ["checkout", "-f", "--detach", task.parent_sha])
	const refs = git(dir, ["for-each-ref", "--format=%(refname)"]).stdout.split("\n").filter(Boolean)
	for (const ref of refs) git(dir, ["update-ref", "-d", ref])
	git(dir, ["remote", "remove", "origin"])
	git(dir, ["reflog", "expire", "--expire=now", "--all"])
	gitOrThrow(dir, ["gc", "--prune=now", "--quiet"])
	const guard = guardShas == null ? [task.sha] : guardShas
	// A provided-but-empty guard list must fail closed: an empty array is truthy,
	// so treating it as "guard nothing" would silently disable the check that
	// keeps the fix commit unreadable from inside the agent sandbox.
	if (!guard.length) throw new Error("history guard: refusing to build an agent sandbox with an empty guard list")
	for (const sha of guard) {
		const leak = git(dir, ["cat-file", "-e", `${sha}^{commit}`])
		if (leak.ok) throw new Error(`history leak: fix commit ${sha.slice(0, 10)} is still readable in the agent sandbox`)
	}
	return {name, path: dir, branch: null, baseSha: task.parent_sha, sandbox: true}
}

// Share the clone's dependencies with the worktree so the repo's test command
// can run at all. node_modules is gitignored in both repos and explicitly
// excluded from the patch, so this cannot leak into a candidate patch.
function linkDeps(cloneDir, wtPath) {
	const src = path.join(cloneDir, "node_modules")
	const dst = path.join(wtPath, "node_modules")
	if (!fs.existsSync(src) || fs.existsSync(dst)) return
	try {
		fs.symlinkSync(src, dst, "dir")
	} catch (e) {
		warn(`could not link node_modules into ${wtPath}: ${errText(e)}`)
	}
}

function removeWorktree(cloneDir, wt) {
	if (!wt) return null
	if (wt.sandbox) {
		try {
			fs.rmSync(wt.path, {recursive: true, force: true})
		} catch (e) {
			return errText(e)
		}
		return fs.existsSync(wt.path) ? `sandbox still present: ${wt.path}` : null
	}
	let error = null
	const r = git(cloneDir, ["worktree", "remove", "--force", wt.path])
	if (!r.ok) {
		try {
			fs.rmSync(wt.path, {recursive: true, force: true})
			git(cloneDir, ["worktree", "prune"])
		} catch (e) {
			error = errText(e)
		}
	}
	if (wt.branch) git(cloneDir, ["branch", "-D", wt.branch])
	if (fs.existsSync(wt.path)) error = error || `worktree still present: ${wt.path}`
	return error
}

// `git add -A -N` marks untracked files as intent-to-add so `git diff` sees
// them. It runs against a throwaway COPY of the real index (GIT_INDEX_FILE) so
// the worktree's own index is never mutated.
function capturePatch(wtPath, baseSha, statePaths = []) {
	const indexOut = gitOrThrow(wtPath, ["rev-parse", "--git-path", "index"]).trim()
	const realIndex = path.isAbsolute(indexOut) ? indexOut : path.resolve(wtPath, indexOut)
	if (!fs.existsSync(realIndex)) throw new Error(`worktree index missing: ${realIndex}`)
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-index-"))
	const env = {GIT_INDEX_FILE: path.join(tmpDir, "index")}
	const excludes = patchExcludes(statePaths)
	try {
		fs.copyFileSync(realIndex, env.GIT_INDEX_FILE)
		gitOrThrow(wtPath, ["add", "-A", "-N", ...excludes], env)
		return gitOrThrow(wtPath, ["diff", "--no-color", "--binary", baseSha, ...excludes], env)
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true})
	}
}

// ---------------------------------------------------------------- results

function emptyTelemetry() {
	const t = {}
	for (const f of TELEMETRY_FIELDS) t[f] = null
	return t
}

function normalizeTelemetry(t) {
	const out = emptyTelemetry()
	if (!t || typeof t !== "object") return out
	for (const f of TELEMETRY_FIELDS) {
		// null/false stay null: only an actually reported value is kept, and 0 is a value.
		if (t[f] === null || t[f] === undefined) continue
		if (typeof t[f] === "number" && Number.isFinite(t[f])) out[f] = t[f]
	}
	return out
}

// Self-describing cost for the result line. A harness-reported number always
// wins; otherwise the checked-in price table supplies an ESTIMATE. The estimate
// is deliberately NOT written back into telemetry, which must stay exactly as
// the harness reported it (null when it reported nothing).
function costOf(model, telemetry) {
	const reported = telemetry && Number.isFinite(telemetry.cost_usd) ? telemetry.cost_usd : null
	if (reported !== null) return {usd: reported, source: "reported", price_as_of: null}
	const estimate = estimateCost({model, telemetry})
	if (estimate && Number.isFinite(estimate.usd)) {
		return {usd: estimate.usd, source: "estimated", price_as_of: estimate.price_as_of}
	}
	return {usd: null, source: "unavailable", price_as_of: null}
}

function normalizeAdapterResult(raw, adapter, model, wallMs, error) {
	const r = raw && typeof raw === "object" ? raw : {}
	let failureMode = r.failure_mode
	if (!FAILURE_MODES.includes(failureMode)) failureMode = r.failure_mode ? "unknown" : "none"
	if (error) failureMode = "harness_crash"
	return {
		harness: typeof r.harness === "string" ? r.harness : adapter.name,
		model: r.model === undefined ? (model ?? null) : r.model,
		exit_code: Number.isInteger(r.exit_code) ? r.exit_code : null,
		timed_out: r.timed_out === true,
		wall_ms: Number.isFinite(r.wall_ms) ? r.wall_ms : wallMs,
		failure_mode: failureMode,
		telemetry: normalizeTelemetry(r.telemetry),
		transcript_path: typeof r.transcript_path === "string" ? r.transcript_path : path.join(adapter.outDir || "", "transcript.txt"),
		notes: typeof r.notes === "string" ? r.notes : "",
		turns: Number.isFinite(r.turns) ? r.turns : null,
		topology: normalizeTopology(r.topology),
		...(error ? {error: errText(error)} : {})
	}
}

const nullRuns = () => ({exit: null, passed: 0, failed: 0, total: 0})

function resultLine({repo, task, adapter, model, trial = 0, trials = 1, patchError}) {
	return {
		repo,
		sha: task.sha,
		parent_sha: task.parent_sha,
		adapter,
		model: model ?? null,
		trial,
		trials,
		resolved: false,
		reason: "git_error",
		patch: {applied: false, empty: false, files: [], deletions: [], error: patchError ?? null},
		tamper: {clean: true, findings: []},
		f2p: {required: 0, passed: 0, failed: []},
		p2p: {required: 0, passed: 0, failed: []},
		partial: {f2p_ratio: 0, p2p_ratio: 1},
		runs: {baseline: nullRuns(), candidate: nullRuns()},
		timing: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0},
		error: patchError ?? null
	}
}

function shapeEvalResult(res, {repo, task, adapter, model, trial, trials}) {
	return {
		repo: res.repo ?? repo,
		sha: res.sha ?? task.sha,
		parent_sha: res.parent_sha ?? task.parent_sha,
		adapter: res.adapter ?? adapter,
		model: res.model === undefined ? (model ?? null) : res.model,
		trial,
		trials,
		resolved: res.resolved === true,
		reason: EVAL_REASONS.includes(res.reason) ? res.reason : "git_error",
		patch: res.patch ?? {applied: false, empty: false, files: [], deletions: [], error: null},
		tamper: res.tamper ?? {clean: true, findings: []},
		f2p: res.f2p ?? {required: 0, passed: 0, failed: []},
		p2p: res.p2p ?? {required: 0, passed: 0, failed: []},
		partial: res.partial ?? {f2p_ratio: 0, p2p_ratio: 1},
		runs: res.runs ?? {baseline: nullRuns(), candidate: nullRuns()},
		timing: res.timing ?? {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0}
	}
}

// ---------------------------------------------------------------- run

let warned = []
function warn(msg) {
	warned.push(msg)
	console.error(`runner: ${msg}`)
}

async function main() {
	let cfg
	try {
		cfg = parseArgs(process.argv.slice(2))
	} catch (e) {
		console.error(`runner: ${errText(e)}`)
		console.error(USAGE)
		return 2
	}
	if (cfg.help) {
		console.log(USAGE)
		return 0
	}

	// A frozen set names its own repo(s) and tasks. The runner grades one repo per
	// run, so a multi-repo set needs --repo to pick the slice.
	let setInfo = null
	let setSlice = null
	if (cfg.set !== null) {
		try {
			const resolved = resolveSet(cfg.set, {
				dir: process.env.RUNNER_SETS_DIR || SETS_DIR,
				tasks: repo => selectTasks(repo, "all"),
				chains: repo => loadChains(repo),
				repo: cfg.repo
			})
			if (resolved.repos.length !== 1) {
				console.error(`runner: set ${cfg.set} spans repos ${resolved.repos.join(", ")}; pass --repo <r> to pick one slice per run`)
				return 2
			}
			cfg.repo = resolved.repos[0]
			setInfo = {name: resolved.set.name, version: resolved.set.version, frozen_at: resolved.set.frozen_at}
			setSlice = resolved.byRepo[cfg.repo]
		} catch (e) {
			console.error(`runner: ${errText(e)}`)
			return 2
		}
	}

	const specs = repoSpecs()
	const spec = specs[cfg.repo]
	if (!spec) throw new Error(`unknown repo: ${cfg.repo}`)
	if (!spec.cloneDir) throw new Error(`repo ${cfg.repo} has no cloneDir`)
	// The resolved spec (registry merged with RUNNER_REPOS_FILE) travels with cfg so
	// the leak audit derives the upstream identity from the same source.
	cfg.spec = spec

	const isChain = !!cfg.chain
	let tasks = []
	let chains = []
	try {
		if (isChain) {
			// Chain mode ignores --task: the chain data names its own steps. The
			// full task records (with message_body) come from the tasks file,
			// looked up by sha inside selectChains(). With --set the pool of
			// chains is the set's pinned list.
			chains = selectChains(cfg.repo, cfg.chain, selectTasks(cfg.repo, "all"), setSlice ? setSlice.chains : null)
			if (cfg.limit !== null) chains = chains.slice(0, cfg.limit)
			if (chains.length === 0) {
				console.error(`runner: no chains selected for repo ${cfg.repo}`)
				return 2
			}
		} else {
			tasks = setSlice ? setSlice.tasks : selectTasks(cfg.repo, cfg.task)
			if (cfg.limit !== null) tasks = tasks.slice(0, cfg.limit)
			if (tasks.length === 0) {
				console.error(`runner: no tasks selected for repo ${cfg.repo}`)
				return 2
			}
		}
	} catch (e) {
		console.error(`runner: ${errText(e)}`)
		return 2
	}
	// Result lines are keyed by (repo, sha) for report.mjs, so a chain's manifest
	// lists each step sha once (deduped) and keeps the chain structure separately.
	const manifestTasks = isChain ? [...new Set(chains.flatMap(c => c.steps.map(s => s.sha)))] : tasks.map(t => t.sha)

	const evaluatorPath = process.env.RUNNER_EVALUATOR || DEFAULT_EVALUATOR
	const adaptersDir = process.env.RUNNER_ADAPTERS_DIR || DEFAULT_ADAPTERS_DIR
	const {mod: evaluator} = await loadModule(evaluatorPath, "evaluator")
	if (typeof evaluator.evaluate !== "function") throw new Error(`evaluator has no evaluate(): ${evaluatorPath}`)
	const adapterMods = []
	for (const name of cfg.adapters) {
		const {abs, mod} = await loadModule(path.join(adaptersDir, `${name}.mjs`), `adapter ${name}`)
		const a = mod.default
		if (!a || typeof a.run !== "function") throw new Error(`adapter ${abs} has no default.run()`)
		adapterMods.push({
			name,
			version: a.version ?? null,
			module: abs,
			run: a.run.bind(a),
			// Per-adapter model (--model-for) falls back to the run-wide --model.
			model: cfg.modelFor[name] !== undefined ? cfg.modelFor[name] : cfg.model,
			statePaths: validateStatePaths(a.statePaths, name)
		})
	}

	// Sandbox resource limits, applied identically to every harness and to the
	// evaluator: an agent that runs a repo's whole vitest suite spawns one worker
	// per CPU by default (10 here), and two such pools alongside the evaluator's
	// pushed a 24 GB host into swap. Operators may override by exporting the
	// variables first; what was in effect is recorded in the manifest.
	const SANDBOX_ENV_DEFAULTS = {VITEST_MAX_WORKERS: "2", VITEST_MIN_WORKERS: "1", VITEST_MAX_THREADS: "2", VITEST_MIN_THREADS: "1"}
	const sandboxEnv = {}
	for (const [k, v] of Object.entries(SANDBOX_ENV_DEFAULTS)) {
		if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v
		sandboxEnv[k] = process.env[k]
	}
	// The hardening below is applied around every adapter invocation only (see
	// runStepInSandbox); it is listed here so the manifest states what the
	// harness ran under.
	for (const [k, v] of Object.entries(SANDBOX_HARDENING)) sandboxEnv[k] = v
	for (const k of SANDBOX_UNSET) sandboxEnv[k] = null
	sandboxEnv.GH_CONFIG_DIR = "<fresh empty dir per trial>"

	const startedMs = Date.now()
	const startedAt = iso()
	const runId = cfg.out ? sanitize(path.basename(path.resolve(cfg.out))) : `${startedAt.replace(/[:.]/g, "-")}-${cfg.repo}-${cfg.adapters.join("+")}`
	const outDir = cfg.out ? path.resolve(cfg.out) : path.join(RUNS_DIR, runId)
	const resultsPath = path.join(outDir, "results.jsonl")
	const baselinesPath = path.join(outDir, "baselines.jsonl")
	const manifestPath = path.join(outDir, "manifest.json")
	const deadline = cfg.budgetMs === null ? null : startedMs + cfg.budgetMs
	fs.mkdirSync(outDir, {recursive: true})
	if (!fs.existsSync(resultsPath)) fs.writeFileSync(resultsPath, "")
	const resume = cfg.resume ? loadResume(resultsPath, cfg.chain !== null) : null
	if (resume) console.log(`runner: resuming ${path.relative(process.cwd(), outDir) || outDir}: ${resume.priorLines} prior line(s)${resume.compacted ? `, ${resume.compacted} partial chain trial(s) dropped for re-run` : ""}`)
	const stateMgr = makeStateManager({mode: cfg.state, keep: cfg.keepState, outDir})
	let stateKept = null

	const state = {
		items: 0,
		resolved: 0,
		failed: 0,
		baselines: 0,
		baselineErrors: 0,
		stopped: null,
		interrupted: false
	}
	const manifest = () => {
		const cloneHead = git(spec.cloneDir, ["rev-parse", "HEAD"])
		return {
			id: runId,
			started_at: startedAt,
			ended_at: iso(),
			wall_ms: Date.now() - startedMs,
			mode: cfg.baselineOnly ? "baseline-only" : isChain ? "chain" : "run",
			node: process.version,
			platform: `${os.platform()} ${os.arch()}`,
			cwd: process.cwd(),
			git_head: git(ROOT, ["rev-parse", "HEAD"]).stdout.trim() || null,
			config: {
				repo: cfg.repo,
				task: cfg.task,
				adapter: cfg.adapters,
				model: cfg.model ?? null,
				limit: cfg.limit,
				budget_ms: cfg.budgetMs,
				item_budget_ms: cfg.itemBudgetMs,
				prompt_version: PROMPT_VERSION,
				sandbox_env: sandboxEnv,
				leak_audit: {enabled: true, version: LEAK_AUDIT_VERSION},
				trials: cfg.trials,
				out: outDir,
				baseline_only: cfg.baselineOnly,
				model_for: cfg.modelFor,
				state: cfg.state,
				keep_state: cfg.keepState,
				...(cfg.set !== null ? {set: cfg.set} : {}),
				...(isChain ? {chain: cfg.chain, chain_mode: cfg.chainMode} : {})
			},
			set: setInfo,
			state: {mode: cfg.state, dir: stateMgr.root, kept: stateKept},
			resume: resume ? {at: resume.at, prior_lines: resume.priorLines, skipped: resume.skipped, compacted_partial_chain_trials: resume.compacted} : null,
			repo: {
				url: spec.url ?? null,
				clone_dir: spec.cloneDir,
				clone_head: cloneHead.ok ? cloneHead.stdout.trim() : null
			},
			adapter: adapterMods.map(a => ({name: a.name, version: a.version, module: a.module, model: a.model ?? null, state_paths: a.statePaths})),
			evaluator: path.resolve(evaluatorPath),
			tasks: manifestTasks,
			...(isChain
				? {chains: chains.map(c => ({chain_id: c.chain_id, length: c.steps.length, steps: c.steps.map(s => s.sha)}))}
				: {}),
			counts: {items: state.items, resolved: state.resolved, failed: state.failed, baselines: state.baselines, baseline_errors: state.baselineErrors},
			stopped: state.stopped,
			warnings: warned
		}
	}
	writeJsonAtomic(manifestPath, manifest())

	const onSignal = sig => {
		state.interrupted = sig
		state.stopped = state.stopped || {reason: "interrupted", signal: sig, at: iso()}
	}
	process.on("SIGINT", () => onSignal("SIGINT"))
	process.on("SIGTERM", () => onSignal("SIGTERM"))

	const budgetLeft = () => (deadline === null ? null : Math.max(0, deadline - Date.now()))
	const budgetOut = () => deadline !== null && Date.now() >= deadline

	// Baseline is computed once per task (the evaluator's own disk cache makes it
	// once per task across runs too) and reused by every adapter on that task.
	const baselineCache = new Map()
	const getBaseline = async (task, evalWt) => {
		if (baselineCache.has(task.sha)) return baselineCache.get(task.sha)
		const base = await evaluator.baseline({repo: cfg.repo, task, dir: evalWt, opts: {}})
		baselineCache.set(task.sha, base)
		// Counted here so the number means the same thing in both modes: chains hit
		// this once per distinct step sha, flat runs once per task, and a cache hit
		// never inflates either.
		state.baselines++
		return base
	}

	// One eval worktree per task: the evaluator mutates `dir` (checkout -f +
	// clean -fd + oracle injection), so it must not be the adapter's worktree.
	const evalWorktrees = []
	const cleanup = () => {
		for (const wt of evalWorktrees.splice(0)) {
			const e = removeWorktree(spec.cloneDir, wt)
			if (e) warn(`eval worktree cleanup: ${e}`)
		}
	}

	if (isChain) {
		await runChainMode({cfg, spec, runId, outDir, chains, adapterMods, evaluator, state, budgetOut, budgetLeft, getBaseline, evalWorktrees, stateMgr, resume})
		cleanup()
		stateKept = stateMgr.finish().kept
		if (!state.stopped && state.interrupted) state.stopped = {reason: "interrupted", signal: state.interrupted, at: iso()}
		writeJsonAtomic(manifestPath, manifest())
		console.log(
			`runner: ${state.items} item(s) -> resolved=${state.resolved} failed=${state.failed} ` +
				`baselines=${state.baselines} out=${path.relative(process.cwd(), outDir) || outDir}`
		)
		return state.interrupted ? 130 : 0
	}

	taskLoop: for (const task of tasks) {
		if (state.interrupted) break
		if (budgetOut()) {
			state.stopped = {reason: "budget_exceeded", at: iso(), budget_ms: cfg.budgetMs}
			break
		}

		if (cfg.baselineOnly) {
			let line
			try {
				const wt = addWorktree(spec.cloneDir, outDir, runId, task.sha, "baseline", task.parent_sha)
				linkDeps(spec.cloneDir, wt.path)
				try {
					const base = await evaluator.baseline({repo: cfg.repo, task, dir: wt.path, opts: {}})
					line = {
						sha: task.sha,
						parent_sha: task.parent_sha,
						ok: true,
						ran_at: base.ran_at ?? iso(),
						f2p: base.f2p ?? [],
						p2p: base.p2p ?? [],
						raw: base.raw ?? null,
						timing_ms: base.timing_ms ?? null
					}
				} finally {
					const e = removeWorktree(spec.cloneDir, wt)
					if (e) warn(`baseline worktree cleanup: ${e}`)
				}
			} catch (e) {
				line = {sha: task.sha, parent_sha: task.parent_sha, ok: false, error: errText(e)}
			}
			if (line.ok) state.baselines++
			else state.baselineErrors++
			appendLine(baselinesPath, line)
			continue
		}

		if (resume) {
			let pending = 0
			for (const adapter of adapterMods) for (let trial = 0; trial < cfg.trials; trial++) if (!resume.done.has(itemKey(task.sha, adapter.name, trial))) pending++
			if (pending === 0) {
				resume.skipped += adapterMods.length * cfg.trials
				continue
			}
		}

		let evalWt = null
		let evalWtError = null
		let base = null
		let baseError = null
		try {
			evalWt = addWorktree(spec.cloneDir, outDir, runId, task.sha, "eval", task.parent_sha)
			linkDeps(spec.cloneDir, evalWt.path)
			evalWorktrees.push(evalWt)
		} catch (e) {
			evalWtError = e
		}
		if (evalWt) {
			try {
				base = await getBaseline(task, evalWt.path)
			} catch (e) {
				baseError = e
				state.baselineErrors++
			}
		}

		for (const adapter of adapterMods) {
			if (state.interrupted) break
			for (let trial = 0; trial < cfg.trials; trial++) {
				if (state.interrupted) break
				// The in-loop budget check only exists to stop repeated trials early.
				// At the default --trials 1 it would change frozen legacy behaviour
				// (stopping mid-task and marking the run partial), so gate it.
				if (cfg.trials > 1 && budgetOut()) {
					state.stopped = {reason: "budget_exceeded", at: iso(), budget_ms: cfg.budgetMs}
					break taskLoop
				}
				if (resume && resume.done.has(itemKey(task.sha, adapter.name, trial))) {
					resume.skipped++
					continue
				}
				// A single-trial run keeps the frozen <sha>/<adapter> layout; repeated
				// trials must not overwrite each other, so each gets its own tN dir.
				const itemDir = cfg.trials === 1 ? path.join(outDir, task.sha, adapter.name) : path.join(outDir, task.sha, adapter.name, `t${trial}`)
				fs.mkdirSync(itemDir, {recursive: true})
				let line
				try {
					line = await runItem({cfg, spec, runId, outDir, itemDir, task, adapter, trial, evalWt, evalWtError, base, baseError, evaluator, budgetLeft, stateMgr})
				} catch (e) {
					// Last-resort guard: runItem records its own failures, so this
					// only fires on a bug in the runner itself.
					line = {
						...resultLine({repo: cfg.repo, task, adapter: adapter.name, model: adapter.model, trial, trials: cfg.trials, patchError: errText(e)}),
						telemetry: emptyTelemetry(),
						adapter_run: normalizeAdapterResult(null, {...adapter, outDir: itemDir}, adapter.model, 0, e)
					}
					warn(`item ${task.sha.slice(0, 8)}/${adapter.name} t${trial} crashed: ${errText(e)}`)
				}
				state.items++
				if (line.resolved) state.resolved++
				else state.failed++
				// Every emitted line (success or failure) is self-describing about cost.
				line.cost = costOf(line.model, line.telemetry)
				appendLine(resultsPath, line)
			}
		}

		if (evalWt) {
			const e = removeWorktree(spec.cloneDir, evalWt)
			if (e) warn(`eval worktree cleanup: ${e}`)
			const i = evalWorktrees.indexOf(evalWt)
			if (i >= 0) evalWorktrees.splice(i, 1)
		}
	}

	cleanup()
	stateKept = stateMgr.finish().kept
	if (!state.stopped && state.interrupted) state.stopped = {reason: "interrupted", signal: state.interrupted, at: iso()}
	writeJsonAtomic(manifestPath, manifest())
	console.log(
		`runner: ${state.items} item(s) -> resolved=${state.resolved} failed=${state.failed} ` +
			`baselines=${state.baselines} out=${path.relative(process.cwd(), outDir) || outDir}`
	)
	return state.interrupted ? 130 : 0
}

const itemKey = (sha, adapter, trial) => `${sha}|${adapter}|${trial}`
const chainKey = (chainId, adapter, trial) => `${chainId}|${adapter}|${trial}`

// --resume: read what an interrupted run already wrote. Task mode skips every
// (sha, adapter, trial) present. Chain mode can only skip a COMPLETE chain trial
// (every step present): steps build on each other in one worktree, so a partial
// trial cannot be continued and is dropped from results.jsonl (a backup is kept
// beside it) to be re-run from step 1. Lines predating the trial keys default
// to trial 0, as the contract requires.
function loadResume(resultsPath, isChain) {
	const raw = fs.readFileSync(resultsPath, "utf8")
	const lines = []
	for (const l of raw.split("\n")) {
		const t = l.trim()
		if (!t) continue
		try {
			lines.push({text: t, obj: JSON.parse(t)})
		} catch {
			lines.push({text: t, obj: null})
		}
	}
	const done = new Set()
	const doneChains = new Set()
	let compacted = 0
	if (!isChain) {
		for (const {obj} of lines) {
			if (!obj || typeof obj.sha !== "string" || typeof obj.adapter !== "string") continue
			if (typeof obj.chain_id === "string") continue
			done.add(itemKey(obj.sha, obj.adapter, Number.isInteger(obj.trial) ? obj.trial : 0))
		}
	} else {
		const groups = new Map()
		for (const {obj} of lines) {
			if (!obj || typeof obj.chain_id !== "string" || typeof obj.adapter !== "string") continue
			const k = chainKey(obj.chain_id, obj.adapter, Number.isInteger(obj.trial) ? obj.trial : 0)
			if (!groups.has(k)) groups.set(k, {steps: new Set(), length: null})
			const g = groups.get(k)
			if (Number.isInteger(obj.chain_step)) g.steps.add(obj.chain_step)
			if (Number.isInteger(obj.chain_length)) g.length = obj.chain_length
		}
		const partial = new Set()
		for (const [k, g] of groups) {
			if (g.length !== null && g.steps.size >= g.length) doneChains.add(k)
			else partial.add(k)
		}
		if (partial.size) {
			fs.copyFileSync(resultsPath, `${resultsPath}.pre-resume-${Date.now()}`)
			const kept = lines.filter(({obj}) => {
				if (!obj || typeof obj.chain_id !== "string" || typeof obj.adapter !== "string") return true
				return !partial.has(chainKey(obj.chain_id, obj.adapter, Number.isInteger(obj.trial) ? obj.trial : 0))
			})
			fs.writeFileSync(resultsPath, kept.length ? `${kept.map(x => x.text).join("\n")}\n` : "")
			compacted = partial.size
		}
	}
	return {at: iso(), priorLines: lines.length, done, doneChains, skipped: 0, compacted}
}

// The adapter's budget is the smaller of what the run has left and the per-item cap.
function itemBudget(cfg, left) {
	if (left === null) return cfg.itemBudgetMs
	return Math.min(left, cfg.itemBudgetMs)
}

async function runItem({cfg, spec, runId, outDir, itemDir, task, adapter, trial, evalWt, evalWtError, base, baseError, evaluator, budgetLeft, stateMgr}) {
	const itemStart = Date.now()
	let wt = null
	let setupError = null
	try {
		wt = makeAgentSandbox(spec, outDir, runId, task, adapter.name)
		linkDeps(spec.cloneDir, wt.path)
	} catch (e) {
		setupError = e
	}
	try {
		return await runStepInSandbox({
			cfg,
			adapter,
			task,
			prompt: taskPrompt(task),
			sandbox: wt,
			setupError,
			itemDir,
			itemStart,
			trial,
			evalWt,
			evalWtError,
			base,
			baseError,
			evaluator,
			budgetLeft,
			stateMgr,
			stateScope: {kind: "task", sha: task.sha, trial}
		})
	} finally {
		const e = removeWorktree(spec.cloneDir, wt)
		if (e) warn(`worktree cleanup: ${e}`)
	}
}

// Runs the adapter once inside an existing sandbox, captures the patch from the
// sandbox's base commit, archives adapter.json and grades it against `task`'s
// baseline. Flat tasks use one step and a throwaway sandbox; a chain reuses one
// sandbox for every step so each captured diff is cumulative from the chain base.
async function runStepInSandbox({
	cfg,
	adapter,
	task,
	prompt,
	sandbox,
	setupError = null,
	itemDir,
	itemStart,
	trial,
	evalWt,
	evalWtError,
	base,
	baseError,
	evaluator,
	budgetLeft,
	stateMgr,
	stateScope
}) {
	let adapterRun = null
	let adapterError = null
	let patchError = null
	let patchWritten = false
	const patchPath = path.join(itemDir, "candidate.patch")
	fs.mkdirSync(itemDir, {recursive: true})
	const model = adapter.model

	// The state dir exists for exactly the adapter invocation. It is delivered
	// twice on purpose: as an argument for adapters that read it, and as
	// BENCH_STATE_DIR in the environment the adapter's child processes inherit.
	const stateHandle = stateMgr.acquire({adapter: adapter.name, scope: stateScope})
	const stateRecord = {
		mode: stateHandle.mode,
		dir_reused: stateHandle.reused,
		bytes_before: stateHandle.bytes_before,
		bytes_after: null,
		in_tree_paths: adapter.statePaths || []
	}
	const prevStateEnv = process.env.BENCH_STATE_DIR
	process.env.BENCH_STATE_DIR = stateHandle.dir
	// Sandbox hardening for the duration of the adapter call: no GitHub
	// credentials (gh gets an empty config dir, tokens are removed), git limited
	// to local protocols, package registries pointed at a dead port. Dependencies
	// are preinstalled, so nothing legitimate needs them. This is the deterrent;
	// the transcript audit below is the enforcement (curl cannot be disabled).
	const hardening = applySandboxHardening()

	try {
		if (setupError) throw setupError
		try {
			const raw = await adapter.run({
				prompt,
				dir: sandbox.path,
				model,
				budgetMs: itemBudget(cfg, budgetLeft()),
				outDir: itemDir,
				stateDir: stateHandle.dir
			})
			adapterRun = normalizeAdapterResult(raw, {...adapter, outDir: itemDir}, model, Date.now() - itemStart, null)
		} catch (e) {
			adapterError = e
			adapterRun = normalizeAdapterResult(null, {...adapter, outDir: itemDir}, model, Date.now() - itemStart, e)
			warn(`adapter ${adapter.name} threw on ${task.sha.slice(0, 8)}: ${errText(e)}`)
		}
		// The patch is always taken from the worktree, never from the adapter's
		// self-report, and it is captured even when the adapter failed.
		try {
			const patch = capturePatch(sandbox.path, sandbox.baseSha, adapter.statePaths)
			fs.writeFileSync(patchPath, patch === "" ? "" : patch.endsWith("\n") ? patch : `${patch}\n`)
			patchWritten = true
		} catch (e) {
			patchError = e
		}
	} catch (e) {
		patchError = patchError || e
		if (!adapterRun) adapterRun = normalizeAdapterResult(null, {...adapter, outDir: itemDir}, model, Date.now() - itemStart, adapterError || e)
	} finally {
		hardening.restore()
		if (prevStateEnv === undefined) delete process.env.BENCH_STATE_DIR
		else process.env.BENCH_STATE_DIR = prevStateEnv
		try {
			stateRecord.bytes_after = stateMgr.release(stateHandle)
		} catch (e) {
			warn(`state dir release: ${errText(e)}`)
		}
	}
	if (!patchWritten) fs.writeFileSync(patchPath, "")
	adapterRun.state = stateRecord

	// Answer-lookup audit over what the harness executed. Grading still happens
	// below (the patch is stored and scored); a fatal finding then overrides the
	// verdict and keeps it under `graded` so nothing is hidden.
	const leak = auditAdapterTranscript(adapterRun, adapter, cfg)
	const finish = line => applyLeak(line, leak)

	fs.writeFileSync(path.join(itemDir, "adapter.json"), `${JSON.stringify(adapterRun, null, "\t")}\n`)

	const failure = evalWtError ? `eval worktree: ${errText(evalWtError)}` : baseError ? `baseline: ${errText(baseError)}` : patchError ? `patch capture: ${errText(patchError)}` : null
	if (failure) {
		const line = resultLine({repo: cfg.repo, task, adapter: adapter.name, model, trial, trials: cfg.trials, patchError: failure})
		if (base) {
			line.f2p = {required: (base.f2p || []).length, passed: 0, failed: [...(base.f2p || [])]}
			line.p2p = {required: (base.p2p || []).length, passed: 0, failed: [...(base.p2p || [])]}
			line.runs.baseline = base.raw ?? nullRuns()
		}
		line.telemetry = adapterRun.telemetry
		line.adapter_run = adapterRun
		finish(line)
		fs.writeFileSync(path.join(itemDir, "eval.json"), `${JSON.stringify(line, null, "\t")}\n`)
		return line
	}

	let res
	try {
		res = await evaluator.evaluate({
			repo: cfg.repo,
			task,
			candidatePatch: patchPath,
			dir: evalWt.path,
			baseline: base,
			opts: {model, adapter: adapter.name}
		})
	} catch (e) {
		const line = resultLine({repo: cfg.repo, task, adapter: adapter.name, model, trial, trials: cfg.trials, patchError: `evaluate: ${errText(e)}`})
		line.f2p = {required: (base.f2p || []).length, passed: 0, failed: [...(base.f2p || [])]}
		line.p2p = {required: (base.p2p || []).length, passed: 0, failed: [...(base.p2p || [])]}
		line.runs.baseline = base.raw ?? nullRuns()
		line.telemetry = adapterRun.telemetry
		line.adapter_run = adapterRun
		finish(line)
		fs.writeFileSync(path.join(itemDir, "eval.json"), `${JSON.stringify(line, null, "\t")}\n`)
		warn(`evaluate threw on ${task.sha.slice(0, 8)}/${adapter.name}: ${errText(e)}`)
		return line
	}

	fs.writeFileSync(path.join(itemDir, "eval.json"), `${JSON.stringify(res, null, "\t")}\n`)
	return finish({
		...shapeEvalResult(res, {repo: cfg.repo, task, adapter: adapter.name, model, trial, trials: cfg.trials}),
		telemetry: adapterRun.telemetry,
		adapter_run: adapterRun
	})
}

// ---- sandbox hardening + leak audit -----------------------------------------

const SANDBOX_HARDENING = {
	GIT_ALLOW_PROTOCOL: "file",
	npm_config_registry: "http://127.0.0.1:9/",
	NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
	YARN_REGISTRY: "http://127.0.0.1:9/",
	PNPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
	PIP_INDEX_URL: "http://127.0.0.1:9/simple",
	PIP_NO_INDEX: "1"
}
const SANDBOX_UNSET = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]

function applySandboxHardening() {
	const saved = new Map()
	const remember = k => {
		if (!saved.has(k)) saved.set(k, process.env[k])
	}
	for (const [k, v] of Object.entries(SANDBOX_HARDENING)) {
		remember(k)
		process.env[k] = v
	}
	for (const k of SANDBOX_UNSET) {
		remember(k)
		delete process.env[k]
	}
	remember("GH_CONFIG_DIR")
	const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-gh-"))
	process.env.GH_CONFIG_DIR = ghDir
	return {
		restore() {
			for (const [k, v] of saved) {
				if (v === undefined) delete process.env[k]
				else process.env[k] = v
			}
			fs.rmSync(ghDir, {recursive: true, force: true})
		}
	}
}

function repoIdentityOf(spec) {
	if (typeof REGISTRY.repoIdentity === "function") {
		try {
			const id = REGISTRY.repoIdentity(spec)
			if (id && typeof id === "object") return id
		} catch {}
	}
	return identityFromSpec(spec)
}

function auditAdapterTranscript(adapterRun, adapter, cfg) {
	const p = adapterRun && typeof adapterRun.transcript_path === "string" ? adapterRun.transcript_path : null
	let text = ""
	if (p && fs.existsSync(p)) {
		try {
			text = fs.readFileSync(p, "utf8")
		} catch {}
	}
	const spec = cfg && cfg.spec ? cfg.spec : REPOS[cfg.repo] || {name: cfg.repo}
	return auditTranscript(text, {adapter: adapter.name, identity: repoIdentityOf(spec)})
}

// A fatal finding overrides the verdict; the evaluator's own verdict is kept
// under `graded` so a reader can see what the patch would have scored.
function applyLeak(line, leak) {
	line.leak = leak
	if (leak && leak.clean === false) {
		line.graded = {resolved: line.resolved === true, reason: line.reason}
		line.resolved = false
		line.reason = "answer_lookup"
	}
	return line
}

// ---- chains ----------------------------------------------------------------

// incremental: only the current step's task. roadmap: the same, prefixed with
// the plan (every step's subject) and never with any part of the answer.
function chainPrompt(step, chain, mode) {
	if (mode !== "roadmap") return taskPrompt(step.task)
	const plan = chain.steps.map(s => `${s.ordinal}. ${s.subject}`).join("\n")
	return `${TASK_INSTRUCTIONS}\n\nOverall plan (${chain.steps.length} sequential tasks in this session):\n${plan}\n\nCurrent task (${step.ordinal} of ${chain.steps.length}):\n${taskSpec(step.task)}`
}

async function runChainMode({cfg, spec, runId, outDir, chains, adapterMods, evaluator, state, budgetOut, budgetLeft, getBaseline, evalWorktrees, stateMgr, resume = null}) {
	const resultsPath = path.join(outDir, "results.jsonl")

	chainLoop: for (const chain of chains) {
		if (state.interrupted) break
		if (budgetOut()) {
			state.stopped = {reason: "budget_exceeded", at: iso(), budget_ms: cfg.budgetMs}
			break
		}

		// One eval worktree per chain: the evaluator mutates `dir` (checkout -f +
		// clean -fd + oracle injection), and every step of the chain is graded
		// against that step's OWN parent. Steps run sequentially, so one is enough.
		const baseSha = chain.steps[0].parent_sha
		let evalWt = null
		let evalWtError = null
		try {
			evalWt = addWorktree(spec.cloneDir, outDir, runId, baseSha, `eval-${chain.chain_id}`, baseSha)
			linkDeps(spec.cloneDir, evalWt.path)
			evalWorktrees.push(evalWt)
		} catch (e) {
			evalWtError = e
		}

		for (const adapter of adapterMods) {
			for (let trial = 0; trial < cfg.trials; trial++) {
				if (state.interrupted) break chainLoop
				if (resume && resume.doneChains.has(chainKey(chain.chain_id, adapter.name, trial))) {
					resume.skipped++
					continue
				}
				if (budgetOut()) {
					state.stopped = {reason: "budget_exceeded", at: iso(), budget_ms: cfg.budgetMs}
					break chainLoop
				}
				const {lines, stopped} = await runChainTrial({
					cfg,
					spec,
					runId,
					outDir,
					chain,
					adapter,
					trial,
					evalWt,
					evalWtError,
					evaluator,
					state,
					budgetOut,
					budgetLeft,
					getBaseline,
					stateMgr
				})
				for (const line of lines) {
					state.items++
					if (line.resolved) state.resolved++
					else state.failed++
					// Every emitted line (success or failure) is self-describing about cost.
					line.cost = costOf(line.model, line.telemetry)
					appendLine(resultsPath, line)
				}
				if (stopped) {
					state.stopped = stopped
					break chainLoop
				}
			}
		}

		if (evalWt) {
			const e = removeWorktree(spec.cloneDir, evalWt)
			if (e) warn(`eval worktree cleanup: ${e}`)
			const i = evalWorktrees.indexOf(evalWt)
			if (i >= 0) evalWorktrees.splice(i, 1)
		}
	}
}

async function runChainTrial({cfg, spec, runId, outDir, chain, adapter, trial, evalWt, evalWtError, evaluator, state, budgetOut, budgetLeft, getBaseline, stateMgr}) {
	const steps = chain.steps
	const baseSha = steps[0].parent_sha
	// A single-trial chain keeps the flat <chain_id>/<adapter>/step-<n> layout;
	// repeated trials must not overwrite each other, so each gets its own tN dir.
	const itemBase =
		cfg.trials === 1
			? path.join(outDir, chain.chain_id, adapter.name)
			: path.join(outDir, chain.chain_id, adapter.name, `t${trial}`)

	let wt = null
	let setupError = null
	try {
		// ONE sandbox for the whole chain, seeded at the chain base. Every step
		// runs in it, so later steps see the agent's earlier edits.
		wt = makeAgentSandbox(spec, outDir, runId, {sha: baseSha, parent_sha: baseSha}, `${adapter.name}-${chain.chain_id}`, steps.map(s => s.sha))
		linkDeps(spec.cloneDir, wt.path)
	} catch (e) {
		setupError = e
	}

	const collected = []
	let stopped = null
	try {
		for (const step of steps) {
			if (state.interrupted) break
			if (budgetOut()) {
				stopped = {reason: "budget_exceeded", at: iso(), budget_ms: cfg.budgetMs}
				break
			}
			const itemStart = Date.now()
			const stepDir = path.join(itemBase, `step-${step.ordinal}`)
			let base = null
			let baseError = null
			if (evalWt) {
				try {
					base = await getBaseline(step.task, evalWt.path)
				} catch (e) {
					baseError = e
					state.baselineErrors++
				}
			}
			const line = await runStepInSandbox({
				cfg,
				adapter,
				task: step.task,
				prompt: chainPrompt(step, chain, cfg.chainMode),
				sandbox: wt,
				setupError,
				itemDir: stepDir,
				itemStart,
				trial,
				evalWt,
				evalWtError,
				base,
				baseError,
				evaluator,
				budgetLeft,
				stateMgr,
				stateScope: {kind: "chain", chainId: chain.chain_id, trial, step: step.ordinal}
			})
			collected.push({step, line})
		}
	} finally {
		const e = removeWorktree(spec.cloneDir, wt)
		if (e) warn(`worktree cleanup: ${e}`)
	}

	// A failed step never aborts the chain; the outcome is only known once every
	// step has been graded, so every line of the chain carries the same flag.
	const complete = !stopped && collected.length === steps.length
	const chainResolved = complete && collected.every(x => x.line.resolved)
	const lines = collected.map(({step, line}) => ({
		...line,
		chain_id: chain.chain_id,
		chain_step: step.ordinal,
		chain_length: steps.length,
		chain_resolved: chainResolved
	}))
	return {lines, stopped}
}

main()
	.then(code => process.exit(code))
	.catch(e => {
		console.error(`runner: fatal: ${errText(e)}`)
		process.exit(1)
	})
