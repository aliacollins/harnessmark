# UNVERIFIED: written on a machine without a docker daemon. Build with
# docker/build.sh; validate by running one cached baseline under
# BENCH_RUNTIME=docker and diffing it against .evidence/baseline/immer.
#
# Pinned grading environment for immer. The dependency tree is installed from the
# lockfile at the clone's HEAD into /work/node_modules, which harness/runtime.mjs
# mounts as a named volume over the worktree's node_modules path.
FROM node:24.5.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /work
# The build context is the repo clone (spike/work/immer); see docker/build.sh.
COPY package.json yarn.lock .yarnrc.yml* ./
COPY .yarn ./.yarn
RUN corepack yarn install --frozen-lockfile
ENV CI=1
