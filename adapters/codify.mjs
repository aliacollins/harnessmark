import {spawn} from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {FAILURE_MODES, PROVIDER_ERROR_RE} from "../harness/registry.mjs"
import {armBudget, awaitExit} from "../harness/proc.mjs"

// Codify is a Salesforce-first AI dev harness that uses Claude via AWS Bedrock.
// Its headless CLI takes a prompt + a working directory and runs the agentic
// engine, writing a usage JSON to --out on completion. No Docker, no container
// mirroring -- task worktrees are plain directories and Codify's file tools work
// directly on them.
//
// Model strings: Codify's backend resolves the model from its auth file (the
// operator's Bedrock config). The `model` arg is forwarded via --model but the
// backend may override it; `resolvedModelId` in the output JSON is what
// actually served the request and is what this adapter reports as `model`.
//
// Auth: set CODIFY_AUTH_FILE to the path of a valid Codify headless credentials
// file (exported from VS Code via "Codify: Export Headless Credentials"). Falls
// back to <repo root>/codify-headless-auth.json when the variable is not set.
//
// Project code: required by the Codify auth backend. Read from
// CODIFY_PROJECT_CODE or extracted from the auth file automatically.

// Repo root is two directories above adapters/codify.mjs (harnessmark root
// doesn't know about Codify); we need Codify's OWN repo root for npm run.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODIFY_REPO = process.env.CODIFY_REPO || path.resolve(HERE, "../../..")

const AUTH_RE =
	/not logged in|invalid.*token|token.*(invalid|expired)|authentication.*(fail|error)|unauthorized|no credentials|credentials.*(missing|expired|invalid)|\b(401|403)\b.{0,40}(unauthorized|forbidden|auth)/i
const CONTEXT_RE =
	/context.*(limit|length|window)|too many tokens|prompt.*too long|exceeds.*context|max_tokens.*context|input.*too long/i

function num(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null
}

// Parse tool calls from Codify's transcript array.
// Each tool entry has: {say:"tool", text:'{"tool":"read_file","input":{...}}'}
function parseTopology(transcript) {
	if (!Array.isArray(transcript)) return null
	const toolCalls = {}
	let readCalls = 0
	let subAgentCalls = 0
	const readPaths = new Set()
	for (const entry of transcript) {
		if (!entry || entry.say !== "tool") continue
		let parsed
		try {
			parsed = JSON.parse(entry.text)
		} catch {
			continue
		}
		const toolName = parsed?.tool
		if (typeof toolName !== "string" || !toolName) continue
		toolCalls[toolName] = (toolCalls[toolName] || 0) + 1
		if (toolName === "read_file" || toolName === "view_file") {
			readCalls++
			const input = parsed?.input && typeof parsed.input === "object" ? parsed.input : {}
			const p = input.path ?? input.file_path ?? input.filePath ?? input.file ?? input.filename
			if (typeof p === "string" && p.trim()) readPaths.add(p.trim())
		}
		if (toolName === "use_subagents" || toolName === "launch_subagent") subAgentCalls++
	}
	const total = Object.values(toolCalls).reduce((s, n) => s + n, 0)
	return {
		parse: "codify-transcript",
		total_tool_calls: total,
		tool_calls: toolCalls,
		tool_errors: {},
		reads: {
			calls: readCalls,
			distinct_files: readPaths.size || readCalls,
			rereads: Math.max(0, readCalls - (readPaths.size || readCalls)),
			result_chars: 0,
			via_bash: 0,
			via_bash_files: 0
		},
		subagents: {
			calls: subAgentCalls,
			distinct: subAgentCalls ? 1 : 0,
			by_agent: subAgentCalls ? {codify: subAgentCalls} : {},
			prompt_chars: 0,
			max_prompt_chars: 0
		},
		retries: 0,
		delegation_ratio: total ? subAgentCalls / total : null,
		tool_result_chars: null,
		tool_result_chars_by_tool: {},
		context: null
	}
}

// Read the most-recently-written JSON from outDir that carries a usage block.
// Returns {payload, usage}; never throws.
function readUsage(outDir) {
	try {
		const entries = fs
			.readdirSync(outDir)
			.filter(f => f.endsWith(".json"))
			.map(f => ({path: path.join(outDir, f), mt: fs.statSync(path.join(outDir, f)).mtimeMs}))
			.sort((a, b) => b.mt - a.mt)
		for (const e of entries) {
			try {
				const payload = JSON.parse(fs.readFileSync(e.path, "utf8"))
				const usage = payload.usage || {}
				if (Object.keys(usage).length) return {payload, usage}
			} catch {}
		}
	} catch {}
	return {payload: null, usage: {}}
}

