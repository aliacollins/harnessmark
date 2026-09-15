// Answer-lookup audit. The sandbox truncates git history and strips the remote,
// so the fix commit is unreachable LOCALLY, but the harness needs the network to
// reach its model, and the fix is public upstream. An agent that runs
// `gh pr view 4717 --repo honojs/hono --json files` or curls the PR diff has read
// the answer key. That cannot be seen in the patch, only in the commands the
// harness executed, so the transcript is audited and a trial that looked up the
// answer is recorded as `answer_lookup` and can never count as resolved, exactly
// like tampering with the oracle tests.
//
// Outcome-blind and harness-neutral: the same rules are applied to every
// transcript format, and only commands the harness actually EXECUTED are
// examined, never the prompt or file contents. Sub-agent commands count: a
// sub-agent fetching the answer is still the harness fetching the answer.
//
// kinds:
//   upstream_lookup  FATAL   a network command aimed at the project under test
//   external_network         any other network command (recorded, not fatal)
//   web_tool                 a web fetch/search tool not aimed at the project
export const LEAK_AUDIT_VERSION = 1
export const LEAK_KINDS = ["upstream_lookup", "external_network", "web_tool"]

const asStr = v => (typeof v === "string" ? v : v == null ? "" : Array.isArray(v) ? v.map(asStr).join(" ") : typeof v === "object" ? JSON.stringify(v) : String(v))

function parseJsonl(text) {
	const out = []
	for (const line of String(text).split("\n")) {
		const s = line.trim()
		if (!s || s[0] !== "{") continue
		try {
			out.push(JSON.parse(s))
		} catch {}
	}
	return out
}

// Tools that reach the web. Deliberately a list, not a substring match: Claude
// Code's ToolSearch (which takes a `query`) and pi's local tools must not count.
const WEB_TOOL_RE = /^(WebFetch|WebSearch|web_?fetch|web_?search|fetch|fetch_url|browse|browser|open_url|http_get|curl)$|^mcp__.*(fetch|browse|search|http)/i

// ---------------------------------------------------------------- extraction

function fromClaude(events, out) {
	for (const ev of events) {
		if (!ev || ev.type !== "assistant") continue
		const via = typeof ev.parent_tool_use_id === "string" && ev.parent_tool_use_id !== ""
		const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : []
		for (const b of content) {
			if (!b || b.type !== "tool_use") continue
			const input = b.input && typeof b.input === "object" ? b.input : {}
			if (b.name === "Bash" || b.name === "bash") {
				if (typeof input.command === "string") out.push({tool: b.name, command: input.command, via_subagent: via})
			} else if (b.name === "WebFetch") {
				out.push({tool: b.name, command: `WebFetch ${asStr(input.url)}`, url: asStr(input.url), via_subagent: via})
			} else if (b.name === "WebSearch") {
				out.push({tool: b.name, command: `WebSearch ${asStr(input.query)}`, query: asStr(input.query), via_subagent: via})
			} else if (WEB_TOOL_RE.test(b.name) && (input.url || input.query)) {
				out.push({tool: b.name, command: `${b.name} ${asStr(input.url || input.query)}`, url: asStr(input.url || ""), via_subagent: via})
			}
		}
	}
}

function fromPi(events, out) {
	for (const ev of events) {
		if (!ev || ev.type !== "tool_execution_start") continue
		const name = typeof ev.toolName === "string" ? ev.toolName : ""
		const args = ev.args && typeof ev.args === "object" ? ev.args : {}
		if (name.toLowerCase() === "bash") {
			if (typeof args.command === "string") out.push({tool: name, command: args.command, via_subagent: false})
		} else if (WEB_TOOL_RE.test(name)) {
			const url = asStr(args.url || args.uri || "")
			const q = asStr(args.query || args.q || "")
			out.push({tool: name, command: `${name} ${url || q || asStr(args)}`, url, query: q, via_subagent: false})
		}
	}
}

function fromCodex(events, out) {
	for (const ev of events) {
		if (!ev || ev.type !== "item.completed" || !ev.item || typeof ev.item !== "object") continue
		const it = ev.item
		if (it.type === "command_execution") {
			// codex records argv; a ["bash","-lc","<cmd>"] wrapper is unwrapped so the
			// inner command is what gets classified.
			let cmd
			if (Array.isArray(it.command) && it.command.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(asStr(it.command[0])) && /^-[a-z]*c[a-z]*$/.test(asStr(it.command[1]))) cmd = asStr(it.command.slice(2))
			else cmd = asStr(it.command)
			if (cmd) out.push({tool: "command_execution", command: cmd, via_subagent: false})
		} else if (it.type === "web_search") {
			out.push({tool: "web_search", command: `web_search ${asStr(it.query)}`, query: asStr(it.query), via_subagent: false})
		} else if (it.type === "mcp_tool_call" && WEB_TOOL_RE.test(asStr(it.tool || it.name))) {
			out.push({tool: asStr(it.tool || it.name), command: `${asStr(it.tool || it.name)} ${asStr(it.arguments || it.input)}`, via_subagent: false})
		}
	}
}

