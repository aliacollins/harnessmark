#!/usr/bin/env node
// Historic replay task harvester + validator.
// usage: node spike/harvest.mjs <repo> [--max=N] [--budget=minutes]
//                                [--max-files=N] [--max-lines=N] [--out=DIR]
//
// Injectable test command (used by spike/test/negative-control.mjs and for manual
// debugging): set SPIKE_TEST_CMD to the executable and SPIKE_TEST_ARGS to a JSON
// array of fixed args; the scoped test file paths are appended.
import {spawn} from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {LANG_TEST_RES, REPOS as REGISTRY_REPOS, isTestPath} from "../harness/registry.mjs"
import {getReporter} from "../harness/reporters.mjs"
import {makeRuntime} from "../harness/runtime.mjs"

const SPIKE = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.join(SPIKE, "work")
const OUT = path.join(SPIKE, "out")

const SINCE = "2025-09-01"
// Intentional and required for contamination resistance: keep the post-cutoff
// slice so the corpus can be filtered against post-training data (F8).
const POST_CUTOFF = "2026-06-01"
// The size ceiling, raised well above anything in the current windows: at
// 12/400 it was deferring the feature-sized commits, and past 30/2000 nothing in
// either repo exceeds it, so it no longer binds. What rejects the remaining
// candidates is not size but version_bump / no_tests / no_source.
const DEFAULT_MAX_FILES = 100
const DEFAULT_MAX_LINES = 5000
// Overridable so the commits the default window defers as "too_large" can be
// harvested deliberately: they are the feature-sized ones, which is exactly the
// long-horizon material a single-file bugfix corpus cannot supply.
let MAX_FILES = DEFAULT_MAX_FILES
let MAX_LINES = DEFAULT_MAX_LINES
const DEFAULT_MAX_CANDIDATES = 60
const DEFAULT_BUDGET_MS = 25 * 60 * 1000

const NON_BEHAVIORAL = /^(chore|docs?|ci|build|release|version|bump|lint|format|style|test|refactor)([:(]|$)/i
const VERSION_BUMP = /^v?\d+\.\d+\.\d+/

// Repo specs come from the registry (single source of truth); the private copy
// that used to live here drifted from it. REPOS is spread into a mutable object
// so tests can inject synthetic repos without touching the frozen module.
const REPOS = {...REGISTRY_REPOS}

// ---------------------------------------------------------------- process

function run(cmd, args, {cwd, timeoutMs = 120_000} = {}) {
	return new Promise(resolve => {
		const t0 = Date.now()
		let out = ""
		let killed = false
		let settled = false
		const child = spawn(cmd, args, {cwd, detached: true, stdio: ["ignore", "pipe", "pipe"]})
		const finish = code => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve({code, out, killed, ms: Date.now() - t0})
		}
		child.stdout.on("data", d => (out += d))
		child.stderr.on("data", d => (out += d))
		const timer = setTimeout(() => {
			killed = true
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {}
			try {
				child.kill("SIGKILL")
			} catch {}
		}, timeoutMs)
		child.on("error", err => {
			out += `\n[spawn error] ${err.message}\n`
			finish(-1)
		})
		child.on("close", code => finish(code))
	})
}

const git = (repo, args, timeoutMs = 120_000) =>
	run("git", ["-c", "core.quotepath=false", ...args], {cwd: repo, timeoutMs})

// Artifacts under spike/out are committed and shared, so tails never carry
// this machine's absolute paths: the repo root (and the home directory, for
// tool output that prints its own paths) is stripped before anything is kept.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scrubPaths = s => s.split(ROOT + path.sep).join("").split(os.homedir()).join("~")
const tail = (s, n = 40) => scrubPaths(s).split("\n").slice(-n).join("\n")
const oneLine = (s, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n)

// ---------------------------------------------------------------- classify

const IGNORE_DIR = /(^|\/)(\.github|examples|docs|benchmarks)\//
const LOCKFILE = /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock)$/

// TEST-SUPPORT (F3): injected with the oracle patch but excluded from the test
// runner file-filter. Snapshots, fixtures, mocks, test utils, setup files.
const SUPPORT_PATTERNS = [
	/\.snap$/i,
	/(^|\/)__snapshots__\//,
	/(^|\/)__fixtures__\//,
	/(^|\/)__mocks__\//,
	/(^|\/)test-utils\//,
	/(^|\/)testUtils\//
]
const SUPPORT_BASENAME = /^(setupTests|vitest\.setup|jest\.setup)\..+$/i

// TEST INFRA (F4): config/reporter/setup files are not source and not tests.
const INFRA_PATTERNS = [
	/(^|\/)(vitest|vite|jest)\.config\.[^/]+$/,
	/(^|\/)tsconfig[^/]*\.json$/,
	/(^|\/)package\.json$/,
	/(^|\/)[^/]*\.setup\.[^/]+$/,
	/(^|\/)[^/]*reporter[^/]*$/i,
	/(^|\/)\.mocharc[^/]*$/,
	/(^|\/)nyc\.config\.[^/]+$/
]

