import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {EVIDENCE_DIR, REPOS, isInfraPath, isTestPath} from "../harness/registry.mjs"
import {getReporter, statusMap} from "../harness/reporters.mjs"
import {makeRuntime} from "../harness/runtime.mjs"

const WEAKEN_RE = /\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\(/

function git(dir, args) {
	const r = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024
	})
	return {code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error || null}
}

function gitOrThrow(dir, args) {
	const r = git(dir, args)
	if (r.error) throw r.error
	if (r.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`)
	}
	return r.stdout
}

// The dependency directory (node_modules, .venv, target) is injected into the
// worktree and must survive `git clean`; never pass -x (contracts.md).
function cleanExcludes(repo) {
	const deps = REPOS[repo]?.deps
	const list = new Set(["node_modules", ...(deps ? [deps] : [])])
	return [...list].flatMap(d => ["-e", d])
}

function testFiles(task) {
	return Array.isArray(task.test_paths) ? task.test_paths : []
}

function oraclePaths(task) {
	return [...(task.test_paths || []), ...(task.support_paths || [])]
}

function restoreFrom(dir, sha, paths) {
	if (!paths.length) return []
	const present = paths.filter(p => git(dir, ["cat-file", "-e", `${sha}:${p}`]).code === 0)
	for (const p of paths) {
		if (present.includes(p)) continue
		const abs = path.join(dir, p)
		if (fs.existsSync(abs)) fs.rmSync(abs, {force: true})
	}
	if (present.length) gitOrThrow(dir, ["checkout", sha, "--", ...present])
	return paths.slice()
}

function oraclePatch(repo, task, dir) {
	const paths = oraclePaths(task)
	if (paths.length === 0) return ""
	return gitOrThrow(dir, ["diff", task.parent_sha, task.sha, "--", ...paths])
}

function unquote(p) {
	if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
		try {
			return JSON.parse(p)
		} catch {
			return p.slice(1, -1)
		}
	}
	return p
}

function splitPaths(s) {
	const out = []
	let i = 0
	const n = s.length
	while (i < n) {
		while (i < n && s[i] === " ") i++
		if (i >= n) break
		if (s[i] === '"') {
			let j = i + 1
			let buf = ""
			while (j < n) {
				if (s[j] === "\\") {
					buf += s[j] + (s[j + 1] ?? "")
					j += 2
					continue
				}
				if (s[j] === '"') break
				buf += s[j]
				j++
			}
			out.push('"' + buf + '"')
			i = j + 1
		} else {
			let j = i
			while (j < n && s[j] !== " ") j++
			out.push(s.slice(i, j))
			i = j
		}
	}
	return out
}

const stripA = p => (p.startsWith("a/") ? p.slice(2) : p)
const stripB = p => (p.startsWith("b/") ? p.slice(2) : p)

function parsePatch(text) {
	const files = []
	let binary = false
	let cur = null
	const finish = () => {
		if (cur) {
			files.push(cur)
			cur = null
		}
	}
	for (const raw of text.split("\n")) {
		if (raw.includes("GIT binary patch")) binary = true
		if (raw.startsWith("diff --git ")) {
			finish()
			cur = {path: null, old: null, new: null, deleted: false, added: []}
			const parts = splitPaths(raw.slice("diff --git ".length))
			if (parts.length >= 2) {
				cur.old = stripA(unquote(parts[0]))
				cur.new = stripB(unquote(parts[1]))
				cur.path = cur.new || cur.old
			}
			continue
		}
		if (!cur) continue
		if (raw.startsWith("deleted file mode")) {
			cur.deleted = true
			continue
		}
		if (raw.startsWith("--- ")) {
			const p = unquote(raw.slice(4).split("\t")[0])
			cur.old = p === "/dev/null" ? null : stripA(p)
			continue
		}
		if (raw.startsWith("+++ ")) {
			const p = unquote(raw.slice(4).split("\t")[0])
			cur.new = p === "/dev/null" ? null : stripB(p)
			cur.path = cur.new || cur.old
			if (p === "/dev/null" && cur.old) cur.deleted = true
			continue
		}
		if (raw.startsWith("+") && !raw.startsWith("+++")) {
			cur.added.push(raw.slice(1))
		}
	}
	finish()
	const touched = new Set()
	const deletions = []
	const addedLines = new Map()
	for (const f of files) {
		if (f.old) touched.add(f.old)
		if (f.new) touched.add(f.new)
		if (f.path && f.deleted) deletions.push(f.path)
		if (f.path && f.added.length) addedLines.set(f.path, f.added)
	}
	return {files, touched: [...touched], deletions, addedLines, binary}
}

function isPatchEmpty(text, parsed) {
	return text.trim() === "" || parsed.files.length === 0
}

const detectTamper = (parsed, task) => {
	const oracle = new Set(oraclePaths(task))
	const findings = []
	const seen = new Set()
	// `fatal` means the damage cannot be neutralised by rebuilding the grading
	// environment. Edits to tests, support files or test config are recoverable
	// (they are restored from the oracle before grading), so they are recorded
	// but not fatal: an agent adding its own test is normal, not cheating.
	const add = (kind, p, fatal) => {
		const key = `${kind}\u0000${p ?? ""}`
		if (seen.has(key)) return
		seen.add(key)
		findings.push({kind, path: p ?? null, fatal: fatal === true})
	}
	for (const p of parsed.touched) {
		if (path.isAbsolute(p) || p.includes("..")) add("touches_outside_repo", p, true)
		if (oracle.has(p)) add("modifies_oracle_test", p, false)
		if (isInfraPath(p)) add("modifies_test_infra", p, false)
	}
	for (const p of parsed.deletions) {
		if (isTestPath(p)) add("deletes_test_file", p, false)
	}
	for (const [p, lines] of parsed.addedLines) {
		if (!isTestPath(p)) continue
		if (lines.some(l => WEAKEN_RE.test(l))) add("weakens_assertions", p, false)
	}
	if (parsed.binary) add("binary_patch", null, true)
	return {clean: !findings.some(f => f.fatal), findings}
}

function applyPatch(dir, text) {
	if (!text.trim()) return {ok: false, stderr: "empty patch"}
	const tmp = path.join(os.tmpdir(), `eval-apply-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
	fs.writeFileSync(tmp, text)
	const first = git(dir, ["apply", "--whitespace=nowarn", tmp])
	if (first.code === 0) return {ok: true, method: "apply"}
	const three = git(dir, ["apply", "--3way", "--whitespace=nowarn", tmp])
	if (three.code === 0) return {ok: true, method: "3way"}
	return {ok: false, method: "apply", stderr: three.stderr || first.stderr || "git apply failed"}
}

// Test execution goes through the runtime (host process or pinned container)
// and report parsing through the repo's declared reporter. The result carries
// `report` (parsed per-test statuses, or null when no machine-readable report
// was produced) alongside the raw process outcome.
async function runTests(repo, task, dir, opts) {
	const spec = REPOS[repo]
	if (!spec) throw new Error(`unknown repo: ${repo}`)
	const reporter = getReporter(spec.reporter)
	const runtime = opts.runtime ?? makeRuntime(spec, opts.runtimeMode ? {mode: opts.runtimeMode} : {})
	const files = testFiles(task)
	const scratch = runtime.scratch()
	const hostOut = path.join(scratch.host, "report.json")
	const guestOut = path.posix.join(scratch.guest, "report.json")
	const args = [...spec.testArgs(files), ...reporter.args(files, guestOut)]
	const timeoutMs = opts.testTimeoutMs ?? spec.testTimeoutMs ?? 120_000
	const run = await runtime.exec(spec.testCmd, args, {cwd: dir, timeoutMs, env: opts.env, scratch})
	let text = null
	try {
		if (reporter.source === "outFile") text = fs.readFileSync(hostOut, "utf8")
		else if (reporter.source === "stdout") text = run.stdout
		else if (reporter.source === "cwdFile") text = fs.readFileSync(reporter.locate(dir), "utf8")
	} catch {
		text = null
	}
	try {
		fs.rmSync(scratch.host, {recursive: true, force: true})
	} catch {}
	const report = text == null ? null : reporter.parse(text)
	return {...run, report}
}

const reportCounts = report => ({passed: report?.passed ?? 0, failed: report?.failed ?? 0, total: report?.total ?? 0})

export async function baseline({repo, task, dir, opts = {}}) {
	if (!REPOS[repo]) throw new Error(`unknown repo: ${repo}`)
	const t0 = performance.now()
	const cacheDir = opts.cacheDir ?? path.join(EVIDENCE_DIR, "baseline", repo)
	const cacheFile = path.join(cacheDir, `${task.sha}.json`)
	if (!opts.refresh && !opts.noCache) {
		try {
			const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
			if (cached.sha === task.sha) return cached
		} catch {}
	}

	const oracle = oraclePatch(repo, task, dir)
	gitOrThrow(dir, ["checkout", "-f", task.parent_sha])
	gitOrThrow(dir, ["clean", "-fd", ...cleanExcludes(repo)])
	const injected = applyPatch(dir, oracle)
	if (!injected.ok) {
		throw new Error(`oracle patch failed to apply: ${(injected.stderr || "").trim()}`)
	}

	const run = await runTests(repo, task, dir, opts)
	const report = run.report
	if (!report) {
		throw new Error(`no per-test report from ${repo} (${REPOS[repo].reporter ?? "vitest-json"}, exit ${run.code}); refusing to degrade to counts`)
	}
	const statuses = statusMap(report)
	const failed = []
	const passed = []
	for (const [name, status] of statuses) {
		if (status === "failed") failed.push(name)
		else if (status === "passed") passed.push(name)
	}
	failed.sort()
	passed.sort()
	const counts = reportCounts(report)
	const result = {
		sha: task.sha,
		parent_sha: task.parent_sha,
		ran_at: new Date().toISOString(),
		f2p: failed,
		p2p: passed,
		raw: {exit: run.code, passed: counts.passed, failed: counts.failed, total: counts.total},
		test_files: testFiles(task),
		timing_ms: Math.round(performance.now() - t0)
	}
	if (!opts.noCache) {
		fs.mkdirSync(cacheDir, {recursive: true})
		fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2))
	}
	return result
}

