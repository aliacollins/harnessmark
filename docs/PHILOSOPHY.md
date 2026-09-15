# Why harness-vs-harness?

## The confound every agent leaderboard ships

Every published coding-agent number is the product of two things: the model and
the harness wrapped around it. SWE-bench, SWE-bench Verified, Aider's
leaderboard, Terminal-Bench — each reports `resolve(model × harness)` as a
single scalar. When a new system scores five points higher, you cannot tell
whether the model got smarter or the scaffold got better, and the two have
completely different consequences:

- If the **model** improved, every harness inherits the gain for free.
- If the **harness** improved, the technique transfers: you can adopt the
  planning strategy, the tool design, the index, the retry policy — on any
  model, including cheap ones.

Harness authors live inside this confound. A team building an agent CLI ships
a change to context management and wants to know what it bought. Rerunning
SWE-bench answers a different question ("how good is my product on this
model?") at the price of the interesting one ("what did *my code* contribute?").

## Lift: subtract the model out

HarnessMark holds the model fixed and varies only the harness. The zero point is
a deliberately boring reference harness: one model loop, two tools (`bash` and
a string-replace `edit`), no planning, no sub-agents, no retries, no index, no
context management beyond what the provider does. Its resolve rate on a model
is a defensible estimate of what *the model alone* can do when it can touch a
repo at all.

**Lift** is the paired per-task resolve-rate delta between a harness and that
reference, same model string, same frozen task set, same sandbox, same grader.
Paired, because task difficulty varies enormously and an unpaired difference
of means throws that structure away.

Lift can be negative. A harness that burns its context on ceremony, retries
itself into loops, or summarizes away the detail the model needed will score
*below* the naked model. That is a real, reportable result — arguably the most
useful one this benchmark can produce — and it is invisible to any leaderboard
that only ranks absolute scores.

## Cost is half the result

Two harnesses at the same resolve rate are not equal if one spends 10x the
tokens. Harness design is exactly the discipline of spending a token budget
well: what to read, what to re-read, what to delegate, what to keep in
context. So HarnessMark reports cost per resolve alongside lift, never averages
reported costs with price-table estimates, and derives a **topology** from
each harness's own transcript: tool calls, delegation ratio, re-read ratio,
tool-result bytes, per-turn context growth. Topology is outcome-blind — it
records what the harness did, never whether it was right — so two harnesses on
the same model can be compared on *how they worked*, not only on pass/fail.

Long-horizon **chains** (contiguous real commits run as one session) extend
this: a harness that builds an index or a working memory on first contact
should show later steps cheaper than the first. Step-k cost over step-1 cost
measures whether the harness builds on its own prior work, which single-task
benchmarks cannot see by construction.

## Honesty rules

Measuring small deltas between harnesses is only meaningful if the noise and
the leaks are controlled harder than in an absolute-score benchmark:

- **Same input, always.** Every harness gets the identical prompt. When the
  prompt changes, the version is recorded and runs across versions are never
  aggregated — a prompt change changes the task.
- **The grader trusts nothing.** The runner captures the patch with
  `git diff`; the oracle's tests decide pass/fail; agent-edited tests are
  restored before grading.
- **Provider failures are not harness failures.** A rate-limited trial says
  nothing about the harness and is excluded, counted, and reported.
- **Answer lookup is measured, not assumed away.** Every task's fix is public
  upstream and the sandbox has network access because the harness needs its
  provider. Prompts are redacted, the instruction forbids the network, and
  every executed command is audited afterwards. A trial that fetched the fix
  is invalidated — and the per-harness lookup rate is itself a column, because
  whether a harness goes looking for the answer key is a property of the
  harness. This benchmark's own v1/v2 results were retracted on exactly this
  ground.
- **No number without its sample.** Unreported telemetry is `n/a`, never zero;
  every rate prints its n; groups on different task sets are not ranked
  against each other.

## What HarnessMark is not

It is not a model leaderboard: absolute resolve rates here say nothing a
model benchmark doesn't say better. It is not a product review: a harness's
UX, safety behaviour and pricing are out of scope. It measures one thing —
what the scaffold contributes to the score, and at what cost — because that is
the number harness authors need and no one else publishes.