// What the harness EXECUTED, per transcript format. Unknown adapters get every
// parser; the formats do not collide (different `type` values).
export function extractCommands(text, {adapter} = {}) {
	const events = parseJsonl(text)
	const out = []
	const a = typeof adapter === "string" ? adapter.toLowerCase() : ""
	if (a.startsWith("claude")) fromClaude(events, out)
	else if (a.startsWith("pi") || a.startsWith("reference")) fromPi(events, out)
	else if (a.startsWith("codex")) fromCodex(events, out)
	else {
		fromClaude(events, out)
		fromPi(events, out)
		fromCodex(events, out)
	}
	return out
}

// ---------------------------------------------------------------- classification

const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[^\s/]*\.local|host\.docker\.internal)$/i
const URL_RE = /\bhttps?:\/\/([^\s"'`<>)\]]+)/gi
const GITHUB_HOST_RE = /^(www\.)?(github\.com|api\.github\.com|raw\.githubusercontent\.com|patch-diff\.githubusercontent\.com|codeload\.github\.com|objects\.githubusercontent\.com|gist\.github\.com)$/i
const REGISTRY_HOST_RE = /^(registry\.npmjs\.org|registry\.yarnpkg\.com|unpkg\.com|cdn\.jsdelivr\.net|esm\.sh|www\.npmjs\.com|npmjs\.com|pypi\.org|files\.pythonhosted\.org|crates\.io|static\.crates\.io|docs\.rs|deno\.land|jsr\.io|pkg\.go\.dev|proxy\.golang\.org)$/i

function hostOf(urlish) {
	let rest = urlish.replace(/^https?:\/\//i, "")
	rest = rest.replace(/^[^@/]+@/, "")
	const host = rest.split(/[/?#]/)[0].split(":")[0]
	return host.toLowerCase()
}

function pathOf(urlish) {
	const rest = urlish.replace(/^https?:\/\//i, "")
	const i = rest.indexOf("/")
	return i < 0 ? "" : rest.slice(i)
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function projectMatchers(identity) {
	const org = identity && identity.org ? String(identity.org) : ""
	const repo = identity && identity.repo ? String(identity.repo) : ""
	const pkg = identity && identity.package ? String(identity.package) : ""
	return {
		org,
		repo,
		pkg,
		slug: org && repo ? new RegExp(`(?:^|[/\\s"'=:])${esc(org)}/${esc(repo)}(?:[/\\s"'.?#]|\\.git|$)`, "i") : null,
		pkgToken: pkg ? new RegExp(`^${esc(pkg)}(?:@[^\\s]*)?$`, "i") : null,
		pkgPath: pkg ? new RegExp(`^/(?:npm/|project/|crates/|simple/|package/|x/)?${esc(pkg)}(?:[@/?#]|$)`, "i") : null
	}
}

// Leading `VAR=x`, `timeout 20`, `sudo`, `time`, `command`, `env`, `nohup`, `exec`
// wrappers are stripped so the network verb is the first word of the segment.
function verbOf(segment) {
	let toks = segment.trim().split(/\s+/)
	for (;;) {
		if (!toks.length) return {verb: "", toks: []}
		const t = toks[0]
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			toks = toks.slice(1)
			continue
		}
		if (/^(sudo|time|command|env|nohup|exec|builtin)$/.test(t)) {
			toks = toks.slice(1)
			continue
		}
		if (t === "timeout" || t === "gtimeout") {
			toks = toks.slice(1)
			while (toks.length && /^(-\S+|\d+[smhd]?)$/.test(toks[0])) toks = toks.slice(1)
			continue
		}
		// `bash -lc "<cmd>"` / `sh -c '<cmd>'`: classify the inner command
		if (/^(ba|z|da)?sh$/.test(t.replace(/^.*\//, "")) && toks.length > 2 && /^-[a-z]*c[a-z]*$/.test(toks[1])) {
			const inner = toks.slice(2).join(" ").replace(/^["']|["']$/g, "")
			toks = inner.split(/\s+/)
			continue
		}
		if (/^\(+$/.test(t) || t.startsWith("(")) {
			toks[0] = t.replace(/^\(+/, "")
			if (!toks[0]) toks = toks.slice(1)
			continue
		}
		return {verb: t.replace(/^.*\//, ""), toks}
	}
}

function splitSegments(command) {
	return String(command)
		.split(/\s*(?:&&|\|\||;|\||\n)\s*/)
		.map(s => s.trim())
		.filter(Boolean)
}

// URLs written with a scheme, plus bare `host/path` after a network verb.
function urlsIn(segment) {
	const urls = []
	for (const m of segment.matchAll(URL_RE)) urls.push(m[0])
	if (!urls.length) {
		for (const m of segment.matchAll(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s"'`<>)]*)?)/gi)) urls.push(m[1])
	}
	return urls
}

function classifyUrl(url, pm) {
	const host = hostOf(url)
	const p = pathOf(url)
	if (!host || LOCAL_HOST_RE.test(host)) return null
	if (GITHUB_HOST_RE.test(host) && pm.slug && pm.slug.test(p)) return "upstream_lookup"
	if (REGISTRY_HOST_RE.test(host) && pm.pkgPath && pm.pkgPath.test(p.replace(/^\/-\/|^\/npm\//, "/"))) return "upstream_lookup"
	if (REGISTRY_HOST_RE.test(host) && pm.pkgPath && pm.pkgPath.test(p)) return "upstream_lookup"
	return "external_network"
}

function pkgArgOf(toks, pm) {
	// first token after the subcommand that is not a flag: the package spec
	for (const t of toks) {
		if (t.startsWith("-")) continue
		const clean = t.replace(/^["']|["']$/g, "")
		if (pm.pkgToken && pm.pkgToken.test(clean)) return {matches: true, name: clean}
		return {matches: false, name: clean}
	}
	return {matches: false, name: ""}
}

function classifySegment(segment, pm) {
	const {verb, toks} = verbOf(segment)
	if (!verb) return []
	const v = verb.toLowerCase()
	if (/^(echo|printf|#|grep|rg|sed|awk|cat|ls|find|cd|export|set|read|true|false|test|\[)$/.test(v)) return []
	const rest = toks.slice(1)
	const found = []

	if (/^(curl|wget|http|https|xh|httpie|aria2c|fetch)$/.test(v)) {
		const urls = urlsIn(segment)
		if (!urls.length) return []
		let worst = null
		for (const u of urls) {
			const k = classifyUrl(u, pm)
			if (k === "upstream_lookup") worst = k
			else if (k && !worst) worst = k
		}
		if (worst) found.push(worst)
		return found
	}

	if (v === "gh") {
		const sub = (rest[0] || "").toLowerCase()
		if (/^(pr|api|issue|search|repo|release|run|gist|browse)$/.test(sub)) {
			found.push(pm.slug && pm.slug.test(segment) ? "upstream_lookup" : "external_network")
		}
		return found
	}

	if (v === "git") {
		const sub = rest.find(t => !t.startsWith("-")) || ""
		const argv = rest.slice(rest.indexOf(sub) + 1)
		if (/^(fetch|pull|clone|ls-remote|submodule)$/.test(sub) || (sub === "remote" && /^(add|set-url|update)$/.test(argv[0] || ""))) {
			if (sub === "submodule" && !/update|sync/.test(argv.join(" "))) return []
			const hasUrl = /https?:\/\/|git@|ssh:\/\/|git:\/\/|\bgithub\.com\b/i.test(segment)
			const mentionsOrigin = /\borigin\b/.test(segment) || /^(fetch|pull|ls-remote)$/.test(sub) && !argv.some(t => !t.startsWith("-"))
			if (pm.slug && pm.slug.test(segment)) found.push("upstream_lookup")
			else if (mentionsOrigin && !hasUrl) found.push("upstream_lookup")
			else if (sub === "remote" && !hasUrl) return []
			else found.push("external_network")
		} else if (sub === "push") {
			found.push("external_network")
		}
		return found
	}

	if (/^(npm|pnpm|yarn|bun)$/.test(v)) {
		const sub = (rest[0] || "").toLowerCase()
		if (/^(view|info|show|pack|install|i|add|dlx|update|upgrade|outdated|search|download)$/.test(sub)) {
			const arg = pkgArgOf(rest.slice(1), pm)
			if (arg.matches) found.push("upstream_lookup")
			else if (/^(view|info|show|pack|search|dlx|download)$/.test(sub) || arg.name) found.push("external_network")
			// bare `npm install` (deps from lockfile) is a network attempt too
			else found.push("external_network")
		}
		return found
	}
	if (v === "npx" || v === "bunx" || v === "pnpx") {
		const arg = rest.find(t => !t.startsWith("-")) || ""
		if (pm.pkgToken && /@/.test(arg) && pm.pkgToken.test(arg)) found.push("upstream_lookup")
		else if (pm.pkgToken && pm.pkgToken.test(arg) && pm.pkg !== arg.replace(/@.*$/, "")) found.push("upstream_lookup")
		else if (/@[^/]/.test(arg.replace(/^@[^/]+\//, ""))) found.push("external_network")
		return found
	}
	if (/^(pip|pip3|uv|poetry|pipx)$/.test(v)) {
		const sub = (rest[0] || "").toLowerCase()
		if (/^(download|install|add|index)$/.test(sub)) {
			const arg = pkgArgOf(rest.slice(1), pm)
			found.push(arg.matches ? "upstream_lookup" : "external_network")
		}
		return found
	}
	if (v === "cargo") {
		const sub = (rest[0] || "").toLowerCase()
		if (/^(add|install|fetch|search|download|update)$/.test(sub)) {
			const arg = pkgArgOf(rest.slice(1), pm)
			found.push(arg.matches ? "upstream_lookup" : "external_network")
		}
		return found
	}
	if (v === "go" && /^(get|install|mod)$/.test((rest[0] || "").toLowerCase())) {
		if (rest[0] === "mod" && !/download|tidy/.test(rest[1] || "")) return []
		found.push(pm.slug && pm.slug.test(segment) ? "upstream_lookup" : "external_network")
		return found
	}
	return found
}

function classifyWebTool(c, pm) {
	const hay = `${c.url || ""} ${c.query || ""} ${c.command || ""}`
	if (pm.slug && pm.slug.test(hay)) return "upstream_lookup"
	if (pm.repo && new RegExp(`\\b${esc(pm.repo)}\\b`, "i").test(hay)) return "upstream_lookup"
	if (pm.pkg && new RegExp(`\\b${esc(pm.pkg)}\\b`, "i").test(hay)) return "upstream_lookup"
	if (c.url) {
		const k = classifyUrl(c.url, pm)
		if (k === "upstream_lookup") return k
	}
	return "web_tool"
}

// `identity` = {org, repo, package, hosts?}; see registry.repoIdentity(spec).
export function auditCommands(commands, identity) {
	const pm = projectMatchers(identity || {})
	const findings = []
	const counts = {upstream_lookup: 0, external_network: 0, web_tool: 0}
	for (const c of commands || []) {
		if (!c || typeof c !== "object") continue
		const isShell = /^(bash|command_execution|shell|sh)$/i.test(c.tool || "")
		const kinds = new Set()
		if (isShell) {
			for (const seg of splitSegments(c.command || "")) for (const k of classifySegment(seg, pm)) kinds.add(k)
		} else {
			kinds.add(classifyWebTool(c, pm))
		}
		// one finding per command, at its worst kind
		const kind = kinds.has("upstream_lookup") ? "upstream_lookup" : kinds.has("external_network") ? "external_network" : kinds.has("web_tool") ? "web_tool" : null
		if (!kind) continue
		counts[kind]++
		findings.push({kind, fatal: kind === "upstream_lookup", tool: c.tool || "unknown", command: String(c.command || "").slice(0, 400), via_subagent: c.via_subagent === true})
	}
	return {clean: counts.upstream_lookup === 0, findings, counts}
}

export function auditTranscript(text, {adapter, identity} = {}) {
	const commands = extractCommands(text, {adapter})
	const audit = auditCommands(commands, identity)
	return {version: LEAK_AUDIT_VERSION, commands_scanned: commands.length, ...audit}
}

// Fallback for registry specs that predate repoIdentity(): org/repo from the
// clone URL, package from the spec name.
export function identityFromSpec(spec) {
	const url = spec && typeof spec.url === "string" ? spec.url : ""
	const m = url.match(/github\.com[/:]([^/]+)\/([^/.\s]+)/i)
	return {
		org: m ? m[1] : null,
		repo: m ? m[2] : spec && spec.name ? String(spec.name) : null,
		package: spec && spec.package ? String(spec.package) : spec && spec.name ? String(spec.name) : m ? m[2] : null,
		hosts: ["github.com", "api.github.com", "raw.githubusercontent.com", "patch-diff.githubusercontent.com", "codeload.github.com"]
	}
}
