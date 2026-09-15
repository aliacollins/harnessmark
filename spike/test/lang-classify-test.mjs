#!/usr/bin/env node
// Dry classification test for the non-TypeScript corpora: synthetic path lists
// per language, no clone, no toolchain. Also pins the TypeScript rule to the
// no-spec behaviour so the hono/immer corpus cannot drift.
import {REPOS} from "../../harness/registry.mjs"
import {LANG_RULES, classify, isRunnableTest} from "../harvest.mjs"

let pass = 0
let fail = 0
const check = (c, m) => {
	if (c) pass++
	else {
		fail++
		console.log(`FAIL: ${m}`)
	}
}
const table = (spec, rows) => {
	for (const [p, kind, runnable] of rows) {
		const got = classify(p, spec)
		check(got === kind, `${spec.name}: ${p} -> ${got}, want ${kind}`)
		if (runnable !== undefined) check(isRunnableTest(p, spec) === runnable, `${spec.name}: runnable(${p}) want ${runnable}`)
	}
}

console.log("== python (httpx/click/fastapi) ==")
table(REPOS.httpx, [
	["tests/test_client.py", "test", true],
	["tests/models/test_requests.py", "test", true],
	["httpx/_client_test.py", "test", true],
	["tests/conftest.py", "support", undefined],
	["tests/fixtures/ca.pem", "support"],
	["tests/data/body.json", "support"],
	["httpx/_client.py", "source", false],
	["httpx/__init__.py", "source"],
	["pyproject.toml", "infra"],
	["setup.cfg", "infra"],
	["requirements.txt", "infra"],
	["requirements-tests.txt", "infra"],
	["tox.ini", "infra"],
	["README.md", "ignore"],
	["docs/index.rst", "ignore"],
	["CHANGELOG.txt", "ignore"],
	["uv.lock", "ignore"],
	["examples/demo.py", "ignore"]
])
check(isRunnableTest("tests/test_client.py", REPOS.click), "pytest runnable does not require .test./.spec. in the name")

console.log("== go (cobra/chi/gin) ==")
table(REPOS.chi, [
	["mux_test.go", "test", true],
	["middleware/logger_test.go", "test", true],
	["mux.go", "source", false],
	["middleware/logger.go", "source", false],
	["testdata/expected.txt", "support"],
	["middleware/testdata/req.golden", "support"],
	["go.mod", "infra"],
	["go.sum", "infra"],
	["README.md", "ignore"],
	[".github/workflows/ci.yml", "ignore"]
])
check(!isRunnableTest("mux.go", REPOS.gin), "go: a non-_test.go file is never a runner entry point")

console.log("== rust (clap/serde_json/axum) ==")
table(REPOS.clap, [
	["tests/builder/flags.rs", "test", true],
	["tests/derive/basic.rs", "test", true],
	["src/parser/tests.rs", "test", true],
	["src/builder/arg.rs", "source", true],
	["src/lib.rs", "source"],
	["build.rs", "source"],
	["tests/ui/error.stderr", "support"],
	["tests/snapshots/help.snap", "support"],
	["tests/fixtures/config.toml", "support"],
	["Cargo.toml", "infra"],
	["clap_builder/Cargo.toml", "infra"],
	["rust-toolchain.toml", "infra"],
	[".config/nextest.toml", "infra"],
	["Cargo.lock", "ignore"],
	["README.md", "ignore"],
	["examples/demo.rs", "ignore"]
])

console.log("== typescript unchanged ==")
const TS = [
	"src/__snapshots__/foo.test.ts.snap",
	"test/__fixtures__/data.json",
	"vitest.config.ts",
	"test/app.test.ts",
	"src/index.ts",
	"src/utils/url.test.ts",
	"src/middleware/etag/index.spec.tsx",
	"package.json",
	"yarn.lock",
	"README.md",
	"deno_dist/mod.ts",
	"benchmarks/bench.ts"
]
for (const p of TS) {
	check(classify(p, REPOS.hono) === classify(p), `hono spec == no-spec for ${p}`)
	check(classify(p, REPOS.immer) === classify(p), `immer spec == no-spec for ${p}`)
	check(isRunnableTest(p, REPOS.hono) === isRunnableTest(p), `hono runnable spec == no-spec for ${p}`)
}
check(classify("test/app.test.ts") === "test" && classify("vitest.config.ts") === "infra" && classify("src/index.ts") === "source", "ts kinds")
check(classify("tests/test_x.py", "klingon") === classify("tests/test_x.py"), "unknown lang falls back to the TypeScript rule")
check(["python", "go", "rust"].every(l => l in LANG_RULES), "rules exist for every non-TS language in the registry")
for (const spec of Object.values(REPOS)) {
	if (spec.lang === "ts") continue
	check(spec.lang in LANG_RULES, `${spec.name}: lang ${spec.lang} has harvest rules`)
}

console.log(`\nALL ${fail ? "FAIL" : "PASS"}: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
