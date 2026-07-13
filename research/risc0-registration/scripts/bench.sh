#!/usr/bin/env bash
# Runs the registration prover once and reports peak resident memory alongside the
# host's own time, proof-size, and cycle numbers. The peak-memory line is the Phase 0
# go/no-go, keep it under roughly 12 GB on a 16 GB node.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "building host (release) ..."
cargo build --release -p host >/dev/null

BIN=target/release/host

echo "running the prover with a peak-memory measurement ..."
if /usr/bin/time -v true >/dev/null 2>&1; then
  # GNU time (Linux): look for "Maximum resident set size (kbytes)"
  /usr/bin/time -v "$BIN"
elif /usr/bin/time -l true >/dev/null 2>&1; then
  # BSD time (macOS): "maximum resident set size" is in bytes
  /usr/bin/time -l "$BIN"
else
  echo "no GNU or BSD /usr/bin/time found, running without a memory measurement" >&2
  "$BIN"
fi
