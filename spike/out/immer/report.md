# Historic replay harvest — immer

- repo: https://github.com/immerjs/immer
- window: commits since 2025-09-01 (non-merge)
- post-cutoff slice: commit date >= 2026-06-01
- generated: 2026-09-11T13:39:07.378Z
- resolved HEAD: 061c2425e1c9dff89e4e4189d42af1b7839dfe0a
- origin fetched at: 2026-09-11T13:38:00.593Z
- partial run: no

## Headline

| metric | value |
| --- | --- |
| non-merge commits in window | 144 |
| candidates found | 18 |
| candidates validation-attempted | 18 |
| **validated tasks** | **12** |
| **validated tasks / 100 commits in window** | **8.3** |
| **validated tasks / 100 post-cutoff commits** (8/44) | **18.2** |
| validated / 100 attempted candidates | 66.7 |

**Deferred (horizon-shaped):** 0 `too_large` commit(s) parked in `deferred.jsonl` (0 for line count, 0 for file count). These are the long-horizon-shaped commits that the anti-gaming size filter discards, kept as a seed corpus. `deferred.jsonl` is a projection, not a separate rejection bucket: each commit is counted exactly once in `rejected.jsonl` (reason `too_large`, shown in the semantic breakdown) and enumerated once here.

## Efficiency

| metric | value |
| --- | --- |
| mean seconds per candidate validated | 3.6s |
| total validation time | 64.5s |
| harvest time | 2.0s |
| setup (clone+install) time | 1.2s |
| total wall-clock | 67.9s (1.1 min) |

## Outcome breakdown — semantic

| outcome | count |
| --- | --- |
| no_source | 87 |
| no_tests | 20 |
| infra_only | 13 |
| touches_test_infra | 5 |
| no_fail_at_parent | 5 |
| non_behavioral_subject | 1 |
| zero_tests_collected | 1 |
| validated | 12 |

## Measurement artifacts — excluded from the semantic breakdown

These codes describe run mechanics, not validation outcomes. They are pulled out of the semantic table above:

| artifact code | count |
| --- | --- |
| not_attempted_budget | 0 |
| not_attempted_cap | 0 |
| version_bump | 0 |

- Semantic bucket codes: `infra_only`, `no_fail_at_parent`, `no_source`, `no_tests`, `non_behavioral_subject`, `touches_test_infra`, `zero_tests_collected`, plus `validated`.
- Measurement-artifact codes: `not_attempted_budget`, `not_attempted_cap`, `version_bump`.

Reason codes from the spec: `non_behavioral_subject`, `too_large`, `no_source`, `version_bump`,
`oracle_apply_failed`, `no_fail_at_parent`, `no_pass_at_fix`, `timeout`.

Added codes (documented extensions, so nothing is dropped silently): `no_tests` (commit changed source
but no test file, or only support files, so it is not even a candidate), `oracle_not_runnable` (test-file
diff applied but the pinned test runner collects no tests for those paths, e.g. a pre-Vitest commit),
`error` (unexpected exception), `not_attempted_cap` / `not_attempted_budget` (run cap or wall-clock budget
reached).

Assertion-level validation codes: `pre_existing_failure` (clean parent control was already red),
`pre_existing_test_not_runnable` (an oracle test path exists at the parent but the pinned runner cannot
run it, so the control cannot be skipped), `parent_fail_not_assertion` (parent+oracle was not an
assertion-level failure with >=1 failing test), `zero_tests_collected` (a run exited 0 but executed no
tests), `unparseable_test_output` (runner output could not be parsed into pass/fail counts), `flaky`
(the two parent+oracle runs disagreed).

Infra codes: `infra_only` (commit changed only test infra), `touches_test_infra` (commit changed test
infra alongside real source). Git codes: `git_error` (a git command failed; the offending operation is
recorded in `detail`), `empty_patch` (the final diff was empty).

No silent drops: every pre-validation commit appears in `rejected.jsonl` with a reason, every attempted
candidate appears in either `tasks.jsonl` (validated) or `rejected.jsonl` (its validation reason), every
`too_large` commit is additionally parked in `deferred.jsonl`, and any git failure is either fatal
(clone/fetch/checkout/log at setup) or recorded as `git_error`.

## Task mix (validated tasks)

`category` is derived mechanically from the commit subject and diff — never hand-labeled and never
LLM-labeled (`category_source` records `prefix` / `heuristic` / `unknown`), so the mix stays un-gameable.

Category counts:

| category | count |
| --- | --- |
| security | 1 |
| perf | 1 |
| refactor | 0 |
| feature | 0 |
| bugfix | 8 |
| unknown | 2 |

Size bucket (total changed lines; XS <=10, S <=50, M <=150, L <=400, XL >400):

| size_bucket | count |
| --- | --- |
| XS | 0 |
| S | 5 |
| M | 6 |
| L | 0 |
| XL | 1 |

Test delta (oracle test files):

| test_delta | count |
| --- | --- |
| new-test-file | 0 |
| modified-test | 12 |
| mixed | 0 |

Subsystem spread (distinct directory prefixes of changed source paths):

| metric | min | median | max | tasks touching >1 subsystem |
| --- | --- | --- | --- | --- |
| subsystem_count | 1 | 1 | 5 | 2 |

## Fail mode at parent (validated tasks)

| fail_mode | count |
| --- | --- |
| assertion | 12 |

## Evidence invariant (machine-checkable from tasks.jsonl)

