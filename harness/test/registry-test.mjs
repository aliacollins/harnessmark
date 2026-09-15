import {BENCHMARK_VERSION, EVAL_REASONS, FAILURE_MODES, INFRA_FAILURE_MODES, LANG_TEST_RES, LEAK_KINDS, PROVIDER_ERROR_RE, REPOS, activeRepos, isTestPath, redactSpec, repoIdentity, taskPrompt, taskSpec, taskSpecRaw, TASK_INSTRUCTIONS, PROMPT_VERSION} from "../registry.mjs"
import {REPORTERS} from "../reporters.mjs"

let pass = 0
let fail = 0
const failures = []
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
function ok(cond, msg) {
	if (cond) pass++
	else {
		fail++
		failures.push(msg)
		console.log(`  FAIL ${msg}`)
	}
}

// Real provider refusals taken verbatim from runs/ results.jsonl and from
// OpenRouter/codex error surfaces. Every one of these must classify.
const REAL_REFUSALS = {
	"openrouter 429": 'error=429: {"message":"Provider returned error","code":429,"metadata":{"raw":"deepseek/deepseek-v4.1-flash is temporarily rate-limited upstream."}}',
	"openrouter 402 credits": 'error=402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 384000 tokens"}',
	"codex transport": "Connection failed: error sending request",
	"framed 503": "HTTP 503 Service Unavailable",
	"anthropic 529": "529 overloaded_error",
	"worded rate limit": "temporarily rate-limited upstream",
	"framed json code": '"code": 502'
}

// Text that a FAILING AGENT legitimately produces. This corpus benchmarks an
// HTTP framework, so these are exactly the strings a genuine failure prints.
// Treating any of them as a provider refusal would exclude a real failure from
// the rate and silently inflate it.
const AGENT_OUTPUT = {
	"hono test failure": "FAIL src/middleware/etag/index.test.ts\n  expected 200 but got 503 Service Unavailable\n  Error: connection refused to localhost:3000",
	"agent quoting status codes": "I saw the API return 402 and 429 earlier in the test suite",
	"agent discussing rate limiting": "the middleware rate-limits requests after 100 calls",
	"unrelated assertion": "expect(fn).toThrow(/quota/)",
	"genuine give-up": "agent gave up after 3 turns",
	"programming error": "TypeError: notes.join is not a function",
	"bare status number": "test returned 500 for an unknown route"
}

for (const [name, text] of Object.entries(REAL_REFUSALS)) {
	ok(PROVIDER_ERROR_RE.test(text), `classifies a real provider refusal: ${name}`)
}
for (const [name, text] of Object.entries(AGENT_OUTPUT)) {
	ok(!PROVIDER_ERROR_RE.test(text), `does NOT classify agent output as a provider refusal: ${name}`)
}

ok(FAILURE_MODES.includes("provider_error"), "provider_error is a recognised failure mode")
ok(INFRA_FAILURE_MODES.includes("provider_error"), "provider_error is an infra failure mode")
ok(!INFRA_FAILURE_MODES.includes("none"), "a successful run is never an infra failure")
ok(!INFRA_FAILURE_MODES.includes("harness_crash"), "a harness crash is not excused as infrastructure")
ok(!INFRA_FAILURE_MODES.includes("auth_error"), "an auth error is operator state, not infra to discard")

// The regex must be stateless across calls: a /g flag would make .test() skip
// matches on alternate calls, which would classify erratically.
ok(!PROVIDER_ERROR_RE.global, "the pattern is not global, so .test() cannot skip matches")

const sample = REAL_REFUSALS["openrouter 429"]
ok(PROVIDER_ERROR_RE.test(sample) && PROVIDER_ERROR_RE.test(sample), "repeated .test() on the same input is stable")


// ---- multi-language repo specs
console.log("== repo specs ==")
const REQUIRED = ["name", "status", "lang", "reporter", "image", "url", "license", "cloneDir", "install", "testCmd", "testArgs", "testTimeoutMs", "installTimeoutMs"]
for (const [key, spec] of Object.entries(REPOS)) {
	ok(spec.name === key, `${key}: name matches its key`)
	ok(REQUIRED.every(k => k in spec), `${key}: has every required field`)
	ok(["active", "candidate"].includes(spec.status), `${key}: status is active|candidate`)
	ok(spec.lang in LANG_TEST_RES, `${key}: lang has test-path conventions`)
	ok(/^[A-Za-z0-9.-]+( OR [A-Za-z0-9.-]+)*$/.test(spec.license), `${key}: license is an SPDX expression`)
	ok(spec.reporter in REPORTERS, `${key}: reporter exists`)
	ok(Array.isArray(spec.testArgs(["x"])), `${key}: testArgs returns argv`)
}
const langs = new Set(Object.values(REPOS).map(r => r.lang))
ok(["ts", "python", "go", "rust"].every(l => langs.has(l)), "corpus spans TypeScript, Python, Go and Rust")
ok(Object.keys(REPOS).length >= 12, "at least twelve repos registered")
ok(/^\d+\.\d+\.\d+$/.test(BENCHMARK_VERSION), "BENCHMARK_VERSION is semver")
ok(activeRepos().map(r => r.name).join(",") === "immer,hono", "only immer and hono are active until harvested")

