#!/usr/bin/env bash
# Reproducibly build the full membership proving artifacts: the circuit wasm and the PLONK
# proving key. PLONK setup is deterministic given the same r1cs and the same universal SRS,
# so anyone who runs this derives the same proving key. The script then proves a test
# witness with the rebuilt key and verifies it against the verification key committed in
# the repo, which confirms the rebuilt key is the canonical one.
#
# That is the distribution model: the multi-GB proving key is not hosted. It is rebuilt
# from public inputs (this repo's circuits, the pinned circom-ecdsa, the public Hermez
# Powers of Tau) and checked against the committed 2 KB verification key. See
# docs/PROVING_KEY.md.
#
# Needs the circom binary (set CIRCOM), node deps (npm ci), about 3 GB of disk, and a
# 1.15 GB SRS download. Takes several minutes.
set -euo pipefail

CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="circuits/build"
PTAU="${PTAU:-$OUT/pot20.ptau}"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau"

mkdir -p "$OUT"

echo "--- fetch circom-ecdsa (pinned commit) ---"
bash scripts/setup_circom_ecdsa.sh

echo "--- compile mno_membership ---"
"$CIRCOM" circuits/mno_membership.circom --r1cs --wasm -o "$OUT" -l node_modules -l circuits/.deps >/dev/null

if [ ! -f "$PTAU" ]; then
  echo "--- download universal SRS (2^20, ~1.15 GB) ---"
  curl -fSL "$PTAU_URL" -o "$PTAU"
fi

echo "--- PLONK setup (several minutes) ---"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}"
"$SNARKJS" plonk setup "$OUT/mno_membership.r1cs" "$PTAU" "$OUT/mno_membership.zkey" >/dev/null

echo "--- integrity check: prove with the rebuilt key, verify against the committed key ---"
node test/membership/make_input.mjs "$OUT" >/dev/null
"$SNARKJS" plonk fullprove "$OUT/input.json" "$OUT/mno_membership_js/mno_membership.wasm" \
  "$OUT/mno_membership.zkey" "$OUT/proof.json" "$OUT/public.json" >/dev/null
"$SNARKJS" plonk verify circuits/build/verification_key.json "$OUT/public.json" "$OUT/proof.json"

echo
echo "Proving artifacts ready in $OUT:"
echo "  mno_membership.zkey                     PLONK proving key (~2.3 GB, distribute out of band)"
echo "  mno_membership_js/mno_membership.wasm   witness generator"
echo "The rebuilt key verified against the committed verification key."
