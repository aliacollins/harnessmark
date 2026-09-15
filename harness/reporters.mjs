// Test-report abstraction. The evaluator grades by PER-TEST identity (f2p / p2p
// sets), so every supported test runner must produce a machine-readable report
// from which a stable test name can be extracted. Scraping human-readable output
// is not an option here: if a reporter cannot yield names it must fail loudly,
// never degrade to counts (contracts.md, "Evidence model").
//
// Each reporter declares WHERE its report lives:
//   source: "outFile"  - runner writes to the path handed to args(files, outFile)
//   source: "stdout"   - runner streams the report on stdout (go test -json)
//   source: "cwdFile"  - runner writes to a fixed path under cwd; locate(cwd)
// and parse(text) -> {tests: [{name, status, file}], passed, failed, total}.
// status is "passed" | "failed" | "skipped". Names include file/suite/package so
// two tests with the same title in different files never collide.

const STATUS = new Set(["passed", "failed", "skipped"])

function tally(tests) {
	let passed = 0
	let failed = 0
	for (const t of tests) {
		if (t.status === "passed") passed++
		else if (t.status === "failed") failed++
	}
	return {tests, passed, failed, total: passed + failed}
}

// ---------------------------------------------------------------- vitest

// Moved verbatim from evaluator/evaluate.mjs: identity is `fullName || title`,
// which vitest builds as "<describe path> <title>" (file is not included, so
// the same title in two files collides; that matched prior behaviour and the
// cached baselines depend on it).
function parseVitestJson(text) {
	let report
	try {
		report = JSON.parse(text)
	} catch {
		return null
	}
	if (!report || !Array.isArray(report.testResults)) return null
	const tests = []
	for (const tr of report.testResults) {
		for (const a of tr.assertionResults || []) {
			const name = a.fullName || a.title
			if (!name) continue
			const status = STATUS.has(a.status) ? a.status : a.status === "pending" || a.status === "todo" ? "skipped" : "unknown"
			tests.push({name, status, file: tr.name ?? null})
		}
	}
	return tally(tests)
}

// ---------------------------------------------------------------- junit xml

const decodeXml = s =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&amp;/g, "&")

function attrs(tag) {
	const out = {}
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
		out[m[1] ?? m[3]] = decodeXml(m[2] ?? m[4] ?? "")
	}
	return out
}

// Tolerant scanner: walks <testcase ...> elements, self-closing or with a body,
// and inspects the body for <failure>, <error>, <skipped>. No XML library; a
// junit file from pytest or nextest is regular enough for this.
function parseJunit(text, {nameOf}) {
	if (typeof text !== "string" || !/<testcase\b/.test(text)) return null
	const tests = []
	const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
	for (const m of text.matchAll(re)) {
		const a = attrs(m[1])
		const body = m[3] ?? ""
		let status = "passed"
		if (/<(failure|error)\b/.test(body)) status = "failed"
		else if (/<skipped\b/.test(body)) status = "skipped"
		const name = nameOf(a)
		if (!name) continue
		tests.push({name, status, file: a.file ?? a.classname ?? null})
	}
	return tally(tests)
}

// pytest: classname is the dotted module (+ class) path, name the function
// (with parametrize id). "tests.test_x.TestY::test_z[case]" is stable.
const pytestName = a => (a.classname ? `${a.classname}::${a.name}` : a.name || null)

// cargo nextest: classname is "<crate>::<binary>", name the test path.
const nextestName = a => (a.classname ? `${a.classname}::${a.name}` : a.name || null)

// ---------------------------------------------------------------- go test -json

// One JSON event per line on stdout. Only leaf test events (with a Test field)
// count; package-level pass/fail lines and output lines are ignored. A test that
// reports both a subtest and itself is two names. Name = "<Package>/<Test>".
function parseGoTestJson(text) {
	if (typeof text !== "string") return null
	const statuses = new Map()
	let sawEvent = false
	for (const line of text.split("\n")) {
		const s = line.trim()
		if (!s.startsWith("{")) continue
		let ev
		try {
			ev = JSON.parse(s)
		} catch {
			continue
		}
		if (!ev || typeof ev.Action !== "string") continue
		sawEvent = true
		if (typeof ev.Test !== "string" || !ev.Test) continue
		const name = `${ev.Package ?? ""}/${ev.Test}`
		if (ev.Action === "pass") statuses.set(name, "passed")
		else if (ev.Action === "fail") statuses.set(name, "failed")
		else if (ev.Action === "skip") statuses.set(name, "skipped")
	}
	if (!sawEvent) return null
	const tests = [...statuses].map(([name, status]) => ({name, status, file: name.slice(0, name.indexOf("/")) || null}))
	return tally(tests)
}

// ---------------------------------------------------------------- registry

export const REPORTERS = {
	// vitest writes JSON to --outputFile; identical argv to the pre-abstraction
	// evaluator so cached baselines stay valid.
	"vitest-json": {
		source: "outFile",
		args: (files, outFile) => ["--reporter=json", `--outputFile=${outFile}`],
		parse: parseVitestJson
	},
	// pytest writes junit XML to --junitxml. -p no:cacheprovider keeps the
	// worktree clean of .pytest_cache so it never shows up in a candidate patch.
	"pytest-junit": {
		source: "outFile",
		args: (files, outFile) => [`--junitxml=${outFile}`, "-p", "no:cacheprovider", "-q"],
		parse: text => parseJunit(text, {nameOf: pytestName})
	},
	// go test streams events on stdout; there is no output file.
	"go-test-json": {
		source: "stdout",
		args: () => ["-json"],
		parse: parseGoTestJson
	},
	// cargo nextest writes junit to target/nextest/<profile>/<junit.path>. The
	// profile lives in docker/nextest.toml (checked in) so the repo needs no
	// config of its own; --config-file is resolved by the caller to an absolute
	// path (see registry REPOS[*].testArgs).
	"cargo-nextest-junit": {
		source: "cwdFile",
		locate: cwd => `${cwd}/target/nextest/bench/junit.xml`,
		args: () => [],
		parse: text => parseJunit(text, {nameOf: nextestName})
	}
}

export function getReporter(name) {
	const r = REPORTERS[name ?? "vitest-json"]
	if (!r) throw new Error(`unknown reporter: ${name}`)
	return r
}

// Collapse duplicate names to one status (a test that both failed and passed,
// e.g. a retry, is recorded as failed). Mirrors the evaluator's prior rule.
export function statusMap(parsed) {
	const statuses = new Map()
	for (const t of parsed?.tests || []) {
		const prev = statuses.get(t.name)
		if (prev === "failed" || t.status === "failed") statuses.set(t.name, "failed")
		else if (prev === "passed" || t.status === "passed") statuses.set(t.name, "passed")
		else statuses.set(t.name, t.status || "unknown")
	}
	return statuses
}
