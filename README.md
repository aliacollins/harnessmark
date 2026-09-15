# HarnessMark

**An open benchmark for comparing AI agent harnesses.**

A benchmark for **coding-agent harnesses**, not models. The model is held fixed;
the scaffold around it (tool set, planning, delegation, retries, context and
index management) is what gets measured.

SWE-bench answers "can this model fix this bug?". HarnessMark answers
"how much of that score is the harness, and what did it cost?". The headline
number is **lift**: the paired resolve-rate delta between a harness and a
deliberately minimal reference harness running the same model on the same
tasks. See [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) for why that comparison is
the one worth making, and [docs/METHODOLOGY.md](docs/METHODOLOGY.md) for the
evidence model.

## Headline measurements

| number | definition |
| --- | --- |
| **lift** | paired resolve-rate delta of a harness versus the `reference` harness, same model, same tasks |
| **cost per resolve** | total spend / resolved tasks, with reported and estimated costs never mixed |
| **topology** | tool calls, sub-agent delegation ratio, retries, re-read ratio, tool-result bytes, context growth per turn |
| **long-horizon chains** | contiguous commit sequences run as one session; step-k cost versus step-1 cost shows whether a harness builds on its own prior work |

Every number states the sample it was computed over. Unreported telemetry is
`n/a`, never zero. Groups that do not cover the same tasks are not ranked
against each other.

Current numbers: [leaderboard.md](leaderboard.md).

## How a task is graded

Tasks are real commits harvested from open-source repos after 2025-09-01. The
agent gets the commit message as its prompt and a history-truncated checkout of
the parent commit; the fix commit is unreachable and the runner verifies that.

Grading is oracle-authoritative: the fix commit's tests are injected on top of
the agent's patch. Fail-to-pass tests must pass, pass-to-pass tests must still
pass. The agent's own edits to tests are restored from the oracle before
grading, so tampering is recorded, never punished, and never rewarded.

Provider failures (rate limits, 5xx) are excluded from every rate and reported
separately. A run that hit a provider error but still resolved stays in.

The fix for every task is public upstream and the sandbox has network access,
because the harness needs its model provider. So the prompt is redacted of PR
numbers, links and SHAs, the instruction tells the harness to work offline, and
every command it executed is audited afterwards. A trial that fetched the
upstream project (its PR, diff, post-fix source or a newer package build) is
`answer_lookup`: recorded, never resolved. How often a harness does that is
itself a leaderboard column.

## The reference harness

`adapters/reference.mjs` is the zero point: one model loop, two tools (`bash`,
`edit`), no planning, no sub-agents, no index. Its resolve rate on a model is
what the model alone can do. Everything a real harness adds or subtracts shows
up as lift against it.

## Quick start

Requirements: Node 24+, git, and API credentials for the model you will run
(the reference harness reads them from the environment; see
`harness/reference/providers.mjs` for the supported model ids and variables).
Zero npm dependencies; there is nothing to install.

```
git clone https://github.com/aliacollins/harnessmark && cd harnessmark

# 0. clone the upstream repos the tasks come from and install their deps
#    (into spike/work/<repo>, gitignored; several minutes, once)
node tools/setup.mjs

# 1. smoke one task with the reference harness
node runner/run.mjs --set dev-immer-12 --limit 1 --adapter reference \
  --model deepseek/deepseek-v4.1-flash --out runs/_smoke

# 2. measure lift: the reference harness and a real harness, SAME model string
node runner/run.mjs --set dev-hono-50 --adapter reference,pi \
  --model deepseek/deepseek-v4.1-flash --trials 3 --out runs/lift-flash

# 3. read the result
node report/report.mjs runs/lift-flash
node report/leaderboard.mjs
```

Every trial is a worktree cut from the clone under `spike/work/<repo>`, with the
clone's dependency directory linked in. Oracle baselines (which tests fail at
the parent, which pass) are computed on first use per task and cached under
`.evidence/`, so the first run over a set is slower than later ones.

More invocations:

```
# oracle baselines for a repo (once, harness-independent)
node runner/run.mjs --repo hono --task all --baseline-only --out runs/_baselines-hono

# a mixed matrix: each harness paired with its own model
node runner/run.mjs --set dev-hono-50 --adapter pi,claude \
  --model-for pi=anthropic/claude-sonnet-4.5 \
  --model-for claude=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --trials 3 --out runs/matrix-sonnet

# long-horizon chains with persistent harness state
node runner/run.mjs --set dev-hono-50 --chain all --adapter pi \
  --model deepseek/deepseek-v4.1-flash --state warm --out runs/chains-warm

# resume an interrupted run in place
node runner/run.mjs ... --out runs/lift-flash --resume
```

Tests are plain scripts:
`for t in */test/*-test.mjs harness/reference/test/*.mjs; do node "$t"; done`.

Model strings are passed bare and unchanged to every harness, because lift is
paired on the model string: the reference harness and the harness under test
must be given the identical id.

## Layout

```
harness/     registry (repos, patterns, failure modes), topology, prices, chains, sets, reporters, runtime
adapters/    one file per harness: pi, codex, claude, reference
evaluator/   oracle grading, tamper restoration
runner/      worktrees, history truncation, trials, chains, state dirs
report/      per-run report and cross-run leaderboard
spike/       task harvester and the corpus (spike/out/<repo>/tasks.jsonl, chains.jsonl)
sets/        frozen task sets (dev-hono-50, dev-immer-12)
docker/      pinned images per repo (unverified on this machine; no Docker installed)
third_party/ verbatim upstream licenses for harvested corpus material
docs/        PHILOSOPHY.md, METHODOLOGY.md
tools/       setup (upstream clones), leak audit, notices generator, worktree helper
```

## Adding a harness

Write `adapters/<name>.mjs` implementing the adapter contract in
`harness/contracts.md`. The adapter runs the harness CLI in the worktree and
writes the raw transcript. It must not create the patch or grade anything. If
the harness keeps local state (an index, a code graph), read `BENCH_STATE_DIR`
and export `statePaths` for anything it writes inside the repo.

See [CONTRIBUTING.md](CONTRIBUTING.md) for ground rules and how to add repos
and frozen sets, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community
standards.

## Status

The corpus is two TypeScript repos today (hono, immer); Python, Go and Rust
repos are registered as candidates and need their toolchains installed before
they can be harvested. Containerised grading is implemented under `docker/`
but unverified.

One complete run stands under the current prompt version: Claude Code with
Sonnet 5 on dev-hono-50, five trials per task. Its rate, interval, cost and
lookup rate are in [leaderboard.md](leaderboard.md). No reference-harness run
exists yet for that model, so its lift is not yet computed. Prompt v1/v2 runs
were retracted after the answer-lookup audit (see METHODOLOGY).

## Versioning

This is **HarnessMark 1** (`1.0.0`). The prompt, grading rules, frozen sets and
audit rules that define it are pinned in [CHANGELOG.md](CHANGELOG.md), and every
report prints the version it was generated with. Development moves forward from
here: additive changes (new sets, adapters, columns) bump the minor version and
leave existing numbers standing; anything that makes old and new results
non-comparable bumps the major version and starts a new leaderboard. Results
are only ever compared within a major version.

## License

HarnessMark's code, docs, frozen sets and results are licensed under the
[Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)). The task corpus is
harvested from third-party open-source projects and **keeps its upstream
licenses**: the patches, commit messages and test output under `spike/out/`
remain the work of the upstream authors, redistributed with attribution and
unchanged licensing. Full texts and per-project details are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). HarnessMark is not affiliated
with or endorsed by the projects in its corpus.
