import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawn, spawnSync} from "node:child_process"
import {fileURLToPath} from "node:url"

// Self-contained test for runner/run.mjs. It never imports the real evaluator or
// the real adapters: a synthetic git repo, a stub evaluator (RUNNER_EVALUATOR), a
// stub adapter dir (RUNNER_ADAPTERS_DIR) and injected repo/task files
// (RUNNER_REPOS_FILE / RUNNER_TASKS_FILE) keep this independent of the other
// workers. The last section exercises the real evaluator on a scratch immer copy
// when one exists.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const RUNNER = path.join(ROOT, "runner", "run.mjs")

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

function git(dir, args, allowFail = false) {
	const r = spawnSync("git", args, {cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024})
	if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
	return (r.stdout || "").trim()
}

function write(root, rel, content) {
	const p = path.join(root, rel)
	fs.mkdirSync(path.dirname(p), {recursive: true})
	fs.writeFileSync(p, content)
}

function tmpdir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// --- fixtures ---------------------------------------------------------------

const STUB_ADAPTER = `import fs from "node:fs"
import path from "node:path"
const mode = "patch"
export default {
\tname: "stub",
\tversion: "test-1",
\tasync run({prompt, dir, model, budgetMs, outDir}) {
\t\t// A stale/bogus self-report the runner must ignore: the real patch is
\t\t// whatever ends up in the worktree.
\t\tconst claim = "THIS IS NOT THE PATCH"
\t\tfs.writeFileSync(path.join(outDir, "transcript.txt"), \`cwd=\${dir}\\nprompt=\${prompt}\\nmodel=\${model}\\nbudgetMs=\${budgetMs}\\n\`)
\t\tif (mode === "empty") {
\t\t\treturn {harness: "stub", model, exit_code: 0, timed_out: false, wall_ms: 1, failure_mode: "none", telemetry: {}, transcript_path: path.join(outDir, "transcript.txt"), notes: "", patch: claim}
\t\t}
\t\tif (mode === "boom") throw new Error("adapter exploded on purpose")
\t\tfs.writeFileSync(path.join(dir, "src/agent-note.txt"), "hello from the stub adapter\\n")
\t\tfs.appendFileSync(path.join(dir, "src/tracked.js"), "export const touched = true\\n")
\t\treturn {
\t\t\tharness: "stub",
\t\t\tmodel,
\t\t\texit_code: 0,
\t\t\ttimed_out: false,
\t\t\twall_ms: 7,
\t\t\tfailure_mode: "none",
\t\t\ttelemetry: {input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: null, cost_usd: 0.0025},
\t\t\ttranscript_path: path.join(outDir, "transcript.txt"),
\t\t\tnotes: "stub",
\t\t\tturns: 4,
\t\t\ttopology: {parse: "stub-events", total_tool_calls: 6, tool_calls: {bash: 5, subagent: 1}, tool_errors: {}, subagents: {calls: 1, distinct: 1, by_agent: {reviewer: 1}, prompt_chars: 12, max_prompt_chars: 12}, retries: 0, delegation_ratio: 0.16666666666666666},
\t\t\tpatch: claim
\t\t}
\t}
}
`

const variant = (name, mode) => STUB_ADAPTER.replace('const mode = "patch"', `const mode = "${mode}"`).replace('name: "stub"', `name: "${name}"`)

// A harness that keeps local state: it writes an "index" into the state dir it
// is handed, counts what was already there (so warm reuse is observable), writes
// in-tree state under .codify (declared via statePaths, so it must never reach
// the patch), and probes whether the shas in PROBE_SHAS are readable from the
// sandbox. In a chain it also drops the STEP_FIX marker the chain evaluator
// grades on, so the same fixture serves flat and chain scenarios.
const STATE_ADAPTER = `import fs from "node:fs"
import path from "node:path"
import {spawnSync} from "node:child_process"
export default {
	name: "state",
	version: "test-1",
	statePaths: [".codify/"],
	async run({prompt, dir, model, budgetMs, outDir, stateDir}) {
		const envDir = process.env.BENCH_STATE_DIR || ""
		const before = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : -1
		const progress = path.join(stateDir, "index.bin")
		let n = 0
		try { n = Number(fs.readFileSync(progress, "utf8").split("|")[0]) || 0 } catch {}
		n++
		fs.writeFileSync(progress, n + "|" + "x".repeat(1000 * n))
		fs.mkdirSync(path.join(dir, ".codify"), {recursive: true})
		fs.writeFileSync(path.join(dir, ".codify", "graph.json"), '{"CODIFY_GRAPH_MARKER":' + n + '}')
		fs.writeFileSync(path.join(dir, "src/agent-note.txt"), "hello from the stub adapter\\n")
		fs.writeFileSync(path.join(dir, "src/chain-step-" + n + ".txt"), "STEP_FIX_" + n + "\\n")
		const probes = (process.env.PROBE_SHAS || "").split(",").filter(Boolean).map(sha => {
			const r = spawnSync("git", ["cat-file", "-e", sha + "^{commit}"], {cwd: dir, encoding: "utf8"})
			return "probe:" + sha + "=" + (r.status === 0 ? "readable" : "unreadable")
		})
		fs.writeFileSync(path.join(outDir, "transcript.txt"), ["cwd=" + dir, "stateDir=" + stateDir, "env=" + envDir, "state_files=" + before, "n=" + n, ...probes].join("\\n") + "\\n")
		return {harness: "state", model, exit_code: 0, timed_out: false, wall_ms: 1, failure_mode: "none", telemetry: {}, transcript_path: path.join(outDir, "transcript.txt"), notes: ""}
	}
}
`

// A harness that looks the answer up: its transcript carries one executed
// command (pi-shaped event) fetching the upstream PR, plus a dump of the
// sandbox environment it saw, so hardening is observable from outside.
const LEAKY_ADAPTER = `import fs from "node:fs"
import path from "node:path"
export default {
	name: "leaky",
	version: "test-1",
	async run({prompt, dir, model, budgetMs, outDir}) {
		fs.writeFileSync(path.join(dir, "src/agent-note.txt"), "hello from the leaky adapter\\n")
		const cmd = process.env.LEAKY_COMMAND || "curl -s https://api.github.com/repos/acme/widget/pulls/1"
		const env = ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GIT_ALLOW_PROTOCOL", "npm_config_registry", "PIP_NO_INDEX", "AWS_REGION"].map(k => k + "=" + (process.env[k] === undefined ? "<unset>" : process.env[k])).join(";")
		const ghEmpty = process.env.GH_CONFIG_DIR && fs.existsSync(process.env.GH_CONFIG_DIR) ? fs.readdirSync(process.env.GH_CONFIG_DIR).length : -1
		const lines = [
			"env:" + env,
			"gh_config_entries:" + ghEmpty,
			JSON.stringify({type: "tool_execution_start", toolName: "bash", args: {command: cmd}}),
			JSON.stringify({type: "tool_execution_end", toolName: "bash", result: {content: [{type: "text", text: "curl https://github.com/acme/widget/pull/1 in OUTPUT is not a command"}]}})
		]
		fs.writeFileSync(path.join(outDir, "transcript.txt"), lines.join("\\n") + "\\n")
		return {harness: "leaky", model, exit_code: 0, timed_out: false, wall_ms: 1, failure_mode: "none", telemetry: {}, transcript_path: path.join(outDir, "transcript.txt"), notes: ""}
	}
}
`

const BAD_STATE_ADAPTER = STATE_ADAPTER.replace('name: "state"', 'name: "badstate"').replace('statePaths: [".codify/"]', 'statePaths: ["../escape"]')

// Slow enough that a SIGINT lands while trial 1+ is still queued, so the
// in-loop interruption check (not just the adapter boundary) is what stops it.
const SLOW_ADAPTER = `import fs from "node:fs"
import path from "node:path"
export default {
	name: "slow",
	version: "test-1",
	async run({dir, outDir}) {
		await new Promise(r => setTimeout(r, 150))
		fs.writeFileSync(path.join(dir, "src/agent-note.txt"), "hello from the stub adapter")
		return {harness: "slow", model: null, exit_code: 0, timed_out: false, wall_ms: 150, failure_mode: "none", telemetry: {}, transcript_path: path.join(outDir, "transcript.txt"), notes: ""}
	}
}
`

const STUB_EVALUATOR = `import fs from "node:fs"
import path from "node:path"

const trace = line => {
\tif (process.env.STUB_TRACE) fs.appendFileSync(process.env.STUB_TRACE, line + "\\n")
}

export async function baseline({repo, task, dir, opts}) {
\ttrace("baseline " + task.sha)
\treturn {
\t\tsha: task.sha,
\t\tparent_sha: task.parent_sha,
\t\tran_at: new Date().toISOString(),
\t\tf2p: ["f2p one"],
\t\tp2p: ["works alpha"],
\t\traw: {exit: 1, passed: 1, failed: 1, total: 2},
\t\ttest_files: task.test_paths || [],
\t\ttiming_ms: 1
\t}
}

export async function evaluate({repo, task, candidatePatch, dir, baseline, opts}) {
\tconst text = fs.readFileSync(candidatePatch, "utf8")
\tconst hasPatch = text.trim().length > 0
\tconst fixed = text.includes("hello from the stub adapter")
\ttrace("evaluate " + task.sha + " dir=" + dir)
\treturn {
\t\trepo,
\t\tsha: task.sha,
\t\tparent_sha: task.parent_sha,
\t\t// The real evaluator records opts.model verbatim (null when unset);
		// mimicking that here makes the runner model-passthrough test real.
		model: opts.model ?? null,
		resolved: fixed,
\t\treason: fixed ? "resolved" : hasPatch ? "f2p_failed" : "empty_patch",
\t\tpatch: {applied: hasPatch, empty: !hasPatch, files: hasPatch ? ["src/agent-note.txt", "src/tracked.js"] : [], deletions: [], error: null},
\t\ttamper: {clean: true, findings: []},
\t\tf2p: {required: 1, passed: fixed ? 1 : 0, failed: fixed ? [] : ["f2p one"]},
\t\tp2p: {required: 1, passed: 1, failed: []},
\t\tpartial: {f2p_ratio: fixed ? 1 : 0, p2p_ratio: 1},
\t\truns: {baseline: baseline.raw, candidate: {exit: fixed ? 0 : 1, passed: fixed ? 2 : 1, failed: fixed ? 0 : 1, total: 2}},
\t\ttiming: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0},
\t\t// proof that the evaluator got its own mutated worktree, not the adapter's
\t\teval_dir: dir
\t}
}
`

