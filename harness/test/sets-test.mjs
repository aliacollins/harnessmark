import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawnSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import {loadTasks} from "../registry.mjs"
import {RULES, SETS_DIR, generateSet, listSets, loadChainsFor, loadSet, resolveSet, setRepos} from "../sets.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SETS_MJS = path.join(HERE, "..", "sets.mjs")

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg) {
	if (cond) pass++
	else {
		fail++
		failures.push(msg)
		console.log(`  FAIL ${msg}`)
	}
}
function eq(a, b, msg) {
	const x = JSON.stringify(a)
	const y = JSON.stringify(b)
	ok(x === y, `${msg} (got ${x}, want ${y})`)
}
function throws(fn, re, msg) {
	try {
		fn()
		ok(false, `${msg} (did not throw)`)
	} catch (e) {
		ok(re.test(e.message), `${msg} (threw: ${e.message})`)
	}
}

const stripFrozen = s => ({...s, frozen_at: null})

console.log("== checked-in sets load, resolve, and match their generation rule ==")
for (const name of Object.keys(RULES)) {
	ok(listSets().includes(name), `sets/${name}.json is checked in`)
	const set = loadSet(name)
	eq(set.name, name, `${name}: name matches`)
	const resolved = resolveSet(name)
	eq(resolved.repos, [RULES[name].describe.repo], `${name}: covers exactly its repo`)
	const slice = resolved.byRepo[resolved.repos[0]]
	eq(slice.tasks.length, set.tasks.length, `${name}: every pinned sha resolves to a task record`)
	eq(slice.chains.length, set.chains.length, `${name}: every pinned chain resolves`)
	// Determinism: regenerating from the rule reproduces the file exactly (modulo timestamp).
	const regenerated = generateSet(name)
	eq(stripFrozen(regenerated), stripFrozen(set), `${name}: the checked-in file equals what the rule generates`)
}

console.log("== dev-hono-50 composition ==")
{
	const set = loadSet("dev-hono-50")
	const hono = loadTasks("hono")
	const bySha = new Map(hono.map(t => [t.sha, t]))
	eq(set.tasks.length, 50, "50 tasks")
	ok(set.tasks.every(t => bySha.get(t.sha).category !== "unknown"), "no task with category unknown")
	const buckets = {}
	for (const t of set.tasks) buckets[bySha.get(t.sha).size_bucket] = (buckets[bySha.get(t.sha).size_bucket] || 0) + 1
	const allXL = hono.filter(t => t.size_bucket === "XL" && t.category !== "unknown").length
	const allL = hono.filter(t => t.size_bucket === "L" && t.category !== "unknown").length
	eq(buckets.XL, allXL, "every non-unknown XL task is in the set")
	eq(buckets.L, allL, "every non-unknown L task is in the set")
	eq(buckets.S ?? 0, 0, "no S task made the cut while M tasks remained")
	eq(buckets.XS ?? 0, 0, "no XS task made the cut")
	// Bucket order then sha order.
	const rank = {XL: 0, L: 1, M: 2, S: 3, XS: 4}
	let ordered = true
	for (let i = 1; i < set.tasks.length; i++) {
		const a = set.tasks[i - 1]
		const b = set.tasks[i]
		const ra = rank[bySha.get(a.sha).size_bucket]
		const rb = rank[bySha.get(b.sha).size_bucket]
		if (ra > rb || (ra === rb && a.sha > b.sha)) ordered = false
	}
	ok(ordered, "tasks are ordered by bucket (XL, L, M) then sha ascending")
	const chains = loadChainsFor("hono")
	const long = chains.filter(c => c.steps.length >= 3).map(c => c.chain_id).sort()
	eq(
		set.chains.map(c => c.chain_id),
		long,
		"every hono chain with >= 3 steps is pinned, in chain_id order"
	)
	ok(set.chains.every(c => c.length >= 3), "no pinned chain is shorter than 3 steps")
	ok(set.selection && set.selection.exclude_categories.includes("unknown"), "the json records the exclusion rule")
}

console.log("== dev-immer-12 composition ==")
{
	const set = loadSet("dev-immer-12")
	const immer = loadTasks("immer")
	eq(set.tasks.length, immer.length, "pins every immer task")
	eq(
		set.tasks.map(t => t.sha),
		immer.map(t => t.sha).sort(),
		"immer tasks are pinned in sha order"
	)
}

