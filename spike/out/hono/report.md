# Historic replay harvest — hono

- repo: https://github.com/honojs/hono
- window: commits since 2025-09-01 (non-merge)
- post-cutoff slice: commit date >= 2026-06-01
- generated: 2026-09-11T13:37:59.463Z
- resolved HEAD: 90e1b948467961718afd3ae34af9dee582b42248
- origin fetched at: 2026-09-11T13:29:33.930Z
- partial run: no

## Headline

| metric | value |
| --- | --- |
| non-merge commits in window | 414 |
| candidates found | 222 |
| candidates validation-attempted | 222 |
| **validated tasks** | **167** |
| **validated tasks / 100 commits in window** | **40.3** |
| **validated tasks / 100 post-cutoff commits** (83/164) | **50.6** |
| validated / 100 attempted candidates | 75.2 |

**Deferred (horizon-shaped):** 0 `too_large` commit(s) parked in `deferred.jsonl` (0 for line count, 0 for file count). These are the long-horizon-shaped commits that the anti-gaming size filter discards, kept as a seed corpus. `deferred.jsonl` is a projection, not a separate rejection bucket: each commit is counted exactly once in `rejected.jsonl` (reason `too_large`, shown in the semantic breakdown) and enumerated once here.

## Efficiency

| metric | value |
| --- | --- |
| mean seconds per candidate validated | 2.2s |
| total validation time | 499.1s |
| harvest time | 5.2s |
| setup (clone+install) time | 1.0s |
| total wall-clock | 506.5s (8.4 min) |

## Outcome breakdown — semantic

| outcome | count |
| --- | --- |
| no_tests | 54 |
| no_source | 40 |
| no_fail_at_parent | 38 |
| pre_existing_failure | 13 |
| infra_only | 12 |
| touches_test_infra | 11 |
| non_behavioral_subject | 5 |
| zero_tests_collected | 2 |
| parent_fail_not_assertion | 2 |
| validated | 167 |

## Measurement artifacts — excluded from the semantic breakdown

These codes describe run mechanics, not validation outcomes. They are pulled out of the semantic table above:

| artifact code | count |
| --- | --- |
| not_attempted_budget | 0 |
| not_attempted_cap | 0 |
| version_bump | 70 |

- Semantic bucket codes: `infra_only`, `no_fail_at_parent`, `no_source`, `no_tests`, `non_behavioral_subject`, `parent_fail_not_assertion`, `pre_existing_failure`, `touches_test_infra`, `zero_tests_collected`, plus `validated`.
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
| security | 2 |
| perf | 1 |
| refactor | 0 |
| feature | 28 |
| bugfix | 94 |
| unknown | 42 |

Size bucket (total changed lines; XS <=10, S <=50, M <=150, L <=400, XL >400):

| size_bucket | count |
| --- | --- |
| XS | 9 |
| S | 71 |
| M | 61 |
| L | 16 |
| XL | 10 |

Test delta (oracle test files):

| test_delta | count |
| --- | --- |
| new-test-file | 1 |
| modified-test | 164 |
| mixed | 2 |

Subsystem spread (distinct directory prefixes of changed source paths):

| metric | min | median | max | tasks touching >1 subsystem |
| --- | --- | --- | --- | --- |
| subsystem_count | 1 | 1 | 2 | 11 |

## Fail mode at parent (validated tasks)