const BOOM_BASELINE_EVALUATOR = `export async function baseline() {
	throw new Error("baseline exploded on purpose")
}
export async function evaluate() {
	throw new Error("unreachable")
}
`

const BOOM_EVALUATE_EVALUATOR = `export async function baseline({repo, task, dir, opts}) {
	return {
		sha: task.sha,
		parent_sha: task.parent_sha,
		ran_at: new Date().toISOString(),
		f2p: ["f2p one"],
		p2p: [],
		raw: {exit: 1, passed: 0, failed: 1, total: 1},
		test_files: [],
		timing_ms: 1
	}
}
export async function evaluate() {
	throw new Error("evaluate exploded on purpose")
}
`

// Chain fixtures. The adapter records how many times it has been invoked in the
// shared worktree (so a skipped step does not shift the numbering) and drops a
// per-step marker file; the evaluator resolves a step only when the CUMULATIVE
// patch still contains that step's marker. A deliberately skipped step therefore
// fails even though earlier steps succeeded, exercising recovery.
const chainAdapter = (name, skip) => `import fs from "node:fs"
import path from "node:path"
const NAME = ${JSON.stringify(name)}
const SKIP = ${skip}
export default {
	name: NAME,
	version: "test-1",
	async run({prompt, dir, outDir}) {
		const progress = path.join(dir, ".chain-progress")
		let n = 0
		try {
			n = Number(fs.readFileSync(progress, "utf8")) || 0
		} catch {}
		n++
		fs.writeFileSync(progress, String(n))
		fs.writeFileSync(path.join(outDir, "transcript.txt"), "cwd=" + dir + "\\nprompt=" + prompt + "\\nn=" + n + "\\n")
		if (n !== SKIP) fs.writeFileSync(path.join(dir, "src/chain-step-" + n + ".txt"), "STEP_FIX_" + n + "\\n")
		return {harness: NAME, model: null, exit_code: 0, timed_out: false, wall_ms: 1, failure_mode: "none", telemetry: {}, transcript_path: path.join(outDir, "transcript.txt"), notes: n === SKIP ? "skipped" : ""}
	}
}
`

const CHAIN_EVALUATOR = `import fs from "node:fs"

const stepNo = task => {
	const m = /chain step (\\d+)/.exec(task.subject || "")
	return m ? Number(m[1]) : null
}

export async function baseline({repo, task, dir, opts}) {
	return {
		sha: task.sha,
		parent_sha: task.parent_sha,
		ran_at: new Date().toISOString(),
		f2p: ["f2p " + task.sha.slice(0, 7)],
		p2p: ["works alpha"],
		raw: {exit: 1, passed: 1, failed: 1, total: 2, sha: task.sha},
		test_files: task.test_paths || [],
		timing_ms: 1
	}
}

export async function evaluate({repo, task, candidatePatch, dir, baseline, opts}) {
	const text = fs.readFileSync(candidatePatch, "utf8")
	const n = stepNo(task)
	const fixed = n !== null && text.includes("+STEP_FIX_" + n)
	return {
		repo,
		sha: task.sha,
		parent_sha: task.parent_sha,
		model: opts.model ?? null,
		resolved: fixed,
		reason: fixed ? "resolved" : "f2p_failed",
		patch: {applied: true, empty: false, files: [], deletions: [], error: null},
		tamper: {clean: true, findings: []},
		f2p: {required: 1, passed: fixed ? 1 : 0, failed: fixed ? [] : [baseline.f2p[0]]},
		p2p: {required: 1, passed: 1, failed: []},
		partial: {f2p_ratio: fixed ? 1 : 0, p2p_ratio: 1},
		runs: {baseline: baseline.raw, candidate: {exit: fixed ? 0 : 1, passed: fixed ? 2 : 1, failed: fixed ? 0 : 1, total: 2}},
		timing: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0},
		eval_dir: dir
	}
}
`

function makeRepo() {
	const root = tmpdir("runner-synth-")
	git(root, ["init", "-q"])
	git(root, ["config", "user.email", "runner@test"])
	git(root, ["config", "user.name", "runner"])
	write(root, ".gitignore", "node_modules/\n")
	write(root, "package.json", '{"name":"synth","private":true}\n')
	write(root, "src/tracked.js", "export const tracked = 0\n")
	write(root, "tests/foo.test.js", 'it("works alpha", () => {})\n')
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "parent"])
	const parent = git(root, ["rev-parse", "HEAD"])

	write(root, "src/tracked.js", "export const tracked = 1\n")
	write(root, "tests/foo.test.js", 'it("works alpha", () => {})\nit("f2p one", () => {})\n')
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "fix one"])
	const shaA = git(root, ["rev-parse", "HEAD"])

	write(root, "src/tracked.js", "export const tracked = 2\n")
	write(root, "tests/other.test.js", 'it("f2p two", () => {})\n')
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "fix two"])
	const shaB = git(root, ["rev-parse", "HEAD"])

	return {root, parent, shaA, shaB}
}

function tasksFile(file, parent, shas) {
	fs.writeFileSync(
		file,
		shas
			.map((sha, i) => {
				const task = {
					sha,
					parent_sha: i === 0 ? parent : shas[i - 1],
					subject: `synthetic task ${i + 1}`,
					message_body: `body ${i + 1}`,
					test_paths: ["tests/foo.test.js"],
					support_paths: [],
					category: "bugfix",
					size_bucket: "S"
				}
				return JSON.stringify(task)
			})
			.join("\n") + "\n"
	)
}

// A 4-commit repo (base + 3 contiguous fixes) for the chain scenarios.
function makeChainRepo() {
	const root = tmpdir("runner-chain-repo-")
	git(root, ["init", "-q"])
	git(root, ["config", "user.email", "runner@test"])
	git(root, ["config", "user.name", "runner"])
	write(root, ".gitignore", "node_modules/\n")
	write(root, "package.json", '{"name":"synthchain","private":true}\n')
	write(root, "src/tracked.js", "export const tracked = 0\n")
	git(root, ["add", "-A"])
	git(root, ["commit", "-q", "-m", "base"])
	const base = git(root, ["rev-parse", "HEAD"])
	const shas = []
	for (let i = 1; i <= 3; i++) {
		write(root, "src/tracked.js", `export const tracked = ${i}\n`)
		write(root, `tests/step${i}.test.js`, `it("chain step ${i}", () => {})\n`)
		git(root, ["add", "-A"])
		git(root, ["commit", "-q", "-m", `chain step ${i}`])
		shas.push(git(root, ["rev-parse", "HEAD"]))
	}
	return {root, base, shas}
}

function chainTasksFile(file, base, shas) {
	fs.writeFileSync(
		file,
		shas
			.map((sha, i) =>
				JSON.stringify({
					sha,
					parent_sha: i === 0 ? base : shas[i - 1],
					subject: `chain step ${i + 1}`,
					message_body: `chain body ${i + 1}`,
					test_paths: [`tests/step${i + 1}.test.js`],
					support_paths: [],
					category: "bugfix",
					size_bucket: "S"
				})
			)
			.join("\n") + "\n"
	)
}

const CHAIN_ID = "synth:chain-abc"

function chainsFile(file, base, shas) {
	const steps = shas.map((sha, i) => ({
		ordinal: i + 1,
		sha,
		parent_sha: i === 0 ? base : shas[i - 1],
		subject: `chain step ${i + 1}`,
		category: "bugfix",
		test_paths: [`tests/step${i + 1}.test.js`],
		support_paths: [],
		diffstat: {files: 1, added: 1, deleted: 0, lines: 1}
	}))
	fs.writeFileSync(file, `${JSON.stringify({repo: "synth", chain_id: CHAIN_ID, length: shas.length, steps})}\n`)
}

// --- harness ----------------------------------------------------------------

function makeEnv(fixtures, extra = {}) {
	const env = {...process.env, ...extra}
	env.RUNNER_ADAPTERS_DIR = extra.RUNNER_ADAPTERS_DIR || fixtures.adaptersDir
	env.RUNNER_EVALUATOR = extra.RUNNER_EVALUATOR || path.join(fixtures.adaptersDir, "stub-evaluator.mjs")
	env.RUNNER_REPOS_FILE = extra.RUNNER_REPOS_FILE || fixtures.reposFile
	env.RUNNER_TASKS_FILE = extra.RUNNER_TASKS_FILE || fixtures.tasksPath
	env.RUNNER_CHAINS_FILE = extra.RUNNER_CHAINS_FILE || fixtures.chainsPath || ""
	env.STUB_TRACE = extra.STUB_TRACE || fixtures.tracePath
	return env
}