// TypeScript classification: the historic rule, byte-identical, used whenever
// the repo spec is absent or its lang has no table below. Every existing
// hono/immer task was produced by exactly this function.
function classifyTs(p) {
	const base = p.split("/").pop()
	if (IGNORE_DIR.test(p)) return "ignore"
	if (/\.(md|mdx)$/i.test(p)) return "ignore"
	if (LOCKFILE.test(p)) return "ignore"
	if (SUPPORT_PATTERNS.some(r => r.test(p)) || SUPPORT_BASENAME.test(base)) return "support"
	if (/(^|\/)(__tests__|test|tests|spec)\//.test(p)) return "test"
	if (/(\.|-)(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "test"
	if (INFRA_PATTERNS.some(r => r.test(p))) return "infra"
	if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p)) return "source"
	return "ignore"
}

// Per-language split for the non-TypeScript corpora. `test` paths come from the
// registry's LANG_TEST_RES via isTestPath(p, spec) so the harvester and the
// evaluator's tamper detector agree on what a test file is. Support files are
// injected with the oracle but never used as runner entry points; infra files
// (build/test config) reject a candidate the same way vitest.config does for
// TypeScript. `runnable` is the file-level heuristic for "the runner can be
// pointed at this path": pytest/go/cargo do not use a .test./.spec. filename.
const LANG_RULES = {
	python: {
		support: [/(^|\/)conftest\.py$/, /(^|\/)tests?\/(fixtures|data|cassettes|snapshots)\//, /(^|\/)__snapshots__\//, /\.(snap|ambr)$/],
		infra: [/(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|pytest\.ini|tox\.ini|noxfile\.py)$/, /(^|\/)requirements[^/]*\.txt$/, /(^|\/)uv\.lock$/],
		ignore: [/(^|\/)(uv|poetry|pdm)\.lock$/],
		source: /\.py$/i,
		// A runner entry point is a TEST module, not any .py file.
		runnable: p => /\.py$/i.test(p) && !/(^|\/)conftest\.py$/.test(p) && isTestPath(p, "python")
	},
	go: {
		support: [/(^|\/)testdata\//],
		infra: [/(^|\/)go\.(mod|sum|work)$/],
		ignore: [],
		source: /\.go$/i,
		runnable: p => /_test\.go$/.test(p)
	},
	rust: {
		support: [/(^|\/)tests?\/(fixtures|data|snapshots|ui)\//, /\.snap$/, /\.stderr$/],
		infra: [/(^|\/)Cargo\.toml$/, /(^|\/)\.config\/nextest\.toml$/, /(^|\/)rust-toolchain(\.toml)?$/],
		ignore: [],
		source: /\.rs$/i,
		runnable: p => /\.rs$/i.test(p)
	}
}

function classify(p, spec) {
	const lang = typeof spec === "string" ? spec : spec?.lang
	const rules = lang && lang !== "ts" ? LANG_RULES[lang] : null
	if (!rules) return classifyTs(p)
	if (IGNORE_DIR.test(p)) return "ignore"
	if (LOCKFILE.test(p) || rules.ignore.some(r => r.test(p))) return "ignore"
	// Support before the docs rule: a golden file under testdata/ may be .txt.
	if (rules.support.some(r => r.test(p))) return "support"
	if (isTestPath(p, lang)) return "test"
	if (/\.(md|mdx|rst|txt)$/i.test(p) && !/requirements[^/]*\.txt$/.test(p)) return "ignore"
	if (rules.infra.some(r => r.test(p))) return "infra"
	if (rules.source.test(p)) return "source"
	return "ignore"
}

const isRunnableTest = (p, spec) => {
	const lang = typeof spec === "string" ? spec : spec?.lang
	const rules = lang && lang !== "ts" ? LANG_RULES[lang] : null
	if (!rules) return /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i.test(p)
	return rules.runnable(p)
}

// ---------------------------------------------------------------- parsing

function summarize(out) {
	const tm = out.match(/^\s*Tests\s+(.+)$/m)
	const fm = out.match(/^\s*Test Files\s+(.+)$/m)
	let passed = 0
	let failed = 0
	let total = 0
	let noTests = false
	let parsed = false
	if (tm) {
		const s = tm[1].trim()
		if (/no tests/i.test(s)) noTests = true
		else {
			const p = s.match(/(\d+)\s+passed/)
			const f = s.match(/(\d+)\s+failed/)
			const t = s.match(/\((\d+)\)/)
			passed = p ? +p[1] : 0
			failed = f ? +f[1] : 0
			total = t ? +t[1] : passed + failed
		}
		parsed = true
	} else if (/No test files found/i.test(out)) {
		noTests = true
		parsed = true
	}
	return {passed, failed, total, noTests, parsed, files: fm ? fm[1].trim() : null}
}

function failMode(res, sum) {
	if (res.killed) return "timeout"
	if (/No test files found/i.test(res.out)) return "collection"
	if (sum.noTests || sum.total === 0) return "collection"
	if (sum.failed > 0) return "assertion"
	return "other"
}

// Run the repo's test command over `paths` through the runtime and summarise it
// with the repo's machine-readable reporter. Returns the harvest-shaped tuple
// {code, out, killed, ms} plus a summary {passed, failed, total, noTests, parsed}.
// The text summariser is only a FALLBACK for two cases: (a) an injected
// SPIKE_TEST_CMD stub with no reporter, and (b) a run that produced no report
// at all, where "No test files found" in the output still has to classify as a
// collection failure rather than "unparseable". A reporter that did produce a
// report always wins - names, not counts, are what grading later trusts.
async function runSuite(cfg, paths, dir) {
	const t0 = Date.now()
	if (!cfg.reporter) {
		const res = await run(cfg.testCmd, cfg.testArgs(paths), {cwd: dir, timeoutMs: cfg.testTimeoutMs})
		return {res, sum: summarize(res.out)}
	}
	const reporter = getReporter(cfg.reporter)
	const runtime = makeRuntime(cfg)
	const scratch = runtime.scratch()
	const hostOut = path.join(scratch.host, "report.json")
	const guestOut = path.posix.join(scratch.guest, "report.json")
	const args = [...cfg.testArgs(paths), ...reporter.args(paths, guestOut)]
	const r = await runtime.exec(cfg.testCmd, args, {cwd: dir, timeoutMs: cfg.testTimeoutMs, scratch})
	const out = (r.stdout || "") + (r.stderr || "")
	const res = {code: r.code == null && !r.timedOut ? -1 : r.code, out, killed: r.timedOut, ms: Date.now() - t0}
	let text = null
	try {
		if (reporter.source === "outFile") text = fs.readFileSync(hostOut, "utf8")
		else if (reporter.source === "stdout") text = r.stdout
		else if (reporter.source === "cwdFile") text = fs.readFileSync(reporter.locate(dir), "utf8")
	} catch {
		text = null
	}
	try {
		fs.rmSync(scratch.host, {recursive: true, force: true})
	} catch {}
	const report = text == null ? null : reporter.parse(text)
	if (!report) return {res, sum: summarize(out)}
	const total = report.total
	return {res, sum: {passed: report.passed, failed: report.failed, total, noTests: total === 0, parsed: true, files: null}}
}

const normalizeExit = code => (code == null ? -1 : code)
const runTuple = (res, sum) => ({
	exit: normalizeExit(res.code),
	passed: sum.passed,
	failed: sum.failed,
	total: sum.total
})
const sameRun = (a, b) =>
	a.exit === b.exit && a.passed === b.passed && a.failed === b.failed && a.total === b.total

const median = a => {
	if (!a.length) return null
	const s = [...a].sort((x, y) => x - y)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------------------------------------------------------------- taxonomy
// Derived, auditable task classification. Everything here is computed from
// commit metadata and the diff; nothing is hand-labeled or LLM-labeled.

const SECURITY_RE = /CVE-|security|vulnerab|prototype pollution|sanitiz|escap/i
const BUGGY_RE = /\b(fix|bug|regression|patch|correct|handle|prevent|avoid|ensure)\b/i
const PREFIX_RE = /^([a-zA-Z]+)(?:\([^)]*\))?!?:/

// Run mechanics, not validation outcomes: excluded from the semantic breakdown.
const MEASUREMENT_ARTIFACTS = new Set(["version_bump", "not_attempted_cap", "not_attempted_budget"])

function categoryOf(subject) {
	if (SECURITY_RE.test(subject)) return {category: "security", category_source: "heuristic"}
	const m = subject.match(PREFIX_RE)
	const prefix = m ? m[1].toLowerCase() : null
	if (prefix === "perf") return {category: "perf", category_source: "prefix"}
	if (prefix === "refactor") return {category: "refactor", category_source: "prefix"}
	if (prefix === "feat") return {category: "feature", category_source: "prefix"}
	if (prefix === "fix") return {category: "bugfix", category_source: "prefix"}
	if (BUGGY_RE.test(subject)) return {category: "bugfix", category_source: "heuristic"}
	return {category: "unknown", category_source: "unknown"}
}

function sizeBucketOf(lines) {
	if (lines <= 10) return "XS"
	if (lines <= 50) return "S"
	if (lines <= 150) return "M"
	if (lines <= 400) return "L"
	return "XL"
}

// Directory prefix used as a subsystem / horizon-shapedness proxy. Both spec
// examples resolve to the first two directory segments (`src/plugins/foo.ts` ->
// `src/plugins`, `packages/x/src/y.ts` -> `packages/x`), so we keep up to two
// directory segments for plain and monorepo layouts alike.
function subsystemOf(p) {
	const dirs = p.split("/").slice(0, -1).filter(Boolean)
	if (!dirs.length) return "."
	return dirs.slice(0, 2).join("/")
}

const subsystemsOf = sourcePaths => [...new Set((sourcePaths || []).map(subsystemOf))].sort()

function testDeltaOf(oracleFilesStatus) {
	const list = oracleFilesStatus || []
	const tests_added = list.filter(e => e.status === "A").length
	const tests_modified = list.length - tests_added
	const test_delta =
		tests_added > 0 && tests_modified > 0 ? "mixed" : tests_added > 0 ? "new-test-file" : "modified-test"
	return {test_delta, tests_added, tests_modified}
}

function deriveTaxonomy(t) {
	const {category, category_source} = categoryOf(t.subject)
	const subsystems = subsystemsOf(t.source_paths)
	const delta = testDeltaOf(t.oracle_files_status)
	return {
		category,
		category_source,
		size_bucket: sizeBucketOf(t.diffstat ? t.diffstat.lines : 0),
		subsystems,
		subsystem_count: subsystems.length,
		...delta
	}
}

function splitOutcomes(reasons) {
	const semantic = {}
	const artifacts = {}
	for (const [k, v] of Object.entries(reasons || {})) {
		if (MEASUREMENT_ARTIFACTS.has(k)) artifacts[k] = v
		else semantic[k] = v
	}
	return {semantic, artifacts}
}

// ---------------------------------------------------------------- stage 0

async function resolveDefaultBranch(dir) {
	const sym = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
	if (sym.code === 0 && sym.out.trim()) return sym.out.trim().replace(/^origin\//, "")
	for (const candidate of ["main", "master"]) {
		const v = await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])
		if (v.code === 0 && v.out.trim()) return candidate
	}
	throw new Error("could not resolve default branch (origin/HEAD missing and no origin/main or origin/master)")
}

async function prepare(name, cfg) {
	fs.mkdirSync(WORK, {recursive: true})
	const dir = path.join(WORK, name)
	let cloned = false
	let fetchedAt = null
	if (!fs.existsSync(path.join(dir, ".git"))) {
		fs.rmSync(dir, {recursive: true, force: true})
		console.log(`[stage0] cloning ${cfg.url}`)
		const c = await run("git", ["clone", cfg.url, dir], {timeoutMs: 900_000})
		if (c.code !== 0) throw new Error(`clone failed (code ${c.code}):\n${tail(c.out)}`)
		cloned = true
		fetchedAt = new Date().toISOString()
	} else {
		console.log(`[stage0] reusing clone, fetching origin`)
		const f = await run("git", ["fetch", "origin"], {cwd: dir, timeoutMs: 900_000})
		if (f.code !== 0) throw new Error(`fetch failed (code ${f.code}):\n${tail(f.out)}`)
		fetchedAt = new Date().toISOString()
	}

	const branch = await resolveDefaultBranch(dir)
	// Hard-reset the local branch to the freshly fetched remote (F6).
	const reset = await git(dir, ["checkout", "-f", "-B", branch, `origin/${branch}`])
	if (reset.code !== 0)
		throw new Error(`reset to origin/${branch} failed (code ${reset.code}):\n${tail(reset.out)}`)
	const head = await git(dir, ["rev-parse", "HEAD"])
	if (head.code !== 0) throw new Error(`rev-parse HEAD failed (code ${head.code}):\n${tail(head.out)}`)
	const headSha = head.out.trim()

	console.log(`[stage0] workdir ${dir} (default branch: ${branch}, HEAD ${headSha.slice(0, 10)})`)
	if (cloned || !fs.existsSync(path.join(dir, "node_modules"))) {
		console.log(`[stage0] install: ${cfg.install.join(" ")}`)
		const i = await run(cfg.install[0], cfg.install.slice(1), {
			cwd: dir,
			timeoutMs: cfg.installTimeoutMs
		})
		if (i.code !== 0) throw new Error(`install failed (code ${i.code}):\n${tail(i.out)}`)
		console.log(`[stage0] install ok in ${(i.ms / 1000).toFixed(1)}s`)
	} else {
		console.log("[stage0] node_modules present, skipping install")
	}
	return {dir, branch, headSha, fetchedAt}
}

// ---------------------------------------------------------------- stage 1

async function harvest(dir, branch, cfg) {
	const log = await git(dir, [
		"log",
		branch,
		`--since=${SINCE}`,
		"--no-merges",
		"--date=iso-strict",
		"--pretty=format:%x1e%H%x1f%cI%x1f%s%x1f%B"
	])
	if (log.code !== 0) throw new Error(`git log failed (code ${log.code}):\n${tail(log.out)}`)
	const records = log.out
		.split("\x1e")
		.map(s => s.replace(/^\n+/, ""))
		.filter(Boolean)

	const commits = []
	const rejected = []
	const candidates = []

	for (const rec of records) {
		let [sha, date, subject, body = ""] = rec.split("\x1f")
		sha = (sha || "").trim()
		date = (date || "").trim()
		subject = (subject || "").trim()
		if (!/^[0-9a-f]{40}$/.test(sha)) continue

		const ns = await git(dir, ["show", "--name-status", "--format=", sha])
		const stat = await git(dir, ["show", "--numstat", "--format=", sha])
		if (ns.code !== 0 || stat.code !== 0) {
			rejected.push({
				sha,
				date,
				subject,
				reason: "git_error",
				detail: `git show failed (name-status ${ns.code}, numstat ${stat.code}): ${oneLine(ns.out || stat.out)}`
			})
			continue
		}

		const entries = []
		for (const line of ns.out.split("\n")) {
			if (!line.trim()) continue
			const f = line.split("\t")
			if (f.length < 2) continue
			const status = f[0][0]
			const renamed = status === "R" || status === "C"
			const p = renamed ? f[2] : f[1]
			if (!p) continue
			const entry = {path: p.trim(), status}
			// Keep the source path of a rename/copy: that is where the file's
			// content lived at the parent, so it is the path the clean-parent
			// control must run against and the path whose existence decides
			// whether the control can be skipped.
			if (renamed && f[1]) entry.old_path = f[1].trim()
			entries.push(entry)
		}
		let added = 0
		let deleted = 0
		for (const line of stat.out.split("\n")) {
			if (!line.trim()) continue
			const f = line.split("\t")
			if (f.length < 3) continue
			added += /^\d+$/.test(f[0]) ? +f[0] : 0
			deleted += /^\d+$/.test(f[1]) ? +f[1] : 0
		}

		const testPaths = []
		const testStatus = new Map()
		const supportPaths = []
		const sourcePaths = []
		const infraPaths = []
		for (const e of entries) {
			const kind = classify(e.path, cfg)
			if (kind === "test") {
				testPaths.push(e.path)
				testStatus.set(e.path, e)
			} else if (kind === "support") supportPaths.push(e.path)
			else if (kind === "source") sourcePaths.push(e.path)
			else if (kind === "infra") infraPaths.push(e.path)
		}
		const fileCount = entries.length
		const lines = added + deleted

		const base = {
			sha,
			parent: `${sha}^`,
			date,
			post_cutoff: date.slice(0, 10) >= POST_CUTOFF,
			subject,
			message_body: (body || "").trim(),
			test_paths: testPaths,
			oracle_files_status: testPaths.map(p => {
				const e = testStatus.get(p)
				const o = {path: p, status: e.status}
				if (e.old_path) o.old_path = e.old_path
				return o
			}),
			support_paths: supportPaths,
			source_paths: sourcePaths,
			infra_paths: infraPaths,
			diffstat: {files: fileCount, added, deleted, lines}
		}

		let reason = null
		let detail = ""
		if (VERSION_BUMP.test(subject)) {
			reason = "version_bump"
			detail = subject
		} else if (infraPaths.length > 0) {
			if (sourcePaths.length > 0) {
				reason = "touches_test_infra"
				detail = `changes real source and test infra: ${infraPaths.join(", ")}`
			} else {
				reason = "infra_only"
				detail = `only test infra changed: ${infraPaths.join(", ")}`
			}
		} else if (sourcePaths.length === 0 && testPaths.length === 0) {
			if (supportPaths.length > 0) {
				reason = "no_tests"
				detail = `support-only changes (${supportPaths.length} file(s)): ${supportPaths.join(", ")}`
			} else {
				reason = "no_source"
				detail = `no source or test files (${fileCount} file(s))`
			}
		} else if (testPaths.length === 0) {
			reason = "no_tests"
			detail = supportPaths.length
				? `support-only changes (${supportPaths.length} file(s)), no real test files: ${supportPaths.join(", ")}`
				: `${sourcePaths.length} source file(s), no test files`
		} else if (sourcePaths.length === 0) {
			reason = "no_source"
			detail = `${testPaths.length} test file(s), no source files`
		} else if (NON_BEHAVIORAL.test(subject)) {
			reason = "non_behavioral_subject"
			detail = subject
		} else if (fileCount > MAX_FILES || lines > MAX_LINES) {
			reason = "too_large"
			detail = `${fileCount} files, ${lines} lines`
		}
		if (reason) {
			const rej = {sha, date, subject, reason, detail}
			if (reason === "too_large") {
				rej.files = fileCount
				rej.lines = lines
				rej.deferred_for =
					lines > MAX_LINES && fileCount > MAX_FILES
						? "lines+files"
						: lines > MAX_LINES
							? "lines"
							: "files"
			}
			rejected.push(rej)
		} else {
			commits.push(base)
			candidates.push(base)
		}
	}

	const nonMergeInWindow = records.filter(r => /^[0-9a-f]{40}/.test(r.replace(/^\n+/, ""))).length
	return {commits, candidates, rejected, nonMergeInWindow}
}

// ---------------------------------------------------------------- stage 2

const gitError = (out, detail) => {
	out.reason = "git_error"
	out.detail = detail
	return out
}

async function validate(dir, cfg, cand) {
	const out = {...cand, validated: false, reason: null, detail: ""}
	const tmp = path.join(os.tmpdir(), `spike-oracle-${process.pid}-${cand.sha}.patch`)
	const t0 = Date.now()
	out.run_tails = {}
	try {
		const co = await git(dir, ["checkout", "-f", "-q", cand.parent])
		if (co.code !== 0) return gitError(out, `checkout parent failed (code ${co.code}): ${oneLine(co.out)}`)
		const cl = await git(dir, ["clean", "-fdq"])
		if (cl.code !== 0) return gitError(out, `clean parent failed (code ${cl.code}): ${oneLine(cl.out)}`)
		const psha = await git(dir, ["rev-parse", "HEAD"])
		if (psha.code !== 0) return gitError(out, `rev-parse parent failed (code ${psha.code}): ${oneLine(psha.out)}`)
		out.parent_sha = psha.out.trim()

		// Resolve each oracle test path's status against git using the parent
		// commit, which is authoritative. A path absent there is `A` (added); a path
		// present there is `M`, or the raw `R`/`C` status when the commit renamed or
		// copied it. Renames are probed at their OLD path: that is where the test
		// content lived at the parent, so a rename never counts as a new test file
		// and never qualifies for the skipped control.
		//
		// Absence must be proven by a SUCCESSFUL git command. `git ls-tree <rev> --
		// <path>` exits 0 with empty output when the path is missing at the parent;
		// any nonzero exit is a git failure (recorded as `git_error`) and is never
		// read as "absent at parent".
		const claimed = new Map((cand.oracle_files_status || []).map(e => [e.path, e]))
		const oracleStatus = []
		for (const p of cand.test_paths) {
			const claim = claimed.get(p) || {}
			const raw = claim.status
			const renamed = raw === "R" || raw === "C"
			const probe = renamed && claim.old_path ? claim.old_path : p
			const lt = await git(dir, ["ls-tree", out.parent_sha, "--", probe])
			if (lt.code !== 0)
				return gitError(out, `ls-tree ${probe} failed (code ${lt.code}): ${oneLine(lt.out)}`)
			const existsAtParent = lt.out.trim().length > 0
			let status
			if (renamed) status = raw
			else if (!existsAtParent) status = "A"
			else if (raw && raw !== "A") status = raw
			else status = "M"
			const entry = {path: p, status}
			if (renamed && claim.old_path) entry.old_path = claim.old_path
			oracleStatus.push(entry)
		}
		out.oracle_files_status = oracleStatus

		// F2: clean-parent control run BEFORE injecting the oracle, over the
		// pre-existing oracle test files only (for a rename, its OLD path). The
		// control is skipped ONLY when every oracle test path is git-verified absent
		// at the parent — "the oracle tests do not exist yet at the parent" is not
		// the same as "the parent is already failing". A path that does exist at the
		// parent but cannot be run by the pinned runner is an explicit rejection,
		// never a silent skip. The red-side requirement after injection still
		// applies unconditionally.
		const preExisting = oracleStatus.filter(e => e.status !== "A")
		out.timings = {cleanMs: 0, parentMs: null, parent2Ms: null, fixMs: null, totalMs: 0}
		if (!preExisting.length) {
			out.parent_clean_run = {skipped: true, reason: "oracle_files_absent_at_parent"}
			out.run_tails.parent_clean = ""
		} else {
			const controlPaths = preExisting
				.filter(e => isRunnableTest(e.old_path || e.path, cfg))
				.map(e => e.old_path || e.path)
			if (!controlPaths.length) {
				out.reason = "pre_existing_test_not_runnable"
				out.detail = `pre-existing oracle path(s) not runnable by the pinned runner: ${preExisting
					.map(e => e.old_path || e.path)
					.join(", ")}`
				return out
			}
			const {res: r0, sum: s0} = await runSuite(cfg, controlPaths, dir)
			out.timings.cleanMs = r0.ms
			out.parent_clean_run = runTuple(r0, s0)
			out.run_tails.parent_clean = tail(r0.out)
			if (r0.killed) {
				out.reason = "timeout"
				out.detail = `clean parent run exceeded ${cfg.testTimeoutMs}ms`
				return out
			}
			if (!s0.parsed) {
				out.reason = "unparseable_test_output"
				out.detail = `clean parent output not parseable: ${oneLine(r0.out)}`
				return out
			}
			if (s0.total < 1) {
				out.reason = "zero_tests_collected"
				out.detail = "clean parent collected zero tests"
				return out
			}
			if (r0.code !== 0 || s0.failed > 0) {
				out.reason = "pre_existing_failure"
				out.detail = `clean parent not green: exit ${normalizeExit(r0.code)}, ${s0.failed} failed / ${s0.passed} passed`
				return out
			}
		}

		// Inject the oracle (real tests + test-support files). F3: support files
		// are part of the oracle patch but never used as runner entry points.
		const oraclePaths = [...cand.test_paths, ...(cand.support_paths || [])]
		const d = await git(dir, ["diff", "--binary", cand.parent, cand.sha, "--", ...oraclePaths])
		if (d.code !== 0) return gitError(out, `oracle diff failed (code ${d.code}): ${oneLine(d.out)}`)
		fs.writeFileSync(tmp, d.out)
		if (!d.out.trim()) {
			out.reason = "oracle_apply_failed"
			out.detail = "empty test diff"
			return out
		}
		let a = await git(dir, ["apply", "--whitespace=nowarn", tmp])
		if (a.code !== 0) {
			a = await git(dir, ["apply", "--3way", "--whitespace=nowarn", tmp])
			if (a.code !== 0) {
				out.reason = "oracle_apply_failed"
				out.detail = tail(a.out, 3).replace(/\n/g, " | ")
				return out
			}
		}

		const runPaths = cand.test_paths.filter(
			p => isRunnableTest(p, cfg) && fs.existsSync(path.join(dir, p))
		)
		if (!runPaths.length) {
			out.reason = "oracle_not_runnable"
			out.detail = "no runnable test files present after oracle apply"
			return out
		}
		out.run_paths = runPaths

		const {res: r1, sum: s1} = await runSuite(cfg, runPaths, dir)
		out.timings.parentMs = r1.ms
		out.parent_oracle_run = runTuple(r1, s1)
		out.run_tails.parent_oracle = tail(r1.out)
		if (r1.killed) {
			out.reason = "timeout"
			out.detail = `parent+oracle run exceeded ${cfg.testTimeoutMs}ms`
			return out
		}
		if (!s1.parsed) {
			out.reason = "unparseable_test_output"
			out.detail = `parent+oracle output not parseable: ${oneLine(r1.out)}`
			return out
		}
		if (r1.code === 0) {
			out.reason = "no_fail_at_parent"
			out.detail = `parent+oracle run passed (${s1.passed} passed)`
			return out
		}
		out.fail_mode = failMode(r1, s1)
		// F1: only an assertion-level failure with at least one failing test
		// and at least one collected test can validate.
		if (out.fail_mode !== "assertion" || s1.failed < 1 || s1.total < 1) {
			out.reason = "parent_fail_not_assertion"
			out.detail = `parent+oracle fail_mode=${out.fail_mode}, failed=${s1.failed}, total=${s1.total}`
			return out
		}

		// F2: rerun ONLY the parent+oracle step and reject if the two runs disagree.
		const {res: r1b, sum: s1b} = await runSuite(cfg, runPaths, dir)
		out.timings.parent2Ms = r1b.ms
		out.parent_oracle_run_2 = runTuple(r1b, s1b)
		out.run_tails.parent_oracle_2 = tail(r1b.out)
		if (r1b.killed) {
			out.reason = "timeout"
			out.detail = `second parent+oracle run exceeded ${cfg.testTimeoutMs}ms`
			return out
		}
		if (!s1b.parsed) {
			out.reason = "unparseable_test_output"
			out.detail = `second parent+oracle output not parseable: ${oneLine(r1b.out)}`
			return out
		}
		if (!sameRun(out.parent_oracle_run, out.parent_oracle_run_2)) {
			out.reason = "flaky"
			out.detail = `parent+oracle runs disagree: ${JSON.stringify(out.parent_oracle_run)} vs ${JSON.stringify(
				out.parent_oracle_run_2
			)}`
			return out
		}

		const co2 = await git(dir, ["checkout", "-f", "-q", cand.sha])
		if (co2.code !== 0)
			return gitError(out, `checkout fix commit failed (code ${co2.code}): ${oneLine(co2.out)}`)
		const cl2 = await git(dir, ["clean", "-fdq"])
		if (cl2.code !== 0) return gitError(out, `clean fix commit failed (code ${cl2.code}): ${oneLine(cl2.out)}`)
		const exist2 = cand.test_paths.filter(
			p => isRunnableTest(p, cfg) && fs.existsSync(path.join(dir, p))
		)
		if (!exist2.length) {
			out.reason = "no_pass_at_fix"
			out.detail = "no test files remain at the fix commit"
			return out
		}

		const {res: r2, sum: s2} = await runSuite(cfg, exist2, dir)
		out.timings.fixMs = r2.ms
		out.fix_run = runTuple(r2, s2)
		out.run_tails.fix = tail(r2.out)
		if (r2.killed) {
			out.reason = "timeout"
			out.detail = `fix run exceeded ${cfg.testTimeoutMs}ms`
			return out
		}
		if (!s2.parsed) {
			out.reason = "unparseable_test_output"
			out.detail = `fix output not parseable: ${oneLine(r2.out)}`
			return out
		}
		if (r2.code !== 0) {
			out.reason = "no_pass_at_fix"
			out.detail = `fix run failed: exit ${normalizeExit(r2.code)}, ${s2.failed} failed / ${s2.passed} passed`
			return out
		}
		if (s2.total < 1) {
			out.reason = "zero_tests_collected"
			out.detail = "fix run collected zero tests"
			return out
		}
		if (s2.failed > 0) {
			out.reason = "no_pass_at_fix"
			out.detail = `fix run reported ${s2.failed} failing tests with exit 0`
			return out
		}
		out.validated = true
		out.reason = "validated"
		return out
	} catch (err) {
		out.reason = "error"
		out.detail = String(err && err.message).slice(0, 300)
		return out
	} finally {
		out.timings = out.timings || {}
		out.timings.totalMs = Date.now() - t0
		try {
			fs.unlinkSync(tmp)
		} catch {}
	}
}

// ---------------------------------------------------------------- stage 3/4

function buildReport(name, cfg, h, results, meta, deferred = [], skipped = []) {
	const {nonMergeInWindow, candidates, rejected} = h
	const validated = results.filter(r => r.validated)
	const attempted = results.length
	const reasons = {}
	for (const r of rejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1
	for (const r of results) {
		if (!r.validated) reasons[r.reason] = (reasons[r.reason] || 0) + 1
	}
	// Skipped candidates are written to rejected.jsonl alongside pre-validation
	// rejections, so the report must tally them too or the two disagree.
	for (const r of skipped) reasons[r.reason] = (reasons[r.reason] || 0) + 1
	const {semantic, artifacts} = splitOutcomes(reasons)
	const sizes = validated.map(v => v.diffstat)
	const per100 = nonMergeInWindow ? (validated.length / nonMergeInWindow) * 100 : 0
	const postTotal = meta.postCutoffCommits
	const postValidated = validated.filter(v => v.post_cutoff).length
	const per100Post = postTotal ? (postValidated / postTotal) * 100 : 0
	const effCand = attempted ? (validated.length / attempted) * 100 : 0
	const meanSec = attempted ? meta.timings.reduce((a, b) => a + b, 0) / attempted / 1000 : 0

	// Change A: derived task mix over validated tasks.
	const tax = validated.map(v => v.taxonomy || deriveTaxonomy(v))
	const tally = key => {
		const m = {}
		for (const t of tax) m[t[key]] = (m[t[key]] || 0) + 1
		return m
	}
	const catCounts = tally("category")
	const sizeCounts = tally("size_bucket")
	const deltaCounts = tally("test_delta")
	const subCounts = tax.map(t => t.subsystem_count).sort((a, b) => a - b)
	const multiSub = tax.filter(t => t.subsystem_count > 1).length
	const deferredLines = deferred.filter(d => d.deferred_for === "lines").length
	const deferredFiles = deferred.filter(d => d.deferred_for === "files").length
	const deferredBoth = deferred.filter(d => d.deferred_for === "lines+files").length

	const L = []
	L.push(`# Historic replay harvest — ${name}`)
	L.push("")
	L.push(`- repo: ${cfg.url}`)
	L.push(`- window: commits since ${SINCE} (non-merge)`)
	L.push(`- post-cutoff slice: commit date >= ${POST_CUTOFF}`)
	L.push(`- generated: ${new Date().toISOString()}`)
	L.push(`- resolved HEAD: ${meta.headSha}`)
	L.push(`- origin fetched at: ${meta.fetchedAt}`)
	L.push(`- partial run: ${meta.partial ? `YES — ${meta.partial}` : "no"}`)
	L.push("")
	L.push("## Headline")
	L.push("")
	L.push("| metric | value |")
	L.push("| --- | --- |")
	L.push(`| non-merge commits in window | ${nonMergeInWindow} |`)
	L.push(`| candidates found | ${candidates.length} |`)
	L.push(`| candidates validation-attempted | ${attempted} |`)
	L.push(`| **validated tasks** | **${validated.length}** |`)
	L.push(`| **validated tasks / 100 commits in window** | **${per100.toFixed(1)}** |`)
	L.push(
		`| **validated tasks / 100 post-cutoff commits** (${postValidated}/${postTotal}) | **${per100Post.toFixed(
			1
		)}** |`
	)
	L.push(`| validated / 100 attempted candidates | ${effCand.toFixed(1)} |`)
	L.push("")
	L.push(
		`**Deferred (horizon-shaped):** ${deferred.length} \`too_large\` commit(s) parked in \`deferred.jsonl\` ` +
			`(${deferredLines} for line count, ${deferredFiles} for file count${deferredBoth ? `, ${deferredBoth} for both` : ""}). ` +
			"These are the long-horizon-shaped commits that the anti-gaming size filter discards, kept as a seed corpus. " +
			"`deferred.jsonl` is a projection, not a separate rejection bucket: each commit is counted exactly once in " +
			"`rejected.jsonl` (reason `too_large`, shown in the semantic breakdown) and enumerated once here."
	)
	L.push("")
	L.push("## Efficiency")
	L.push("")
	L.push("| metric | value |")
	L.push("| --- | --- |")
	L.push(`| mean seconds per candidate validated | ${meanSec.toFixed(1)}s |`)
	L.push(`| total validation time | ${(meta.timings.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s |`)
	L.push(`| harvest time | ${(meta.harvestMs / 1000).toFixed(1)}s |`)
	L.push(`| setup (clone+install) time | ${(meta.setupMs / 1000).toFixed(1)}s |`)
	L.push(`| total wall-clock | ${(meta.wallMs / 1000).toFixed(1)}s (${(meta.wallMs / 60000).toFixed(1)} min) |`)
	L.push("")
	L.push("## Outcome breakdown — semantic")
	L.push("")
	L.push("| outcome | count |")
	L.push("| --- | --- |")
	for (const [k, v] of Object.entries(semantic).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
	L.push(`| validated | ${validated.length} |`)
	L.push("")
	L.push("## Measurement artifacts — excluded from the semantic breakdown")
	L.push("")
	L.push("These codes describe run mechanics, not validation outcomes. They are pulled out of the semantic table above:")
	L.push("")
	L.push("| artifact code | count |")
	L.push("| --- | --- |")
	for (const k of [...MEASUREMENT_ARTIFACTS].sort()) L.push(`| ${k} | ${artifacts[k] || 0} |`)
	L.push("")
	L.push(`- Semantic bucket codes: ${Object.keys(semantic).sort().map(c => `\`${c}\``).join(", ") || "(none)"}, plus \`validated\`.`)
	L.push(`- Measurement-artifact codes: ${[...MEASUREMENT_ARTIFACTS].sort().map(c => `\`${c}\``).join(", ")}.`)
	L.push("")
	L.push("Reason codes from the spec: `non_behavioral_subject`, `too_large`, `no_source`, `version_bump`,")
	L.push("`oracle_apply_failed`, `no_fail_at_parent`, `no_pass_at_fix`, `timeout`.")
	L.push("")
	L.push("Added codes (documented extensions, so nothing is dropped silently): `no_tests` (commit changed source")
	L.push("but no test file, or only support files, so it is not even a candidate), `oracle_not_runnable` (test-file")
	L.push("diff applied but the pinned test runner collects no tests for those paths, e.g. a pre-Vitest commit),")
	L.push("`error` (unexpected exception), `not_attempted_cap` / `not_attempted_budget` (run cap or wall-clock budget")
	L.push("reached).")
	L.push("")
	L.push("Assertion-level validation codes: `pre_existing_failure` (clean parent control was already red),")
	L.push("`pre_existing_test_not_runnable` (an oracle test path exists at the parent but the pinned runner cannot")
	L.push("run it, so the control cannot be skipped), `parent_fail_not_assertion` (parent+oracle was not an")
	L.push("assertion-level failure with >=1 failing test), `zero_tests_collected` (a run exited 0 but executed no")
	L.push("tests), `unparseable_test_output` (runner output could not be parsed into pass/fail counts), `flaky`")
	L.push("(the two parent+oracle runs disagreed).")
	L.push("")
	L.push("Infra codes: `infra_only` (commit changed only test infra), `touches_test_infra` (commit changed test")
	L.push("infra alongside real source). Git codes: `git_error` (a git command failed; the offending operation is")
	L.push("recorded in `detail`), `empty_patch` (the final diff was empty).")
	L.push("")
	L.push("No silent drops: every pre-validation commit appears in `rejected.jsonl` with a reason, every attempted")
	L.push("candidate appears in either `tasks.jsonl` (validated) or `rejected.jsonl` (its validation reason), every")
	L.push("`too_large` commit is additionally parked in `deferred.jsonl`, and any git failure is either fatal")
	L.push("(clone/fetch/checkout/log at setup) or recorded as `git_error`.")
	L.push("")
	L.push("## Task mix (validated tasks)")
	L.push("")
	L.push("`category` is derived mechanically from the commit subject and diff — never hand-labeled and never")
	L.push("LLM-labeled (`category_source` records `prefix` / `heuristic` / `unknown`), so the mix stays un-gameable.")
	L.push("")
	L.push("Category counts:")
	L.push("")
	L.push("| category | count |")
	L.push("| --- | --- |")
	for (const k of ["security", "perf", "refactor", "feature", "bugfix", "unknown"]) L.push(`| ${k} | ${catCounts[k] || 0} |`)
	L.push("")
	L.push("Size bucket (total changed lines; XS <=10, S <=50, M <=150, L <=400, XL >400):")
	L.push("")
	L.push("| size_bucket | count |")
	L.push("| --- | --- |")
	for (const k of ["XS", "S", "M", "L", "XL"]) L.push(`| ${k} | ${sizeCounts[k] || 0} |`)
	L.push("")
	L.push("Test delta (oracle test files):")
	L.push("")
	L.push("| test_delta | count |")
	L.push("| --- | --- |")
	for (const k of ["new-test-file", "modified-test", "mixed"]) L.push(`| ${k} | ${deltaCounts[k] || 0} |`)
	L.push("")
	L.push("Subsystem spread (distinct directory prefixes of changed source paths):")
	L.push("")
	L.push("| metric | min | median | max | tasks touching >1 subsystem |")
	L.push("| --- | --- | --- | --- | --- |")
	L.push(
		`| subsystem_count | ${subCounts[0] ?? "-"} | ${median(subCounts) ?? "-"} | ${
			subCounts[subCounts.length - 1] ?? "-"
		} | ${multiSub} |`
	)
	L.push("")
	L.push("## Fail mode at parent (validated tasks)")
	L.push("")
	const fm = {}
	for (const v of validated) fm[v.fail_mode] = (fm[v.fail_mode] || 0) + 1
	L.push("| fail_mode | count |")
	L.push("| --- | --- |")
	for (const [k, v] of Object.entries(fm).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`)
	L.push("")
	L.push("## Evidence invariant (machine-checkable from tasks.jsonl)")
	L.push("")
	L.push("Every validated task records the run tuples `{exit, passed, failed, total}`. There are two honest forms.")
	L.push("")
	L.push("Normal form — the clean-parent control actually executed:")
	L.push("")
	L.push("```")
	L.push("parent_clean_run.exit == 0 && parent_clean_run.failed == 0")
	L.push("```")
	L.push("")
	L.push("Skipped form — every oracle test path is git-verified absent at the parent, so there was no copy to")
	L.push("control (this never claims a green control run that did not happen):")
	L.push("")
	L.push("```")
	L.push("parent_clean_run.skipped == true")
	L.push('parent_clean_run.reason == "oracle_files_absent_at_parent"')
	L.push('oracle_files_status has >= 1 entry, and EVERY entry has status "A"')
	L.push("```")
	L.push("")
	L.push("A renamed oracle file (`status: \"R\"`, with `old_path`) is NOT new: its content existed at the parent")
	L.push("under `old_path`, so the control runs against that old path and the skipped form is unavailable. A path")
	L.push("that exists at the parent but cannot be run by the pinned runner is rejected as")
	L.push("`pre_existing_test_not_runnable`, never skipped.")
	L.push("")
	L.push("Both forms additionally require:")
	L.push("")
	L.push("```")
	L.push("parent_oracle_run.exit != 0 && parent_oracle_run.failed >= 1 && parent_oracle_run.total >= 1")
	L.push("fix_run.exit == 0 && fix_run.failed == 0 && fix_run.total >= 1")
	L.push("```")
	L.push("")
	L.push("Verify both forms and require zero violations:")
	L.push("")
	L.push("```sh")
	L.push("jq -s '")
	L.push("  def ok:")
	L.push("    (((.parent_clean_run.skipped == true)")
	L.push('      and (.parent_clean_run.reason == "oracle_files_absent_at_parent")')
	L.push("      and ([.oracle_files_status[]?] | length >= 1)")
	L.push('      and ([.oracle_files_status[]? | select(.status != "A")] | length == 0))')
	L.push("     or ((.parent_clean_run.skipped != true)")
	L.push("      and (.parent_clean_run.exit == 0)")
	L.push("      and (.parent_clean_run.failed == 0)))")
	L.push("    and (.parent_oracle_run.exit != 0)")
	L.push("    and (.parent_oracle_run.failed >= 1)")
	L.push("    and (.parent_oracle_run.total >= 1)")
	L.push("    and (.fix_run.exit == 0)")
	L.push("    and (.fix_run.failed == 0)")
	L.push("    and (.fix_run.total >= 1);")
	L.push("  { total: length, violations: ([.[] | select(ok | not)] | length) }' out/<repo>/tasks.jsonl")
	L.push("```")
	L.push("")
	L.push("## Machine-checkable accounting")
	L.push("")
	L.push("`tasks + rejected == window`, and each deferred commit appears exactly once in `deferred.jsonl` and once")
	L.push("in `rejected.jsonl` (reason `too_large`), so it is never double-counted:")
	L.push("")
	L.push("```sh")
	L.push(
		`test "$(( $(wc -l < out/${name}/tasks.jsonl) + $(wc -l < out/${name}/rejected.jsonl) ))" = "$(git -C work/${name} log --since=${SINCE} --no-merges --pretty=%H | wc -l)"`
	)
	L.push(
		`diff <(jq -r .sha out/${name}/deferred.jsonl | sort) <(jq -r 'select(.reason=="too_large") | .sha' out/${name}/rejected.jsonl | sort)`
	)
	L.push("```")
	L.push("")
	L.push("Semantic vs measurement-artifact rejection split (semantic bucket = everything not in the artifact set):")
	L.push("")
	L.push("```sh")
	L.push(
		`jq -r .reason out/${name}/rejected.jsonl | sort | uniq -c | awk '{ if ($2=="version_bump" || $2=="not_attempted_cap" || $2=="not_attempted_budget") print "ARTIFACT", $0; else print "SEMANTIC ", $0 }'`
	)
	L.push("```")
	L.push("")
	L.push("## Size distribution of validated tasks")
	L.push("")
	L.push("| metric | min | median | max |")
	L.push("| --- | --- | --- | --- |")
	const col = k => sizes.map(s => s[k]).sort((a, b) => a - b)
	const files = col("files")
	const lines = col("lines")
	const added = col("added")
	L.push(
		`| files touched | ${files[0] ?? "-"} | ${median(files) ?? "-"} | ${files[files.length - 1] ?? "-"} |`
	)
	L.push(
		`| lines changed | ${lines[0] ?? "-"} | ${median(lines) ?? "-"} | ${lines[lines.length - 1] ?? "-"} |`
	)
	L.push(`| lines added | ${added[0] ?? "-"} | ${median(added) ?? "-"} | ${added[added.length - 1] ?? "-"} |`)
	L.push("")
	L.push("## Validated tasks")
	L.push("")
	L.push("| sha | date | post_cutoff | fail_mode | category | size_bucket | test_delta | files | lines | subject |")
	L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
	validated.forEach((v, i) =>
		L.push(
			`| ${v.sha.slice(0, 10)} | ${v.date.slice(0, 10)} | ${v.post_cutoff} | ${v.fail_mode} | ${tax[i].category} | ${tax[i].size_bucket} | ${tax[i].test_delta} | ${v.diffstat.files} | ${v.diffstat.lines} | ${v.subject.replace(/\|/g, "\\|")} |`
		)
	)
	L.push("")
	return L.join("\n")
}

// ---------------------------------------------------------------- main

function withTestOverride(cfg) {
	const cmd = process.env.SPIKE_TEST_CMD
	if (!cmd) return cfg
	let fixedArgs = []
	if (process.env.SPIKE_TEST_ARGS) {
		try {
			fixedArgs = JSON.parse(process.env.SPIKE_TEST_ARGS)
		} catch {
			throw new Error("SPIKE_TEST_ARGS must be a JSON array")
		}
	}
	return {...cfg, reporter: null, testCmd: cmd, testArgs: files => [...fixedArgs, ...files]}
}

async function main() {
	const name = process.argv[2]
	if (!REPOS[name]) throw new Error(`unknown repo "${name}". known: ${Object.keys(REPOS).join(", ")}`)
	const cfg = withTestOverride(REPOS[name])
	const argMax = process.argv.find(a => a.startsWith("--max="))
	const argBudget = process.argv.find(a => a.startsWith("--budget="))
	const argMaxFiles = process.argv.find(a => a.startsWith("--max-files="))
	const argMaxLines = process.argv.find(a => a.startsWith("--max-lines="))
	const argOut = process.argv.find(a => a.startsWith("--out="))
	const maxCandidates = argMax ? +argMax.split("=")[1] : DEFAULT_MAX_CANDIDATES
	const budgetMs = argBudget ? +argBudget.split("=")[1] * 60_000 : DEFAULT_BUDGET_MS
	if (argMaxFiles) MAX_FILES = +argMaxFiles.split("=")[1]
	if (argMaxLines) MAX_LINES = +argMaxLines.split("=")[1]
	console.log(`[cfg] size filter: >${MAX_FILES} files or >${MAX_LINES} lines is deferred`)

	const wall0 = Date.now()
	// Overridable so the corpus can be probed into a scratch directory without
	// overwriting the committed one (a run writes tasks.jsonl unconditionally).
	const outDir = argOut ? path.resolve(argOut.split("=")[1]) : path.join(OUT, name)
	// F7: clear stale patches from previous runs before writing new ones.
	fs.rmSync(path.join(outDir, "patches"), {recursive: true, force: true})
	fs.mkdirSync(path.join(outDir, "patches"), {recursive: true})

	const setup0 = Date.now()
	const {dir, branch, headSha, fetchedAt} = await prepare(name, cfg)
	const setupMs = Date.now() - setup0

	const h0 = Date.now()
	const coBranch = await git(dir, ["checkout", "-f", "-q", branch])
	if (coBranch.code !== 0) throw new Error(`checkout ${branch} failed (code ${coBranch.code}):\n${tail(coBranch.out)}`)
	const clBranch = await git(dir, ["clean", "-fdq"])
	if (clBranch.code !== 0) throw new Error(`clean before harvest failed (code ${clBranch.code}):\n${tail(clBranch.out)}`)
	const h = await harvest(dir, branch, cfg)
	const harvestMs = Date.now() - h0

	const fullCommits = await git(dir, [
		"log",
		branch,
		`--since=${SINCE}`,
		"--no-merges",
		"--pretty=format:%H%x1f%cI"
	])
	if (fullCommits.code !== 0)
		throw new Error(`git log (full window) failed (code ${fullCommits.code}):\n${tail(fullCommits.out)}`)
	const allDates = fullCommits.out
		.split("\n")
		.map(l => l.split("\x1f")[1])
		.filter(Boolean)
	const postCutoffAll = allDates.filter(d => d.slice(0, 10) >= POST_CUTOFF).length

	console.log(
		`[stage1] ${h.nonMergeInWindow} non-merge commits in window, ${postCutoffAll} post-cutoff, ${h.candidates.length} candidates, ${h.rejected.length} rejected pre-validation`
	)

	const todo = h.candidates.slice(0, maxCandidates)
	const skipped = h.candidates.slice(maxCandidates).map(c => ({
		sha: c.sha,
		date: c.date,
		subject: c.subject,
		reason: "not_attempted_cap",
		detail: `candidate cap of ${maxCandidates} reached`
	}))

	const results = []
	const timings = []
	let partial = ""
	for (let i = 0; i < todo.length; i++) {
		if (Date.now() - wall0 > budgetMs) {
			partial = `global wall-clock budget of ${(budgetMs / 60000).toFixed(1)} min hit after ${i}/${todo.length} candidates`
			for (const c of todo.slice(i))
				skipped.push({
					sha: c.sha,
					date: c.date,
					subject: c.subject,
					reason: "not_attempted_budget",
					detail: partial
				})
			break
		}
		const c = todo[i]
		const r = await validate(dir, cfg, c)
		timings.push(r.timings.totalMs)
		results.push(r)
		console.log(
			`[stage2] ${i + 1}/${todo.length} ${c.sha.slice(0, 8)} ${r.validated ? "VALIDATED" : r.reason} (${(r.timings.totalMs / 1000).toFixed(1)}s) ${c.subject.slice(0, 60)}`
		)
	}

	// Artifacts. Generate patches first: a failed or empty final diff must never
	// be written as a patch, so demote such a task to a rejection (F5).
	const validated = []
	for (const v of results.filter(r => r.validated)) {
		const p = await git(dir, ["diff", "--binary", `${v.sha}^`, v.sha])
		if (p.code !== 0) {
			v.validated = false
			v.reason = "git_error"
			v.detail = `final diff failed (code ${p.code}): ${tail(p.out, 3).replace(/\n/g, " | ")}`
			continue
		}
		if (!p.out.trim()) {
			v.validated = false
			v.reason = "empty_patch"
			v.detail = "final diff produced an empty patch"
			continue
		}
		fs.writeFileSync(path.join(outDir, "patches", `${v.sha}.patch`), p.out)
		validated.push(v)
	}
	for (const v of validated) v.taxonomy = deriveTaxonomy(v)

	// Change A: park the horizon-shaped (`too_large`) commits instead of silently
	// discarding them. Each stays in rejected.jsonl as `too_large` as well, so it
	// is counted exactly once in the accounting and never double-counted.
	const deferred = h.rejected.filter(r => r.reason === "too_large")
	fs.writeFileSync(
		path.join(outDir, "deferred.jsonl"),
		deferred.length
			? deferred
					.map(r =>
						JSON.stringify({
							sha: r.sha,
							date: r.date,
							subject: r.subject,
							files: r.files,
							lines: r.lines,
							deferred_for: r.deferred_for,
							why_deferred: `exceeds ${MAX_FILES} files / ${MAX_LINES} lines (${r.detail})`
						})
					)
					.join("\n") + "\n"
			: ""
	)

	fs.writeFileSync(
		path.join(outDir, "tasks.jsonl"),
		validated
			.map(r =>
				JSON.stringify({
					sha: r.sha,
					parent: r.parent,
					parent_sha: r.parent_sha,
					date: r.date,
					post_cutoff: r.post_cutoff,
					subject: r.subject,
					message_body: r.message_body,
					test_paths: r.test_paths,
					oracle_files_status: r.oracle_files_status || [],
					support_paths: r.support_paths || [],
					source_paths: r.source_paths,
					diffstat: r.diffstat,
					...r.taxonomy,
					fail_mode: r.fail_mode,
					timings: r.timings,
					patch: `patches/${r.sha}.patch`,
					parent_clean_run: r.parent_clean_run,
					parent_oracle_run: r.parent_oracle_run,
					parent_oracle_run_2: r.parent_oracle_run_2,
					fix_run: r.fix_run,
					run_tails: {
						parent_clean: tail(r.run_tails.parent_clean || "", 12),
						parent_oracle: tail(r.run_tails.parent_oracle || "", 12),
						parent_oracle_2: tail(r.run_tails.parent_oracle_2 || "", 12),
						fix: tail(r.run_tails.fix || "", 12)
					}
				})
			)
			.join("\n") + "\n"
	)

	const runFields = r => ({
		parent_clean_run: r.parent_clean_run || null,
		parent_oracle_run: r.parent_oracle_run || null,
		parent_oracle_run_2: r.parent_oracle_run_2 || null,
		fix_run: r.fix_run || null
	})
	const rejectedLines = [
		...h.rejected.map(r => JSON.stringify(r)),
		...results
			.filter(r => !r.validated)
			.map(r =>
				JSON.stringify({
					sha: r.sha,
					date: r.date,
					subject: r.subject,
					reason: r.reason,
					detail: r.detail,
					test_paths: r.test_paths,
					oracle_files_status: r.oracle_files_status || null,
					support_paths: r.support_paths || [],
					source_paths: r.source_paths,
					infra_paths: r.infra_paths || [],
					fail_mode: r.fail_mode || null,
					...runFields(r)
				})
			),
		...skipped.map(s => JSON.stringify(s))
	]
	fs.writeFileSync(path.join(outDir, "rejected.jsonl"), rejectedLines.join("\n") + "\n")

	// Leave the work clone on a known branch. A checkout failure here is fatal
	// (F5); artifacts are already on disk.
	const restore = await git(dir, ["checkout", "-f", "-q", branch])
	if (restore.code !== 0) throw new Error(`final checkout ${branch} failed (code ${restore.code}):\n${tail(restore.out)}`)
	const cleanRestore = await git(dir, ["clean", "-fdq"])
	if (cleanRestore.code !== 0)
		throw new Error(`final clean failed (code ${cleanRestore.code}):\n${tail(cleanRestore.out)}`)

	const meta = {
		partial,
		harvestMs,
		setupMs,
		timings,
		wallMs: Date.now() - wall0,
		postCutoffCommits: postCutoffAll,
		headSha,
		fetchedAt
	}
	fs.writeFileSync(path.join(outDir, "report.md"), buildReport(name, cfg, h, results, meta, deferred, skipped))

	console.log(
		`\n[done] validated=${validated.length}/${results.length} attempted | ${(meta.wallMs / 1000).toFixed(1)}s wall-clock`
	)
	console.log(`[done] artifacts in ${outDir}`)
}

const thisFile = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)
if (invokedDirectly) {
	main().catch(err => {
		console.error(`FATAL: ${err.message}`)
		process.exit(1)
	})
}

export {
	classify,
	isRunnableTest,
	LANG_RULES,
	summarize,
	failMode,
	resolveDefaultBranch,
	harvest,
	validate,
	prepare,
	REPOS,
	categoryOf,
	sizeBucketOf,
	subsystemOf,
	subsystemsOf,
	testDeltaOf,
	deriveTaxonomy,
	splitOutcomes,
	MEASUREMENT_ARTIFACTS
}
