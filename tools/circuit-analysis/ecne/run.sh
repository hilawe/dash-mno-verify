#!/usr/bin/env bash
# Compile a circuit to UNOPTIMIZED R1CS on the host, then run Ecne's determinism check in the container.
#
# Ecne asks whether the R1CS uniquely determines its outputs from its inputs. --O0 is mandatory: an
# optimized R1CS assumes the compiler preserved equivalence, which is exactly the assumption a soundness
# check must not lean on. Pass a circuit that has a `main` component (the top-level circuits do).
#
#   bash tools/circuit-analysis/ecne/run.sh                         # defaults to mno_members
#   bash tools/circuit-analysis/ecne/run.sh circuits/mno_members.circom
#
# Needs colima running, circom on the host (CIRCOM overrides the path), and the circom-ecdsa dep fetched.
# The big ECDSA circuits may not complete without trusted-function decomposition, which is expected.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
IMG="dash-mno-ecne"
CIRCUIT="${1:-circuits/mno_members.circom}"
NAME="$(basename "$CIRCUIT" .circom)"
# Under the repository's gitignored output/ on purpose. The container runtime (colima) mounts the home
# tree (/Users), but NOT /tmp or the macOS per-user temp ($TMPDIR resolves to /var/folders/...), so a
# work dir outside the home is invisible to the container and the R1CS mount comes up empty. output/ is
# under the repo (so under /Users) and gitignored, so it is both mountable and disposable.
mkdir -p "$REPO/output"
WORK="$(mktemp -d "$REPO/output/ecne-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "=== compiling $CIRCUIT to unoptimized R1CS ===" >&2
( cd "$REPO" && "$CIRCOM" "$CIRCUIT" --r1cs --sym --O0 -l node_modules -l circuits/.deps -o "$WORK" >&2 )

echo "=== Ecne determinism check on $NAME ===" >&2
docker run --rm -v "$WORK:/work:ro" "$IMG" \
  julia --project=/ecne /ecne/src/Ecne.jl --r1cs "/work/$NAME.r1cs" --name "$NAME" --sym "/work/$NAME.sym"