function runRunner(fixtures, argv, extra = {}) {
	const t0 = Date.now()
	const r = spawnSync(process.execPath, [RUNNER, ...argv], {encoding: "utf8", env: makeEnv(fixtures, extra), maxBuffer: 32 * 1024 * 1024})
	if (r.status !== 0) console.log(`  runner exit ${r.status}: ${(r.stderr || "").trim()}`)
	return {...r, wall_ms: Date.now() - t0}
}

function launchRunner(f, argv, extra = {}) {
	const child = spawn(process.execPath, [RUNNER, ...argv], {env: makeEnv(f, extra), stdio: ["ignore", "pipe", "pipe"]})
	let stdout = ""
	let stderr = ""
	child.stdout.on("data", d => {
		stdout += d
	})
	child.stderr.on("data", d => {
		stderr += d
	})
	const done = new Promise(resolve => child.on("close", status => resolve({status, stdout, stderr})))
	return {child, done}
}

function results(outDir) {
	const file = path.join(outDir, "results.jsonl")
	if (!fs.existsSync(file)) return []
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
}

function readTrace(fixtures) {
	if (!fs.existsSync(fixtures.tracePath)) return []
	return fs
		.readFileSync(fixtures.tracePath, "utf8")
		.split("\n")
		.filter(Boolean)
}

function gitWorktreePaths(cloneDir) {
	return git(cloneDir, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter(l => l.startsWith("worktree "))
		.map(l => l.slice("worktree ".length))
}

function branches(cloneDir) {
	return git(cloneDir, ["branch", "--list", "runner/*", "--format=%(refname:short)"]).split("\n").filter(Boolean)
}

function makeFixtures() {
	const base = tmpdir("runner-fixtures-")
	const {root, parent, shaA, shaB} = makeRepo()
	const adaptersDir = path.join(base, "adapters")
	fs.mkdirSync(adaptersDir, {recursive: true})
	write(adaptersDir, "stub.mjs", STUB_ADAPTER)
	write(adaptersDir, "stub2.mjs", variant("stub2", "patch"))
	write(adaptersDir, "slow.mjs", SLOW_ADAPTER)
	write(adaptersDir, "boom.mjs", variant("boom", "boom"))
	write(adaptersDir, "empty.mjs", variant("empty", "empty"))
	write(adaptersDir, "stub-evaluator.mjs", STUB_EVALUATOR)
	write(adaptersDir, "baseline-throw.mjs", BOOM_BASELINE_EVALUATOR)
	write(adaptersDir, "evaluate-throw.mjs", BOOM_EVALUATE_EVALUATOR)
	write(adaptersDir, "chain.mjs", chainAdapter("chain", 0))
	write(adaptersDir, "chain-skip2.mjs", chainAdapter("chain-skip2", 2))
	write(adaptersDir, "chain-evaluator.mjs", CHAIN_EVALUATOR)
	write(adaptersDir, "state.mjs", STATE_ADAPTER)
	write(adaptersDir, "badstate.mjs", BAD_STATE_ADAPTER)
	write(adaptersDir, "leaky.mjs", LEAKY_ADAPTER)
	const tasksPath = path.join(base, "tasks.jsonl")
	tasksFile(tasksPath, parent, [shaA, shaB])
	const reposFile = path.join(base, "repos.json")
	fs.writeFileSync(
		reposFile,
		JSON.stringify({synth: {url: "", cloneDir: root, install: [], testCmd: "true", testArgs: () => [], testTimeoutMs: 2000, installTimeoutMs: 2000}})
	)

	// Separate repo/task/chain files for the chain scenarios, so the flat
	// `--task all` fixtures above keep exactly two tasks.
	const chain = makeChainRepo()
	const chainDir = path.join(base, "chain")
	fs.mkdirSync(chainDir, {recursive: true})
	const chainTasksPath = path.join(chainDir, "tasks.jsonl")
	chainTasksFile(chainTasksPath, chain.base, chain.shas)
	const chainsPath = path.join(chainDir, "chains.jsonl")
	chainsFile(chainsPath, chain.base, chain.shas)
	const chainReposFile = path.join(chainDir, "repos.json")
	fs.writeFileSync(
		chainReposFile,
		JSON.stringify({synth: {url: "", cloneDir: chain.root, install: [], testCmd: "true", testArgs: () => [], testTimeoutMs: 2000, installTimeoutMs: 2000}})
	)

	return {
		base,
		root,
		parent,
		shaA,
		shaB,
		adaptersDir,
		tasksPath,
		reposFile,
		tracePath: path.join(base, "trace.txt"),
		chainRoot: chain.root,
		chainBase: chain.base,
		chainShas: chain.shas,
		chainTasksPath,
		chainsPath,
		chainReposFile
	}
}

// --- scenarios --------------------------------------------------------------

async function testCapture(f) {
	console.log("== patch captured from the worktree, not the adapter claim ==")
	const outDir = path.join(f.base, "runs-capture")
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--model", "test-model", "--out", outDir])
	eq(r.status, 0, "capture run exits 0")
	const lines = results(outDir)
	eq(lines.length, 1, "capture run wrote one result line")
	const line = lines[0]

	// EvalResult shape + the two required additions.
	const shape = ["repo", "sha", "parent_sha", "adapter", "model", "trial", "trials", "resolved", "reason", "patch", "tamper", "f2p", "p2p", "partial", "runs", "timing", "telemetry", "adapter_run", "leak", "cost"]
	eq(Object.keys(line), shape, "result line has the frozen shape in order")
	ok(line.telemetry && "input_tokens" in line.telemetry, "result line carries telemetry")
	ok(line.adapter_run && typeof line.adapter_run.failure_mode === "string", "result line carries adapter_run")
	eq(line.adapter, "stub", "adapter recorded on the line")
	eq(line.model, "test-model", "model recorded on the line")
	eq([line.trial, line.trials], [0, 1], "single-trial line reports trial 0 of 1")
	eq(line.resolved, true, "stub patch resolves under the stub evaluator")
	eq(line.reason, "resolved", "reason resolved")

	// Telemetry fidelity: reported 0 kept, unreported null kept, never guessed.
	eq(line.telemetry.cache_read_tokens, 0, "reported zero telemetry preserved")
	eq(line.telemetry.cache_write_tokens, null, "unreported telemetry stays null")
	eq(line.telemetry.cost_usd, 0.0025, "cost passed through")

	// The patch must come from `git diff` on the worktree, never the adapter's
	// self-reported `patch` field ("THIS IS NOT THE PATCH").
	const patch = fs.readFileSync(path.join(outDir, f.shaA, "stub", "candidate.patch"), "utf8")
	ok(patch.includes("+hello from the stub adapter"), "candidate.patch has the untracked file the stub created")
	ok(patch.includes("+export const touched = true"), "candidate.patch has the tracked file the stub modified")
	ok(!patch.includes("THIS IS NOT THE PATCH"), "adapter's self-reported patch is ignored")

	// Run directory layout.
	const item = path.join(outDir, f.shaA, "stub")
	for (const f2 of ["candidate.patch", "transcript.txt", "eval.json", "adapter.json"]) {
		ok(fs.existsSync(path.join(item, f2)), `run dir has <sha>/<adapter>/${f2}`)
	}
	const transcript = fs.readFileSync(path.join(item, "transcript.txt"), "utf8")
	ok(transcript.includes("synthetic task 1"), "adapter got taskPrompt(subject)")
	ok(transcript.includes("body 1"), "adapter got taskPrompt(message_body)")
	const adapterJson = JSON.parse(fs.readFileSync(path.join(item, "adapter.json"), "utf8"))
	ok(!("patch" in adapterJson), "adapter.json drops the adapter's patch claim")
	const evalJson = JSON.parse(fs.readFileSync(path.join(item, "eval.json"), "utf8"))
	const adapterCwd = /cwd=(.*)/.exec(transcript)[1].trim()
	ok(evalJson.eval_dir !== adapterCwd, "evaluator dir is a separate worktree from the adapter dir")
	ok(path.basename(adapterCwd).endsWith("-stub"), "adapter worktree path is named after sha+adapter")

	const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
	ok(typeof manifest.started_at === "string" && typeof manifest.ended_at === "string", "manifest has start/end")
	eq(manifest.node, process.version, "manifest records node version")
	ok(typeof manifest.git_head === "string" && manifest.git_head.length === 40, "manifest records the harness git head")
	ok(manifest.config && manifest.config.repo === "synth", "manifest records the run config")
	eq(manifest.adapter.map(a => a.name + ":" + a.version), ["stub:test-1"], "manifest records the resolved adapter/version")
	eq(manifest.counts, {items: 1, resolved: 1, failed: 0, baselines: 1, baseline_errors: 0}, "manifest counts")

	const wts = gitWorktreePaths(f.root).filter(p => p.startsWith(outDir))
	eq(wts, [], "worktrees under the run dir are cleaned up")
	eq(git(f.root, ["worktree", "list", "--porcelain"]).split("\n").filter(l => l.startsWith("worktree ")).length, 1, "only the clone worktree remains")
	eq(branches(f.root), [], "runner branches are deleted")
	return {wall_ms: r.wall_ms, stdout: r.stdout}
}

async function testThrowingAdapter(f) {
	console.log("== throwing adapter does not abort the run ==")
	const outDir = path.join(f.base, "runs-boom")
	const before = readTrace(f).filter(l => l.startsWith("baseline ")).length
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "boom,stub", "--model", "m", "--out", outDir])
	eq(r.status, 0, "run with a throwing adapter still exits 0")
	const lines = results(outDir)
	eq(lines.length, 2, "both adapters produced a result line")
	const boom = lines.find(l => l.adapter === "boom")
	const stub = lines.find(l => l.adapter === "stub")
	ok(!!boom, "throwing adapter has a result line")
	eq(boom.resolved, false, "throwing adapter line is not resolved")
	ok(boom.reason !== "resolved", "throwing adapter line carries a failure reason")
	eq(boom.reason, "empty_patch", "throwing adapter line reason (nothing written)")
	eq(boom.adapter_run.failure_mode, "harness_crash", "throwing adapter recorded as harness_crash")
	ok(/exploded on purpose/.test(boom.adapter_run.error || ""), "adapter error recorded on the line")
	ok(fs.existsSync(path.join(outDir, f.shaA, "boom", "candidate.patch")), "empty candidate.patch written for the throwing adapter")
	ok(stub && stub.resolved === true, "the run continued to the next adapter after the throw")
	eq(readTrace(f).filter(l => l.startsWith("baseline ")).length - before, 1, "baseline computed once and reused across adapters")
	return {wall_ms: r.wall_ms}
}

