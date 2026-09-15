#!/usr/bin/env node
// Codex CLI adapter. Headless entry point discovered from `codex exec --help`
// (codex-cli 0.154.0): `codex exec --json` emits one JSON event per line on
// stdout and the prompt is read from stdin when `-` is passed.
//
// Event shapes observed on a real run:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id","type":"agent_message","text"}}
//   {"type":"item.completed","item":{"id","type":"file_change","changes":[{"path","kind"}],"status"}}
//   {"type":"item.completed","item":{"id","type":"command_execution","command","exit_code","status"}}
//   {"type":"error","message":"..."}
//   {"type":"turn.failed","error":{"message":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens",
//                                     "cache_write_input_tokens","output_tokens",
//                                     "reasoning_output_tokens"}}
import fs from "node:fs"
import path from "node:path"
import {spawn} from "node:child_process"
import {PROVIDER_ERROR_RE} from "../harness/registry.mjs"
import {armBudget, awaitExit} from "../harness/proc.mjs"

// `codex exec` defaults to a read-only sandbox and refuses model file writes;
// workspace-write is the least permissive mode that allows unattended edits.
const SANDBOX_MODE = "workspace-write"

// Signatures taken from real failure runs (see notes in the task report).
const AUTH_ERROR_RES = [
	/401\b/,
	/\bunauthorized\b/i,
	/missing bearer/i,
	/no codex credentials/i,
	/\bnot logged in\b/i,
	/\bnot signed in\b/i,
	/codex login/i,
	/invalid api key/i,
	/incorrect api key/i,
	/auth\.json/i
]

const CONTEXT_LIMIT_RES = [
	/context window exceeded/i,
	/context_length_exceeded/i,
	/exceeds the context window/i,
	/\bcontext (?:window|length)\b[^\n]{0,40}\b(?:exceed|overflow|full|too (?:long|large))/i
]

function resolveCli() {
	if (process.env.CODEX_BIN) return process.env.CODEX_BIN
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue
		const candidate = path.join(dir, "codex")
		try {
			fs.accessSync(candidate, fs.constants.X_OK)
			return candidate
		} catch {}
	}
	return "codex"
}

// Sums only what the harness actually reported; absent fields stay null.
const add = (a, b) => (typeof b === "number" ? (a ?? 0) + b : a)

export function parseCodexStream(stdout) {
	const telemetry = {
		input_tokens: null,
		output_tokens: null,
		cache_read_tokens: null,
		cache_write_tokens: null,
		cost_usd: null
	}
	const errors = []
	let turnFailed = false
	let completed = false
	let turns = 0
	for (const line of String(stdout || "").split("\n")) {
		const trimmed = line.trim()
		if (!trimmed.startsWith("{")) continue
		let event
		try {
			event = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (!event || typeof event !== "object") continue
		if (event.type === "turn.completed") {
			completed = true
			turns++
			const usage = event.usage || {}
			telemetry.input_tokens = add(telemetry.input_tokens, usage.input_tokens)
			telemetry.output_tokens = add(telemetry.output_tokens, usage.output_tokens)
			telemetry.cache_read_tokens = add(telemetry.cache_read_tokens, usage.cached_input_tokens)
			telemetry.cache_write_tokens = add(
				telemetry.cache_write_tokens,
				usage.cache_write_input_tokens
			)
		} else if (event.type === "turn.failed") {
			turnFailed = true
			const msg = event.error && event.error.message
			if (msg) errors.push(String(msg))
		} else if (event.type === "error") {
			if (event.message) errors.push(String(event.message))
		} else if (event.type === "item.completed" && event.item && event.item.type === "error") {
			if (event.item.message) errors.push(String(event.item.message))
		}
	}
	return {telemetry, errors, turnFailed, completed, turns}
}

function classify({timedOut, spawnError, exitCode, turnFailed, text}) {
	if (timedOut) return "agent_timeout"
	if (spawnError) return "harness_crash"
	const failed = exitCode !== 0 || turnFailed
	// Only a run that actually failed can be a provider refusal; the contract
	// requires that gate, and it keeps a successful run from being labelled.
	if (failed && PROVIDER_ERROR_RE.test(text)) return "provider_error"
	if (CONTEXT_LIMIT_RES.some(re => re.test(text))) return "context_limit"
	if (AUTH_ERROR_RES.some(re => re.test(text))) return "auth_error"
	if (failed) return "harness_crash"
	return "none"
}

export default {
	name: "codex",
	version: "1",

	async run({prompt, dir, model, budgetMs, outDir}) {
		const transcriptPath = path.join(outDir, "transcript.txt")
		const started = Date.now()

		const args = [
			"exec",
			"--json",
			"--color",
			"never",
			"--ephemeral",
			"--skip-git-repo-check",
			"--sandbox",
			SANDBOX_MODE
		]
		if (model) args.push("--model", model)
		args.push("-")

		let stdout = ""
		let stderr = ""
		let exitCode = null
		let spawnError = null
		let timedOut = false

		const finish = () => {
			const elapsed = Date.now() - started
			const parsed = parseCodexStream(stdout)
			const text = [...parsed.errors, stderr].join("\n")
			const failure = classify({
				timedOut,
				spawnError,
				exitCode,
				turnFailed: parsed.turnFailed,
				text
			})

			const notes = []
			if (timedOut) notes.push(`killed process group after ${budgetMs}ms budget`)
			if (spawnError) notes.push(`spawn failed: ${spawnError.message}`)
			if (failure !== "none" && parsed.errors.length) {
				notes.push(`agent error: ${parsed.errors[parsed.errors.length - 1].slice(0, 300)}`)
			} else if (failure !== "none") {
				const tail = lastLine(stderr) || lastLine(stdout)
				if (tail) notes.push(`output tail: ${tail.slice(0, 300)}`)
			}
			if (failure === "none" && !parsed.completed) notes.push("no turn.completed event observed")

			try {
				fs.mkdirSync(outDir, {recursive: true})
				const body = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout
				fs.writeFileSync(transcriptPath, body)
			} catch {}

			return {
				harness: "codex",
				model: model || null,
				exit_code: exitCode,
				timed_out: timedOut,
				wall_ms: elapsed,
				failure_mode: failure,
				telemetry: parsed.telemetry,
				turns: parsed.turns,
				transcript_path: transcriptPath,
				notes: notes.join("; ")
			}
		}

		const child = spawn(resolveCli(), args, {
			cwd: dir,
			detached: true, // own process group so the whole tree can be killed
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env
		})

		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", chunk => {
			stdout += chunk
		})
		child.stderr.on("data", chunk => {
			stderr += chunk
		})
		child.stdin.on("error", () => {}) // EPIPE when codex exits early

		// Whole process tree at the deadline, and no waiting on pipes a grandchild
		// still holds (harness/proc.mjs).
		const budgetArm = armBudget(child, budgetMs, {onTimeout: () => (timedOut = true)})
		try {
			child.stdin.end(String(prompt ?? ""))
		} catch {}
		const exited = await awaitExit(child, {onError: err => (spawnError = err)})
		budgetArm.cancel()
		exitCode = exited.signal && exited.code === -1 ? null : exited.code
		if (exited.signal && !timedOut && !spawnError) spawnError = new Error(`terminated by ${exited.signal}`)
		return finish()
	}
}

function lastLine(text) {
	const lines = String(text || "")
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean)
	return lines.length ? lines[lines.length - 1] : ""
}