| fail_mode | count |
| --- | --- |
| assertion | 167 |

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
test "$(( $(wc -l < out/hono/tasks.jsonl) + $(wc -l < out/hono/rejected.jsonl) ))" = "$(git -C work/hono log --since=2025-09-01 --no-merges --pretty=%H | wc -l)"
diff <(jq -r .sha out/hono/deferred.jsonl | sort) <(jq -r 'select(.reason=="too_large") | .sha' out/hono/rejected.jsonl | sort)
```

Semantic vs measurement-artifact rejection split (semantic bucket = everything not in the artifact set):

```sh
jq -r .reason out/hono/rejected.jsonl | sort | uniq -c | awk '{ if ($2=="version_bump" || $2=="not_attempted_cap" || $2=="not_attempted_budget") print "ARTIFACT", $0; else print "SEMANTIC ", $0 }'
```

## Size distribution of validated tasks

| metric | min | median | max |
| --- | --- | --- | --- |
| files touched | 2 | 2 | 12 |
| lines changed | 3 | 51 | 1489 |
| lines added | 2 | 49 | 1425 |

## Validated tasks

| sha | date | post_cutoff | fail_mode | category | size_bucket | test_delta | files | lines | subject |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 90e1b94846 | 2026-09-10 | true | assertion | bugfix | M | new-test-file | 2 | 123 | fix(aws-lambda): respect backpressure when streaming the response body (#5351) |
| 7792f5dc14 | 2026-09-10 | true | assertion | perf | XL | modified-test | 3 | 709 | perf(jsx/dom): reduce lookup work for large keyed updates (#5340) |
| 2b8ed402cd | 2026-09-05 | true | assertion | unknown | XL | modified-test | 12 | 591 | Merge commit from fork |
| 499c35ebda | 2026-08-27 | true | assertion | bugfix | S | modified-test | 2 | 35 | fix(client): normalize root WebSocket URLs (#5291) |
| 50b8788cf5 | 2026-08-27 | true | assertion | bugfix | M | modified-test | 2 | 85 | fix(client): keep a param value of "index" in $url() and $path() (#5297) |
| 531e9c5a3a | 2026-08-26 | true | assertion | unknown | M | modified-test | 2 | 69 | Merge commit from fork |
| 3a67f7f399 | 2026-08-26 | true | assertion | unknown | L | modified-test | 4 | 220 | Merge commit from fork |
| 9c28d724c5 | 2026-08-26 | true | assertion | unknown | M | modified-test | 4 | 93 | Merge commit from fork |
| 5e5b83d6ed | 2026-08-23 | true | assertion | bugfix | M | modified-test | 2 | 61 | fix(utils/stream): do not let abort listeners crash abort() (#5274) |
| 241ae4c72b | 2026-08-23 | true | assertion | bugfix | S | modified-test | 3 | 24 | fix(cookie): allow parsing signed cookies with empty string values (#5246) |
| c409d855d9 | 2026-08-23 | true | assertion | bugfix | S | modified-test | 2 | 27 | fix(request): serialize cached JSON body in cloneRawRequest (#5288) |
| 612b59c022 | 2026-08-23 | true | assertion | bugfix | S | modified-test | 2 | 33 | fix(request): drop stale content length for cloned FormData (#5282) |
| 73794bdabe | 2026-08-23 | true | assertion | bugfix | M | modified-test | 2 | 69 | fix(client): omit empty query delimiter (#5283) |
| 28a9c12891 | 2026-08-22 | true | assertion | bugfix | M | modified-test | 2 | 121 | fix(accepts): support wildcard media types and specificity ordering in defaultMatch (#5255) |
| 1096d66e03 | 2026-08-22 | true | assertion | bugfix | S | modified-test | 2 | 41 | fix(client): support custom buildSearchParams and filter undefined query in $ws() (#5256) |
| c4a44071ee | 2026-08-22 | true | assertion | bugfix | S | modified-test | 2 | 35 | fix(client): skip an undefined entry inside a form array (#5280) |
| 2059584f84 | 2026-08-22 | true | assertion | bugfix | S | modified-test | 3 | 49 | fix(client): skip an undefined entry inside a query array (#5272) |
| d6c0b0de16 | 2026-08-22 | true | assertion | bugfix | M | modified-test | 2 | 85 | fix(client): skip undefined header and cookie values (#5244) |
| f8b7847d75 | 2026-08-22 | true | assertion | bugfix | S | modified-test | 2 | 11 | fix(etag): match If-None-Match tags with optional whitespace before the comma (#5222) |
| 48e360fcaa | 2026-08-19 | true | assertion | bugfix | M | modified-test | 2 | 81 | fix(jsx/dom): execute previous ref cleanup when ref prop changes on re-render (#5264) |
| 7967760748 | 2026-08-19 | true | assertion | bugfix | S | modified-test | 2 | 11 | fix(request): handle params on unmatched requests (#5268) |
| 5ad469a888 | 2026-08-18 | true | assertion | feature | M | modified-test | 2 | 51 | feat(pretty-json): support structured JSON content-types (+json) (#5226) |
| c91ec9b60d | 2026-08-18 | true | assertion | bugfix | S | modified-test | 2 | 12 | fix(utils/ipaddr): avoid truncation on embedded IPv4 addresses in expandIPv6 (#5247) |
| eea9735fe3 | 2026-08-17 | true | assertion | bugfix | S | modified-test | 2 | 12 | fix(csrf): exempt OPTIONS request from CSRF validation (#5250) |
| 63bbcf508c | 2026-08-17 | true | assertion | bugfix | L | modified-test | 4 | 194 | fix(trie-router): match suffix wildcard routes (#5236) |
| 8bf03c377a | 2026-08-16 | true | assertion | bugfix | S | modified-test | 2 | 30 | fix(cors): append Origin to Vary header on OPTIONS preflight (#5235) |
| 546eca0c40 | 2026-08-16 | true | assertion | bugfix | S | modified-test | 2 | 33 | fix(etag): avoid skipping headers when filtering 304 response headers (#5234) |
| 7195c24860 | 2026-08-16 | true | assertion | bugfix | M | mixed | 3 | 53 | fix(etag): copy pending stream bytes (#5239) |
| 4eb022de68 | 2026-08-16 | true | assertion | bugfix | S | modified-test | 2 | 17 | fix(client): prevent URL corruption when replaceUrlParam contains $ replacement tokens (#5227) |
| 329b6f4686 | 2026-08-13 | true | assertion | bugfix | S | modified-test | 2 | 16 | fix(client): send falsy JSON bodies (#5215) |
| d982f637eb | 2026-08-13 | true | assertion | bugfix | XS | modified-test | 2 | 5 | fix(url): strip trailing question mark correctly for optional params with regex quantifiers (#5209) |
| 26de73133b | 2026-08-10 | true | assertion | bugfix | M | modified-test | 2 | 85 | fix(etag): stabilize digest across stream chunks (#5205) |
| f2a72d333a | 2026-08-09 | true | assertion | bugfix | XS | modified-test | 2 | 10 | fix(client): serialize multiple cookies correctly (#5202) |
| 8a5852d4c1 | 2026-08-09 | true | assertion | bugfix | M | modified-test | 2 | 51 | fix(etag): resolve incorrect incremental hashing for chunked responses (#5199) |
| 765d13b009 | 2026-08-09 | true | assertion | bugfix | S | modified-test | 2 | 39 | fix(jsx): render async children of document metadata tags instead of [object Promise] (#5204) |
| 13a9481ee1 | 2026-08-09 | true | assertion | bugfix | S | modified-test | 2 | 11 | fix(secure-headers): output standard empty parentheses () instead of none for disabled Permissions-Policy directives (#5197) |
| f6aa913c3f | 2026-08-07 | true | assertion | bugfix | S | modified-test | 2 | 38 | fix(etag): skip unsafe methods or error responses on non-* case (#5196) |
| cd31bc196e | 2026-08-06 | true | assertion | bugfix | S | modified-test | 2 | 45 | fix(utils/stream): re-acquire writer lock when pipe() throws (#4988) |
| 569b4191a2 | 2026-08-06 | true | assertion | bugfix | S | modified-test | 3 | 45 | fix(trie-router): count every slash a pattern consumes (#5189) |
| 8f07028270 | 2026-08-04 | true | assertion | bugfix | M | modified-test | 2 | 101 | fix(compress): set Vary: Accept-Encoding on negotiated responses (#5137) |
| 8a0b18fd9b | 2026-08-04 | true | assertion | feature | XL | modified-test | 4 | 572 | feat(reg-exp-router): throw UnsupportedPathError during route registration (#5171) |
| 3feb3551d4 | 2026-08-04 | true | assertion | bugfix | L | modified-test | 8 | 265 | fix(jsx): allow a function component to return an array (#5179) |
| 30277aee0d | 2026-08-04 | true | assertion | feature | M | modified-test | 4 | 139 | feat(jwt,jwk): add a configurable WWW-Authenticate realm (#5141) |
| 3bc96ba915 | 2026-08-04 | true | assertion | feature | XL | modified-test | 2 | 561 | feat(cache): add first-class support for QUERY requests (#5119) |
| 75b8a4932a | 2026-08-04 | true | assertion | feature | S | modified-test | 2 | 23 | feat(cors): allow QUERY by default as a first-class method (#5115) |
| 2159deb4bd | 2026-08-04 | true | assertion | feature | S | modified-test | 2 | 49 | feat(etag): support conditional requests for the QUERY method (#5111) |
| 6f101a7779 | 2026-08-04 | true | assertion | feature | S | modified-test | 5 | 47 | feat: add first-class QUERY method support (#5070) |
| 0c45036d6b | 2026-08-03 | true | assertion | unknown | S | modified-test | 2 | 48 | Merge commit from fork |
| 720b566290 | 2026-08-03 | true | assertion | unknown | S | modified-test | 2 | 32 | Merge commit from fork |
| 93fc250d8b | 2026-08-03 | true | assertion | unknown | XS | modified-test | 2 | 9 | Merge commit from fork |
| 224d2f5cbf | 2026-07-26 | true | assertion | bugfix | L | modified-test | 2 | 158 | fix(jsx): handle useSyncExternalStore subscription and snapshot changes (#5166) |
| 09cf01c0a8 | 2026-07-26 | true | assertion | bugfix | S | modified-test | 2 | 35 | fix(cookie): relax name validation when parsing Cookie header (#5164) |
| 402eb3abe5 | 2026-07-24 | true | assertion | bugfix | M | modified-test | 2 | 93 | fix(secure-headers): keep CSP callbacks scoped to their header (#5147) |
| c85aead088 | 2026-07-24 | true | assertion | bugfix | S | modified-test | 6 | 27 | fix: use `Object.create(null)` when parsing query, headers, and params (#5161) |
| 44f884321a | 2026-07-21 | true | assertion | bugfix | S | modified-test | 2 | 13 | fix(sse): emit empty id field to reset Last-Event-ID (#5138) |
| aeba9ece77 | 2026-07-19 | true | assertion | bugfix | S | modified-test | 2 | 29 | fix(sse): emit retry feild when retry is `0` (#5135) |
| d7964503c9 | 2026-07-18 | true | assertion | bugfix | S | modified-test | 2 | 36 | fix(request): fix multipart boundary mismatch in `cloneRawRequest` (#5133) |
| 80959d47d5 | 2026-07-18 | true | assertion | bugfix | S | modified-test | 2 | 22 | fix(utils/body): reuse cached formData in `parseBody()` (#5131) |
| e0cdeb0a89 | 2026-07-13 | true | assertion | bugfix | S | modified-test | 2 | 28 | fix(method-override): set duplex when forwarding a stream body in query mode (#5110) |
| 653025e5c3 | 2026-07-13 | true | assertion | bugfix | S | modified-test | 2 | 12 | fix(client): replaceUrlParam should not match a param that prefixes another (#5096) |
| 67efb27f7b | 2026-07-13 | true | assertion | bugfix | S | modified-test | 2 | 15 | fix(compress): do not compress 206 Partial Content responses (#5020) |
| a48c8bf248 | 2026-07-13 | true | assertion | bugfix | S | modified-test | 2 | 20 | fix(cache): deduplicate Cache-Control directives case-insensitively (#5025) |
| 2126289c15 | 2026-07-10 | true | assertion | bugfix | S | modified-test | 2 | 40 | fix(etag): treat If-None-Match: `*` as a match (#5084) |
| 0fc7ffc949 | 2026-07-10 | true | assertion | bugfix | M | modified-test | 4 | 51 | fix(trie-router): match empty wildcard remainder after regexp param (#5102) |
| b93a2547a3 | 2026-07-10 | true | assertion | bugfix | XS | modified-test | 2 | 9 | fix(aws-lambda): treat any non-identity content-encoding as binary (#5101) |
| 6217f4b74c | 2026-07-10 | true | assertion | bugfix | M | modified-test | 2 | 71 | fix(lambda-edge): base64 encode content-encoded response bodies (#5099) |
| 24547a6ed5 | 2026-07-07 | true | assertion | bugfix | M | modified-test | 3 | 117 | fix(lambda-edge): resolve the handler with the value passed to the callback (#5094) |
| f9992096de | 2026-07-07 | true | assertion | bugfix | M | modified-test | 2 | 71 | fix(client): merge function headers with per-request headers (#5092) |
| 45b081b9b9 | 2026-07-05 | true | assertion | bugfix | S | modified-test | 2 | 23 | fix(aws-lambda): detect V2 events by request context, not rawPath alone (#5033) |
| 872997d283 | 2026-07-04 | true | assertion | bugfix | S | modified-test | 2 | 43 | fix(bun): report the requested subprotocol on WSContext.protocol (#5059) |
| b20d4225c9 | 2026-07-01 | true | assertion | bugfix | M | modified-test | 6 | 125 | fix(utils/body,validator): normalize Content-Type media type for case-insensitive matching (#5067) |
| 03a9416a13 | 2026-06-30 | true | assertion | bugfix | S | modified-test | 2 | 17 | fix(serve-static): treat empty string content as found (#5062) |
| aa921770d0 | 2026-06-23 | true | assertion | unknown | M | modified-test | 2 | 77 | Merge commit from fork |
| cd3f6f7194 | 2026-06-23 | true | assertion | unknown | M | modified-test | 3 | 92 | Merge commit from fork |
| fab3b13639 | 2026-06-23 | true | assertion | unknown | XL | mixed | 8 | 1489 | Merge commit from fork |
| 751ba41ba2 | 2026-06-09 | true | assertion | unknown | S | modified-test | 2 | 11 | Merge commit from fork |
| f0b094db84 | 2026-06-09 | true | assertion | unknown | M | modified-test | 2 | 69 | Merge commit from fork |
| fa5f9bfcc2 | 2026-06-09 | true | assertion | unknown | M | modified-test | 4 | 88 | Merge commit from fork |
| 3892a6c2b5 | 2026-06-09 | true | assertion | unknown | S | modified-test | 2 | 32 | Merge commit from fork |
| 7ae7cbae5d | 2026-06-09 | true | assertion | unknown | M | modified-test | 2 | 65 | Merge commit from fork |
| c78932d745 | 2026-06-04 | true | assertion | bugfix | S | modified-test | 2 | 13 | fix(utils/ipaddr): render the unspecified address binary as "::" (#4998) |
| d22ff9c6fe | 2026-06-02 | true | assertion | bugfix | XS | modified-test | 2 | 9 | fix(utils/ipaddr): expand "::" to eight zero groups (#4973) |
| 413d3cbd0e | 2026-06-01 | true | assertion | bugfix | S | modified-test | 2 | 11 | fix(bearer-auth): mention verifyToken in missing-options error message (#4987) |
| bcd290a64c | 2026-05-25 | false | assertion | bugfix | XS | modified-test | 2 | 7 | fix(utils/ipaddr): do not compress a single 0 group to `::` (#4971) |
| c968177d9c | 2026-05-25 | false | assertion | feature | M | modified-test | 2 | 73 | feat(compress): add contentTypeFilter option and `COMPRESSIBLE_CONTENT_TYPE_REGEX` re-export (#4961) |
| 82dad6297c | 2026-05-24 | false | assertion | bugfix | S | modified-test | 2 | 13 | fix(serve-static): normalize all backslashes in file paths, not just the first (#4962) |
| 7e0555d14c | 2026-05-22 | false | assertion | bugfix | M | modified-test | 2 | 79 | fix(deno): echo negotiated WebSocket subprotocol in upgrade response (#4955) |
| f0ed246591 | 2026-05-22 | false | assertion | bugfix | M | modified-test | 2 | 145 | fix(compress): respect Accept-Encoding when encoding option is set (#4951) |
| a192df0844 | 2026-05-22 | false | assertion | bugfix | M | modified-test | 2 | 53 | fix(mime): specify charset parameter per MIME type instead of mechanical detection (#4912) |
| 6cbb025ff8 | 2026-05-19 | false | assertion | unknown | S | modified-test | 2 | 36 | Merge commit from fork |
| c831020fb1 | 2026-05-19 | false | assertion | unknown | XL | modified-test | 4 | 434 | Merge commit from fork |
| 905aedbc20 | 2026-05-19 | false | assertion | unknown | S | modified-test | 2 | 26 | Merge commit from fork |
| 5463db2735 | 2026-05-19 | false | assertion | unknown | L | modified-test | 4 | 197 | Merge commit from fork |
| dcabbece34 | 2026-05-19 | false | assertion | bugfix | M | modified-test | 3 | 85 | fix(route): preserve the base path of the mounted route() app (#4942) |
| 54f2f0cfda | 2026-05-16 | false | assertion | feature | S | modified-test | 2 | 49 | feat(request): add `bytes()` (#4921) |
| e59db594fb | 2026-05-16 | false | assertion | feature | L | modified-test | 2 | 268 | feat(cache): key cache entries by configured vary headers (#4915) |
| ff7522fdcc | 2026-05-16 | false | assertion | bugfix | M | modified-test | 2 | 62 | fix(cookie): return the first cookie when there are multiple cookies with the same name (#4922) |
| a5bd9ebead | 2026-05-06 | false | assertion | unknown | L | modified-test | 2 | 184 | Merge commit from fork |
| 58d3d3ad56 | 2026-05-06 | false | assertion | unknown | XL | modified-test | 4 | 401 | Merge commit from fork |
| 568c2ecc1d | 2026-05-06 | false | assertion | unknown | L | modified-test | 2 | 157 | Merge commit from fork |
| 8f027e5574 | 2026-05-03 | false | assertion | bugfix | S | modified-test | 2 | 18 | fix(ssg): add `atom+xml` and `rss+xml` to `defaultExtensionMap` (#4899) |
| bfba97ca7e | 2026-05-01 | false | assertion | bugfix | S | modified-test | 3 | 19 | fix(jsx): normalize SVG attributes on the <svg> root element (#4893) |
| db05b96d7a | 2026-04-30 | false | assertion | unknown | M | modified-test | 2 | 140 | Merge commit from fork |
| 614b834551 | 2026-04-30 | false | assertion | unknown | L | modified-test | 4 | 195 | Merge commit from fork |
| 027e3dfca9 | 2026-04-26 | false | assertion | bugfix | S | modified-test | 2 | 19 | fix(method-override): handle Content-Type with charset parameter (#4894) |
| 18fe604c8c | 2026-04-23 | false | assertion | bugfix | S | modified-test | 2 | 35 | fix(jwt): support single-line PEM keys (#4889) |
| 66daa2edef | 2026-04-15 | false | assertion | unknown | L | modified-test | 8 | 299 | Merge commit from fork |
| fa2c74fe5c | 2026-04-15 | false | assertion | bugfix | M | modified-test | 2 | 72 | fix(aws-lambda): handle invalid header names in request processing (#4883) |
| faa6c46a1a | 2026-04-15 | false | assertion | feature | S | modified-test | 2 | 41 | feat(cache): add `onCacheNotAvailable` option (#4876) |
| f23e97b7f3 | 2026-04-15 | false | assertion | feature | M | modified-test | 2 | 82 | feat(trailing-slash): add `skip` option (#4862) |
| cc067c8559 | 2026-04-07 | false | assertion | unknown | M | modified-test | 2 | 60 | Merge commit from fork |
| a586cd72e3 | 2026-04-07 | false | assertion | unknown | S | modified-test | 2 | 16 | Merge commit from fork |
| 48fa2233bc | 2026-04-07 | false | assertion | unknown | M | modified-test | 3 | 98 | Merge commit from fork |
| b470278920 | 2026-04-07 | false | assertion | unknown | M | modified-test | 4 | 100 | Merge commit from fork |
| 9aff14bd72 | 2026-04-07 | false | assertion | unknown | XS | modified-test | 2 | 7 | Merge commit from fork |
| f82aba8e8e | 2026-04-04 | false | assertion | feature | XL | modified-test | 5 | 456 | feat(css): add classNameSlug option to createCssContext (#4834) |
| 0bce36bf36 | 2026-03-31 | false | assertion | bugfix | M | modified-test | 2 | 58 | fix(compress): convert strong ETag to weak ETag when compressing (#4848) |
| 75b4308496 | 2026-03-31 | false | assertion | bugfix | M | modified-test | 2 | 123 | fix(jsx/dom): apply select value after children are rendered (#4847) |
| 66fe9feec2 | 2026-03-23 | false | assertion | bugfix | M | modified-test | 2 | 78 | fix(cors): reflect request origin when credentials is true with wildcard (#4813) |
| 8bd9dddce2 | 2026-03-21 | false | assertion | bugfix | S | modified-test | 2 | 46 | fix(request): remove `parseBody` from bodyCache to prevent TypeError (#4807) |
| 0c0bf8d789 | 2026-03-13 | false | assertion | security | M | modified-test | 2 | 86 | fix(bearer-auth): escape regex metacharacters in bearer auth prefix option (#4750) |
| 488ea6ab3e | 2026-03-12 | false | assertion | bugfix | XS | modified-test | 2 | 3 | fix(utils/mime): Normalize input extension to lowercase before MIME check (#4800) |
| ef902257e0 | 2026-03-10 | false | assertion | unknown | M | modified-test | 2 | 56 | Merge commit from fork |
| 53b66aeac5 | 2026-03-10 | false | assertion | bugfix | S | modified-test | 2 | 38 | fix(lambda-edge): avoid callback handler deprecation on NODEJS_24_X (#4782) |
| 58825a72f7 | 2026-03-10 | false | assertion | feature | M | modified-test | 2 | 68 | feat(jsx-renderer): support function-based options (#4780) |
| 5086956298 | 2026-03-06 | false | assertion | bugfix | L | modified-test | 2 | 373 | fix(accept): replace regex split to mitigate ReDoS (#4758) |
| 8c4d7f3d2f | 2026-03-04 | false | assertion | bugfix | M | modified-test | 2 | 61 | fix(jwt): validate token format in decode and decodeHeader functions (#4752) |
| 44ae0c8cc4 | 2026-03-03 | false | assertion | unknown | S | modified-test | 2 | 30 | Merge commit from fork |
| 6a0607a929 | 2026-03-03 | false | assertion | unknown | S | modified-test | 3 | 28 | Merge commit from fork |
| bda46ac114 | 2026-02-26 | false | assertion | bugfix | M | modified-test | 2 | 71 | fix(jwt): prevent memory leak by avoiding mutation of options object (#4759) |
| e4602ad11a | 2026-02-24 | false | assertion | bugfix | S | modified-test | 2 | 24 | fix(jwt): use `Math.floor` instead of bitwise OR for safe timestamp (#4754) |
| 4bb70fafbc | 2026-02-24 | false | assertion | bugfix | S | modified-test | 2 | 24 | fix(validator): prevent type diff bug in form data parsing (#4753) |
| 41adbf56e2 | 2026-02-23 | false | assertion | unknown | M | modified-test | 2 | 52 | Merge commit from fork |
| 02346c6d94 | 2026-02-19 | false | assertion | feature | M | modified-test | 2 | 95 | feat(language): add progressive locale code truncation to normalizeLanguage (#4717) |
| 034223f1bf | 2026-02-19 | false | assertion | feature | L | modified-test | 2 | 204 | feat(trailing-slash): add `alwaysRedirect` option to support wildcard routes (#4658) |
| bf37828d6d | 2026-02-19 | false | assertion | feature | M | modified-test | 2 | 138 | feat(basic-auth): add context key and callback options (#4645) |
| 9524923b48 | 2026-02-19 | false | assertion | feature | M | modified-test | 4 | 150 | feat(client): $path (#4636) |
| 67ac19a99f | 2026-02-19 | false | assertion | bugfix | S | modified-test | 2 | 39 | fix(client): skip undefined values in form data serialization (#4732) |
| 0c1d4c76cf | 2026-02-08 | false | assertion | bugfix | M | modified-test | 2 | 63 | fix(url): ignore fragment identifiers in getPath() (#4627) |
| 3aa2f9ae09 | 2026-02-06 | false | assertion | bugfix | S | modified-test | 2 | 23 | fix(bearer-auth): make auth-scheme case-insensitive (#4659) |
| edbf6eea8e | 2026-01-27 | false | assertion | unknown | S | modified-test | 2 | 17 | Merge commit from fork |
| 12c511745b | 2026-01-27 | false | assertion | unknown | M | modified-test | 2 | 104 | Merge commit from fork |
| 190f6e28e2 | 2026-01-13 | false | assertion | unknown | XL | modified-test | 7 | 703 | Merge commit from fork |
| cc0aa7ae32 | 2026-01-13 | false | assertion | unknown | L | modified-test | 5 | 240 | Merge commit from fork |
| b694129912 | 2025-12-13 | false | assertion | feature | M | modified-test | 3 | 116 | feat(client): add buildSearchParams option to customize query serialization (#4535) |
| d94f4a44e7 | 2025-12-13 | false | assertion | feature | S | modified-test | 2 | 21 | feat(context-storage): Add optional tryGetContext helper to context-storage middleware (#4539) |
| 61f473ba1f | 2025-12-13 | false | assertion | feature | S | modified-test | 2 | 26 | feat(pretty-json): support force option (#4531) |
| 44bb7bb08a | 2025-12-13 | false | assertion | feature | M | modified-test | 3 | 68 | feat(timing): add wrapTime to simplify usage (#4519) |
| d2e7440d85 | 2025-12-09 | false | assertion | feature | M | modified-test | 2 | 52 | feat(csrf): Support async `IsAllowedSecFetchSiteHandler` (#4559) |
| 489afe6b79 | 2025-12-09 | false | assertion | feature | M | modified-test | 2 | 53 | feat(csrf): Support async `IsAllowedOriginHandler` (#4558) |
| 7d6d04ea4b | 2025-11-26 | false | assertion | bugfix | S | modified-test | 3 | 24 | fix(adapter/bun): fix TypeError: null is not an object (#4429) (#4538) |
| 96d2a89c57 | 2025-11-14 | false | assertion | feature | XL | modified-test | 2 | 492 | feat: Improve auth middlewares (#4485) |
| cea3fb09a1 | 2025-11-14 | false | assertion | feature | L | modified-test | 4 | 301 | feat(aws-lambda): handle AWS Lattice events (#4451) |
| df851842a4 | 2025-11-11 | false | assertion | bugfix | M | modified-test | 2 | 84 | fix(middleware/cache): skip caching when `Vary: *` is present (#4504) |
| fa8eef7079 | 2025-11-07 | false | assertion | bugfix | XS | modified-test | 2 | 9 | fix(utils/url): make _getQueryParam search behind question mark (#4507) |
| d9b8b4b73b | 2025-10-25 | false | assertion | unknown | M | modified-test | 2 | 67 | Merge commit from fork |
| 52161170e8 | 2025-10-24 | false | assertion | bugfix | S | modified-test | 2 | 15 | fix(request-id): validation accepts `=` (#4478) |
| 253ec2857a | 2025-10-23 | false | assertion | bugfix | S | modified-test | 2 | 33 | fix(aws-lambda): serve microsoft office files as binary in lambda handler (#4469) |
| 45ba3bf9e3 | 2025-10-22 | false | assertion | unknown | L | modified-test | 3 | 317 | Merge commit from fork |
| 9ae98c9416 | 2025-10-17 | false | assertion | bugfix | M | modified-test | 2 | 122 | fix(proxy): Correct hop-by-hop header handling per RFC 9110 (#4459) |
| 12806614b9 | 2025-10-16 | false | assertion | feature | L | modified-test | 3 | 264 | feat(request): add cloneRawRequest utility for request cloning (#4382) |
| 38f756dd92 | 2025-10-05 | false | assertion | security | S | modified-test | 2 | 41 | fix(aws-lambda): sanitize non-ASCII header values to prevent ByteString errors (#4437) |
| 81bda2e169 | 2025-09-24 | false | assertion | feature | S | modified-test | 2 | 45 | feat(helper/route): enable to get route path at specific index (#4423) |
| 3fe60f180a | 2025-09-18 | false | assertion | bugfix | M | modified-test | 3 | 51 | fix(request): return empty string for empty catch-all param (#4395) |
| 605c70560b | 2025-09-12 | false | assertion | unknown | M | modified-test | 2 | 84 | Merge commit from fork |
| 5b277d811c | 2025-09-05 | false | assertion | bugfix | S | modified-test | 2 | 33 | fix(client): Fix `parseResponse` not parsing json in react native (#4399) |
| 1d79aedc3f | 2025-09-03 | false | assertion | unknown | S | modified-test | 2 | 16 | Merge commit from fork |