async function testLimit(f) {
	console.log("== --limit is honoured ==")
	const outDir = path.join(f.base, "runs-limit")
	const r = runRunner(f, ["--repo", "synth", "--task", "all", "--adapter", "stub,stub2", "--limit", "1", "--out", outDir])
	eq(r.status, 0, "limit run exits 0")
	const lines = results(outDir)
	eq(lines.length, 2, "--limit 1 on a 2-task file yields 1 task x 2 adapters")
	eq([...new Set(lines.map(l => l.sha))], [f.shaA], "--limit selected only the first task")
	ok(!fs.existsSync(path.join(outDir, f.shaB)), "the unselected task has no run dir")

	const outAll = path.join(f.base, "runs-all")
	const rAll = runRunner(f, ["--repo", "synth", "--task", "all", "--adapter", "stub", "--out", outAll])
	eq(rAll.status, 0, "unlimited run exits 0")
	eq(results(outAll).length, 2, "both tasks ran without --limit")
	return {wall_ms: r.wall_ms + rAll.wall_ms}
}

async function testBudget(f) {
	console.log("== global budget ==")
	const outDir = path.join(f.base, "runs-budget")
	const r = runRunner(f, ["--repo", "synth", "--task", "all", "--adapter", "stub", "--budget-ms", "1", "--out", outDir])
	eq(r.status, 0, "budget run exits 0")
	eq(results(outDir).length, 0, "no items attempted under an exhausted budget")
	const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
	eq(manifest.stopped.reason, "budget_exceeded", "manifest records the budget stop")
	return {wall_ms: r.wall_ms}
}

async function testBudgetDefaultTrials(f) {
	console.log("== budget does not stop mid-task at the default --trials 1 ==")
	const outDir = path.join(f.base, "runs-budget-midtask")
	// The slow adapter overruns the 100ms budget. At trials=1 the frozen legacy
	// behaviour runs every adapter for the task regardless; only the task-loop
	// check may stop the run. The in-loop budget check is gated to trials>1.
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "slow,stub", "--budget-ms", "100", "--out", outDir])
	eq(r.status, 0, "mid-task budget run exits 0")
	const lines = results(outDir)
	eq(lines.map(l => l.adapter), ["slow", "stub"], "both adapters ran despite the budget expiring during the first")
	const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
	eq(manifest.stopped, null, "no in-loop budget stop recorded at trials=1")
	return {wall_ms: r.wall_ms}
}

async function testBaselineOnly(f) {
	console.log("== --baseline-only ==")
	const outDir = path.join(f.base, "runs-baseline")
	const r = runRunner(f, ["--repo", "synth", "--task", "all", "--baseline-only", "--out", outDir])
	eq(r.status, 0, "baseline-only exits 0")
	const lines = fs
		.readFileSync(path.join(outDir, "baselines.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
	eq(lines.length, 2, "baseline-only precomputed both tasks")
	ok(lines.every(l => l.ok && l.f2p.length === 1 && l.p2p.length === 1), "baseline lines carry f2p/p2p")
	eq(results(outDir).length, 0, "baseline-only writes no eval results")
	const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
	eq(manifest.mode, "baseline-only", "manifest marks baseline-only mode")
	eq(gitWorktreePaths(f.root).filter(p => p.startsWith(outDir)), [], "baseline-only cleans up its worktrees")
	return {wall_ms: r.wall_ms}
}

async function testTrials(f) {
	console.log("== --trials repeats the run per (task, adapter) ==")

	// Default (no --trials): exactly one line per (task, adapter), trial 0 of 1,
	// and the frozen <sha>/<adapter> run-dir layout is untouched.
	const base0 = readTrace(f).filter(l => l.startsWith("baseline ")).length
	const outDefault = path.join(f.base, "runs-trials-default")
	const rDefault = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--out", outDefault])
	eq(rDefault.status, 0, "default trials run exits 0")
	const base1 = readTrace(f).filter(l => l.startsWith("baseline ")).length
	const defLines = results(outDefault)
	eq(defLines.length, 1, "default run writes one result line per (task, adapter)")
	eq([defLines[0].trial, defLines[0].trials], [0, 1], "default line is trial 0 of 1")
	ok(fs.existsSync(path.join(outDefault, f.shaA, "stub", "candidate.patch")), "default run keeps the <sha>/<adapter> layout")
	ok(!fs.existsSync(path.join(outDefault, f.shaA, "stub", "t0")), "default run creates no tN dir")
	const defManifest = JSON.parse(fs.readFileSync(path.join(outDefault, "manifest.json"), "utf8"))
	eq(defManifest.config.trials, 1, "manifest records trials=1 by default")
	eq(base1 - base0, 1, "default run computes one baseline")

	// --trials 3: three sequential lines per (task, adapter), trial 0,1,2 in its
	// own run dir; the baseline is still computed once per task.
	const out3 = path.join(f.base, "runs-trials-3")
	const r3 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub,stub2", "--trials", "3", "--out", out3])
	eq(r3.status, 0, "--trials 3 run exits 0")
	const base2 = readTrace(f).filter(l => l.startsWith("baseline ")).length
	const lines3 = results(out3)
	eq(lines3.length, 6, "--trials 3 with 2 adapters yields 3 lines each")
	eq(
		lines3.map(l => `${l.adapter}:${l.trial}`),
		["stub:0", "stub:1", "stub:2", "stub2:0", "stub2:1", "stub2:2"],
		"trials are strictly sequential (all trials of one adapter before the next)"
	)
	for (const adapter of ["stub", "stub2"]) {
		const tl = lines3.filter(l => l.adapter === adapter)
		eq(tl.map(l => l.trial), [0, 1, 2], `${adapter} lines report trials 0,1,2`)
		ok(tl.every(l => l.trials === 3), `${adapter} lines all report trials=3`)
		for (let t = 0; t < 3; t++) {
			ok(
				fs.existsSync(path.join(out3, f.shaA, adapter, `t${t}`, "eval.json")),
				`${adapter} trial ${t} writes its own run dir`
			)
		}
	}
	const manifest3 = JSON.parse(fs.readFileSync(path.join(out3, "manifest.json"), "utf8"))
	eq(manifest3.config.trials, 3, "manifest records trials=3")
	eq(manifest3.counts.items, 6, "manifest counts every trial as an item")
	eq(base2 - base1, 1, "the baseline is computed once per task, not once per trial")

	// Failure paths must carry trial/trials too: a baseline that throws (runItem's
	// early-failure branch) and an evaluator that throws (the evaluate branch).
	const btOut = path.join(f.base, "runs-trials-baseline-throw")
	const rBT = runRunner(
		f,
		["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--out", btOut],
		{RUNNER_EVALUATOR: path.join(f.adaptersDir, "baseline-throw.mjs")}
	)
	eq(rBT.status, 0, "baseline-throw run exits 0")
	const btLines = results(btOut)
	eq(btLines.length, 2, "baseline-throw run still emits one line per trial")
	eq(btLines.map(l => [l.trial, l.trials]), [[0, 2], [1, 2]], "baseline-failure lines carry trial/trials")
	ok(btLines.every(l => /^baseline:/.test(l.error || "")), "baseline failure recorded on every trial")

	const etOut = path.join(f.base, "runs-trials-evaluate-throw")
	const rET = runRunner(
		f,
		["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--out", etOut],
		{RUNNER_EVALUATOR: path.join(f.adaptersDir, "evaluate-throw.mjs")}
	)
	eq(rET.status, 0, "evaluate-throw run exits 0")
	const etLines = results(etOut)
	eq(etLines.length, 2, "evaluate-throw run still emits one line per trial")
	eq(etLines.map(l => [l.trial, l.trials]), [[0, 2], [1, 2]], "evaluate-failure lines carry trial/trials")
	ok(etLines.every(l => /^evaluate:/.test(l.error || "")), "evaluate failure recorded on every trial")

	// Argument validation.
	const rZero = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "0", "--out", path.join(f.base, "runs-trials-zero")])
	eq(rZero.status, 2, "--trials 0 is rejected")
	const rText = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "abc", "--out", path.join(f.base, "runs-trials-text")])
	eq(rText.status, 2, "--trials abc is rejected")

	return {wall_ms: rDefault.wall_ms + r3.wall_ms + rBT.wall_ms + rET.wall_ms + rZero.wall_ms + rText.wall_ms}
}

