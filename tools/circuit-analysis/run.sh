#!/usr/bin/env bash
# Build the circomspect image and run it over the project's circuits.
#
# The circuits and their fetched include trees (node_modules/circomlib, circuits/.deps/circom-ecdsa) are
# mounted from the repository, and the include search paths mirror scripts/check_circuits.sh exactly
# (-L node_modules -L circuits/.deps), so the analyzer sees the same sources the compiler does. Output
# goes to stdout and, if a path is given as the first argument, is also written there.
#
# Needs colima running and the circom-ecdsa dependency fetched (scripts/setup_circom_ecdsa.sh). Like
# tools/x11-reference, this is a deliberate run, not part of npm test.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMG="dash-mno-circuit-analysis"
OUT="${1:-}"

if [ ! -d "$REPO/circuits/.deps/circom-ecdsa" ]; then
  echo "circom-ecdsa is not fetched. Run scripts/setup_circom_ecdsa.sh first." >&2
  exit 1
fi

echo "=== building $IMG (compiles circomspect; first build is slow) ===" >&2
docker build -t "$IMG" "$HERE" >&2

# The top-level circuits plus the shared components. hash160 is a template file with no main; circomspect
# analyzes template-only files too, which is what we want for the component-level view.
CIRCUITS=(
  circuits/mno_membership.circom
  circuits/mno_registration.circom
  circuits/mno_members.circom
  circuits/merkle.circom
  circuits/hash160/hash160.circom
)

echo "=== circomspect (pinned v0.9.0) ===" >&2
docker run --rm "$IMG" circomspect --help >&2 2>&1 | head -1 || true

run_one() {
  local c="$1"
  echo ""
  echo "############################################################"
  echo "### circomspect: $c"
  echo "############################################################"
  # -L paths mirror the compiler's -l flags. Run from /repo so relative includes (./merkle.circom,
  # ./hash160/...) resolve exactly as the compiler resolves them.
  docker run --rm -v "$REPO:/repo:ro" -w /repo "$IMG" \
    circomspect --level INFO -L node_modules -L circuits/.deps "$c" 2>&1 || true
}

report() {
  echo "circomspect report, generated against the working tree"
  echo "circuits analyzed: ${CIRCUITS[*]}"
  for c in "${CIRCUITS[@]}"; do
    run_one "$c"
  done
}

if [ -n "$OUT" ]; then
  report | tee "$OUT"
else
  report
fi
