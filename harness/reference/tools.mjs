// The reference harness's entire tool surface: a shell and a string-replace
// editor. Nothing else -- no file reader, no search, no planner, no sub-agents.
// Every richer harness is measured as lift over this floor, so the floor must
// stay deliberately small and boring.
import {spawn} from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export const MAX_OUTPUT_CHARS = 30_000
export const DEFAULT_BASH_TIMEOUT_MS = 120_000
// Head/tail split of a truncated tool result: the model usually needs the start
// (what ran) and the end (the error) more than the middle.
const HEAD_CHARS = 22_000
const TAIL_CHARS = 6_000

export const TOOL_SPECS = [
	{
		name: "bash",
		description:
			"Run a shell command from the repository root. Returns combined stdout and stderr, truncated to 30000 characters. Each call is a fresh shell; the working directory is always the repository root. Commands are killed after 120 seconds.",
		input_schema: {
			type: "object",
			properties: {command: {type: "string", description: "The shell command to run."}},
			required: ["command"]
		}
	},
	{
		name: "edit",
		description:
			"Edit a file by replacing exactly one occurrence of old_string with new_string. path is relative to the repository root. old_string must match exactly once, including whitespace; include enough surrounding lines to make it unique. To create a new file, pass an empty old_string and a path that does not exist yet.",
		input_schema: {
			type: "object",
			properties: {
				path: {type: "string", description: "File path relative to the repository root."},
				old_string: {type: "string", description: "Exact text to replace; empty to create a new file."},
				new_string: {type: "string", description: "Replacement text, or the full contents of a new file."}
			},
			required: ["path", "old_string", "new_string"]
		}
	}
]

export class ToolError extends Error {}

function realpathOrNearest(p) {
	// realpath of the deepest existing ancestor, so a path to be created is
	// judged by where it would actually land (symlinked parents included).
	let cur = p
	for (;;) {
		try {
			return fs.realpathSync(cur)
		} catch {
			const parent = path.dirname(cur)
			if (parent === cur) throw new ToolError(`cannot resolve ${p}`)
			cur = parent
		}
	}
}

function isInside(root, abs) {
	const rel = path.relative(root, abs)
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
}

// Resolve `p` against `dir` and refuse anything that lands outside it, both
// lexically (absolute paths, `..`) and physically (a symlink such as the
// injected node_modules pointing out of the sandbox).
export function resolveInside(dir, p) {
	if (typeof p !== "string" || !p.trim()) throw new ToolError("path must be a non-empty string")
	const root = path.resolve(dir)
	const abs = path.resolve(root, p)
	if (!isInside(root, abs)) throw new ToolError(`path escapes the repository: ${p}`)
	const realRoot = fs.realpathSync(root)
	const realTarget = realpathOrNearest(abs)
	if (!isInside(realRoot, realTarget)) throw new ToolError(`path resolves outside the repository: ${p}`)
	return abs
}

export function truncateOutput(text, max = MAX_OUTPUT_CHARS) {
	if (typeof text !== "string") text = String(text ?? "")
	if (text.length <= max) return {text, truncated: false}
	const head = text.slice(0, HEAD_CHARS)
	const tail = text.slice(-TAIL_CHARS)
	const dropped = text.length - head.length - tail.length
	return {text: `${head}\n\n[... output truncated: ${dropped} characters omitted ...]\n\n${tail}`, truncated: true}
}

export function runBash({dir, command, timeoutMs = DEFAULT_BASH_TIMEOUT_MS, signal}) {
	if (typeof command !== "string" || !command.trim()) {
		return Promise.resolve({text: "error: command must be a non-empty string", isError: true, exit: null, timedOut: false})
	}
	return new Promise(resolve => {
		const t0 = Date.now()
		let out = ""
		let settled = false
		let timedOut = false
		let aborted = false
		const child = spawn("/bin/sh", ["-c", command], {
			cwd: dir,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env
		})
		const kill = sig => {
			try {
				process.kill(-child.pid, sig)
			} catch {
				try {
					child.kill(sig)
				} catch {}
			}
		}
		const onAbort = () => {
			aborted = true
			kill("SIGKILL")
		}
		if (signal) {
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, {once: true})
		}
		const timer = setTimeout(() => {
			timedOut = true
			kill("SIGKILL")
		}, timeoutMs)
		const finish = (code, sig, err) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (signal) signal.removeEventListener("abort", onAbort)
			const {text, truncated} = truncateOutput(out)
			const parts = [text]
			if (err) parts.push(`\n[spawn error: ${err.message}]`)
			if (timedOut) parts.push(`\n[command killed after ${timeoutMs} ms]`)
			else if (aborted) parts.push("\n[command aborted: run budget exhausted]")
			else if (code !== 0) parts.push(`\n[exit code ${code}${sig ? ` signal ${sig}` : ""}]`)
			resolve({
				text: parts.join(""),
				isError: Boolean(err) || timedOut || aborted || code !== 0,
				exit: code,
				timedOut,
				truncated,
				ms: Date.now() - t0
			})
		}
		child.stdout.on("data", d => (out += d.toString("utf8")))
		child.stderr.on("data", d => (out += d.toString("utf8")))
		child.on("error", e => finish(null, null, e))
		child.on("close", (code, sig) => finish(code, sig, null))
	})
}

export function editFile({dir, path: p, old_string, new_string}) {
	if (typeof old_string !== "string" || typeof new_string !== "string") throw new ToolError("old_string and new_string must be strings")
	const abs = resolveInside(dir, p)
	if (old_string === "") {
		if (fs.existsSync(abs)) throw new ToolError(`${p} already exists; pass the text to replace in old_string`)
		fs.mkdirSync(path.dirname(abs), {recursive: true})
		fs.writeFileSync(abs, new_string, "utf8")
		return `created ${p} (${Buffer.byteLength(new_string)} bytes)`
	}
	let content
	try {
		content = fs.readFileSync(abs, "utf8")
	} catch (e) {
		if (e.code === "ENOENT") throw new ToolError(`${p} does not exist; pass an empty old_string to create it`)
		if (e.code === "EISDIR") throw new ToolError(`${p} is a directory`)
		throw new ToolError(`cannot read ${p}: ${e.message}`)
	}
	let count = 0
	let idx = content.indexOf(old_string)
	while (idx !== -1) {
		count++
		idx = content.indexOf(old_string, idx + old_string.length)
	}
	if (count === 0) throw new ToolError(`old_string not found in ${p}`)
	if (count > 1) throw new ToolError(`old_string matches ${count} times in ${p}; include more surrounding context so it matches exactly once`)
	const at = content.indexOf(old_string)
	fs.writeFileSync(abs, content.slice(0, at) + new_string + content.slice(at + old_string.length), "utf8")
	return `edited ${p}: replaced 1 occurrence`
}

// Execute one tool call. Never throws: tool failures are returned to the model
// as an error result so the loop can continue.
export async function executeTool({name, input, dir, signal, bashTimeoutMs}) {
	const args = input && typeof input === "object" ? input : {}
	try {
		if (name === "bash") {
			const r = await runBash({dir, command: args.command, signal, timeoutMs: bashTimeoutMs})
			return {text: r.text, isError: r.isError}
		}
		if (name === "edit") {
			return {text: editFile({dir, path: args.path, old_string: args.old_string, new_string: args.new_string}), isError: false}
		}
		return {text: `error: unknown tool ${name}`, isError: true}
	} catch (e) {
		return {text: `error: ${e.message}`, isError: true}
	}
}