async function testTurns(f) {
	console.log("== adapter_run.turns is passed through, null when unreported ==")
	const outDir = path.join(f.base, "runs-turns")
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub,empty", "--out", outDir])
	eq(r.status, 0, "turns run exits 0")
	const lines = results(outDir)
	eq(lines.length, 2, "turns run wrote one result line per adapter")
	const stub = lines.find(l => l.adapter === "stub")
	const empty = lines.find(l => l.adapter === "empty")
	eq(stub.adapter_run.turns, 4, "adapter_run.turns equals the value the stub adapter returned")
	eq(empty.adapter_run.turns, null, "adapter_run.turns is null when the adapter returns no turns")
	// Topology rides alongside turns: recorded when the adapter reports it, null
	// (never a zero-delegation record) when it does not.
	eq(stub.adapter_run.topology.subagents.by_agent, {reviewer: 1}, "adapter_run.topology carries which sub-agents the adapter reported")
	eq(stub.adapter_run.topology.total_tool_calls, 6, "adapter_run.topology carries the tool-call count")
	eq(empty.adapter_run.topology, null, "adapter_run.topology is null when the adapter reports no topology")
	return {wall_ms: r.wall_ms}
}

async function testModel(f) {
	console.log("== --model is recorded on the result line ==")
	const outDir = path.join(f.base, "runs-model")
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--model", "model-under-test", "--out", outDir])
	eq(r.status, 0, "model run exits 0")
	const lines = results(outDir)
	eq(lines.length, 1, "model run wrote one result line")
	// The stub evaluator returns `model: opts.model ?? null` exactly like the
	// real evaluator. If the runner does not forward the model, this is null.
	eq(lines[0].model, "model-under-test", "result line model equals the --model value, not null")
	eq(lines[0].adapter_run.model, "model-under-test", "adapter_run model equals the --model value")
	return {wall_ms: r.wall_ms}
}

async function testInterrupt(f) {
	console.log("== SIGINT stops the trial loop ==")
	const outDir = path.join(f.base, "runs-interrupt")
	const {child, done} = launchRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "slow", "--trials", "20", "--out", outDir])
	const resultsFile = path.join(outDir, "results.jsonl")
	const deadline = Date.now() + 10000
	// Wait until the run is demonstrably inside the trial loop, then interrupt.
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 25))
		if (fs.existsSync(resultsFile) && fs.readFileSync(resultsFile, "utf8").trim()) break
	}
	child.kill("SIGINT")
	const r = await Promise.race([
		done,
		new Promise(resolve =>
			setTimeout(() => {
				child.kill("SIGKILL")
				resolve({status: "timeout", stdout: "", stderr: ""})
			}, 15000)
		)
	])
	eq(r.status, 130, "interrupted run exits 130")
	const lines = results(outDir)
	ok(lines.length >= 1, `at least one trial completed before the interrupt (got ${lines.length})`)
	ok(lines.length < 20, `SIGINT stopped the remaining trials (ran ${lines.length}/20)`)
	const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
	eq(manifest.stopped && manifest.stopped.reason, "interrupted", "manifest records the interrupt")
	return {wall_ms: 0}
}

async function testIntegration() {
	console.log("== integration: real evaluator on a scratch immer copy ==")
	// Opt-in: gated so the default test run stays fast and hermetic.
	const cloneDir = process.env.RUNNER_TEST_IMMER_DIR
	if (!cloneDir || !fs.existsSync(path.join(cloneDir, "node_modules"))) {
		console.log(`  SKIP integration: set RUNNER_TEST_IMMER_DIR to a scratch immer checkout with node_modules (got ${cloneDir})`)
		return null
	}
	// A task without a cached baseline, so the real baseline + test run actually happen.
	const sha = process.env.RUNNER_TEST_IMMER_SHA || "0c3efdd4eae2"
	const fixtures = makeFixtures()
	const reposFile = path.join(fixtures.base, "immer-repos.json")
	fs.writeFileSync(reposFile, JSON.stringify({immer: {cloneDir}}))
	const outDir = path.join(fixtures.base, "runs-immer")
	const t0 = Date.now()
	const r = spawnSync(
		process.execPath,
		[RUNNER, "--repo", "immer", "--task", sha, "--adapter", "stub", "--model", "none", "--budget-ms", "900000", "--out", outDir],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: {...process.env, RUNNER_ADAPTERS_DIR: fixtures.adaptersDir, RUNNER_REPOS_FILE: reposFile}
		}
	)
	const wall_ms = Date.now() - t0
	console.log(`  runner stdout: ${(r.stdout || "").trim().split("\n").pop()}`)
	if (r.status !== 0) console.log(`  stderr: ${(r.stderr || "").trim()}`)
	eq(r.status, 0, "immer run exits 0")
	const lines = results(outDir)
	eq(lines.length, 1, "immer run wrote one result line")
	if (lines.length) {
		const line = lines[0]
		eq(line.repo, "immer", "immer line repo")
		eq(line.adapter, "stub", "immer line adapter")
		ok(line.f2p.required >= 1, `immer baseline has f2p tests (got ${line.f2p.required})`)
		ok(line.tamper.clean === true, "stub patch is not tamper")
		eq(line.patch.applied, true, "stub patch applies to the eval checkout")
		ok(line.patch.files.includes("src/agent-note.txt"), "stub file shows up in the graded patch")
		eq(line.reason, "f2p_failed", "unfixed bug reports f2p_failed")
		eq(line.resolved, false, "unfixed bug not resolved")
	}
	eq(gitWorktreePaths(cloneDir).length, 1, "immer scratch clone has no leftover worktrees")
	return {wall_ms}
}

async function testChains(f) {
	console.log("== --chain runs a contiguous commit chain as one session ==")
	const env = {
		RUNNER_REPOS_FILE: f.chainReposFile,
		RUNNER_TASKS_FILE: f.chainTasksPath,
		RUNNER_CHAINS_FILE: f.chainsPath,
		RUNNER_EVALUATOR: path.join(f.adaptersDir, "chain-evaluator.mjs")
	}
	const chainId = CHAIN_ID

	// (a) one line per (chain, step, adapter, trial), chain_step 1..3, chain_length 3.
	// (f) every step resolves -> chain_resolved true on every line.
	const outDir = path.join(f.base, "runs-chain-incremental")
	const r = runRunner(f, ["--repo", "synth", "--chain", chainId, "--adapter", "chain", "--out", outDir], env)
	eq(r.status, 0, "chain run exits 0")
	const lines = results(outDir)
	eq(lines.length, 3, "a 3-step chain emits exactly 3 result lines")
	eq(lines.map(l => l.chain_step), [1, 2, 3], "chain_step is 1-based and ordered")
	eq([...new Set(lines.map(l => l.chain_length))], [3], "chain_length is 3 on every line")
	eq([...new Set(lines.map(l => l.chain_id))], [chainId], "chain_id is on every line")
	eq(lines.map(l => l.sha), f.chainShas, "each line carries its own step sha")
	eq(lines.map(l => l.resolved), [true, true, true], "all three steps resolve")
	eq(lines.map(l => l.chain_resolved), [true, true, true], "chain_resolved is true when every step resolved")
	eq(lines.map(l => l.trial), [0, 0, 0], "a single trial reports trial 0")

	// (b) the emitted patch is the CUMULATIVE diff from the chain base.
	const stepPatch = n => fs.readFileSync(path.join(outDir, chainId, "chain", `step-${n}`, "candidate.patch"), "utf8")
	const p1 = stepPatch(1)
	const p2 = stepPatch(2)
	ok(p1.includes("STEP_FIX_1"), "step 1 patch has step 1's change")
	ok(!p1.includes("STEP_FIX_2"), "step 1 patch does NOT contain step 2's change")
	ok(p2.includes("STEP_FIX_1") && p2.includes("STEP_FIX_2"), "step 2 patch is cumulative (contains step 1 and step 2)")

	// (c) all steps run inside the SAME worktree directory.
	const stepTranscript = n => fs.readFileSync(path.join(outDir, chainId, "chain", `step-${n}`, "transcript.txt"), "utf8")
	const cwd1 = /cwd=(.*)/.exec(stepTranscript(1))[1].trim()
	const cwd3 = /cwd=(.*)/.exec(stepTranscript(3))[1].trim()
	eq(cwd1, cwd3, "every step runs in the same sandbox directory")
	ok(cwd1.startsWith(path.join(outDir, ".worktrees")), "the shared sandbox lives under the run dir")

	// (d) incremental: step 2's prompt must not reveal step 3.
	const prompt2 = stepTranscript(2)
	ok(prompt2.includes("chain step 2"), "incremental step 2 prompt contains its own subject")
	ok(!prompt2.includes("chain step 3"), "incremental step 2 prompt does NOT contain step 3's subject")

	// (d) roadmap: step 1's prompt contains every step's subject.
	const outRoad = path.join(f.base, "runs-chain-roadmap")
	const rRoad = runRunner(f, ["--repo", "synth", "--chain", chainId, "--chain-mode", "roadmap", "--adapter", "chain", "--out", outRoad], env)
	eq(rRoad.status, 0, "roadmap chain run exits 0")
	const prompt1Road = fs.readFileSync(path.join(outRoad, chainId, "chain", "step-1", "transcript.txt"), "utf8")
	for (const s of ["chain step 1", "chain step 2", "chain step 3"]) ok(prompt1Road.includes(s), `roadmap step 1 prompt lists "${s}"`)

	// (e)+(f) a failing step does not abort the chain; step 3 still runs.
	const outSkip = path.join(f.base, "runs-chain-skip2")
	const rSkip = runRunner(f, ["--repo", "synth", "--chain", chainId, "--adapter", "chain-skip2", "--out", outSkip], env)
	eq(rSkip.status, 0, "a chain containing a failing step still exits 0")
	const skipLines = results(outSkip)
	eq(skipLines.length, 3, "a failing step does not abort the chain (3 lines emitted)")
	eq(skipLines.map(l => l.chain_step), [1, 2, 3], "the following step still ran after the failure")
	eq(skipLines.map(l => l.resolved), [true, false, true], "step 2 failed and step 3 recovered")
	eq(skipLines.map(l => l.chain_resolved), [false, false, false], "chain_resolved is false when any step failed")
	// Each step must be graded against its OWN baseline. The stub names the
	// failing test after the baseline it was handed, so if the runner reused one
	// baseline across the chain this line would carry step 1's name instead.
	ok(skipLines[0].sha !== skipLines[1].sha, "chain steps are distinct commits")
	eq(skipLines[1].f2p.failed, [`f2p ${skipLines[1].sha.slice(0, 7)}`], "step 2 is graded against its own baseline, not step 1's")
	// Resolution does not depend on the baseline, so assert the baseline identity
	// itself: the stub echoes the baseline's own sha into runs.baseline, which is
	// observable whether or not the step resolved.
	for (const line of skipLines) {
		eq(line.runs.baseline.sha, line.sha, `step ${line.chain_step} received its own baseline`)
	}
	ok(fs.existsSync(path.join(outSkip, chainId, "chain-skip2", "step-3", "eval.json")), "step 3 artifacts were written after the failed step")

	// --trials repeats the WHOLE chain.
	const outTrials = path.join(f.base, "runs-chain-trials")
	const rTrials = runRunner(f, ["--repo", "synth", "--chain", chainId, "--adapter", "chain", "--trials", "2", "--out", outTrials], env)
	eq(rTrials.status, 0, "--trials 2 chain run exits 0")
	const trialLines = results(outTrials)
	eq(trialLines.length, 6, "--trials 2 repeats the whole 3-step chain")
	eq(trialLines.map(l => `${l.trial}:${l.chain_step}`), ["0:1", "0:2", "0:3", "1:1", "1:2", "1:3"], "each trial repeats steps 1..3")
	ok(fs.existsSync(path.join(outTrials, chainId, "chain", "t1", "step-1", "candidate.patch")), "--trials>1 uses the tN layout")

	// (g) unknown chain id lists the available ones and exits non-zero.
	const rUnknown = runRunner(f, ["--repo", "synth", "--chain", "nope", "--adapter", "chain", "--out", path.join(f.base, "runs-chain-unknown")], env)
	ok(rUnknown.status !== 0, "an unknown --chain id exits non-zero")
	ok(/available chains/.test(rUnknown.stderr) && rUnknown.stderr.includes(chainId), "the unknown --chain error names the available ids")

	// (h) a bogus --chain-mode is rejected.
	const rMode = runRunner(f, ["--repo", "synth", "--chain", chainId, "--chain-mode", "bogus", "--adapter", "chain", "--out", path.join(f.base, "runs-chain-mode")], env)
	eq(rMode.status, 2, "--chain-mode bogus is rejected")

	return {wall_ms: r.wall_ms + rRoad.wall_ms + rSkip.wall_ms + rTrials.wall_ms + rUnknown.wall_ms + rMode.wall_ms}
}

