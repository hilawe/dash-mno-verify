#!/usr/bin/env bash
# Fetch circom-ecdsa (0xPARC) as an external build dependency for the full single-tier
# membership circuit. It is deliberately NOT vendored into this repo: its LICENSE file is
# GPL-3.0, and copying it in would taint this MIT repo. Keeping it external keeps the repo
# MIT-clean. Note that a circuit compiled against it inherits GPL-3.0, so anyone shipping
# the built mno_membership artifacts should treat them as GPL-3.0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/circuits/.deps/circom-ecdsa"

# Pinned for reproducible builds, so everyone derives the same r1cs and the same keys.
REF="${CIRCOM_ECDSA_REF:-d87eb7068cb35c951187093abe966275c1839ead}"

mkdir -p "$ROOT/circuits/.deps"
if [ ! -d "$DST/.git" ]; then
  git clone https://github.com/0xPARC/circom-ecdsa "$DST"
fi
git -C "$DST" checkout -q "$REF"

# Point circom-ecdsa at THIS repo's circomlib so the compiled circuit has a single
# circomlib. Without this, circom-ecdsa's own copy and ours would both be pulled into one
# compilation and circom would error on duplicate template definitions.
mkdir -p "$DST/node_modules"
rm -rf "$DST/node_modules/circomlib"
ln -s "$ROOT/node_modules/circomlib" "$DST/node_modules/circomlib"

echo "circom-ecdsa ready at circuits/.deps/circom-ecdsa (circomlib symlinked to repo)"
