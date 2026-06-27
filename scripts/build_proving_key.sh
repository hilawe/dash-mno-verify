#!/usr/bin/env bash
# Reproducibly build one circuit's PLONK proving artifacts (the witness wasm and the proving key)
# and export its verification key. PLONK setup is deterministic given the same r1cs and the same
# universal SRS, so anyone who runs this derives the same keys. They are rebuilt from public inputs
# (this repo's circuits, the pinned circom-ecdsa, the public Hermez Powers of Tau). For
# mno_membership the script also proves a test witness and verifies it against the exported key.
#
# That is the distribution model: the multi-GB proving key is not hosted. It is rebuilt from public
# inputs and the small verification key is committed. See docs/PROVING_KEY.md.
#
# Usage: scripts/build_proving_key.sh [circuit]
#   circuit is mno_membership (default) or mno_registration. See scripts/rebuild_proving_keys.sh to
#   rebuild both at once. Needs the circom binary (set CIRCOM), node deps (npm ci), ~3 GB of disk,
#   and a 1.15 GB SRS download. Takes several minutes per circuit.
set -euo pipefail

CIRCUIT="${1:-mno_membership}"
case "$CIRCUIT" in
  mno_membership)   VKEY="verification_key.json";      MK="test/membership/make_input.mjs" ;;
  mno_registration) VKEY="mno_registration_vkey.json"; MK="test/registration/make_input.mjs" ;;
  *) echo "unknown circuit: $CIRCUIT (expected mno_membership or mno_registration)" >&2; exit 1 ;;
esac

CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="circuits/build"
PTAU="${PTAU:-$OUT/pot20.ptau}"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}"

mkdir -p "$OUT"

echo "--- fetch circom-ecdsa (pinned commit) ---"
bash scripts/setup_circom_ecdsa.sh

echo "--- compile $CIRCUIT ---"
"$CIRCOM" "circuits/$CIRCUIT.circom" --r1cs --wasm -o "$OUT" -l node_modules -l circuits/.deps >/dev/null

if [ ! -f "$PTAU" ]; then
  echo "--- download universal SRS (2^20, ~1.15 GB) ---"
  curl -fSL "$PTAU_URL" -o "$PTAU"
fi

echo "--- PLONK setup (several minutes, ~12 GB heap) ---"
"$SNARKJS" plonk setup "$OUT/$CIRCUIT.r1cs" "$PTAU" "$OUT/$CIRCUIT.zkey" >/dev/null

# Prove a real witness with the rebuilt zkey, then check it two ways depending on intent.
#
# Default (reproducibility): verify the proof against the COMMITTED verification key and do not
# touch it. PLONK setup is deterministic, so a faithful rebuild produces a proof the committed key
# accepts; a drifted compiler, circuit, or dependency produces one it rejects, which fails here.
# This is the guarantee a deployed gateway relies on, that a locally rebuilt proving key matches the
# committed verification key.
#
# Promote (MNO_PROMOTE_VKEY=1, used by rebuild_proving_keys.sh after an intentional circuit change):
# export the new verification key to a temp, verify the proof against it, then overwrite the
# committed key, so a failed run never leaves a half-updated key behind.
echo "--- integrity: prove a test witness ---"
node "$MK" "$OUT" >/dev/null
"$SNARKJS" plonk fullprove "$OUT/input.json" "$OUT/${CIRCUIT}_js/$CIRCUIT.wasm" \
  "$OUT/$CIRCUIT.zkey" "$OUT/proof.json" "$OUT/public.json" >/dev/null

if [ "${MNO_PROMOTE_VKEY:-}" = "1" ]; then
  echo "--- promote: export the new verification key and overwrite the committed one ---"
  "$SNARKJS" zkey export verificationkey "$OUT/$CIRCUIT.zkey" "$OUT/$VKEY.tmp" >/dev/null
  "$SNARKJS" plonk verify "$OUT/$VKEY.tmp" "$OUT/public.json" "$OUT/proof.json"
  mv "$OUT/$VKEY.tmp" "$OUT/$VKEY"
  echo "    verification key updated at $OUT/$VKEY"
else
  echo "--- reproducibility: verify against the committed $VKEY (no overwrite) ---"
  if [ ! -f "$OUT/$VKEY" ]; then
    echo "no committed $OUT/$VKEY to verify against; rerun with MNO_PROMOTE_VKEY=1 to create it" >&2
    exit 1
  fi
  "$SNARKJS" plonk verify "$OUT/$VKEY" "$OUT/public.json" "$OUT/proof.json"
  echo "    the rebuilt key reproduces the committed $VKEY"
fi

echo
echo "Artifacts ready in $OUT:"
echo "  $CIRCUIT.zkey                 PLONK proving key (~2.3 GB, distribute out of band)"
echo "  ${CIRCUIT}_js/$CIRCUIT.wasm   witness generator"
echo "  $VKEY                         verification key (committed)"
