import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {REPORTERS, getReporter, statusMap} from "../reporters.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fixture = f => fs.readFileSync(path.join(HERE, "fixtures", f), "utf8")

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
const byName = r => Object.fromEntries(r.tests.map(t => [t.name, t.status]))

console.log("== registry ==")
eq(Object.keys(REPORTERS).sort(), ["cargo-nextest-junit", "go-test-json", "pytest-junit", "vitest-json"], "four reporters")
for (const [name, r] of Object.entries(REPORTERS)) {
	ok(["outFile", "stdout", "cwdFile"].includes(r.source), `${name} declares a source`)
	ok(typeof r.args === "function" && typeof r.parse === "function", `${name} has args/parse`)
	ok(r.source !== "cwdFile" || typeof r.locate === "function", `${name} cwdFile reporter has locate`)
}
ok(getReporter(undefined) === REPORTERS["vitest-json"], "no reporter name defaults to vitest-json")
let threw = false
try {
	getReporter("nope")
} catch {
	threw = true
}
ok(threw, "unknown reporter throws rather than silently degrading")

console.log("== vitest-json ==")
const v = REPORTERS["vitest-json"]
eq(v.args(["a.test.ts"], "/tmp/out.json"), ["--reporter=json", "--outputFile=/tmp/out.json"], "vitest argv identical to the pre-abstraction evaluator")
const vr = v.parse(fixture("vitest.json"))
eq(byName(vr), {"base works alpha": "passed", "base f2p delta": "failed", "only title": "skipped"}, "vitest names use fullName||title; pending is skipped")
eq([vr.passed, vr.failed, vr.total], [1, 1, 2], "vitest counts exclude skipped")
ok(v.parse("not json") === null, "vitest: garbage -> null (caller fails loudly)")
ok(v.parse("{}") === null, "vitest: JSON without testResults -> null")

console.log("== pytest-junit ==")
const p = REPORTERS["pytest-junit"]
ok(p.args([], "/s/r.xml").includes("--junitxml=/s/r.xml"), "pytest writes junit to the outFile")
ok(p.args([], "x").includes("no:cacheprovider"), "pytest keeps .pytest_cache out of the worktree")
const pr = p.parse(fixture("pytest-junit.xml"))
eq(
	byName(pr),
	{
		"tests.test_client::test_get": "passed",
		"tests.test_client::test_post[json-body]": "failed",
		"tests.test_client.TestTimeouts::test_read": "skipped",
		"tests.test_client.TestTimeouts::test_write": "failed",
		'tests.test_other::test_quote"d': "passed"
	},
	"pytest names are classname::name; error counts as failed; entities decoded"
)
eq([pr.passed, pr.failed, pr.total], [2, 2, 4], "pytest counts")
ok(p.parse("<testsuites></testsuites>") === null, "pytest: no testcase elements -> null")

console.log("== go-test-json ==")
const g = REPORTERS["go-test-json"]
eq(g.source, "stdout", "go reads stdout")
eq(g.args(["x_test.go"], "/ignored"), ["-json"], "go argv")
const gr = g.parse(fixture("go-test.jsonl"))
eq(
	byName(gr),
	{
		"github.com/spf13/cobra/TestRoot/sub": "failed",
		"github.com/spf13/cobra/TestRoot": "failed",
		"github.com/spf13/cobra/TestFlags": "passed",
		"github.com/spf13/cobra/doc/TestFlags": "skipped"
	},
	"go: only leaf Test events; same test name in two packages stays distinct"
)
eq([gr.passed, gr.failed, gr.total], [1, 2, 3], "go counts ignore package-level lines and noise")
ok(g.parse("plain text\nno events") === null, "go: no events -> null")

console.log("== cargo-nextest-junit ==")
const c = REPORTERS["cargo-nextest-junit"]
eq(c.source, "cwdFile", "nextest reads a file under cwd")
eq(c.locate("/w"), "/w/target/nextest/bench/junit.xml", "nextest junit lives under the bench profile")
const cr = c.parse(fixture("nextest-junit.xml"))
eq(
	byName(cr),
	{"clap::builder::tests::flag_parses": "passed", "clap::builder::tests::flag_conflicts": "failed", "clap::derive::tests::flag_parses": "passed"},
	"nextest names are crate::binary::test; CDATA bodies handled; self-closing testcase handled"
)
eq([cr.passed, cr.failed, cr.total], [2, 1, 3], "nextest counts")

console.log("== statusMap ==")
const sm = statusMap({tests: [{name: "a", status: "passed"}, {name: "a", status: "failed"}, {name: "b", status: "skipped"}, {name: "b", status: "passed"}]})
eq([...sm], [["a", "failed"], ["b", "passed"]], "duplicate names: failed wins over passed, passed over skipped")
eq([...statusMap(null)].length, 0, "statusMap(null) is empty, not a throw")

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) for (const f of failures) console.log(` - ${f}`)
process.exit(fail ? 1 : 0)