const transcriptOf = file => Object.fromEntries(
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => {
			const at = l.indexOf("=")
			return [l.slice(0, at), l.slice(at + 1)]
		})
)

async function testState(f) {
	console.log("== --state cold|warm: per-invocation state dirs, never in the patch ==")
	let wall = 0

	// cold (default): fresh empty dir per trial, gone afterwards.
	const outCold = path.join(f.base, "runs-state-cold")
	const rCold = runRunner(f, ["--repo", "synth", "--task", "all", "--adapter", "state", "--out", outCold])
	wall += rCold.wall_ms
	eq(rCold.status, 0, "cold state run exits 0")
	const cold = results(outCold)
	eq(cold.length, 2, "cold run wrote one line per task")
	eq(cold.map(l => l.adapter_run.state.mode), ["cold", "cold"], "adapter_run.state.mode is cold by default")
	eq(cold.map(l => l.adapter_run.state.dir_reused), [false, false], "cold dirs are never reused")
	eq(cold.map(l => l.adapter_run.state.bytes_before), [0, 0], "cold dirs start empty")
	ok(cold.every(l => l.adapter_run.state.bytes_after > 1000), `cold bytes_after reflects the written index (got ${cold.map(l => l.adapter_run.state.bytes_after)})`)
	eq(cold.map(l => l.adapter_run.state.in_tree_paths), [[".codify"], [".codify"]], "in_tree_paths carries the adapter's normalized statePaths")
	const tCold1 = transcriptOf(path.join(outCold, f.shaA, "state", "transcript.txt"))
	const tCold2 = transcriptOf(path.join(outCold, f.shaB, "state", "transcript.txt"))
	eq(tCold1.stateDir, tCold1.env, "stateDir argument and BENCH_STATE_DIR env agree")
	ok(tCold1.stateDir.startsWith(path.join(outCold, ".state")), "state dirs live under <out>/.state")
	ok(tCold1.stateDir !== tCold2.stateDir, "cold mode hands each item a different dir")
	eq([tCold1.state_files, tCold2.state_files], ["0", "0"], "cold dirs are empty on arrival")
	eq(fs.existsSync(path.join(outCold, ".state")), false, "cold state dirs are removed after the run")
	// statePaths exclusion: .codify never reaches the patch, real edits do.
	const pCold = fs.readFileSync(path.join(outCold, f.shaA, "state", "candidate.patch"), "utf8")
	ok(!pCold.includes(".codify") && !pCold.includes("CODIFY_GRAPH_MARKER"), "in-tree state under a declared statePath is excluded from candidate.patch")
	ok(pCold.includes("src/agent-note.txt"), "the real edit is still captured alongside the excluded state")
	const mCold = JSON.parse(fs.readFileSync(path.join(outCold, "manifest.json"), "utf8"))
	eq(mCold.adapter[0].state_paths, [".codify"], "manifest records the adapter's statePaths")
	eq(mCold.config.state, "cold", "manifest config.state is cold")

	// warm: one dir per adapter for the run; the second item sees the first's index.
	const outWarm = path.join(f.base, "runs-state-warm")
	const rWarm = runRunner(f, ["--repo", "synth", "--task", "all", "--adapter", "state", "--state", "warm", "--out", outWarm])
	wall += rWarm.wall_ms
	eq(rWarm.status, 0, "warm state run exits 0")
	const warm = results(outWarm)
	eq(warm.map(l => l.adapter_run.state.mode), ["warm", "warm"], "adapter_run.state.mode is warm")
	eq(warm.map(l => l.adapter_run.state.dir_reused), [false, true], "warm: first item creates the dir, second reuses it")
	eq(warm[0].adapter_run.state.bytes_before, 0, "warm first item starts empty")
	eq(warm[1].adapter_run.state.bytes_before, warm[0].adapter_run.state.bytes_after, "warm second item starts with exactly what the first left")
	ok(warm[1].adapter_run.state.bytes_after > warm[1].adapter_run.state.bytes_before, "warm second item grew the index")
	const tWarm1 = transcriptOf(path.join(outWarm, f.shaA, "state", "transcript.txt"))
	const tWarm2 = transcriptOf(path.join(outWarm, f.shaB, "state", "transcript.txt"))
	eq(tWarm1.stateDir, tWarm2.stateDir, "warm mode hands every item the same dir")
	eq([tWarm1.state_files, tWarm2.state_files], ["0", "1"], "the second warm item finds the first item's file")
	eq(fs.existsSync(path.join(outWarm, ".state")), false, "warm state dirs are removed at the end of the run by default")
	const mWarm = JSON.parse(fs.readFileSync(path.join(outWarm, "manifest.json"), "utf8"))
	eq(mWarm.state.kept, [], "manifest.state.kept is empty when state is not kept")

	// --keep-state leaves the warm dir behind and records it.
	const outKeep = path.join(f.base, "runs-state-keep")
	const rKeep = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "state", "--state", "warm", "--keep-state", "--out", outKeep])
	wall += rKeep.wall_ms
	eq(rKeep.status, 0, "--keep-state run exits 0")
	const keptDir = path.join(outKeep, ".state", "state", "run")
	ok(fs.existsSync(path.join(keptDir, "index.bin")), "--keep-state leaves the warm dir and its index on disk")
	const mKeep = JSON.parse(fs.readFileSync(path.join(outKeep, "manifest.json"), "utf8"))
	eq(mKeep.state.kept, [keptDir], "manifest.state.kept lists the kept dir")
	eq(mKeep.config.keep_state, true, "manifest config.keep_state is recorded")

	// Bad flags and a bad statePaths declaration are rejected.
	const rBogus = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "state", "--state", "lukewarm", "--out", path.join(f.base, "runs-state-bogus")])
	eq(rBogus.status, 2, "--state lukewarm is rejected")
	const rKeepCold = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "state", "--keep-state", "--out", path.join(f.base, "runs-state-keepcold")])
	eq(rKeepCold.status, 2, "--keep-state without --state warm is rejected")
	const rBad = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "badstate", "--out", path.join(f.base, "runs-state-bad")])
	ok(rBad.status !== 0 && /statePaths/.test(rBad.stderr), "an adapter whose statePaths escapes the worktree is refused")
	wall += rBogus.wall_ms + rKeepCold.wall_ms + rBad.wall_ms

	// warm + chain: the state dir persists across steps, but the sandbox is the
	// same history-truncated one, so no step's fix commit is readable.
	const env = {
		RUNNER_REPOS_FILE: f.chainReposFile,
		RUNNER_TASKS_FILE: f.chainTasksPath,
		RUNNER_CHAINS_FILE: f.chainsPath,
		RUNNER_EVALUATOR: path.join(f.adaptersDir, "chain-evaluator.mjs"),
		PROBE_SHAS: f.chainShas.join(",")
	}
	const outChain = path.join(f.base, "runs-state-chain")
	const rChain = runRunner(f, ["--repo", "synth", "--chain", CHAIN_ID, "--adapter", "state", "--state", "warm", "--trials", "2", "--out", outChain], env)
	wall += rChain.wall_ms
	eq(rChain.status, 0, "warm chain run exits 0")
	const chainLines = results(outChain)
	eq(chainLines.length, 6, "2 trials x 3 steps")
	eq(chainLines.map(l => l.adapter_run.state.dir_reused), [false, true, true, false, true, true], "warm chain: steps 2 and 3 reuse the dir; a new trial starts fresh")
	eq(chainLines.map(l => l.resolved), [true, true, true, true, true, true], "state files in the sandbox do not break cumulative grading")
	for (let t = 0; t < 2; t++) {
		for (let s = 1; s <= 3; s++) {
			const tr = fs.readFileSync(path.join(outChain, CHAIN_ID, "state", `t${t}`, `step-${s}`, "transcript.txt"), "utf8")
			for (const sha of f.chainShas) ok(tr.includes(`probe:${sha}=unreadable`), `t${t} step ${s}: fix commit ${sha.slice(0, 7)} is unreadable from the warm sandbox`)
			const p = fs.readFileSync(path.join(outChain, CHAIN_ID, "state", `t${t}`, `step-${s}`, "candidate.patch"), "utf8")
			ok(!p.includes(".codify"), `t${t} step ${s}: cumulative chain patch excludes in-tree state`)
		}
	}
	const t0s3 = transcriptOf(path.join(outChain, CHAIN_ID, "state", "t0", "step-3", "transcript.txt"))
	eq(t0s3.state_files, "1", "warm chain step 3 sees the index written by earlier steps")
	const t1s1 = transcriptOf(path.join(outChain, CHAIN_ID, "state", "t1", "step-1", "transcript.txt"))
	eq(t1s1.state_files, "0", "the second chain trial does not inherit the first trial's state")
	return {wall_ms: wall}
}

