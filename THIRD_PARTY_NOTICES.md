# Third-party notices

HarnessMark's own code, documentation, frozen sets and results are licensed under the Apache
License 2.0 (see `LICENSE` and `NOTICE`). The task corpus is different: every task is a real
commit harvested from an
open-source project, and the repository ships the parts of those commits the grader needs:
the patch (`spike/out/<repo>/patches/<sha>.patch`), the commit subject and body, file lists
and test-runner output (`spike/out/<repo>/tasks.jsonl`, `chains.jsonl`, `rejected.jsonl`,
`deferred.jsonl`, `report.md`). That material is the work of the upstream authors. It is
redistributed here under its original license, unchanged and not relicensed, with the
notices below. HarnessMark is not affiliated with or endorsed by any of these projects.

A benchmark run checks out the upstream repository itself at the task's parent commit. Those
checkouts, and anything an agent produces from them, are governed by the upstream license too.

## Projects in the corpus

| project | upstream | license | tasks | notice |
| --- | --- | --- | --- | --- |
| immer | https://github.com/immerjs/immer | MIT | 12 | `third_party/immer/LICENSE` |
| hono | https://github.com/honojs/hono | MIT | 167 | `third_party/hono/LICENSE` |

### immer

Source: https://github.com/immerjs/immer (MIT). Verbatim upstream license:

```
MIT License

Copyright (c) 2017 Michel Weststrate

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### hono

Source: https://github.com/honojs/hono (MIT). Verbatim upstream license:

```
MIT License

Copyright (c) 2021 - present, Yusuke Wada and Hono contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Registered, not yet harvested

These repos are registered as candidates in `harness/registry.mjs`. No material from them
is in this repository yet. When one is harvested, its upstream license text must be added
under `third_party/<repo>/LICENSE` and this file regenerated with `node tools/notices.mjs`.
Projects under Apache-2.0 also require their `NOTICE` file, if they ship one, to be copied
alongside.

| project | upstream | license |
| --- | --- | --- |
| zod | https://github.com/colinhacks/zod | MIT |
| h3 | https://github.com/unjs/h3 | MIT |
| httpx | https://github.com/encode/httpx | BSD-3-Clause |
| click | https://github.com/pallets/click | BSD-3-Clause |
| fastapi | https://github.com/tiangolo/fastapi | MIT |
| cobra | https://github.com/spf13/cobra | Apache-2.0 |
| chi | https://github.com/go-chi/chi | MIT |
| gin | https://github.com/gin-gonic/gin | MIT |
| clap | https://github.com/clap-rs/clap | Apache-2.0 OR MIT |
| serde_json | https://github.com/serde-rs/json | Apache-2.0 OR MIT |
| axum | https://github.com/tokio-rs/axum | MIT |
