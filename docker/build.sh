#!/usr/bin/env sh
# Build every pinned grading image. UNVERIFIED on the authoring machine (no
# docker daemon). Each docker/<repo>/Dockerfile uses the repo CLONE as its build
# context so lockfiles come from the clone's HEAD; the tag matches
# REPOS[<repo>].image in harness/registry.mjs.
#
#   sh docker/build.sh            # all repos that have a Dockerfile and a clone
#   sh docker/build.sh immer hono # a subset
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
repos="$*"
if [ -z "$repos" ]; then
	repos=$(ls "$ROOT/docker" | grep -v '^_' | grep -v '\.' )
fi
for r in $repos; do
	df="$ROOT/docker/$r/Dockerfile"
	ctx="$ROOT/spike/work/$r"
	if [ ! -f "$df" ]; then echo "skip $r: no Dockerfile"; continue; fi
	if [ ! -d "$ctx" ]; then echo "skip $r: no clone at $ctx (run spike/harvest.mjs $r first)"; continue; fi
	tag=$(node -e "import('$ROOT/harness/registry.mjs').then(m=>console.log(m.REPOS['$r'].image))")
	echo "== building $tag from $ctx"
	docker build --build-context bench="$ROOT" -f "$df" -t "$tag" "$ctx"
done
