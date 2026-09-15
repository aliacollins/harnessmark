// Execution runtime for test commands: local host process or a pinned container.
// The evaluator and harvester never spawn a test runner directly; they ask the
// runtime, so one switch (BENCH_RUNTIME=local|docker) moves grading into an
// image whose toolchain and dependency tree are fixed by docker/<repo>/Dockerfile.
//
// The docker path is DESIGNED here but UNVERIFIED on this machine (no docker
// daemon was available when it was written). Known open point: the runner links
// node_modules into each worktree as an absolute host symlink, which dangles
// inside a container. The image therefore bakes dependencies at /work/<deps> and
// a named volume is mounted over that path so the host symlink is shadowed;
// whether docker allows a mount over a dangling symlink target must be checked on
// a machine with docker before this mode is trusted.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {spawn} from "node:child_process"

const GUEST_WORK = "/work"
const GUEST_SCRATCH = "/bench-scratch"

export function runtimeMode(env = process.env) {
	const m = (env.BENCH_RUNTIME || "local").trim().toLowerCase()
	if (m !== "local" && m !== "docker") throw new Error(`BENCH_RUNTIME must be "local" or "docker", got "${m}"`)
	return m
}

function spawnCapture(cmd, args, {cwd, timeoutMs, env} = {}) {
	return new Promise(resolve => {
		let child
		try {
			child = spawn(cmd, args, {
				cwd,
				env: {...process.env, ...(env || {})},
				detached: true,
				stdio: ["ignore", "pipe", "pipe"]
			})
		} catch (e) {
			resolve({code: null, signal: null, timedOut: false, stdout: "", stderr: String(e)})
			return
		}
		let stdout = ""
		let stderr = ""
		let timedOut = false
		let done = false
		const cap = s => (s.length > 2_000_000 ? s.slice(-1_000_000) : s)
		child.stdout.on("data", d => (stdout = cap(stdout + d)))
		child.stderr.on("data", d => (stderr = cap(stderr + d)))
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGKILL")
			} catch {
				try {
					child.kill("SIGKILL")
				} catch {}
			}
		}
		const timer = setTimeout(() => {
			timedOut = true
			kill()
		}, timeoutMs ?? 120_000)
		const finish = (code, signal) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve({code, signal, timedOut, stdout, stderr})
		}
		child.on("error", () => finish(null, null))
		child.on("close", (code, signal) => finish(code, signal))
	})
}

function scratchDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bench-scratch-"))
}

// Build the docker argv without running it, so it can be unit-tested here.
export function dockerArgv(spec, cmd, args, {cwd, scratch, env} = {}) {
	if (!spec?.image) throw new Error(`repo spec has no image; cannot run in docker`)
	const argv = ["run", "--rm", "--network", "none", "-v", `${cwd}:${GUEST_WORK}`, "-w", GUEST_WORK]
	if (scratch) argv.push("-v", `${scratch.host}:${scratch.guest}`)
	// Shadow the host's dependency symlink (see header) with the image's baked copy.
	if (spec.deps) argv.push("-v", `bench-deps-${spec.name ?? "repo"}:${GUEST_WORK}/${spec.deps}`)
	for (const [k, v] of Object.entries(env || {})) argv.push("-e", `${k}=${v}`)
	argv.push(spec.image, cmd, ...args)
	return argv
}

export function makeRuntime(spec, {mode} = {}) {
	const m = mode ?? runtimeMode()
	if (m === "local") {
		return {
			mode: "local",
			// Same path on both sides: local scratch needs no mapping.
			scratch() {
				const host = scratchDir()
				return {host, guest: host}
			},
			// A cwd-relative report path is the same on both sides too.
			guestPath: p => p,
			exec: (cmd, args, opts = {}) => spawnCapture(cmd, args, opts)
		}
	}
	return {
		mode: "docker",
		scratch() {
			return {host: scratchDir(), guest: GUEST_SCRATCH}
		},
		guestPath: p => p,
		exec(cmd, args, {cwd, timeoutMs, env, scratch} = {}) {
			const argv = dockerArgv(spec, cmd, args, {cwd, scratch, env})
			// docker's own client is the process we kill on timeout; --rm plus the
			// SIGKILL on the client leaves the container to be reaped by the daemon.
			return spawnCapture("docker", argv, {cwd, timeoutMs})
		}
	}
}
