// Shared source of truth. Treat as READ-ONLY from worker tasks: do not edit.
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const DATASET_DIR = path.join(ROOT, "spike/out")
export const RUNS_DIR = path.join(ROOT, "runs")
export const EVIDENCE_DIR = path.join(ROOT, ".evidence")

// Per-language test-path conventions. The TypeScript patterns are the historic
// defaults and stay the fallback when no repo spec is given, so nothing about
// immer/hono changes. Rust unit tests live in-source under #[cfg(test)]; only the
// conventional tests/ directory and */tests.rs modules are addressable as files.
export const LANG_TEST_RES = {
	ts: [/(^|\/)(__tests__|tests?|spec)\//, /\.(test|spec)\.[cm]?[jt]sx?$/],
	python: [/(^|\/)tests?\//, /(^|\/)test_[^/]*\.py$/, /_test\.py$/, /(^|\/)conftest\.py$/],
	go: [/_test\.go$/],
	rust: [/(^|\/)tests\//, /(^|\/)tests\.rs$/]
}

// Test-file paths -> the argument that scopes the runner to them. Go scopes by
// package directory, cargo cannot scope by file at all (nextest filters by test
// name), so the whole workspace runs and the f2p/p2p sets do the selecting.
const goPackages = files => {
	const dirs = [...new Set(files.map(f => path.posix.dirname(f)))]
	return dirs.map(d => (d === "." ? "./" : `./${d}`))
}
const NEXTEST_CONFIG = path.join(ROOT, "docker", "nextest.toml")

// `status`: "active" repos are harvested and have tasks under spike/out;
// "candidate" repos carry a best-effort install/test recipe and become active
// once spike/harvest.mjs has validated tasks for them. `image` is the pinned
// grading container built from docker/<repo>/Dockerfile; `deps` names the
// dependency directory the image bakes (see harness/runtime.mjs). `license` is the
// upstream SPDX expression; harvested patches stay under it (THIRD_PARTY_NOTICES.md).
export const REPOS = {
	immer: {
		name: "immer",
		status: "active",
		lang: "ts",
		reporter: "vitest-json",
		image: "harness-bench/immer:v1",
		deps: "node_modules",
		url: "https://github.com/immerjs/immer",
		license: "MIT",
		org: "immerjs",
		repo: "immer",
		package: "immer",
		cloneDir: path.join(ROOT, "spike/work/immer"),
		install: ["corepack", "yarn", "install", "--frozen-lockfile"],
		testCmd: "corepack",
		testArgs: files => ["yarn", "vitest", "run", ...files],
		testTimeoutMs: 120_000,
		installTimeoutMs: 600_000
	},
	hono: {
		name: "hono",
		status: "active",
		lang: "ts",
		reporter: "vitest-json",
		image: "harness-bench/hono:v1",
		deps: "node_modules",
		url: "https://github.com/honojs/hono",
		license: "MIT",
		org: "honojs",
		repo: "hono",
		package: "hono",
		cloneDir: path.join(ROOT, "spike/work/hono"),
		install: ["npm", "install"],
		testCmd: "npx",
		testArgs: files => ["vitest", "run", ...files],
		testTimeoutMs: 240_000,
		installTimeoutMs: 900_000
	},
	zod: {
		name: "zod",
		status: "candidate",
		lang: "ts",
		reporter: "vitest-json",
		image: "harness-bench/zod:v1",
		deps: "node_modules",
		url: "https://github.com/colinhacks/zod",
		license: "MIT",
		org: "colinhacks",
		repo: "zod",
		package: "zod",
		cloneDir: path.join(ROOT, "spike/work/zod"),
		install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
		testCmd: "corepack",
		testArgs: files => ["pnpm", "vitest", "run", ...files],
		testTimeoutMs: 240_000,
		installTimeoutMs: 900_000
	},
	h3: {
		name: "h3",
		status: "candidate",
		lang: "ts",
		reporter: "vitest-json",
		image: "harness-bench/h3:v1",
		deps: "node_modules",
		url: "https://github.com/unjs/h3",
		license: "MIT",
		org: "unjs",
		repo: "h3",
		package: "h3",
		cloneDir: path.join(ROOT, "spike/work/h3"),
		install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
		testCmd: "corepack",
		testArgs: files => ["pnpm", "vitest", "run", ...files],
		testTimeoutMs: 240_000,
		installTimeoutMs: 900_000
	},
	httpx: {
		name: "httpx",
		status: "candidate",
		lang: "python",
		reporter: "pytest-junit",
		image: "harness-bench/httpx:v1",
		deps: ".venv",
		url: "https://github.com/encode/httpx",
		license: "BSD-3-Clause",
		org: "encode",
		repo: "httpx",
		package: "httpx",
		cloneDir: path.join(ROOT, "spike/work/httpx"),
		install: ["python3", "-m", "pip", "install", "-r", "requirements.txt"],
		testCmd: "python3",
		testArgs: files => ["-m", "pytest", ...files],
		testTimeoutMs: 300_000,
		installTimeoutMs: 900_000
	},
	click: {
		name: "click",
		status: "candidate",
		lang: "python",
		reporter: "pytest-junit",
		image: "harness-bench/click:v1",
		deps: ".venv",
		url: "https://github.com/pallets/click",
		license: "BSD-3-Clause",
		org: "pallets",
		repo: "click",
		package: "click",
		cloneDir: path.join(ROOT, "spike/work/click"),
		install: ["python3", "-m", "pip", "install", "-e", ".", "-r", "requirements/tests.txt"],
		testCmd: "python3",
		testArgs: files => ["-m", "pytest", ...files],
		testTimeoutMs: 300_000,
		installTimeoutMs: 900_000
	},
	fastapi: {
		name: "fastapi",
		status: "candidate",
		lang: "python",
		reporter: "pytest-junit",
		image: "harness-bench/fastapi:v1",
		deps: ".venv",
		url: "https://github.com/tiangolo/fastapi",
		license: "MIT",
		org: "tiangolo",
		repo: "fastapi",
		package: "fastapi",
		cloneDir: path.join(ROOT, "spike/work/fastapi"),
		install: ["python3", "-m", "pip", "install", "-r", "requirements-tests.txt"],
		testCmd: "python3",
		testArgs: files => ["-m", "pytest", ...files],
		testTimeoutMs: 600_000,
		installTimeoutMs: 1_200_000
	},
	cobra: {
		name: "cobra",
		status: "candidate",
		lang: "go",
		reporter: "go-test-json",
		image: "harness-bench/cobra:v1",
		deps: null,
		url: "https://github.com/spf13/cobra",
		license: "Apache-2.0",
		org: "spf13",
		repo: "cobra",
		package: "github.com/spf13/cobra",
		cloneDir: path.join(ROOT, "spike/work/cobra"),
		install: ["go", "mod", "download"],
		testCmd: "go",
		testArgs: files => ["test", "-count=1", ...goPackages(files)],
		testTimeoutMs: 300_000,
		installTimeoutMs: 900_000
	},
	chi: {
		name: "chi",
		status: "candidate",
		lang: "go",
		reporter: "go-test-json",
		image: "harness-bench/chi:v1",
		deps: null,
		url: "https://github.com/go-chi/chi",
		license: "MIT",
		org: "go-chi",
		repo: "chi",
		package: "github.com/go-chi/chi",
		cloneDir: path.join(ROOT, "spike/work/chi"),
		install: ["go", "mod", "download"],
		testCmd: "go",
		testArgs: files => ["test", "-count=1", ...goPackages(files)],
		testTimeoutMs: 300_000,
		installTimeoutMs: 900_000
	},
	gin: {
		name: "gin",
		status: "candidate",
		lang: "go",
		reporter: "go-test-json",
		image: "harness-bench/gin:v1",
		deps: null,
		url: "https://github.com/gin-gonic/gin",
		license: "MIT",
		org: "gin-gonic",
		repo: "gin",
		package: "github.com/gin-gonic/gin",
		cloneDir: path.join(ROOT, "spike/work/gin"),
		install: ["go", "mod", "download"],
		testCmd: "go",
		testArgs: files => ["test", "-count=1", ...goPackages(files)],
		testTimeoutMs: 300_000,
		installTimeoutMs: 900_000
	},
	clap: {
		name: "clap",
		status: "candidate",
		lang: "rust",
		reporter: "cargo-nextest-junit",
		image: "harness-bench/clap:v1",
		deps: "target",
		url: "https://github.com/clap-rs/clap",
		license: "Apache-2.0 OR MIT",
		org: "clap-rs",
		repo: "clap",
		package: "clap",
		cloneDir: path.join(ROOT, "spike/work/clap"),
		install: ["cargo", "fetch"],
		testCmd: "cargo",
		testArgs: () => ["nextest", "run", "--workspace", "--config-file", NEXTEST_CONFIG, "--profile", "bench", "--no-fail-fast"],
		testTimeoutMs: 900_000,
		installTimeoutMs: 1_800_000
	},
	serde_json: {
		name: "serde_json",
		status: "candidate",
		lang: "rust",
		reporter: "cargo-nextest-junit",
		image: "harness-bench/serde_json:v1",
		deps: "target",
		url: "https://github.com/serde-rs/json",
		license: "Apache-2.0 OR MIT",
		org: "serde-rs",
		repo: "json",
		package: "serde_json",
		cloneDir: path.join(ROOT, "spike/work/serde_json"),
		install: ["cargo", "fetch"],
		testCmd: "cargo",
		testArgs: () => ["nextest", "run", "--workspace", "--config-file", NEXTEST_CONFIG, "--profile", "bench", "--no-fail-fast"],
		testTimeoutMs: 900_000,
		installTimeoutMs: 1_800_000
	},
	axum: {
		name: "axum",
		status: "candidate",
		lang: "rust",
		reporter: "cargo-nextest-junit",
		image: "harness-bench/axum:v1",
		deps: "target",
		url: "https://github.com/tokio-rs/axum",
		license: "MIT",
		org: "tokio-rs",
		repo: "axum",
		package: "axum",
		cloneDir: path.join(ROOT, "spike/work/axum"),
		install: ["cargo", "fetch"],
		testCmd: "cargo",
		testArgs: () => ["nextest", "run", "--workspace", "--config-file", NEXTEST_CONFIG, "--profile", "bench", "--no-fail-fast"],
		testTimeoutMs: 1_200_000,
		installTimeoutMs: 1_800_000
	}
}

export const activeRepos = () => Object.values(REPOS).filter(r => r.status === "active")

export const TEST_DIR_RE = /(^|\/)(__tests__|tests?|spec)\//
export const TEST_EXT_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
export const SUPPORT_RES = [
	/(^|\/)(__snapshots|__fixtures__|__mocks__|test-utils|testUtils)\//,
	/\.snap$/,
	/(^|\/)(setupTests|vitest\.setup|jest\.setup)\./
]
export const INFRA_RES = [
	/(^|\/)(vitest|vite|jest)\.config\./,
	/(^|\/)tsconfig[^/]*\.json$/,
	/(^|\/)package\.json$/,
	/\.setup\./,
	/reporter/i,
	/(^|\/)\.mocharc/,
	/(^|\/)nyc\.config\./
]

// Optional spec (or lang string) selects the language's conventions; with no
// spec the historic TypeScript rule applies unchanged.
export const isTestPath = (p, spec) => {
	const lang = typeof spec === "string" ? spec : spec?.lang
	if (!lang || !LANG_TEST_RES[lang]) return TEST_DIR_RE.test(p) || TEST_EXT_RE.test(p)
	return LANG_TEST_RES[lang].some(re => re.test(p))
}
export const isSupportPath = p => SUPPORT_RES.some(re => re.test(p))
export const isInfraPath = p => INFRA_RES.some(re => re.test(p))

// Null means the harness did not report it. Never substitute 0 for unknown.
export const TELEMETRY_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cost_usd"
]

export const FAILURE_MODES = [
	"none",
	"agent_timeout",
	"budget_exceeded",
	"context_limit",
	"harness_crash",
	"auth_error",
	"provider_error",
	"unknown"
]

// Failure modes that are NOT the harness's doing: the model provider refused or
// could not serve the request (rate limit, quota, 5xx). Such a trial carries no
// information about the harness and must be excluded from every rate, because
// counting it as a failure blames the agent for the provider's behaviour.
export const INFRA_FAILURE_MODES = ["provider_error"]

// Wire patterns for a provider-side refusal. Status codes must appear in
// provider framing ("error=429", '"code": 402', "HTTP 503") rather than as bare
// numbers: this corpus runs an HTTP framework, so an agent legitimately failing
// with "expected 200 but got 503" in its own output must NOT be mistaken for the
// provider refusing to serve. Generic transport phrases ("connection refused",
// "network error") are deliberately absent for the same reason - they are exactly
// what an HTTP client's own test output prints - so only unambiguous signals are
// matched. Adapters additionally pass only harness-level text and only for a run
// that already failed.
export const PROVIDER_ERROR_RE =
	/(?:error|code|status|http)[\s:="']{0,4}(?:429|402|500|502|503|504|529)\b|\b429 too many requests\b|\brate[- _]?limit(?:ed|ing)?\b|\bquota\b[^\n]{0,24}\b(exceeded|exhausted|error|reached)\b|\b(exceeded|exhausted)\b[^\n]{0,24}\bquota\b|insufficient (?:credits|quota|balance)|requires more credits|\boverloaded(_error)?\b|temporarily unavailable|provider returned error|error sending request|socket hang ?up|\bECONNRESET\b/i

export const EVAL_REASONS = [
	"resolved",
	"patch_apply_failed",
	"empty_patch",
	"tamper_detected",
	// The transcript audit found the harness fetching the upstream fix (the PR,
	// its diff, the post-fix source, a newer package build). Fatal like tamper.
	"answer_lookup",
	"f2p_failed",
	"p2p_regression",
	"no_tests_ran",
	"test_timeout",
	"git_error"
]

// Kinds a leak audit can record on a trial. Only upstream_lookup is fatal: the
// harness reached the project that CONTAINS the answer. external_network is any
// other reach outside the sandbox (recorded, reported, not fatal); web_tool is a
// harness's built-in fetch/search tool being invoked.
export const LEAK_KINDS = ["upstream_lookup", "external_network", "web_tool"]

// What the leak audit needs to recognise the upstream project in a command or
// URL: the GitHub org/repo, the registry package, and the hosts that serve them.
export function repoIdentity(spec) {
	if (!spec || typeof spec !== "object") return null
	let org = spec.org ?? null
	let repo = spec.repo ?? null
	if ((!org || !repo) && typeof spec.url === "string") {
		const m = spec.url.match(/github\.com\/([^/]+)\/([^/.]+)/)
		if (m) {
			org = org || m[1]
			repo = repo || m[2]
		}
	}
	return {
		org,
		repo,
		package: spec.package ?? null,
		hosts: ["github.com", "api.github.com", "raw.githubusercontent.com", "patch-diff.githubusercontent.com", "objects.githubusercontent.com", "codeload.github.com", "gist.github.com", "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "pkg.go.dev", "crates.io", "static.crates.io", "docs.rs"]
	}
}

export function loadTasks(repo) {
	return fs
		.readFileSync(path.join(DATASET_DIR, repo, "tasks.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
}

// The task SPEC is the commit's own message. The task PROMPT wraps it in an
// explicit, harness-neutral instruction to act. Without that instruction a
// harness that treats a bare PR description as something to discuss rather
// than implement (Claude Code did: 27 of 36 trials ended in a clarifying
// question and an empty patch) is scored on prompt interpretation, not on
// engineering. Every harness receives the identical prompt.
//
// PROMPT_VERSION is recorded in each run's manifest; runs made under different
// versions did not receive the same input and must not be compared.
// v3: the spec is REDACTED (see redactSpec) and the instruction carries an
// offline rule. Under v2 every hono message ended in its PR number and the
// sandbox has network access for the model API, so agents fetched the fix from
// GitHub: 96 of 250 Claude Code trials, 21 of 50 reference, 27 of 50 pi.
export const PROMPT_VERSION = 3

export const TASK_INSTRUCTIONS = [
	"Implement the change described below in the git repository at your current working directory.",
	"Edit the source so the described behaviour works and the existing tests keep passing.",
	"Do not ask questions: make reasonable decisions and proceed.",
	"Do not commit, do not create branches, and do not modify anything outside this directory.",
	"Work only from the repository checkout in your working directory. Do not use the network to look anything up: no git fetch, clone or pull, no GitHub, no package registries, no web search or fetch. Everything needed is in the checkout, and a trial that reaches outside it is invalid.",
	"Stop when the change is complete."
].join(" ")

// The commit message as harvested. For the harvester and the report only: it
// carries the PR number and links that point straight at the fix.
export function taskSpecRaw(task) {
	const body = (task.message_body || "").trim()
	return body ? `${task.subject}\n\n${body}` : task.subject
}

// Answer pointers a commit message carries. Each rule names its kind so the
// redaction can be counted and reported. Order matters: URLs before bare
// references, trailers before SHAs (a trailer may carry one).
const ANSWER_HOSTS = /(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|github\.io|gist\.github\.com|gitlab\.com|bitbucket\.org)/i
const REDACTIONS = [
	// Co-authored-by: / Signed-off-by: / Reviewed-by: whole lines
	{kind: "trailer", re: /^[ \t]*(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|refs?):.*$/gim},
	// URLs on answer hosts (github, raw/patch-diff, gist, gitlab, bitbucket)
	{kind: "url", re: /\bhttps?:\/\/[^\s<>()\[\]"']+/gi, test: m => ANSWER_HOSTS.test(m)},
	// Fixes #123 / Closes #123 / Resolves #123 / Refs owner/repo#123 / see #123
	{kind: "issue_ref", re: /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|see|re|ref|refs|part of|related to|addresses|implements|reverts?)\s*:?\s*(?:[\w.-]+\/[\w.-]+)?(?:#|GH-|gh-)\d{1,7}(?:\s*,\s*(?:[\w.-]+\/[\w.-]+)?(?:#|GH-|gh-)\d{1,7})*/gi},
	// (#5222), owner/repo#5222, and bare #5222 / GH-5222, not preceded by a word
	// char (Array#push, C#) or a shebang
	{kind: "pr_ref", re: /\(\s*(?:[\w.-]+\/[\w.-]+)?(?:#|GH-|gh-)\d{1,7}\s*\)|(?<![\w!/#])[\w.-]+\/[\w.-]+#\d{1,7}\b|(?<![\w!/])(?:#|GH-|gh-)\d{2,7}\b|(?<=\w)#\d{3,7}\b/g},
	// ("compatibility#1228": a reference glued to a word is still a reference;
	// Array#push is not, because what follows its # is letters)
	// standalone commit SHAs: 7-40 hex, not inside a word or a version, and
	// containing both a letter and a digit (so 1234567 is a number, v4.13.7 a
	// version, and all-letter hex words such as "defaced" or "deadbeef" survive)
	{kind: "sha", re: /(?<![\w./#-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w./-])/gi}
]

// Strip everything that points at the answer, keeping the sentence readable.
export function redactSpec(text) {
	let out = String(text ?? "")
	const counts = {}
	for (const {kind, re, test} of REDACTIONS) {
		out = out.replace(re, m => {
			if (test && !test(m)) return m
			counts[kind] = (counts[kind] || 0) + 1
			return ""
		})
	}
	out = out
		.replace(/\(\s*\)/g, "")
		// a reference that opened a sentence leaves its punctuation behind
		.replace(/^[ \t]*[.,;:]+[ \t]*/gm, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([,.;:)])/g, "$1")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	return {text: out, counts}
}

// The redacted message: what every harness is given. If redaction empties the
// body the subject alone is the spec; if it empties the subject too the raw
// subject is kept, since a task with no spec would not be a task.
export function taskSpec(task) {
	const subject = redactSpec(task.subject).text || String(task.subject || "").trim()
	const body = redactSpec((task.message_body || "").trim()).text
	return body ? `${subject}\n\n${body}` : subject
}

taskSpec.redactions = task => {
	const a = redactSpec(task.subject).counts
	const b = redactSpec(task.message_body || "").counts
	const counts = {...a}
	for (const [k, v] of Object.entries(b)) counts[k] = (counts[k] || 0) + v
	counts.total = Object.values(counts).reduce((x, y) => x + y, 0)
	return counts
}

export function taskPrompt(task) {
	return `${TASK_INSTRUCTIONS}\n\n---\n\n${taskSpec(task)}`
}