async function testSets(f) {
	console.log("== --set runs a frozen task set ==")
	const setsDir = path.join(f.base, "sets")
	fs.mkdirSync(setsDir, {recursive: true})
	const frozen = "2026-09-12T00:00:00.000Z"
	const writeSet = (name, tasks, chains = [], extra = {}) =>
		fs.writeFileSync(path.join(setsDir, `${name}.json`), JSON.stringify({name, version: 3, frozen_at: frozen, selection: {kind: "test"}, tasks, chains, ...extra}))
	writeSet("synth-two", [{repo: "synth", sha: f.shaB}, {repo: "synth", sha: f.shaA}])
	writeSet("synth-bad", [{repo: "synth", sha: "0".repeat(40)}])
	writeSet("synth-chain", [], [{repo: "synth", chain_id: CHAIN_ID}])
	writeSet("multi", [{repo: "synth", sha: f.shaA}, {repo: "other", sha: f.shaB}])
	writeSet("malformed", [{repo: "synth", sha: "abc"}])
	const env = {RUNNER_SETS_DIR: setsDir}
	let wall = 0

	const out = path.join(f.base, "runs-set")
	const r = runRunner(f, ["--set", "synth-two", "--adapter", "stub", "--out", out], env)
	wall += r.wall_ms
	eq(r.status, 0, "--set run exits 0 without --repo")
	const lines = results(out)
	eq(lines.map(l => l.sha), [f.shaB, f.shaA], "--set runs the set's tasks in the set's pinned order")
	const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq(m.set, {name: "synth-two", version: 3, frozen_at: frozen}, "manifest.set records name, version and frozen_at")
	eq(m.config.set, "synth-two", "manifest config.set records the set name")
	eq(m.config.repo, "synth", "the repo is derived from the set")

	const outLimit = path.join(f.base, "runs-set-limit")
	const rLimit = runRunner(f, ["--set", "synth-two", "--limit", "1", "--adapter", "stub", "--out", outLimit], env)
	wall += rLimit.wall_ms
	eq(results(outLimit).length, 1, "--limit applies to a set")

	const rTask = runRunner(f, ["--set", "synth-two", "--task", f.shaA, "--adapter", "stub", "--out", path.join(f.base, "runs-set-task")], env)
	eq(rTask.status, 2, "--set with --task is rejected")
	const rBad = runRunner(f, ["--set", "synth-bad", "--adapter", "stub", "--out", path.join(f.base, "runs-set-bad")], env)
	ok(rBad.status === 2 && /not found in the dataset/.test(rBad.stderr), "a pinned sha missing from the dataset fails loudly")
	const rMal = runRunner(f, ["--set", "malformed", "--adapter", "stub", "--out", path.join(f.base, "runs-set-mal")], env)
	ok(rMal.status === 2 && /40-hex/.test(rMal.stderr), "a set with a short sha is rejected")
	const rNope = runRunner(f, ["--set", "nope", "--adapter", "stub", "--out", path.join(f.base, "runs-set-nope")], env)
	ok(rNope.status === 2 && rNope.stderr.includes("synth-two"), "an unknown set names the available ones")
	const rMulti = runRunner(f, ["--set", "multi", "--adapter", "stub", "--out", path.join(f.base, "runs-set-multi")], env)
	ok(rMulti.status === 2 && /spans repos/.test(rMulti.stderr), "a multi-repo set without --repo is refused")
	wall += rTask.wall_ms + rBad.wall_ms + rMal.wall_ms + rNope.wall_ms + rMulti.wall_ms
	const outSlice = path.join(f.base, "runs-set-slice")
	const rSlice = runRunner(f, ["--set", "multi", "--repo", "synth", "--adapter", "stub", "--out", outSlice], env)
	wall += rSlice.wall_ms
	eq(rSlice.status, 0, "--set with --repo selects one slice of a multi-repo set")
	eq(results(outSlice).map(l => l.sha), [f.shaA], "the slice contains only that repo's pinned tasks")

	const outChain = path.join(f.base, "runs-set-chain")
	const rChain = runRunner(f, ["--set", "synth-chain", "--chain", "all", "--adapter", "chain", "--out", outChain], {
		...env,
		RUNNER_REPOS_FILE: f.chainReposFile,
		RUNNER_TASKS_FILE: f.chainTasksPath,
		RUNNER_CHAINS_FILE: f.chainsPath,
		RUNNER_EVALUATOR: path.join(f.adaptersDir, "chain-evaluator.mjs")
	})
	wall += rChain.wall_ms
	eq(rChain.status, 0, "--set with --chain all runs the set's chains")
	eq(results(outChain).map(l => l.chain_step), [1, 2, 3], "the set's chain ran every step")
	return {wall_ms: wall}
}

async function testModelFor(f) {
	console.log("== --model-for pairs each adapter with its own model ==")
	const out = path.join(f.base, "runs-model-for")
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub,stub2", "--model", "default-m", "--model-for", "stub2=special-m", "--out", out])
	eq(r.status, 0, "--model-for run exits 0")
	const lines = results(out)
	const stub = lines.find(l => l.adapter === "stub")
	const stub2 = lines.find(l => l.adapter === "stub2")
	eq([stub.model, stub.adapter_run.model], ["default-m", "default-m"], "an adapter without --model-for gets --model")
	eq([stub2.model, stub2.adapter_run.model], ["special-m", "special-m"], "an adapter with --model-for gets its own model on the line and in adapter_run")
	const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq(m.adapter.map(a => a.model), ["default-m", "special-m"], "manifest.adapter[].model records each adapter's model")
	eq(m.config.model_for, {stub2: "special-m"}, "manifest config.model_for records the overrides")
	const rUnknown = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--model-for", "boom=x", "--out", path.join(f.base, "runs-model-for-unknown")])
	eq(rUnknown.status, 2, "--model-for naming an adapter not in --adapter is rejected")
	const rNoEq = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--model-for", "stub", "--out", path.join(f.base, "runs-model-for-noeq")])
	eq(rNoEq.status, 2, "--model-for without = is rejected")
	return {wall_ms: r.wall_ms + rUnknown.wall_ms + rNoEq.wall_ms}
}

