# UNVERIFIED template for a pytest repo (httpx, click, fastapi). Copy to
# docker/<repo>/Dockerfile and set REQ to the repo's test-requirements file.
# Dependencies are installed into /work/.venv, which the runtime mounts over the
# worktree; python3 resolves to the venv interpreter via PATH.
FROM python:3.12.6-slim-bookworm
ARG REQ=requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . /work
RUN python3 -m venv /work/.venv && /work/.venv/bin/pip install --no-cache-dir -U pip \
 && /work/.venv/bin/pip install --no-cache-dir -r ${REQ} && /work/.venv/bin/pip install --no-cache-dir -e . pytest
ENV PATH=/work/.venv/bin:$PATH CI=1
