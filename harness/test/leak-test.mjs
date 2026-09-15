import {LEAK_KINDS, auditCommands, auditTranscript, extractCommands, identityFromSpec} from "../leak.mjs"

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
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const ID = {org: "honojs", repo: "hono", package: "hono"}
const kindOf = (cmd, tool = "Bash") => {
	const r = auditCommands([{tool, command: cmd}], ID)
	return r.findings.length ? r.findings[0].kind : "clean"
}

console.log("== fatal upstream lookups ==")
for (const c of [
	"gh pr view 4717 --repo honojs/hono --json title,body,files 2>&1 | head -200",
	'cd "/w/x" && git remote -v; gh pr view 5166 --repo honojs/hono 2>&1 | head -100',
	"gh api repos/honojs/hono/pulls/5205 2>&1 | head -50",
	"cd /tmp && curl -sL --max-time 20 https://patch-diff.githubusercontent.com/raw/honojs/hono/pull/5102.diff -o pr.diff",
	'curl -s "https://api.github.com/repos/honojs/hono/pulls/5102/files" | head -200',
	'timeout 15 curl -sL "https://raw.githubusercontent.com/honojs/hono/main/src/middleware/trailing-slash/index.ts" | head',
	"wget -q https://github.com/honojs/hono/archive/refs/heads/main.zip",
	"timeout 15 git ls-remote https://github.com/honojs/hono HEAD 2>&1 | head",
	"git fetch",
	"git fetch origin main",
	"git pull",
	"git clone https://github.com/honojs/hono /tmp/upstream",
	"git clone git@github.com:honojs/hono.git",
	"npm view hono versions --json",
	"npm pack hono@4.13.8",
	"npm install hono@latest",
	"npx hono@4.13.8 --help",
	"pnpm add hono@4.13.8",
	"curl -s https://registry.npmjs.org/hono | head -c 400",
	"curl -sL https://unpkg.com/hono@4.13.8/dist/index.js",
	"curl -sL https://cdn.jsdelivr.net/npm/hono@4.13.8/dist/index.js"
]) {
	eq(kindOf(c), "upstream_lookup", `upstream: ${c.slice(0, 70)}`)
}

console.log("== non-fatal external network ==")
for (const c of ["curl https://example.com/x", "wget -q https://deno.land/x/foo/mod.ts", "git clone https://github.com/other/thing", "gh api rate_limit", "npm install", "npm view lodash version", "pip download requests", "cargo search serde", "npx create-react-app@latest x", "git push origin HEAD"]) {
	eq(kindOf(c), "external_network", `external: ${c.slice(0, 60)}`)
}

console.log("== clean local commands ==")
for (const c of [
	"curl -s http://localhost:3000/",
	"curl -i http://127.0.0.1:8787/api/health",
	"curl -X POST http://0.0.0.0:3000/users -d '{}'",
	"git log --oneline -5 && git status",
	"git diff HEAD~1 -- src/",
	"git show abc1234 --stat",
	"git remote -v",
	"git submodule status",
	"npx vitest run src/a.test.ts",
	"npx tsc --noEmit",
	"npx eslint src",
	"gh --version",
	"cat src/hono.ts",
	"ls node_modules/hono",
	"echo see https://github.com/honojs/hono/pull/1",
	'grep -rn "curl https://github.com/honojs/hono" src | head',
	'rg "api.github.com/repos/honojs/hono" -l',
	"npm test",
	"npm run build",
	"yarn vitest run __tests__/base.js",
	"cd /w && node -e \"console.log(1)\"",
	"sed -n 1,40p src/router.ts"
]) {
	eq(kindOf(c), "clean", `clean: ${c.slice(0, 60)}`)
}

console.log("== web tools ==")
eq(auditCommands([{tool: "WebFetch", command: "WebFetch https://github.com/honojs/hono/pull/5222", url: "https://github.com/honojs/hono/pull/5222"}], ID).findings[0].kind, "upstream_lookup", "WebFetch of the upstream PR is fatal")
eq(auditCommands([{tool: "WebSearch", command: "WebSearch hono etag If-None-Match whitespace", query: "hono etag If-None-Match whitespace"}], ID).findings[0].kind, "upstream_lookup", "WebSearch naming the project is fatal")
eq(auditCommands([{tool: "WebFetch", command: "WebFetch https://developer.mozilla.org/x", url: "https://developer.mozilla.org/x"}], ID).findings[0].kind, "web_tool", "WebFetch of unrelated docs is recorded, not fatal")
{
	const r = auditCommands([{tool: "WebFetch", command: "WebFetch https://developer.mozilla.org/x", url: "https://developer.mozilla.org/x"}], ID)
	eq(r.clean, true, "a non-fatal web tool leaves the trial clean")
	eq(r.counts, {upstream_lookup: 0, external_network: 0, web_tool: 1}, "counts by kind")
}