console.log("== isTestPath per language ==")
ok(isTestPath("src/a.test.ts") && isTestPath("__tests__/x.js") && !isTestPath("src/a.ts"), "no spec: historic TypeScript rule")
ok(isTestPath("tests/test_x.py", REPOS.httpx) && isTestPath("httpx/foo_test.py", "python") && !isTestPath("httpx/_client.py", "python"), "python: tests/, test_*.py, *_test.py")
ok(isTestPath("tests/conftest.py", "python"), "python: conftest is test infrastructure-as-test")
ok(isTestPath("cmd_test.go", REPOS.chi) && !isTestPath("cmd.go", REPOS.chi), "go: _test.go only")
ok(isTestPath("tests/int.rs", "rust") && isTestPath("src/parser/tests.rs", "rust") && !isTestPath("src/lib.rs", "rust"), "rust: tests/ dir and tests.rs modules; in-source cfg(test) is not addressable")
ok(isTestPath("tests/test_x.py", "klingon") === isTestPath("tests/test_x.py"), "unknown lang falls back to the default rule")
eq(REPOS.cobra.testArgs(["cmd/x_test.go", "root_test.go", "cmd/y_test.go"]), ["test", "-count=1", "./cmd", "./"], "go scopes by package dir, deduplicated")
ok(REPOS.clap.testArgs(["tests/a.rs"]).includes("--profile") && REPOS.clap.testArgs([]).some(a => a.endsWith("docker/nextest.toml")), "rust runs the workspace under the checked-in nextest profile")
eq(REPOS.immer.testArgs(["__tests__/base.js"]), ["yarn", "vitest", "run", "__tests__/base.js"], "immer argv unchanged")
eq(REPOS.hono.testArgs(["src/a.test.ts"]), ["vitest", "run", "src/a.test.ts"], "hono argv unchanged")

// Task prompt: an explicit instruction wraps the commit's own message.
{
	const task = {subject: "fix: thing", message_body: "  details here\n"}
	eq(taskSpec(task), "fix: thing\n\ndetails here", "taskSpec is subject + trimmed body")
	eq(taskSpecRaw(task), "fix: thing\n\ndetails here", "taskSpecRaw matches when there is nothing to redact")
	eq(taskSpec({subject: "only subject", message_body: ""}), "only subject", "taskSpec without a body is the subject alone")
	const p = taskPrompt(task)
	ok(p.startsWith(TASK_INSTRUCTIONS), "taskPrompt begins with the shared instruction")
	ok(p.endsWith(taskSpec(task)), "taskPrompt ends with the spec, unchanged")
	ok(/do not ask questions/i.test(TASK_INSTRUCTIONS), "the instruction tells the harness to act rather than ask")
	ok(/do not commit/i.test(TASK_INSTRUCTIONS), "the instruction forbids committing")
	ok(!/parent|oracle|f2p|test_paths/i.test(TASK_INSTRUCTIONS), "the instruction leaks nothing about grading")
	ok(PROMPT_VERSION === 3, "PROMPT_VERSION is 3 (v1 bare message, v2 instruction, v3 redacted + offline)")
}

