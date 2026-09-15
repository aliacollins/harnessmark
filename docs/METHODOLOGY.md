# Methodology

## What is under test

A harness is everything between the model and the repository: the tool set,
the system prompt, planning and delegation, retry policy, context management,
and any local indexing. The benchmark varies the harness and holds the model,
the tasks, the sandbox and the grader constant.

A harness *configuration* is a distinct harness. pi with delegation disabled is
labelled `pi-solo`, not merged into pi.

## Task construction

1. Harvest post-cutoff commits from a registered repo (`spike/harvest.mjs`).
   Non-behavioural commits (docs, chore, release, refactor) are rejected.
2. Split the diff into test paths, support paths (fixtures, snapshots) and
   source paths. A task needs at least one test file and one source file.
3. Validate the oracle: at the parent commit with the fix's tests injected,
   at least one test must fail (fail-to-pass); at the fix commit every test
   must pass. Flaky oracles are re-run and rejected if unstable.
4. Record the fail-to-pass and pass-to-pass sets in `.evidence/baseline`. They
   are computed once per task and shared by every harness.
5. Contiguous validated commits form chains. A chain is only kept when each
   step's parent is the previous step's fix commit, and its coherence
   (shared source paths between adjacent steps) is recorded.

Tasks whose message does not specify the behaviour are excluded from frozen
sets. In hono this removes the "Merge commit from fork" security advisories,
whose descriptions were private.

## Sandbox

The agent works in a git checkout whose history is truncated at the parent
commit. Later refs are dropped and unreachable objects pruned, and the runner
verifies the fix commit cannot be read before handing over the directory. A
shared object store would let `git log --all` reach the answer.

Dependencies are linked in from the clone today. Containerised execution with
one pinned image per repo is implemented under `docker/` but unverified on the
development machine.

## Grading

`resolved = tamper.clean && patch.applied && !patch.empty && testsRan
           && f2p.passed === f2p.required && p2p.passed === p2p.required`

The candidate patch is captured by the runner with `git diff`; nothing trusts
the agent's or the harness's own report. Before tests run, oracle test and
support files are restored from the fix commit and test-infrastructure files
the agent touched are restored from the parent. Only damage that restoration
cannot undo (paths outside the repo, binary patches) is fatal.

## Answer lookup

Every task's fix is a public commit, and the sandbox cannot be offline because
the harness must reach its model provider. Under prompt version 2, where the
task spec was the raw commit message, hono's messages ended in their pull
request number and agents used it: 96 of 250 Claude Code trials on Sonnet 5
ran `gh pr view <n> --repo honojs/hono` or equivalent and received the file
list or diff; 21 of 50 reference and 27 of 50 pi trials on deepseek flash
fetched the PR diff or post-fix source from GitHub. Every one of those trials
resolved. Excluding them, Claude Code's rate fell from 87.2% to 79.2%. All
version 1 and 2 numbers were retracted for this reason.

Version 3 closes the channel in three layers. The spec is redacted of PR and
issue references, GitHub links, trailers and SHAs. The instruction states an
offline rule: work only from the checkout, no fetch, no GitHub, no registries,
no web search. And the transcript of every trial is audited afterwards: a
command that reached the upstream project is `answer_lookup`, fatal like
tampering, while other network reach is recorded and reported. The sandbox
environment also drops GitHub credentials, restricts git to the local
protocol and points npm at a dead registry; that deters, the audit enforces.

The lookup rate is reported per harness. Whether a harness goes looking for
the answer when it can is a property of the harness, and one worth knowing.

## Failure attribution

`provider_error` marks a trial where the model provider refused or failed to
serve the request. Such a trial, if it did not resolve, carries no information
about the harness and is excluded from every rate and mean, with the excluded
count reported. Matching uses provider framing (`error=429`, `rate limit`), not
bare status codes, because the corpus includes an HTTP framework whose own test
output prints status codes.

## Metrics

**Resolve rate** is reported with a Wilson 95% interval and the sample size.
Groups with fewer than three trials per task are marked provisional.

**Lift** is the paired difference in resolve rate between a harness and the
reference harness on the same model over the common task set. It is undefined
when no reference run exists for that model.

**Cost per resolve** divides total cost by resolved tasks. Reported costs and
price-table estimates are never averaged together.

**Topology** is derived from the harness's own transcript and is outcome-blind:
tool calls by name, sub-agent calls and distinct agents, delegation ratio,
retries, read calls and distinct files read, re-read ratio, tool-result
characters, and the per-turn input-token series (first, last, mean, growth,
cache-read ratio). A harness with no sub-agent tool reports zero delegation;
a transcript with no per-tool detail reports `n/a`.

**Chains** report every step's tokens, reads and outcome, plus the ratio of
mean step-1 cost to mean later-step cost. A harness that indexes on first
contact and reuses the index should show later steps cheaper than the first.

## Persistent harness state

Some harnesses build a local code map or graph on first read and consult it on
later reads. The runner supports `--state cold|warm`. Cold gives every trial a
fresh state directory. Warm persists one directory per chain (or per run in
task mode) and records its size before and after each trial, so the report
can show whether an index was built, reused, and what it saved. State written
inside the worktree is excluded from the candidate patch via the adapter's
`statePaths`. Warm state never crosses a benchmark boundary: the worktree for
each step is still built from truncated history.

## Comparability rules

- A leaderboard row is a (harness, model) pair. Rows on different task sets are
  not ranked; the common-subset table is the only apples-to-apples view.
- Same model via different providers (Bedrock versus OpenRouter) is noted on
  the row. It is the closest achievable control when harnesses are locked to
  providers.
- Frozen sets under `sets/` are generated by a recorded rule, not hand-picked.
