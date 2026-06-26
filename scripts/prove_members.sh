#!/usr/bin/env bash
# Full PLONK prove-and-verify of the cheap recurring members circuit, end to end. It is
# small (a few thousand constraints), so it fits a small public universal SRS (2^15, ~36
# MB) and runs on every CI push. This is the complete zero-knowledge loop: compile, setup,
# prove, verify.
#
# Set CIRCOM to the circom binary (defaults to `circom` on PATH).
set -euo pipefail

CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUILD="$(mktemp -d)"
PTAU="${PTAU:-circuits/build/pot15.ptau}"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

mkdir -p circuits/build

echo "--- compile mno_members ---"
"$CIRCOM" circuits/mno_members.circom --r1cs --wasm -o "$BUILD" -l node_modules >/dev/null

echo "--- universal SRS (public Hermez 2^15, ~36 MB, cached) ---"
[ -f "$PTAU" ] || curl -fsSL "$PTAU_URL" -o "$PTAU"

echo "--- PLONK setup and verification key ---"
"$SNARKJS" plonk setup "$BUILD/mno_members.r1cs" "$PTAU" "$BUILD/members.zkey" >/dev/null
"$SNARKJS" zkey export verificationkey "$BUILD/members.zkey" "$BUILD/members_vkey.json" >/dev/null

echo "--- witness, prove, verify ---"
node test/members/make_input.mjs "$BUILD" >/dev/null
"$SNARKJS" plonk fullprove "$BUILD/input.json" "$BUILD/mno_members_js/mno_members.wasm" "$BUILD/members.zkey" "$BUILD/proof.json" "$BUILD/public.json" >/dev/null
"$SNARKJS" plonk verify "$BUILD/members_vkey.json" "$BUILD/public.json" "$BUILD/proof.json"

rm -rf "$BUILD"
echo "MEMBERS PLONK PROVE-AND-VERIFY PASSED"