console.log("== loading is strict ==")
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-test-"))
	const write = (name, obj) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(obj))
	const good = {name: "good", version: 1, frozen_at: "2026-09-12T00:00:00.000Z", selection: {kind: "x"}, tasks: [{repo: "r", sha: "a".repeat(40)}], chains: []}
	write("good", good)
	eq(loadSet("good", {dir}).tasks.length, 1, "a well-formed set loads")
	eq(setRepos(loadSet("good", {dir})), ["r"], "setRepos lists the repos")
	throws(() => loadSet("missing", {dir}), /unknown set "missing".*available: good/, "a missing set names the available ones")
	write("shortsha", {...good, name: "shortsha", tasks: [{repo: "r", sha: "abc"}]})
	throws(() => loadSet("shortsha", {dir}), /40-hex/, "a short sha is rejected")
	write("dup", {...good, name: "dup", tasks: [good.tasks[0], good.tasks[0]]})
	throws(() => loadSet("dup", {dir}), /duplicate task/, "a duplicate task is rejected")
	write("wrongname", {...good, name: "other"})
	throws(() => loadSet("wrongname", {dir}), /names itself/, "a file whose name field disagrees is rejected")
	write("noversion", {...good, name: "noversion", version: "1"})
	throws(() => loadSet("noversion", {dir}), /version/, "a non-integer version is rejected")
	write("nofreeze", {...good, name: "nofreeze", frozen_at: "yesterday"})
	throws(() => loadSet("nofreeze", {dir}), /frozen_at/, "an unparseable frozen_at is rejected")
	write("norule", {...good, name: "norule", selection: null})
	throws(() => loadSet("norule", {dir}), /selection/, "a set without a selection rule is rejected")
	throws(() => loadSet("../escape", {dir}), /invalid set name/, "a path-like set name is rejected")

	// resolveSet fails loudly on any pinned id the dataset no longer has.
	const tasks = () => [{sha: "a".repeat(40)}]
	const chains = () => [{chain_id: "c1", steps: [{}, {}, {}]}]
	eq(resolveSet("good", {dir, tasks, chains}).byRepo.r.tasks.length, 1, "resolveSet joins pinned shas to records")
	write("stale", {...good, name: "stale", tasks: [{repo: "r", sha: "b".repeat(40)}], chains: [{repo: "r", chain_id: "gone"}]})
	throws(() => resolveSet("stale", {dir, tasks, chains}), /2 pinned id\(s\) not found/, "a stale sha and a stale chain both fail loudly")
	write("two", {...good, name: "two", tasks: [{repo: "r", sha: "a".repeat(40)}, {repo: "s", sha: "a".repeat(40)}]})
	eq(resolveSet("two", {dir, tasks, chains}).repos, ["r", "s"], "a multi-repo set reports both repos")
	eq(resolveSet("two", {dir, tasks, chains, repo: "s"}).repos, ["s"], "repo filter narrows to one slice")
	throws(() => resolveSet("two", {dir, tasks, chains, repo: "zz"}), /has no tasks or chains for repo/, "a repo filter that matches nothing fails")
	throws(() => generateSet("nope"), /no generation rule/, "generating an unknown set fails")

	// CLI round trip into a scratch dir.
	const r = spawnSync(process.execPath, [SETS_MJS, "--generate", "dev-immer-12", "--out", dir], {encoding: "utf8"})
	eq(r.status, 0, `--generate exits 0 (${(r.stderr || "").trim()})`)
	eq(stripFrozen(loadSet("dev-immer-12", {dir})), stripFrozen(loadSet("dev-immer-12")), "--generate --out writes the same set as the checked-in one")
	const rShow = spawnSync(process.execPath, [SETS_MJS, "--show", "dev-hono-50"], {encoding: "utf8"})
	ok(rShow.status === 0 && /"tasks": 50/.test(rShow.stdout), "--show prints the composition")
	const rBad = spawnSync(process.execPath, [SETS_MJS, "--show", "nope"], {encoding: "utf8"})
	ok(rBad.status === 1 && /unknown set/.test(rBad.stderr), "--show of an unknown set exits 1")
	fs.rmSync(dir, {recursive: true, force: true})
	ok(fs.existsSync(SETS_DIR), "SETS_DIR points at the checked-in sets directory")
}

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const m of failures) console.log(` - ${m}`)
}
process.exit(fail ? 1 : 0)
