// The evaluator must grade a non-vitest repo through the reporter abstraction:
// a synthetic Python-shaped repo whose "pytest" is a Node stub writing junit XML
// to --junitxml. Also checks the stdout-sourced path (go-style) and that a
// runner producing no machine-readable report makes baseline() throw.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {REPOS} from "../../harness/registry.mjs"
import {baseline, evaluate} from "../evaluate.mjs"

let pass = 0
let fail = 0
const failures = []
const ok = (c, m) => {
	if (c) pass++
	else {
		fail++
		failures.push(m)
		console.log(`  FAIL ${m}`)
	}
}
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const git = (dir, args) => {
	const r = spawnSync("git", args, {cwd: dir, encoding: "utf8"})
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
	return (r.stdout || "").trim()
}
const write = (root, rel, content) => {
	const p = path.join(root, rel)
	fs.mkdirSync(path.dirname(p), {recursive: true})
	fs.writeFileSync(p, content)
}

// Stub "pytest": reads tests/test_x.py for `def test_*` names, marks a test failed
// when its name contains "f2p" and src/fix.py lacks FIXED, writes junit to
// --junitxml=<path>. With MODE=stdout it prints go-test-json events instead.
const STUB = `import fs from "node:fs"
import path from "node:path"
const argv = process.argv.slice(2)
const junit = argv.find(a => a.startsWith("--junitxml="))?.slice("--junitxml=".length)
const files = argv.filter(a => !a.startsWith("-") && a.endsWith(".py"))
const read = p => { try { return fs.readFileSync(path.resolve(p), "utf8") } catch { return "" } }
const fixed = /FIXED/.test(read("src/fix.py"))
const cases = []
for (const f of files.length ? files : ["tests/test_x.py"]) {
	for (const m of read(f).matchAll(/def (test_\\w+)/g)) {
		const name = m[1]
		cases.push({cls: f.replace(/\\//g, ".").replace(/\\.py$/, ""), name, failed: /f2p/.test(name) && !fixed})
	}
}
if (process.env.MODE === "stdout") {
	for (const c of cases) console.log(JSON.stringify({Action: c.failed ? "fail" : "pass", Package: "pkg", Test: c.name}))
} else if (process.env.MODE === "silent") {
	console.log("Tests  1 passed (1)")
} else if (junit) {
	const xml = cases.map(c => c.failed ? '<testcase classname="' + c.cls + '" name="' + c.name + '"><failure message="x">y</failure></testcase>' : '<testcase classname="' + c.cls + '" name="' + c.name + '"/>').join("")
	fs.writeFileSync(junit, "<testsuites><testsuite>" + xml + "</testsuite></testsuites>")
}
process.exit(cases.some(c => c.failed) ? 1 : 0)
`

async function main() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reporter-"))
	const stub = path.join(root, "..", `pytest-stub-${process.pid}.mjs`)
	fs.writeFileSync(stub, STUB)
	git(root, ["init", "-q"])
	git(root, ["config", "user.email", "t@t"])
	git(root, ["config", "user.name", "t"])
	write(root, "src/fix.py", "def add(a, b):\n    return a - b\n")
	write(root, "tests/test_x.py", "def test_works():\n    pass\n")
	git(root, ["add", "-A"])
	git(root, ["commit", "-qm", "parent"])
	const parent = git(root, ["rev-parse", "HEAD"])
	write(root, "src/fix.py", "def add(a, b):\n    return a + b  # FIXED\n")
	write(root, "tests/test_x.py", "def test_works():\n    pass\n\ndef test_f2p_add():\n    assert add(1, 2) == 3\n")
	git(root, ["add", "-A"])
	git(root, ["commit", "-qm", "fix"])
	const sha = git(root, ["rev-parse", "HEAD"])
	const fixPatch = spawnSync("git", ["diff", parent, sha, "--", "src/fix.py"], {cwd: root, encoding: "utf8"}).stdout
	const patchFile = path.join(root, "..", `fix-${process.pid}.patch`)
	fs.writeFileSync(patchFile, fixPatch)
	const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-reporter-cache-"))

	REPOS.synthpy = {
		name: "synthpy",
		status: "candidate",
		lang: "python",
		reporter: "pytest-junit",
		image: null,
		deps: ".venv",
		url: "",
		cloneDir: root,
		install: [],
		testCmd: process.execPath,
		testArgs: files => [stub, ...files],
		testTimeoutMs: 5000,
		installTimeoutMs: 1000
	}
	const task = {sha, parent_sha: parent, test_paths: ["tests/test_x.py"], support_paths: [], source_paths: ["src/fix.py"]}

	console.log("== pytest-junit path ==")
	const base = await baseline({repo: "synthpy", task, dir: root, opts: {cacheDir}})
	eq(base.f2p, ["tests.test_x::test_f2p_add"], "f2p from junit: classname::name identity")
	eq(base.p2p, ["tests.test_x::test_works"], "p2p from junit")
	eq(base.raw.failed, 1, "raw counts from junit")
	const r = await evaluate({repo: "synthpy", task, candidatePatch: patchFile, dir: root, baseline: base})
	eq([r.resolved, r.reason], [true, "resolved"], "reference fix resolves through the junit reporter")
	ok(!fs.existsSync(path.join(root, "report.json")), "report scratch file never lands in the worktree")

	console.log("== stdout-sourced reporter path (go-style) ==")
	REPOS.synthpy.reporter = "go-test-json"
	const baseGo = await baseline({repo: "synthpy", task, dir: root, opts: {cacheDir, noCache: true, env: {MODE: "stdout"}}})
	eq(baseGo.f2p, ["pkg/test_f2p_add"], "f2p read from stdout events")
	const rGo = await evaluate({repo: "synthpy", task, candidatePatch: patchFile, dir: root, baseline: baseGo, opts: {env: {MODE: "stdout"}}})
	eq(rGo.reason, "resolved", "resolves through the stdout reporter")

	console.log("== no machine-readable report ==")
	REPOS.synthpy.reporter = "pytest-junit"
	let threw = null
	try {
		await baseline({repo: "synthpy", task, dir: root, opts: {cacheDir, noCache: true, env: {MODE: "silent"}}})
	} catch (e) {
		threw = e.message
	}
	ok(threw && /refusing to degrade to counts/.test(threw), `baseline throws when only human-readable output exists (${threw})`)
	const rSilent = await evaluate({repo: "synthpy", task, candidatePatch: patchFile, dir: root, baseline: base, opts: {env: {MODE: "silent"}}})
	eq(rSilent.reason, "no_tests_ran", "evaluate without a report is no_tests_ran, never resolved")

	console.log("== deps dir survives git clean ==")
	fs.mkdirSync(path.join(root, ".venv"), {recursive: true})
	fs.writeFileSync(path.join(root, ".venv", "marker"), "x")
	await evaluate({repo: "synthpy", task, candidatePatch: patchFile, dir: root, baseline: base})
	ok(fs.existsSync(path.join(root, ".venv", "marker")), "the language deps dir (.venv) is excluded from git clean")

	delete REPOS.synthpy
	fs.rmSync(root, {recursive: true, force: true})
	fs.rmSync(cacheDir, {recursive: true, force: true})
	fs.rmSync(stub, {force: true})
	fs.rmSync(patchFile, {force: true})
	console.log(`\npass=${pass} fail=${fail}`)
	if (failures.length) for (const f of failures) console.log(` - ${f}`)
	process.exit(fail ? 1 : 0)
}
main().catch(e => {
	console.error(e)
	process.exit(1)
})
