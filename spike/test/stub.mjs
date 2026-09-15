#!/usr/bin/env node
// Tiny test-runner stub for spike/test/negative-control.mjs.
// Emits controlled vitest-shaped output based on STUB_SCENARIO and the state of
// the synthetic working tree (whether the oracle test marker is present and
// whether src/lib.js has the fix applied). No dependencies.
import fs from "node:fs"
import path from "node:path"

const scenario = process.env.STUB_SCENARIO || "positive"
const counterPath = process.env.STUB_COUNTER || ""
const args = process.argv.slice(2)
const testFile = args.find(a => /\.test\.(m?js|ts)$/.test(a)) || args[0] || "test/lib.test.js"

// Optional path log (used by the rename regression cases to assert which path the
// clean-parent control actually ran against).
const logPath = process.env.STUB_LOG || ""
if (logPath) {
	try {
		fs.appendFileSync(logPath, `${testFile}\n`)
	} catch {}
}

const read = p => {
	try {
		return fs.readFileSync(path.resolve(process.cwd(), p), "utf8")
	} catch {
		return ""
	}
}

const oracle = read(testFile).includes("ORACLE_CASE")
const fixed = /return\s+a\s*\+\s*b/.test(read("src/lib.js"))
const oracleRun = oracle && !fixed

const green = (n = 2) => {
	console.log(" Test Files  1 passed (1)")
	console.log(`      Tests  ${n} passed (${n})`)
	process.exit(0)
}
const assertionFail = (passed = 1, failed = 1) => {
	console.log(" Test Files  1 failed (1)")
	console.log(`      Tests  ${failed} failed | ${passed} passed (${passed + failed})`)
	process.exit(1)
}
const collection = () => {
	console.log(" Test Files  1 failed (1)")
	console.log("      Tests  no tests")
	process.exit(1)
}
const zeroGreen = () => {
	console.log(" Test Files  no tests")
	console.log("      Tests  no tests")
	process.exit(0)
}
const unparseable = () => {
	console.log("totally unparseable runner output")
	process.exit(2)
}
const readCount = () => {
	try {
		return +fs.readFileSync(counterPath, "utf8") || 0
	} catch {
		return 0
	}
}
const bumpCount = () => {
	if (counterPath) fs.writeFileSync(counterPath, String(readCount() + 1))
}

switch (scenario) {
	case "positive":
		oracleRun ? assertionFail(1, 1) : green(2)
		break
	case "collection":
		oracleRun ? collection() : green(2)
		break
	case "unparseable":
		oracleRun ? unparseable() : green(2)
		break
	case "zero_fix":
		if (oracleRun) assertionFail(1, 1)
		else if (oracle && fixed) zeroGreen()
		else green(2)
		break
	case "pre_existing":
		oracleRun ? assertionFail(1, 1) : !oracle && !fixed ? assertionFail(1, 1) : green(2)
		break
	case "rename_path":
		// The moved test's behavior depends on its path (e.g. relative imports or a
		// filename-keyed runner): green at the old path, red once moved to the new
		// path, green again once the source fix is applied. Exercises an R100 rename
		// whose old path is green at the parent.
		fixed ? green(2) : /new\.test\./.test(testFile) ? assertionFail(1, 1) : green(2)
		break
	case "flaky":
		if (oracleRun) {
			const c = readCount()
			bumpCount()
			c === 0 ? assertionFail(1, 1) : green(2)
		} else green(2)
		break
	case "apply_fail":
		// Mutate the target with conflicting content so both `git apply` and
		// `git apply --3way` reject the oracle patch.
		if (!oracle && !fixed) {
			try {
				fs.writeFileSync(path.resolve(process.cwd(), testFile), "CONFLICTING WORKING TREE CONTENT\n")
			} catch {}
			green(2)
		} else green(2)
		break
	default:
		green(2)
}
