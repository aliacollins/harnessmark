# Frozen contracts

Anything in this file is a frozen interface. Implement against it; change it only here,
deliberately, and update every consumer in the same change. Shared files are read-only for
workers: `harness/registry.mjs`, `harness/contracts.md`, `tools/wt.mjs`, `spike/**`.
Create only the files you own.

Zero npm dependencies anywhere. Plain Node ESM, `node:` builtins only. Prose lives in
`README.md` and `docs/METHODOLOGY.md`; code files carry no generator/attribution headers
and commits carry no co-author trailers beyond what the repository owner configures.

## Ownership

| Path | Owner | Status |
|---|---|---|
| `harness/registry.mjs`, `harness/contracts.md` | frozen | read-only |
| `evaluator/evaluate.mjs`, `evaluator/test/` | evaluator worker | |
| `adapters/pi.mjs` | pi worker | |
| `adapters/claude.mjs` | claude worker | |
| `adapters/codex.mjs` | codex worker | |
| `runner/run.mjs`, `runner/test/` | runner worker | |
| `report/report.mjs`, `report/leaderboard.mjs`, `report/topology.mjs`, `report/test/` | report worker | |
| `adapters/reference.mjs`, `harness/reference/` | reference worker | |
| `harness/topology.mjs`, `harness/test/topology-test.mjs` | topology worker | |
| `harness/reporters.mjs`, `harness/runtime.mjs`, `docker/`, `spike/harvest.mjs` | corpus worker | |
| `harness/sets.mjs`, `sets/` | runner worker | |
| `harness/prices.mjs` | shared | edit with a test |

## Task record (input)

One JSON object per line in `spike/out/<repo>/tasks.jsonl`. Relevant fields:
`sha`, `parent_sha`, `subject`, `message_body`, `test_paths[]`, `support_paths[]`,
`category`, `size_bucket`, `test_delta`, `diffstat`.
Load with `loadTasks(repo)`. `taskSpecRaw(task)` is the commit's own message (subject + body) and
is for the harvester and the report only. `taskSpec(task)` is that message **redacted** by
`redactSpec`: PR/issue references (`(#5222)`, `Fixes #123`, `GH-77`), URLs on GitHub, gist,
githubusercontent, GitLab or Bitbucket hosts, `Co-authored-by:`/`Signed-off-by:` trailers, and
standalone commit SHAs are removed; `taskSpec.redactions(task)` counts what was stripped by kind.
Code identifiers (`Array#push`), shebangs, status codes, versions and CSS colours survive.
`taskPrompt(task)` is `TASK_INSTRUCTIONS` + the redacted spec: an explicit, harness-neutral
instruction to implement the change, not ask questions, not commit, and **not use the network**
(no git fetch/clone/pull, no GitHub, no package registries, no web search or fetch). Every
harness receives the identical prompt. `PROMPT_VERSION` (now 3: v1 bare message, v2 instruction,
v3 redacted + offline rule) is recorded in `manifest.config.prompt_version`; the leaderboard only
aggregates runs sharing one prompt version (the latest present unless `--prompt-version N`),
because runs made under different prompts did not receive the same input.

### Leak audit

The sandbox has network access because the harness needs its model provider, and the fix for
every task is public upstream. So every command a harness executed (from its transcript: bash
commands, web-fetch/search tools) is audited after the run against `repoIdentity(spec)`. A reach
into the upstream project — `gh pr|api` on the org/repo, `curl`/`wget` to github.com, api.github.com
or githubusercontent paths for it, `git fetch|clone|pull|ls-remote` of it, `npm view|pack` /
`npx <package>@` of its package — is `upstream_lookup`: **fatal**, reason `answer_lookup`, never
resolved, exactly like tamper. Other network reach is `external_network` and a harness's own
fetch/search tool is `web_tool`; both are recorded, reported, not fatal. `LEAK_KINDS` lists them.
The per-harness lookup rate is a harness property and a leaderboard column. Under prompt v2 the
audit found 96/250 Claude Code trials, 21/50 reference and 27/50 pi trials fetching the fix; those
rows were retracted.

## Evidence model