async function testResume(f) {
	console.log("== --resume continues an interrupted run in place ==")
	// Task mode: a run with 2 trials, of which trial 0 already exists on disk.
	const full = path.join(f.base, "runs-resume-full")
	const r0 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--out", full])
	eq(r0.status, 0, "reference run exits 0")
	const both = results(full)
	eq(both.map(l => l.trial), [0, 1], "reference run has trials 0 and 1")

	const out = path.join(f.base, "runs-resume")
	fs.mkdirSync(out, {recursive: true})
	fs.writeFileSync(path.join(out, "results.jsonl"), `${JSON.stringify(both[0])}\n`)
	const r1 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--resume", "--out", out])
	eq(r1.status, 0, "resumed run exits 0")
	const after = results(out)
	eq(after.length, 2, "the resumed run adds only the missing trial")
	eq(after.map(l => l.trial), [0, 1], "trial 0 was kept, trial 1 was run")
	ok(r1.stdout.includes("resuming") && r1.stdout.includes("1 prior line"), "the runner announces what it resumed from")
	const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq([m.resume.prior_lines, m.resume.skipped, m.resume.compacted_partial_chain_trials], [1, 1, 0], "manifest.resume records prior lines and skipped items")

	// A fully completed task is skipped without touching the repo (no eval worktree).
	const r2 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--resume", "--out", out])
	eq(r2.status, 0, "resuming a complete run exits 0")
	eq(results(out).length, 2, "resuming a complete run adds nothing")
	const m2 = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq(m2.resume.skipped, 2, "every item is reported skipped")
	eq(m2.resume, {...m2.resume, prior_lines: 2}, "prior_lines counts what was on disk")

	// Without --resume the frozen behaviour is unchanged: lines are appended.
	const r3 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "stub", "--trials", "2", "--out", out])
	eq(r3.status, 0, "plain re-run exits 0")
	eq(results(out).length, 4, "without --resume the run appends (frozen behaviour)")
	const m3 = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq(m3.resume, null, "manifest.resume is null when not resuming")

	// Chain mode: a complete chain trial is skipped; a partial one is dropped and re-run.
	const env = {
		RUNNER_REPOS_FILE: f.chainReposFile,
		RUNNER_TASKS_FILE: f.chainTasksPath,
		RUNNER_CHAINS_FILE: f.chainsPath,
		RUNNER_EVALUATOR: path.join(f.adaptersDir, "chain-evaluator.mjs")
	}
	const cout = path.join(f.base, "runs-resume-chain")
	const c0 = runRunner(f, ["--repo", "synth", "--chain", CHAIN_ID, "--adapter", "chain", "--out", cout], env)
	eq(c0.status, 0, "chain run exits 0")
	const clines = results(cout)
	eq(clines.length, 3, "3-step chain -> 3 lines")
	const c1 = runRunner(f, ["--repo", "synth", "--chain", CHAIN_ID, "--adapter", "chain", "--resume", "--out", cout], env)
	eq(c1.status, 0, "resumed chain run exits 0")
	eq(results(cout).length, 3, "a complete chain trial is skipped on resume")
	const cm = JSON.parse(fs.readFileSync(path.join(cout, "manifest.json"), "utf8"))
	eq([cm.resume.skipped, cm.resume.compacted_partial_chain_trials], [1, 0], "the complete chain trial counts as one skipped item")
	// Truncate to a partial trial (steps 1-2 only) and resume.
	fs.writeFileSync(path.join(cout, "results.jsonl"), `${clines.slice(0, 2).map(l => JSON.stringify(l)).join("\n")}\n`)
	const c2 = runRunner(f, ["--repo", "synth", "--chain", CHAIN_ID, "--adapter", "chain", "--resume", "--out", cout], env)
	eq(c2.status, 0, "resume over a partial chain trial exits 0")
	const relines = results(cout)
	eq(relines.length, 3, "the partial trial was dropped and re-run to completion, no duplicates")
	eq(relines.map(l => l.chain_step), [1, 2, 3], "steps are 1..3 exactly once")
	ok(fs.readdirSync(cout).some(n => n.startsWith("results.jsonl.pre-resume-")), "the pre-compaction file is kept as a backup")
	const cm2 = JSON.parse(fs.readFileSync(path.join(cout, "manifest.json"), "utf8"))
	eq(cm2.resume.compacted_partial_chain_trials, 1, "manifest records the compacted partial trial")
	return {wall_ms: r0.wall_ms + r1.wall_ms + r2.wall_ms + r3.wall_ms + c0.wall_ms + c1.wall_ms + c2.wall_ms}
}

async function testLeak(f) {
	console.log("== answer-lookup audit and sandbox hardening ==")
	// A repo spec with an upstream identity, so the audit knows what "upstream" is.
	const reposFile = path.join(f.base, "repos-leak.json")
	fs.writeFileSync(reposFile, JSON.stringify({synth: {url: "https://github.com/acme/widget", name: "widget", cloneDir: f.root, install: [], testCmd: "true", testArgs: () => [], testTimeoutMs: 2000, installTimeoutMs: 2000}}))
	const env = {RUNNER_REPOS_FILE: reposFile, GH_TOKEN: "ghp_secret_from_operator", GITHUB_TOKEN: "also_secret", GH_CONFIG_DIR: path.join(f.base, "operator-gh")}
	fs.mkdirSync(env.GH_CONFIG_DIR, {recursive: true})
	fs.writeFileSync(path.join(env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\n  user: operator\n")

	const out = path.join(f.base, "runs-leak")
	const r = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "leaky,stub", "--out", out], env)
	eq(r.status, 0, "run with a leaking adapter exits 0")
	const lines = results(out)
	const leaky = lines.find(l => l.adapter === "leaky")
	const stub = lines.find(l => l.adapter === "stub")
	ok(leaky && leaky.leak && leaky.leak.clean === false, "the leaky trial is marked not clean")
	eq(leaky.reason, "answer_lookup", "a fatal lookup overrides the reason")
	eq(leaky.resolved, false, "a fatal lookup can never count as resolved")
	ok(leaky.graded && typeof leaky.graded.resolved === "boolean" && typeof leaky.graded.reason === "string", "the evaluator's own verdict is kept under graded")
	eq(leaky.leak.counts.upstream_lookup, 1, "one upstream lookup counted")
	eq(leaky.leak.findings[0].kind, "upstream_lookup", "the finding names the kind")
	ok(/acme\/widget/.test(leaky.leak.findings[0].command), "the finding carries the executed command")
	ok(fs.existsSync(path.join(out, f.shaA, "leaky", "candidate.patch")) && fs.readFileSync(path.join(out, f.shaA, "leaky", "candidate.patch"), "utf8").includes("agent-note"), "the patch is still captured and stored")
	ok(stub && stub.leak && stub.leak.clean === true && stub.graded === undefined, "a clean trial has leak.clean=true and no graded override")
	eq(stub.leak.commands_scanned, 0, "a plain-text transcript has no executed commands")

	// Sandbox hardening as seen from inside the adapter.
	const transcript = fs.readFileSync(path.join(out, f.shaA, "leaky", "transcript.txt"), "utf8")
	const envLine = transcript.split("\n").find(l => l.startsWith("env:")) || ""
	ok(/GH_TOKEN=<unset>/.test(envLine), "GH_TOKEN is removed inside the sandbox")
	ok(/GITHUB_TOKEN=<unset>/.test(envLine), "GITHUB_TOKEN is removed inside the sandbox")
	ok(/GIT_ALLOW_PROTOCOL=file/.test(envLine), "git is limited to the file protocol")
	ok(/npm_config_registry=http:\/\/127\.0\.0\.1:9\//.test(envLine), "npm registry points at a dead port")
	ok(/PIP_NO_INDEX=1/.test(envLine), "pip has no index")
	ok(!envLine.includes(env.GH_CONFIG_DIR), "gh does not see the operator's config dir")
	ok(/gh_config_entries:0/.test(transcript), "gh config dir is fresh and empty")
	ok(envLine.includes("AWS_REGION=" + (process.env.AWS_REGION === undefined ? "<unset>" : process.env.AWS_REGION)), "provider variables are left alone")

	// Manifest records the policy.
	const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"))
	eq(m.config.leak_audit, {enabled: true, version: 1}, "manifest records the leak audit version")
	eq(m.config.sandbox_env.GIT_ALLOW_PROTOCOL, "file", "manifest records the hardening")
	eq(m.config.sandbox_env.GH_TOKEN, null, "manifest records removed variables as null")

	// Non-fatal external network is recorded but does not change the verdict.
	const out2 = path.join(f.base, "runs-leak-ext")
	const r2 = runRunner(f, ["--repo", "synth", "--task", f.shaA, "--adapter", "leaky", "--out", out2], {...env, LEAKY_COMMAND: "curl -s https://example.com/docs"})
	eq(r2.status, 0, "external-network run exits 0")
	const ext = results(out2)[0]
	eq([ext.leak.clean, ext.leak.counts.external_network, ext.reason === "answer_lookup"], [true, 1, false], "external network is recorded, not fatal")

	// Chain mode: every step carries a leak record.
	const cenv = {RUNNER_REPOS_FILE: f.chainReposFile, RUNNER_TASKS_FILE: f.chainTasksPath, RUNNER_CHAINS_FILE: f.chainsPath, RUNNER_EVALUATOR: path.join(f.adaptersDir, "chain-evaluator.mjs")}
	const cout = path.join(f.base, "runs-leak-chain")
	const c = runRunner(f, ["--repo", "synth", "--chain", CHAIN_ID, "--adapter", "chain", "--out", cout], cenv)
	eq(c.status, 0, "chain run exits 0")
	const clines = results(cout)
	ok(clines.length === 3 && clines.every(l => l.leak && l.leak.clean === true), "chain steps carry a leak record")
	return {wall_ms: r.wall_ms + r2.wall_ms + c.wall_ms}
}

async function main() {
	const f = makeFixtures()
	const times = {}
	times.capture = await testCapture(f)
	times.boom = await testThrowingAdapter(f)
	times.limit = await testLimit(f)
	times.budget = await testBudget(f)
	times.budgetDefault = await testBudgetDefaultTrials(f)
	times.baseline = await testBaselineOnly(f)
	times.trials = await testTrials(f)
	times.turns = await testTurns(f)
	times.model = await testModel(f)
	times.chains = await testChains(f)
	times.state = await testState(f)
	times.sets = await testSets(f)
	times.modelFor = await testModelFor(f)
	times.resume = await testResume(f)
	times.leak = await testLeak(f)
	times.interrupt = await testInterrupt(f)
	times.integration = await testIntegration()

	console.log(`\npass=${pass} fail=${fail}`)
	for (const [k, v] of Object.entries(times)) {
		if (v) console.log(`  ${k}: ${v.wall_ms}ms`)
	}
	if (failures.length) {
		console.log("failures:")
		for (const m of failures) console.log(` - ${m}`)
	}
	process.exit(fail ? 1 : 0)
}

main().catch(e => {
	console.error("FATAL", e)
	process.exit(1)
})
