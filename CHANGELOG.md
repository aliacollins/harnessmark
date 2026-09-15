# Changelog

HarnessMark follows semantic versioning over **comparability of results**:

- **Major**: a result under the new version is not comparable with one under
  the old. Prompt changes, grading changes, frozen-set changes, audit-rule
  changes.
- **Minor**: additive. New task sets, adapters, report columns, tooling.
  Existing numbers stand.
- **Patch**: fixes that alter no number.

Every run manifest records `prompt_version`, the set name and version, the
leak-audit version and the git head it ran under. The leaderboard aggregates
only runs sharing one prompt version.

## 1.0.0 (2026-09-15)

First public release: HarnessMark 1.

**Frozen under this version**

- Task prompt version 3: redacted commit message plus an explicit act-offline
  instruction (`harness/registry.mjs`, `TASK_INSTRUCTIONS`).
- Frozen sets `dev-hono-50` v1 (50 hono tasks, headroom-biased by size bucket,
  every hono chain with 3 or more steps) and `dev-immer-12` v1.
- Leak audit version 1: upstream lookups are fatal (`answer_lookup`), other
  network reach is recorded.
- Resolution rule, tamper restoration and failure-mode precedence as in
  `harness/contracts.md`.
- Reference harness: one loop, `bash` and `edit`, no planning, retries, index
  or sub-agents.

**Measured**

- Lift (paired against the reference harness on the same model string), Wilson
  intervals, provisional marking under 3 trials per task.
- Cost per resolve with reported and estimated costs never mixed.
- Transcript-derived topology: tool calls, delegation, re-reads, tool-result
  bytes, per-turn context growth, cache-read ratio.
- Long-horizon chains with cold or warm harness state.
- Per-harness answer-lookup rate.

**Adapters**: reference, pi, Claude Code, Codex.

**Corpus**: hono (167 validated tasks, 39 chains) and immer (12 tasks,
2 chains), harvested from commits after 2025-09-01. Python, Go and Rust repos
registered as candidates.

**Results shipped**: one complete run, Claude Code with Sonnet 5 on
`dev-hono-50`, five trials per task. No reference run on that model yet, so no
lift. All prompt v1 and v2 runs retracted after the answer-lookup audit.

**Known gaps**: containerised grading implemented but unverified; corpus is
TypeScript only; the leaderboard prints raw model ids.
