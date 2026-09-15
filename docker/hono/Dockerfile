# UNVERIFIED: written on a machine without a docker daemon (see docker/immer).
# hono's registry recipe is `npm install` with no lockfile committed, so this
# image pins the resolved tree by installing once at build time from the clone's
# HEAD package.json; the resulting node_modules is the frozen dependency set for
# every task graded in this image. Rebuilding the image re-resolves - bump the tag.
FROM node:24.5.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json ./
RUN npm install --no-audit --no-fund
ENV CI=1
