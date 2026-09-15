# UNVERIFIED template for a `go test` repo (cobra, chi, gin). Copy to
# docker/<repo>/Dockerfile. The module cache is warmed at build time so tests run
# with --network none; GOFLAGS=-mod=mod is deliberately NOT set so a candidate
# patch that adds a dependency fails visibly instead of downloading.
FROM golang:1.23.2-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY go.mod go.sum* ./
RUN go mod download
ENV CI=1 GOFLAGS=-count=1
