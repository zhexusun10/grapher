# Reproducible Grapher *base* for Harbor task images. Does not copy the build
# context (and thus cannot accidentally ship .env, model keys or local edits).
# Build: docker build -f benchmark/Dockerfile --build-arg GRAPHER_COMMIT=<sha> -t grapher-harbor:<sha> benchmark
# Task images must retain their own dependencies/files and use the SAME image
# configuration when comparing agent harnesses. User namespaces must also be
# allowed by the outer Harbor environment; an image alone cannot enable them.
FROM node:22.19.0-bookworm

ARG GRAPHER_REPOSITORY=https://github.com/zhexusun10/grapher.git
ARG GRAPHER_COMMIT
ARG RUST_VERSION=1.98.1

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        bubblewrap git curl ca-certificates build-essential pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"
ENV PATH="/root/.cargo/bin:${PATH}"

RUN test -n "${GRAPHER_COMMIT}" \
    && git clone "${GRAPHER_REPOSITORY}" /installed-agent/grapher \
    && git -C /installed-agent/grapher checkout --detach "${GRAPHER_COMMIT}" \
    && git -C /installed-agent/grapher submodule update --init --recursive \
    && cd /installed-agent/grapher \
    && npm run pi:setup \
    && cargo build --release --manifest-path backend/Cargo.toml --bin grapher \
    && node scripts/pi-baseline.mjs verify \
    && test -x backend/target/release/grapher \
    && test -x /usr/bin/bwrap \
    && test "$(backend/target/release/grapher --build-identity)" = "${GRAPHER_COMMIT}" \
    && test -z "$(git status --porcelain --untracked-files=normal)"