Every validated task records the run tuples `{exit, passed, failed, total}`. There are two honest forms.

Normal form — the clean-parent control actually executed:

```
parent_clean_run.exit == 0 && parent_clean_run.failed == 0
```

Skipped form — every oracle test path is git-verified absent at the parent, so there was no copy to
control (this never claims a green control run that did not happen):

```
parent_clean_run.skipped == true
parent_clean_run.reason == "oracle_files_absent_at_parent"
oracle_files_status has >= 1 entry, and EVERY entry has status "A"
```

A renamed oracle file (`status: "R"`, with `old_path`) is NOT new: its content existed at the parent
under `old_path`, so the control runs against that old path and the skipped form is unavailable. A path
that exists at the parent but cannot be run by the pinned runner is rejected as
`pre_existing_test_not_runnable`, never skipped.

Both forms additionally require:

```
parent_oracle_run.exit != 0 && parent_oracle_run.failed >= 1 && parent_oracle_run.total >= 1
fix_run.exit == 0 && fix_run.failed == 0 && fix_run.total >= 1
```

Verify both forms and require zero violations:

```sh
jq -s '
  def ok:
    (((.parent_clean_run.skipped == true)
      and (.parent_clean_run.reason == "oracle_files_absent_at_parent")
      and ([.oracle_files_status[]?] | length >= 1)
      and ([.oracle_files_status[]? | select(.status != "A")] | length == 0))
     or ((.parent_clean_run.skipped != true)
      and (.parent_clean_run.exit == 0)
      and (.parent_clean_run.failed == 0)))
    and (.parent_oracle_run.exit != 0)
    and (.parent_oracle_run.failed >= 1)
    and (.parent_oracle_run.total >= 1)
    and (.fix_run.exit == 0)
    and (.fix_run.failed == 0)
    and (.fix_run.total >= 1);
  { total: length, violations: ([.[] | select(ok | not)] | length) }' out/<repo>/tasks.jsonl
```

## Machine-checkable accounting

`tasks + rejected == window`, and each deferred commit appears exactly once in `deferred.jsonl` and once
in `rejected.jsonl` (reason `too_large`), so it is never double-counted:

```sh
test "$(( $(wc -l < out/immer/tasks.jsonl) + $(wc -l < out/immer/rejected.jsonl) ))" = "$(git -C work/immer log --since=2025-09-01 --no-merges --pretty=%H | wc -l)"
diff <(jq -r .sha out/immer/deferred.jsonl | sort) <(jq -r 'select(.reason=="too_large") | .sha' out/immer/rejected.jsonl | sort)
```

Semantic vs measurement-artifact rejection split (semantic bucket = everything not in the artifact set):

```sh
jq -r .reason out/immer/rejected.jsonl | sort | uniq -c | awk '{ if ($2=="version_bump" || $2=="not_attempted_cap" || $2=="not_attempted_budget") print "ARTIFACT", $0; else print "SEMANTIC ", $0 }'
```

## Size distribution of validated tasks

| metric | min | median | max |
| --- | --- | --- | --- |
| files touched | 2 | 2 | 14 |
| lines changed | 12 | 62 | 1066 |
| lines added | 11 | 58 | 715 |

## Validated tasks

| sha | date | post_cutoff | fail_mode | category | size_bucket | test_delta | files | lines | subject |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9491138b11 | 2026-08-15 | true | assertion | unknown | S | modified-test | 2 | 16 | Skip new references for arrays when sort or reverse is a no-op |
| 0c3efdd4ea | 2026-08-15 | true | assertion | bugfix | M | modified-test | 2 | 104 | fix: preserve structural sharing for no-op array-methods calls |
| e3df956dca | 2026-08-05 | true | assertion | bugfix | S | modified-test | 2 | 24 | fix: key inserted array indices by name in the array-methods plugin |
| e38ad71f25 | 2026-07-16 | true | assertion | bugfix | S | modified-test | 2 | 12 | fix: throw proper immer error when applyPatches path traverses null (#1251) |
| a73672ab76 | 2026-07-16 | true | assertion | bugfix | M | modified-test | 3 | 60 | fix: draft relocated base refs after reverse/sort in array-methods plugin (#1255) |
| 858d0365aa | 2026-07-03 | true | assertion | bugfix | M | modified-test | 2 | 64 | fix: improve DraftMap.{entries,values}() compatibility#1228 (#1228) |
| 16e225b5a3 | 2026-07-03 | true | assertion | bugfix | S | modified-test | 2 | 26 | fix: undefined assigned to a prototype-inherited key gets dropped (#1262) |
| 48fc378860 | 2026-07-01 | true | assertion | security | M | modified-test | 3 | 141 | fix: prevent prototype pollution via constructor.prototype access (CVE-2026-XXXX) (#1259) |
| d3bc436d0f | 2026-05-04 | false | assertion | bugfix | M | modified-test | 2 | 92 | fix: handle nested proxies after spreading and inserting into an array |
| 90a77655af | 2026-02-09 | false | assertion | bugfix | M | modified-test | 2 | 92 | fix: handle nested proxies after spreading and inserting into an array |
| ad510d4bfa | 2025-11-27 | false | assertion | unknown | S | modified-test | 2 | 25 | Re-add isDraftable check to skip freezing non-obj values |
| d6c12028c0 | 2025-11-23 | false | assertion | perf | XL | modified-test | 14 | 1066 | perf: Rewrite finalization system to use a callback approach instead of tree traversal (#1183) |
