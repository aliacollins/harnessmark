# Leaderboard

- Generated: 2026-09-15T04:45:23.283Z
- Runs directory: `runs`
- Runs included: 1
- Task prompt version: 3 (runs under version(s) 1, 2 excluded: different input, not comparable)
- Groups: 1
- Fully comparable: yes

## Included runs

| run | tasks | trials | partial | notes |
| --- | --- | --- | --- | --- |
| claude-sonnet5-xhigh-hono50-v3 | 50 | 250 | no |  |

## Excluded runs

| run | reason |
| --- | --- |
| _baselines-hono | name begins with _ (excluded by convention) |
| _claude-bash-check | name begins with _ (excluded by convention) |
| _claude-prompt-v2-check | name begins with _ (excluded by convention) |
| _claude-stream-check | name begins with _ (excluded by convention) |
| _invalid | name begins with _ (excluded by convention) |
| _ref-smoke | name begins with _ (excluded by convention) |
| _ref-smoke-bedrock | name begins with _ (excluded by convention) |
| _set-smoke | name begins with _ (excluded by convention) |
| _v3-check-claude | name begins with _ (excluded by convention) |
| _v3-check-flash | name begins with _ (excluded by convention) |
| arm-solo | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| bench-1 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| bench-2 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| bench-3 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| chain-finalize | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| chain-query | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| claude-sonnet5-xhigh-hono50 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| claude-sonnet5-xhigh-hono50-v2 | prompt version 2 != 3 (runs under different task prompts are not comparable) |
| codex-smoke | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| codex-trials | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| lift-flash-10 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| lift-flash-50 | prompt version 2 != 3 (runs under different task prompts are not comparable) |
| lift-flash-50x5 | prompt version 2 != 3 (runs under different task prompts are not comparable) |
| pi-2 | prompt version 1 != 3 (runs under different task prompts are not comparable) |
| pi-3 | prompt version 1 != 3 (runs under different task prompts are not comparable) |

## Leaderboard

Ranked by pass rate. Groups covering different task sets are NOT comparable - see the common-subset table below.

| harness | model | runs | tasks | trials | infra failures | rate (scored) | 95% CI | lift vs reference | resolved tasks (all trials) | pass@N (any trial) | mean in tokens | mean out tokens | mean cache-read | mean cache-write | mean cost | mean wall ms | mean turns | failure modes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-xhigh | us.anthropic.claude-sonnet-5 | 1 | 50 | 250 | 4 | 71.1% (n=246/250) | [65.2%, 76.4%] | no reference | 28 | 43 | 51.46 (n=240/246) | 16,327.32 (n=240/246) | 1,527,050.67 (n=240/246) | 44,184.81 (n=240/246) | $0.5951 (n=230/246) + ~$0.3471 est for 10 rows | 399,587 (n=246/246) | 26.49 (n=240/246) | agent_timeout:13, none:233, provider_error:4, answer_lookup:1 |

No `reference` harness has been run, so `lift vs reference` cannot be computed: a resolve rate on its own confounds the harness with the model. Run the reference harness on the same model and tasks to get the zero point.

## Harness efficiency

How each harness spent its budget, from its own transcript. `cost/resolve` is total cost over resolved trials among trials that report a cost; `reads/trial` counts read-tool calls; `reread ratio` is reads of a file already read over all reads; `ctx growth` is the last turn's prompt over the first turn's. `lookup rate` is the share of audited trials that fetched the upstream answer (filed as answer_lookup failures); `ext. network/trial` counts non-fatal external network calls. Outcome-blind and n/a where the transcript carries no per-tool detail or no audit.

| harness | model | 95% CI | cost/resolve | tokens/resolve | tool calls/trial | reads/trial | reread ratio | result chars/trial | ctx growth | retries/trial | lookup rate | ext. network/trial |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-xhigh | us.anthropic.claude-sonnet-5 | [65.2%, 76.4%] | n/a (reported and estimated costs are never combined) | 22,462 (n=240/246) | 25.57 (n=246/246) | 5.34 (n=246/246) | 0.39 (n=246/246) | 46,930 (n=246/246) | 2.81 (n=246/246) | 0.00 (n=246/246) | 0.4% (n=246/246 audited) | 0.00 (n=246/246) |

## Notes

- `tasks` counts DISTINCT (repo, sha) across every contributing run; `trials` counts result lines. A task run in several runs is counted once.
- Costs, telemetry and sample sizes follow report.mjs: unreported telemetry is `n/a`, never 0, and a `~`-prefixed `est` cost is an estimate from the checked-in price table. Reported and estimated costs are never averaged together.
- Groups covering different task sets are not comparable; use the common-subset table.
- `95% CI` is a Wilson score interval on the scored rate. `lift vs reference` is the paired per-task resolve-rate delta against the `reference` harness on the SAME model, over the tasks both scored (paired n); a harness on a model with no reference run shows `no reference`.
- `†` marks a provisional group: fewer than 3 scored trials per task on average, too few to separate the harness from run-to-run variance.
- `lookup rate` (efficiency table) is the share of audited scored trials in which the harness fetched the upstream answer; such trials are filed as `answer_lookup` (shown in the failure-mode column) and count as failures, never as infra. Rows whose lines predate the audit show n/a.