An agent's run is graded by injecting the task's oracle tests (the test-file portion of
`parent_sha..sha`) on top of (parent + the agent's patch). Nothing trusts the agent's or
the harness's self-report: the candidate patch is captured by the runner with `git diff`,
and pass/fail is decided by executed tests.

- **f2p** — tests that FAIL at `parent_sha` + oracle. All must PASS after the agent's patch.
- **p2p** — tests that PASS at `parent_sha` + oracle. All must still PASS.
- f2p/p2p sets are derived from a **baseline run** and cached (harness-independent).

### Baseline cache — `.evidence/baseline/<repo>/<sha>.json`

```json
{
  "sha": "...", "parent_sha": "...", "ran_at": "ISO",
  "f2p": ["test name", "..."], "p2p": ["test name", "..."],
  "raw": {"exit": 1, "passed": 0, "failed": 0, "total": 0},
  "test_files": ["..."], "timing_ms": 0
}
```

Deriving per-test names: run the repo's test command through the reporter named by
`REPOS[repo].reporter` (`harness/reporters.mjs`: `vitest-json`, `pytest-junit`,
`go-test-json`, `cargo-nextest-junit`; default `vitest-json`), which appends the machine-
readable-report arguments and parses the report into per-test names. Do not scrape
human-readable output for test identity. If per-test names are unavailable, fail loudly
rather than degrading to counts. Every test-command spawn goes through
`harness/runtime.mjs` (`BENCH_RUNTIME=local|docker`, default local; the docker path is
unverified on the development machine). `isTestPath(p, spec)` applies the repo's language
patterns from `LANG_TEST_RES`; without a spec it is the historic TypeScript rule.

## Evaluator API — `evaluator/evaluate.mjs`

```js
export async function baseline({repo, task, dir, opts}) -> Baseline
export async function evaluate({repo, task, candidatePatch, dir, baseline, opts}) -> EvalResult
```

`dir` is a git checkout of the repo the evaluator may mutate (`git checkout -f`, `git clean -fd`).
**Never pass `-x` to `git clean`** (it deletes `node_modules`). `candidatePatch` is a path to a
patch file; `baseline` is a parsed Baseline object.

### EvalResult

```json
{
  "repo": "immer", "sha": "...", "parent_sha": "...",
  "adapter": "pi", "model": "...",
  "resolved": false,
  "reason": "f2p_failed",
  "patch": {"applied": true, "empty": false, "files": [], "deletions": [], "error": null},
  "tamper": {"clean": true, "findings": []},
  "f2p": {"required": 1, "passed": 0, "failed": ["name"]},
  "p2p": {"required": 10, "passed": 10, "failed": []},
  "partial": {"f2p_ratio": 0.0, "p2p_ratio": 1.0},
  "runs": {"baseline": {"exit": 1, "passed": 0, "failed": 0, "total": 0},
           "candidate": {"exit": 0, "passed": 0, "failed": 0, "total": 0}},
  "timing": {"checkout_ms": 0, "apply_ms": 0, "test_ms": 0, "total_ms": 0}
}
```

`reason` is one of `EVAL_REASONS` in the registry.

### Resolution rule (exact)

```
resolved = tamper.clean && patch.applied && !patch.empty
           && testsRan && f2p.passed === f2p.required && p2p.passed === p2p.required
```

Precedence when several fail: `patch_apply_failed` > `empty_patch` > `tamper_detected` >
`answer_lookup` > `test_timeout` > `no_tests_ran` > `f2p_failed` > `p2p_regression`. `f2p.required` must be
>= 1; a baseline with zero failing tests is not a gradable task -> `no_tests_ran`.

### Tamper rules

The grading environment is **rebuilt from the oracle** before tests run: test and
support files are restored from the fix commit, and any test-infra file the candidate
touched is restored from the parent (or removed if it did not exist there). So an agent
editing a test, or adding one of its own, is normal behaviour and cannot change its score —
it is recorded, not punished. Only damage that restoration cannot undo is fatal.
`tamper.clean` means no fatal findings; `tamper.restored` lists the rebuilt paths.

| kind | trigger | fatal |
|---|---|---|
| `touches_outside_repo` | patch path is absolute or contains `..` | yes |
| `binary_patch` | patch contains `GIT binary patch` | yes |
| `modifies_oracle_test` | patch touches any `test_paths` / `support_paths` path | no — restored |
| `modifies_test_infra` | patch touches a path matching `INFRA_RES` | no — restored from parent |
| `deletes_test_file` | patch deletes a path matching `isTestPath` | no — restored |
| `weakens_assertions` | an ADDED line in a test file matches `/\.(skip\|only\|todo)\s*\(\|\bxit\s*\(\|\bxdescribe\s*\(\|\bxtest\s*\(/` | no — restored |

Each finding carries `fatal: true|false`. A candidate that only weakens or deletes the oracle
tests, without fixing the source, must NOT resolve — that property is tested.

## Adapter API — `adapters/<name>.mjs`

```js
export default {
  name: "pi",
  version: "1",
  async run({prompt, dir, model, budgetMs, outDir}) -> AdapterResult
}
```

`dir` is a git worktree the adapter works in. The adapter **must not** create the patch or
grade anything — the runner captures the patch and the evaluator grades it.

`run()` also receives `stateDir`: a directory the harness may use for persistent local
state (an index, a code graph, a cache). The same path is in `process.env.BENCH_STATE_DIR`
for the duration of the call, so a spawned CLI inherits it; adapters forward it however the
harness expects (HOME/XDG override, a flag). Under `--state cold` (default) it is fresh per
trial and deleted afterwards; under `--state warm` it persists across the steps of one
chain trial, or across a whole run in task mode. An adapter whose harness writes state INSIDE
the repo exports `statePaths: [".codify"]` (relative, no `..`); the runner excludes those
paths from patch capture and records them on the result line as `state.in_tree_paths`.

**Model strings are passed bare and unchanged** (`deepseek/deepseek-v4.1-flash`,
`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). Lift is paired on the model string, so the
reference harness and the harness under test must be given the identical id. The
`reference` adapter infers its provider from the id shape (Bedrock-shaped ids go to Bedrock,
everything else to OpenRouter) and `REF_PROVIDER` forces one. A harness CONFIGURATION is a
distinct harness: label it (`pi-solo`), never merge it into the default arm.

The runner must hand the adapter a **history-truncated sandbox**, never a worktree of the
full clone: a shared object store lets `git log --all` reach the very commit that solves the
task, which turns the benchmark into an exercise in reading the answer key. History up to the
parent is kept; every later ref is dropped and unreachable objects are pruned, and the runner
verifies the fix commit is unreadable before handing the directory over.

### AdapterResult

```json
{
  "harness": "pi", "model": "...",
  "exit_code": 0, "timed_out": false, "wall_ms": 0,
  "failure_mode": "none",
  "telemetry": {"input_tokens": null, "output_tokens": null,
                "cache_read_tokens": null, "cache_write_tokens": null, "cost_usd": null},
  "transcript_path": "<outDir>/transcript.txt",
  "turns": null,
  "topology": null,
  "notes": ""
}
```

`failure_mode` is one of `FAILURE_MODES`. Telemetry fields are **null when the harness does
not report them** — never 0, never guessed. Always write the full raw stdout+stderr to
`transcript_path`. Honour `budgetMs` by killing the child process (kill the process group;
macOS has no `timeout` binary).

`turns` is the number of agent turns the harness completed, or `null` if it does not report
one. It is NOT a telemetry field and must not be added to `TELEMETRY_FIELDS`. `notes` is a
single string; an adapter that accumulates an array of note fragments must join it before
returning.

`topology` describes how the harness STRUCTURED the work, so two harnesses on the same model
can be compared on delegation and efficiency rather than only on pass/fail. Shape:
`{parse, total_tool_calls, tool_calls{}, tool_errors{}, subagents{calls, distinct, by_agent{},
prompt_chars, max_prompt_chars}, retries, delegation_ratio,
reads{calls, distinct_files, rereads, reread_ratio, result_chars, via_bash, via_bash_files},
tool_result_chars, tool_result_chars_by_tool{},
context{turns, input_first, input_last, input_mean, input_max, input_total, output_total, growth, cache_read_ratio}}`.
`reads.calls` counts read-tool calls; `via_bash` counts shell file dumps (`cat`, `sed -n`,
`head`, `tail`) separately. `context.input_*` is the prompt the model saw per turn, fresh
input PLUS cache read, so a caching harness does not show negative growth. Legacy records
without these blocks normalise them to `null`, never 0. These are the fields a harness that
indexes on first read and reuses the index (fewer re-reads, flatter context growth, cheaper
later chain steps) is measured on. Adapters may emit pi-shaped events
(`tool_execution_start/end` with `toolName`, `args`, `result.content[].text`) plus
`{type:"model_call", usage:{input, output, cache_read, cache_write}}` and
`{type:"retry"}`; `topologyFromTranscript(text, {adapter})` parses them. A harness with no sub-agent
tool reports `subagents.calls: 0` — that is a measurement, not missing data; `null` means the
harness's output format carries no per-tool detail and must render as n/a, never as zero.
Adapters derive it with `harness/topology.mjs`. It is outcome-blind: it records what the
harness did, never whether it was right.

`provider_error` means the model provider refused or could not serve the request (rate
limit, quota, 5xx, dropped connection) - it is NOT a harness failure. It is assigned only
to a run that already failed, and `PROVIDER_ERROR_RE` matches provider framing rather than
bare status numbers, so an agent printing a status code from its own test output does not
trip it. Adapters pass only harness-level text (stderr, structured error events), never the
agent's own message. `INFRA_FAILURE_MODES` lists these modes. A trial whose `failure_mode`
is an infra mode AND which did not resolve carries no information about the harness: any
rate AND every mean must EXCLUDE it and report the excluded count separately, stating the
sample the rate was computed over. A run that hit a provider error but still resolved is a
valid measurement and must stay in - dropping it would inflate the figure.

Each adapter must discover its harness's real headless mode by running `<cli> --help` and
capturing output. Do not invent flags.

## Runner — `runner/run.mjs`

```
node runner/run.mjs --repo immer --task <sha|all> --adapter pi --model <m>
                    [--limit N] [--trials N] [--budget-ms N] [--item-budget-ms N] [--out runs/<id>]
node runner/run.mjs --set <name> [--repo r] [--chain all|<id>] --adapter a[,b] --model <m>
                    [--model-for a=<m>]... [--state cold|warm] [--keep-state] ...
```

`--resume` continues an interrupted run in the same `--out`: every `(sha, adapter, trial)` already
in `results.jsonl` is skipped, a complete chain trial is skipped, and a partial chain trial is dropped
(backup kept beside the file) and re-run from step 1, since chain steps build on one worktree. The
manifest records `resume: {at, prior_lines, skipped, compacted_partial_chain_trials}`. Without
`--resume`, re-running into an existing directory appends, as before.

`--budget-ms` caps the whole run; `--item-budget-ms` (default 1,200,000) caps every adapter
invocation, and the adapter receives the smaller of the two. `--set` loads a frozen task set
from `sets/<name>.json` (generated by a recorded rule via `node harness/sets.mjs --generate`,
never hand-picked) and is mutually exclusive with `--task` and `--baseline-only`.
`--model-for adapter=model` pairs one harness with its own model; `--model` is the default
for the rest. The manifest records `set`, `state`, `config.item_budget_ms`,
`config.model_for` and each adapter's `model` and `state_paths`. Each result line's
`adapter_run.state` is `{mode, dir_reused, bytes_before, bytes_after, in_tree_paths}`.
Chain result lines carry `chain_id`, `chain_step` (1-based), `chain_length`,
`chain_resolved`.

Per (task, adapter): create an isolated worktree, precompute/reuse the baseline, run the
adapter, capture the patch with `git diff`, evaluate, append to `results.jsonl`. One task
failing must never abort the run. Budget caps are enforced.

`--trials N` (default 1) repeats the agent run N times per (task, adapter), sequentially,
and appends one result line per trial. Trials share the per-task baseline and are never run
in parallel: the evaluation worktree is mutated per call. The baseline is computed once per
task, not once per trial.

### Run directory

```
runs/<id>/manifest.json                       # config, start/end, versions, host
runs/<id>/results.jsonl                       # one EvalResult + telemetry per line
runs/<id>/<sha>/<adapter>/candidate.patch
runs/<id>/<sha>/<adapter>/transcript.txt
runs/<id>/<sha>/<adapter>/eval.json
runs/<id>/<sha>/<adapter>/adapter.json
```

At `--trials 1` these per-item paths are used verbatim. At `--trials > 1` each trial gets
its own `runs/<id>/<sha>/<adapter>/t<N>/` directory, so trials cannot overwrite each other.

Result line shape = EvalResult with an added `"telemetry"` object, an added `"adapter_run"`,
and two trial-tracking keys: `"trial"` (0-based index) and `"trials"` (the run's trial count).
Lines written before this key existed have neither; a reader must default them to `0` and
`1` respectively. `results.jsonl` must be append-only and survive interruption.
Anything that counts tasks must count DISTINCT `(repo, sha)`, and anything that checks
whether a run is complete must count DISTINCT `(sha, adapter)` pairs rather than result
lines — at `--trials > 1` one (task, adapter) emits N lines, so a line count cannot detect a
truncated run.

## Report — `report/report.mjs`

```
node report/report.mjs <runid|path> [--json]
```

Emits `report.md` (and JSON with `--json`). Rates carry a Wilson 95% interval and the
sample; groups averaging fewer than 3 trials per task are marked provisional. The
leaderboard reports **lift**: the paired per-task resolve-rate delta against the
`reference` harness on the same model string over the common task set, `no reference` when
none exists. **cost per resolve** and **tokens per resolve** divide totals by resolved
count; reported and estimated costs are never combined. Chain runs get a per-step table
and a warm-up ratio (mean of steps >= 2 over step 1) for tokens, reads, result chars and
wall time. Must include a harness x model comparison table:
tasks, resolved, resolution rate, mean tokens in/out, cache tokens, cost, mean wall-clock,
mean turns, failure-mode breakdown, and a per-category breakdown. Report `null` telemetry as
`n/a` and state the sample size — never average over missing data or imply a number is
comparable when it is not.