// Read project code from auth file -- avoids "unable to find project tagging" errors.
function readProjectCode(authFile) {
	try {
		const d = JSON.parse(fs.readFileSync(authFile, "utf8"))
		return d?.codifyUserDetail?.projectCode || null
	} catch {
		return null
	}
}

export const statePaths = [".codify", ".codify-headless"]

export default {
	name: "codify",
	version: "1",
	statePaths,

	async run({prompt, dir, model, budgetMs, outDir, stateDir}) {
		const started = Date.now()

		const authFile =
			process.env.CODIFY_AUTH_FILE ||
			path.join(CODIFY_REPO, "codify-headless-auth.json")

		if (!fs.existsSync(authFile)) {
			throw new Error(
				`No Codify credentials at ${authFile}. ` +
					'Export them from VS Code ("Codify: Export Headless Credentials") ' +
					"or set CODIFY_AUTH_FILE."
			)
		}

		const runOutDir = path.resolve(outDir || ".", "codify-run")
		fs.mkdirSync(runOutDir, {recursive: true})
		const transcriptPath = path.resolve(outDir || ".", "transcript.txt")

		// SmartContext's index lives in --storage-dir. Use the shared stateDir
		// (warm across tasks for the same repo/adapter) rather than a throwaway
		// per-item directory, so the index survives from one task to the next.
		const smartContextDir = stateDir
			? path.join(stateDir, "smart-context-storage")
			: path.join(runOutDir, "state")
		fs.mkdirSync(smartContextDir, {recursive: true})

		// SmartContext also keys its index to the --cwd path. Each task runs in a
		// fresh worktree (different path), so even a shared storage dir would
		// produce a cache miss every task. A stable symlink updated before each spawn
		// gives it a fixed key. Atomic tmp+rename avoids corruption; with
		// --concurrency > 1 last writer wins (benign race -- worst case is a cold
		// rebuild, not a corrupted index).
		const linkBase = stateDir || CODIFY_REPO
		const workspaceLink = path.join(linkBase, "codify-workspace")
		let cwdForCodify = dir
		const tmpLink = `${workspaceLink}.${process.pid}.${Date.now()}`
		try {
			fs.mkdirSync(linkBase, {recursive: true})
			fs.symlinkSync(dir, tmpLink, process.platform === "win32" ? "junction" : "dir")
			try {
				fs.rmSync(workspaceLink, {force: true, recursive: false})
			} catch {}
			fs.renameSync(tmpLink, workspaceLink)
			cwdForCodify = workspaceLink
		} catch {
			try {
				fs.rmSync(tmpLink, {force: true, recursive: false})
			} catch {}
			// Symlink update failed -- fall through with the raw worktree path.
		}

		// --timeout is Codify's internal engine timeout. Set it well above budgetMs
		// so the process-level kill (armBudget) is always the real enforcement and
		// Codify never self-terminates first.
		const timeoutSec = budgetMs ? Math.ceil(budgetMs / 1000) + 120 : 7200

		const projectCode = process.env.CODIFY_PROJECT_CODE || readProjectCode(authFile)

		// Prefer the pre-built headless-cli.js (ships in .vsix, no TypeScript toolchain needed).
		// Falls back to `npm run headless` (ts-node) for development checkouts.
		const builtCli = path.join(CODIFY_REPO, "out", "headless-cli.js")
		const useBuilt = fs.existsSync(builtCli)

		const args = useBuilt
			? [builtCli]
			: ["run", "--silent", "headless", "--"]

		args.push(
			"--cwd",
			cwdForCodify,
			"--auth",
			authFile,
			"--out",
			runOutDir,
			"--storage-dir",
			smartContextDir,
			"--mode",
			"execute",
			"--timeout",
			String(timeoutSec)
		)
		if (model) args.push("--model", String(model))
		if (projectCode) args.push("--project-code", String(projectCode))

		// Append a verification reminder so Codify always runs the full test suite
		// before finishing. Without this, Codify may implement all new behaviour
		// correctly but miss a regression in an edge-case existing test.
		const verifyReminder =
			"\n\nIMPORTANT: Before calling attempt_completion, run the COMPLETE test " +
			"suite (e.g. `npx vitest run` or the project's test command) and verify " +
			"that ALL existing tests still pass. Fix any regressions before finishing."
		args.push("--prompt", String(prompt || "") + verifyReminder)

		let stdout = ""
		let stderr = ""
		let exitCode = -1
		let signal = null
		let spawnError = null
		let timedOut = false

		const budget = Number(budgetMs)
		const hasBudget = Number.isFinite(budget) && budget > 0

		const child = spawn(useBuilt ? "node" : "npm", args, {
			cwd: CODIFY_REPO,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env
		})

		const budgetArm = armBudget(child, hasBudget ? budget : null, {
			onTimeout: () => (timedOut = true)
		})
		child.stdout.on("data", c => (stdout += c.toString("utf8")))
		child.stderr.on("data", c => (stderr += c.toString("utf8")))
		child.stdout.on("error", () => {})
		child.stderr.on("error", () => {})

		const exited = await awaitExit(child, {onError: err => (spawnError = err)})
		exitCode = exited.code
		signal = exited.signal
		budgetArm.cancel()
		const wallMs = Date.now() - started

		// Write raw stdout+stderr as transcript for debugging.
		const transcript = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "")
		let transcriptError = null
		try {
			fs.writeFileSync(transcriptPath, transcript, "utf8")
		} catch (e) {
			transcriptError = e.message
		}

		// Read usage from Codify's output JSON (written by headless runner).
		const {payload, usage} = readUsage(runOutDir)

		const resolvedModel = payload?.resolvedModelId || null
		const outcome = payload?.outcome || null
		const tokensIn = num(usage.tokensIn)
		const tokensOut = num(usage.tokensOut)
		const cacheReads = num(usage.cacheReads)
		const cost = num(usage.cost)

		// Telemetry in HarnessMark's canonical field names.
		const telemetry = {
			input_tokens: tokensIn,
			output_tokens: tokensOut,
			cache_read_tokens: cacheReads,
			cache_write_tokens: null, // Codify doesn't break out cache writes separately
			cost_usd: cost
		}

		// Failure classification -- only consult error signals on failed runs
		// so agent output quoting an HTTP status never misclassifies a success.
		const failed =
			!!spawnError ||
			timedOut ||
			exitCode !== 0 ||
			outcome === "error" ||
			outcome === "timeout"
		const haystack = `${stderr}\n${stdout.slice(-4000)}`

		let failureMode
		if (timedOut) failureMode = "agent_timeout"
		else if (spawnError) failureMode = "harness_crash"
		else if (outcome === "timeout") failureMode = "agent_timeout"
		else if (failed && PROVIDER_ERROR_RE.test(haystack)) failureMode = "provider_error"
		else if (failed && AUTH_RE.test(haystack)) failureMode = "auth_error"
		else if (failed && CONTEXT_RE.test(haystack)) failureMode = "context_limit"
		else if (failed) failureMode = "unknown"
		else failureMode = "none"
		if (!FAILURE_MODES.includes(failureMode)) failureMode = "unknown"

		const notes = [
			`cmd: npm run headless (cwd=${CODIFY_REPO}, worktree=${cwdForCodify === workspaceLink ? `${workspaceLink} -> ${dir}` : dir})`,
			`auth: ${authFile}`,
			resolvedModel ? `resolved_model=${resolvedModel}` : "",
			outcome ? `outcome=${outcome}` : "",
			cost !== null ? `cost=$${cost.toFixed(4)}` : "cost=n/a",
			signal ? `signal=${signal}` : "",
			spawnError ? `spawn_error=${spawnError.message}` : "",
			transcriptError ? `transcript_error=${transcriptError}` : ""
		]
			.filter(Boolean)
			.join("; ")
			.slice(0, 1200)

		const topology = parseTopology(payload?.transcript)

		return {
			harness: (process.env.CODIFY_HARNESS_LABEL || "").trim() || "codify",
			model: resolvedModel || (model ? String(model) : null),
			exit_code: exitCode,
			timed_out: timedOut,
			wall_ms: wallMs,
			failure_mode: failureMode,
			telemetry,
			transcript_path: transcriptPath,
			turns: num(payload?.requests),
			topology,
			notes
		}
	}
}
