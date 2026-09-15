# UNVERIFIED template for a cargo-nextest repo (clap, serde_json, axum). Copy to
# docker/<repo>/Dockerfile. Crates are fetched and a warm `target` is built at
# the clone HEAD so per-task runs are incremental; /work/target is mounted as the
# deps volume by the runtime. docker/nextest.toml is copied to /bench so the
# registry's --config-file path resolves inside the container too.
FROM rust:1.82.0-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-nextest --locked
WORKDIR /work
COPY . /work
COPY --from=bench docker/nextest.toml /bench/nextest.toml
RUN cargo fetch && cargo nextest run --workspace --no-run --config-file /bench/nextest.toml --profile bench || true
ENV CI=1 CARGO_NET_OFFLINE=true