// Prompt v3: answer pointers are redacted, the instruction is offline, the reason exists.
console.log("== redaction ==")
{
	const r1 = redactSpec("fix(etag): match tags with optional whitespace (#5222)")
	eq(r1.text, "fix(etag): match tags with optional whitespace", "a trailing (#NNNN) PR reference is dropped with its parentheses")
	eq(r1.counts, {pr_ref: 1}, "the PR reference is counted")
	const r2 = redactSpec("Fixes #1234, closes #99 and resolves GH-77. Also see #4321.")
	ok(!/#\d|GH-\d/.test(r2.text), `issue references are removed (got ${JSON.stringify(r2.text)})`)
	ok((r2.counts.issue_ref || 0) + (r2.counts.pr_ref || 0) >= 2, "issue references are counted")
	const r3 = redactSpec("see https://github.com/honojs/hono/pull/5102 and https://patch-diff.githubusercontent.com/raw/honojs/hono/pull/5102.diff and https://gist.github.com/x/abc but keep https://hono.dev/docs/api and https://developer.mozilla.org/x")
	ok(!/github/.test(r3.text), "github, githubusercontent and gist URLs are removed")
	ok(r3.text.includes("https://hono.dev/docs/api") && r3.text.includes("developer.mozilla.org"), "non-answer URLs survive")
	eq(r3.counts.url, 3, "three answer URLs counted")
	const r4 = redactSpec("body\nCo-authored-by: A <a@b.c>\nSigned-off-by: B <b@c.d>\nReviewed-by: C\nmore")
	eq(r4.text, "body\n\nmore", "trailer lines are removed whole (the gap collapses to one blank line)")
	eq(r4.counts.trailer, 3, "trailers counted")
	const r5 = redactSpec("Commit a1b2c3d4e5f6 and 0c3efdd4eae2d44a9c436c554499c68c45b4eccc broke it; cafef00d too; but defaced and deadbeef are words")
	ok(!/a1b2c3d4|0c3efdd4|cafef00d/.test(r5.text), `standalone SHAs are removed (got ${JSON.stringify(r5.text)})`)
	ok(/defaced and deadbeef/.test(r5.text), "all-letter hex words are not treated as SHAs")
	eq(r5.counts.sha, 3, "three SHAs counted")
	eq(redactSpec("improve DraftMap compatibility#1228").text, "improve DraftMap compatibility", "a reference glued to a word is removed")
	const r8 = redactSpec("Refs honojs/hono#4989 and see owner/repo#12 (honojs/hono#7)")
	ok(!/#\d/.test(r8.text), `owner/repo#N references are removed (got ${JSON.stringify(r8.text)})`)
	const keep = "Array#push and #!/usr/bin/env node return HTTP 404 in v4.13.7; color: #ff00aa; port 1234567 and 20250929 stay; C# too; id 1e10 stays"
	const r6 = redactSpec(keep)
	eq(r6.text, keep, "code identifiers, shebangs, status codes, versions, CSS hex, pure-digit runs and C# survive")
	eq(r6.counts, {}, "nothing counted when nothing is redacted")
	const r7 = redactSpec("Fixes #1234. Then the sentence continues")
	eq(r7.text, "Then the sentence continues", "a reference that opened a sentence does not leave stray punctuation")
	// taskSpec: redacted; raw kept for reporting; counts
	const task = {subject: "feat(x): add y (#4717)", message_body: "Closes #4700.\n\nDetails here https://github.com/honojs/hono/issues/4700\n\nCo-authored-by: Q <q@r.s>"}
	eq(taskSpec(task), "feat(x): add y\n\nDetails here", "taskSpec is fully redacted")
	ok(taskSpecRaw(task).includes("#4717") && taskSpecRaw(task).includes("github.com"), "taskSpecRaw keeps the pointers for harvest/report")
	const c = taskSpec.redactions(task)
	eq([c.pr_ref, c.issue_ref, c.url, c.trailer, c.total], [1, 1, 1, 1, 4], "redaction counts by kind and total")
	eq(taskSpec({subject: "(#123)", message_body: ""}), "(#123)", "a subject that redacts to nothing falls back to the raw subject")
	eq(taskSpec({subject: "fix: z", message_body: "Fixes #1"}), "fix: z", "a body that redacts to nothing yields the subject alone")
	ok(taskPrompt(task).startsWith(TASK_INSTRUCTIONS) && taskPrompt(task).endsWith(taskSpec(task)), "taskPrompt = instructions + redacted spec")
	ok(/do not use the network/i.test(TASK_INSTRUCTIONS) && /no github/i.test(TASK_INSTRUCTIONS) && /package registr/i.test(TASK_INSTRUCTIONS), "the instruction carries the offline rule")
	ok(TASK_INSTRUCTIONS.split(/\s+/).length <= 115, `the instruction stays short (${TASK_INSTRUCTIONS.split(/\s+/).length} words)`)
	ok(!/parent|oracle|f2p|test_paths|baseline/i.test(TASK_INSTRUCTIONS), "the instruction leaks nothing about grading")
	ok(EVAL_REASONS.includes("answer_lookup"), "answer_lookup is an eval reason")
	eq(LEAK_KINDS, ["upstream_lookup", "external_network", "web_tool"], "leak kinds are fixed")
	const hono = repoIdentity(REPOS.hono)
	eq([hono.org, hono.repo, hono.package], ["honojs", "hono", "hono"], "hono identity")
	const immer = repoIdentity(REPOS.immer)
	eq([immer.org, immer.repo, immer.package], ["immerjs", "immer", "immer"], "immer identity")
	ok(hono.hosts.includes("api.github.com") && hono.hosts.includes("registry.npmjs.org") && hono.hosts.includes("patch-diff.githubusercontent.com"), "identity lists the hosts that serve the answer")
	eq(repoIdentity({url: "https://github.com/foo/bar"}).org, "foo", "identity is derived from the url when org/repo are absent")
	for (const [k, spec] of Object.entries(REPOS)) ok(typeof spec.org === "string" && typeof spec.repo === "string" && "package" in spec, `${k} declares org, repo and package`)
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)