console.log("== extraction per transcript format ==")
{
	const claude = [
		{type: "system", subtype: "init"},
		{type: "assistant", parent_tool_use_id: null, message: {id: "m1", content: [{type: "tool_use", id: "t1", name: "Bash", input: {command: "gh pr view 4717 --repo honojs/hono --json files"}}]}},
		{type: "user", message: {content: [{type: "tool_result", tool_use_id: "t1", content: "{...}"}]}},
		{type: "assistant", parent_tool_use_id: "t9", message: {id: "s1", content: [{type: "tool_use", id: "s2", name: "Bash", input: {command: "curl https://api.github.com/repos/honojs/hono/pulls/1"}}]}},
		{type: "assistant", parent_tool_use_id: null, message: {id: "m2", content: [{type: "tool_use", id: "t3", name: "WebFetch", input: {url: "https://developer.mozilla.org/x"}}]}},
		{type: "assistant", parent_tool_use_id: null, message: {id: "m3", content: [{type: "tool_use", id: "t4", name: "Read", input: {file_path: "/w/src/a.ts"}}, {type: "text", text: "curl https://github.com/honojs/hono in prose is not a command"}]}},
		{type: "assistant", parent_tool_use_id: null, message: {id: "m4", content: [{type: "tool_use", id: "t5", name: "ToolSearch", input: {query: "select:WebFetch"}}, {type: "tool_use", id: "t6", name: "Task", input: {subagent_type: "Explore", prompt: "find hono router"}}, {type: "tool_use", id: "t7", name: "Grep", input: {pattern: "github.com/honojs/hono"}}]}},
		{type: "result", subtype: "success"}
	].map(e => JSON.stringify(e)).join("\n") + "\n--- stderr ---\nnoise"
	const cmds = extractCommands(claude, {adapter: "claude"})
	eq(cmds.length, 3, "claude: Bash x2 (one via sub-agent) + WebFetch; Read, ToolSearch, Task, Grep and prose are not commands")
	eq(cmds.map(c => c.via_subagent), [false, true, false], "sub-agent commands are tagged")
	const audit = auditTranscript(claude, {adapter: "claude", identity: ID})
	eq(audit.clean, false, "claude transcript is not clean")
	eq(audit.counts, {upstream_lookup: 2, external_network: 0, web_tool: 1}, "claude counts: two upstream lookups incl. the sub-agent's, one web tool")
	eq(audit.findings.filter(f => f.fatal).length, 2, "two fatal findings")
	eq(audit.commands_scanned, 3, "commands_scanned reports what was examined")
	ok(audit.findings.some(f => f.via_subagent === true && f.fatal), "a sub-agent fetching the answer is fatal")
}
{
	const pi = [
		{type: "tool_execution_start", toolName: "bash", args: {command: "cd /tmp && curl -sL https://patch-diff.githubusercontent.com/raw/honojs/hono/pull/5102.diff -o x"}},
		{type: "tool_execution_end", toolName: "bash", result: {content: [{type: "text", text: "curl https://github.com/honojs/hono/pull/1 in OUTPUT is not a command"}]}},
		{type: "tool_execution_start", toolName: "read", args: {path: "/w/src/a.ts"}},
		{type: "tool_execution_start", toolName: "bash", args: {command: "npx vitest run src/a.test.ts"}}
	].map(e => JSON.stringify(e)).join("\n")
	const a = auditTranscript(pi, {adapter: "pi", identity: ID})
	eq(a.commands_scanned, 2, "pi: two bash commands, read is not a command")
	eq(a.clean, false, "pi transcript with a PR diff fetch is fatal")
	eq(a.counts.upstream_lookup, 1, "one upstream lookup")
	const ref = auditTranscript(pi, {adapter: "reference", identity: ID})
	eq(ref.counts.upstream_lookup, 1, "reference uses the pi parser")
}
{
	const codex = [
		{type: "item.completed", item: {type: "command_execution", command: ["bash", "-lc", "curl -s https://api.github.com/repos/honojs/hono/pulls/9/files"]}},
		{type: "item.completed", item: {type: "agent_message", text: "curl https://github.com/honojs/hono is prose"}},
		{type: "item.completed", item: {type: "command_execution", command: "npx vitest run"}},
		{type: "item.completed", item: {type: "web_search", query: "hono jwt middleware"}}
	].map(e => JSON.stringify(e)).join("\n")
	const a = auditTranscript(codex, {adapter: "codex", identity: ID})
	eq(a.commands_scanned, 3, "codex: two commands + one web search; agent_message is prose")
	eq(a.counts, {upstream_lookup: 2, external_network: 0, web_tool: 0}, "codex: curl of the PR and a web search naming the project are both fatal")
	const any = auditTranscript(codex, {adapter: undefined, identity: ID})
	eq(any.counts.upstream_lookup, 2, "unknown adapter tries every parser")
}
{
	const a = auditTranscript("", {adapter: "claude", identity: ID})
	eq([a.clean, a.commands_scanned, a.findings.length], [true, 0, 0], "an empty transcript is clean with nothing scanned")
	const b = auditTranscript("not json at all\nplain text prompt=curl https://github.com/honojs/hono", {adapter: "pi", identity: ID})
	eq(b.clean, true, "plain-text transcripts carry no executed commands")
}

console.log("== identity ==")
eq(identityFromSpec({url: "https://github.com/honojs/hono", name: "hono"}), {org: "honojs", repo: "hono", package: "hono", hosts: ["github.com", "api.github.com", "raw.githubusercontent.com", "patch-diff.githubusercontent.com", "codeload.github.com"]}, "identity derived from the clone url")
eq(identityFromSpec({url: "", name: "synth"}).repo, "synth", "no url: repo falls back to the spec name")
{
	const other = {org: "immerjs", repo: "immer", package: "immer"}
	eq(auditCommands([{tool: "Bash", command: "gh pr view 1 --repo honojs/hono"}], other).findings[0].kind, "external_network", "another project's PR is external, not upstream")
	eq(auditCommands([{tool: "Bash", command: "npm view immer versions"}], other).findings[0].kind, "upstream_lookup", "package match is per identity")
	eq(auditCommands([{tool: "Bash", command: "cat src/immer.ts && ls node_modules/immer"}], other).findings.length, 0, "package name in a path is not a lookup")
}
eq(LEAK_KINDS, ["upstream_lookup", "external_network", "web_tool"], "kinds are exported")

console.log(`\npass=${pass} fail=${fail}`)
if (failures.length) {
	console.log("failures:")
	for (const f of failures) console.log(` - ${f}`)
}
process.exit(fail ? 1 : 0)