function pickReason(result, timedOut, testsRan) {
	if (result.patch.error) return "patch_apply_failed"
	if (result.patch.empty) return "empty_patch"
	if (!result.tamper.clean) return "tamper_detected"
	if (timedOut) return "test_timeout"
	if (!testsRan || result.f2p.required < 1) return "no_tests_ran"
	if (result.f2p.passed < result.f2p.required) return "f2p_failed"
	if (result.p2p.passed < result.p2p.required) return "p2p_regression"
	return "resolved"
}

export async function evaluate({repo, task, candidatePatch, dir, baseline: base, opts = {}}) {
	const t0 = performance.now()
	if (!REPOS[repo]) throw new Error(`unknown repo: ${repo}`)
	if (!base) throw new Error("evaluate requires a baseline object")

	const result = {
		repo,
		sha: task.sha,
		parent_sha: task.parent_sha,
		adapter: opts.adapter ?? null,
		model: opts.model ?? null,
		resolved: false,
		reason: "f2p_failed",
		patch: {applied: false, empty: false, files: [], deletions: [], error: null},
		tamper: {clean: true, findings: []},
		f2p: {required: (base.f2p || []).length, passed: 0, failed: [...(base.f2p || [])]},
		p2p: {required: (base.p2p || []).length, passed: 0, failed: [...(base.p2p || [])]},
		partial: {f2p_ratio: 0, p2p_ratio: 1},
		runs: {
			baseline: base.raw ?? {exit: null, passed: 0, failed: 0, total: 0},
			candidate: {exit: null, passed: 0, failed: 0, total: 0}
		},
		timing: {checkout_ms: 0, apply_ms: 0, test_ms: 0, total_ms: 0}
	}

	let text
	try {
		text = fs.readFileSync(candidatePatch, "utf8")
	} catch (e) {
		result.patch.error = `cannot read candidate patch: ${e.message}`
		result.reason = "patch_apply_failed"
		result.timing.total_ms = Math.round(performance.now() - t0)
		return result
	}

	const parsed = parsePatch(text)
	result.patch.files = parsed.touched
	result.patch.deletions = parsed.deletions
	result.patch.empty = isPatchEmpty(text, parsed)
	result.tamper = detectTamper(parsed, task)

	const tCheckout = performance.now()
	gitOrThrow(dir, ["checkout", "-f", task.parent_sha])
	gitOrThrow(dir, ["clean", "-fd", ...cleanExcludes(repo)])
	result.timing.checkout_ms = Math.round(performance.now() - tCheckout)

	if (!result.patch.empty) {
		const tApply = performance.now()
		const applied = applyPatch(dir, text)
		result.timing.apply_ms = Math.round(performance.now() - tApply)
		result.patch.applied = applied.ok
		if (!applied.ok) result.patch.error = (applied.stderr || "git apply failed").trim().slice(0, 2000)
	}

	let timedOut = false
	let testsRan = false

	if (result.patch.applied) {
		// Rebuild the grading environment from the oracle so the candidate's test
		// edits cannot influence the outcome: test/support files are restored from
		// the fix commit, and any test-infra file the candidate touched is restored
		// from the parent (or removed if it did not exist there).
		const restored = restoreFrom(dir, task.sha, oraclePaths(task))
		const infraTouched = result.patch.files.filter(p => isInfraPath(p))
		if (infraTouched.length) restored.push(...restoreFrom(dir, task.parent_sha, infraTouched))
		result.tamper.restored = restored
		const tTest = performance.now()
		const run = await runTests(repo, task, dir, opts)
		result.timing.test_ms = Math.round(performance.now() - tTest)
		timedOut = run.timedOut
		const report = run.report
		result.runs.candidate = {exit: run.code, ...reportCounts(report)}
		if (report) {
			const statuses = statusMap(report)
			testsRan = statuses.size > 0
			result.f2p.passed = (base.f2p || []).filter(n => statuses.get(n) === "passed").length
			result.f2p.failed = (base.f2p || []).filter(n => statuses.get(n) !== "passed")
			result.p2p.passed = (base.p2p || []).filter(n => statuses.get(n) === "passed").length
			result.p2p.failed = (base.p2p || []).filter(n => statuses.get(n) !== "passed")
		}
	}

	result.partial.f2p_ratio = result.f2p.required > 0 ? result.f2p.passed / result.f2p.required : 0
	result.partial.p2p_ratio = result.p2p.required > 0 ? result.p2p.passed / result.p2p.required : 1

	result.reason = pickReason(result, timedOut, testsRan)
	result.resolved = result.reason === "resolved"
	result.timing.total_ms = Math.round(performance.now() - t0)
	return result
}
