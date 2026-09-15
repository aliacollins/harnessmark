import fs from "node:fs"
import path from "node:path"
import {dockerArgv, makeRuntime, runtimeMode} from "../runtime.mjs"

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

console.log("== mode selection ==")
eq(runtimeMode({}), "local", "default mode is local")
eq(runtimeMode({BENCH_RUNTIME: "Docker "}), "docker", "mode is trimmed and case-insensitive")
let threw = false
try {
	runtimeMode({BENCH_RUNTIME: "podman"})
} catch {
	threw = true
}
ok(threw, "unknown mode throws")

console.log("== docker argv (construction only; docker itself is unavailable here) ==")
const spec = {name: "immer", image: "harness-bench/immer:v1", deps: "node_modules"}
const argv = dockerArgv(spec, "corepack", ["yarn", "vitest", "run", "a.test.ts"], {
	cwd: "/host/wt",
	scratch: {host: "/tmp/s1", guest: "/bench-scratch"},
	env: {CI: "1"}
})
eq(argv.slice(0, 4), ["run", "--rm", "--network", "none"], "no network inside the grading container")
ok(argv.includes("/host/wt:/work"), "worktree mounted at /work")
eq(argv[argv.indexOf("-w") + 1], "/work", "cwd is /work")
ok(argv.includes("/tmp/s1:/bench-scratch"), "scratch dir mounted for the report file")
ok(argv.includes("bench-deps-immer:/work/node_modules"), "baked deps volume shadows the host symlink")
ok(argv.includes("CI=1"), "env forwarded with -e")
const imgIdx = argv.indexOf("harness-bench/immer:v1")
eq(argv.slice(imgIdx + 1), ["corepack", "yarn", "vitest", "run", "a.test.ts"], "command follows the image verbatim")
const noDeps = dockerArgv({name: "chi", image: "i"}, "go", ["test"], {cwd: "/w"})
ok(!noDeps.some(a => a.startsWith("bench-deps-")), "no deps dir -> no deps volume")
threw = false
try {
	dockerArgv({name: "x"}, "go", [], {cwd: "/w"})
} catch {
	threw = true
}
ok(threw, "spec without image cannot run in docker")

const dr = makeRuntime(spec, {mode: "docker"})
eq(dr.mode, "docker", "docker runtime reports its mode")
const ds = dr.scratch()
ok(fs.existsSync(ds.host) && ds.guest === "/bench-scratch", "docker scratch: host tmp dir, fixed guest path")
fs.rmSync(ds.host, {recursive: true, force: true})

console.log("== local executor ==")
const lr = makeRuntime(spec, {mode: "local"})
eq(lr.mode, "local", "local runtime reports its mode")
const ls = lr.scratch()
ok(ls.host === ls.guest && fs.existsSync(ls.host), "local scratch: same path both sides")
const r1 = await lr.exec(process.execPath, ["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], {cwd: ls.host, timeoutMs: 10_000})
eq([r1.code, r1.stdout, r1.stderr, r1.timedOut], [3, "out", "err", false], "captures stdout, stderr, exit code")
const r2 = await lr.exec(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], {cwd: ls.host, timeoutMs: 300})
ok(r2.timedOut === true, "timeout kills the process and flags timedOut")
const r3 = await lr.exec(process.execPath, ["-e", "process.stdout.write(process.env.BENCH_X)"], {cwd: ls.host, timeoutMs: 5000, env: {BENCH_X: "y"}})
eq(r3.stdout, "y", "env is merged into the child")
const r4 = await lr.exec("/definitely/not/a/binary", [], {cwd: ls.host, timeoutMs: 5000})
ok(r4.code === null, "spawn failure resolves with a null code instead of throwing")
const r5 = await lr.exec(process.execPath, ["-e", `require("fs").writeFileSync(process.argv[1], "hi")`, path.join(ls.guest, "report.json")], {cwd: ls.host, timeoutMs: 5000})
eq(fs.readFileSync(path.join(ls.host, "report.json"), "utf8"), "hi", "a file written to the guest scratch path is readable at the host path")
fs.rmSync(ls.host, {recursive: true, force: true})

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) for (const f of failures) console.log(` - ${f}`)
process.exit(fail ? 1 : 0)
