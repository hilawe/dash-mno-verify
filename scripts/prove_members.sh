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

echo "--- committed key matches this source ---"
# The gateway boots from the COMMITTED circuits/build/mno_members_vkey.json, but the prove-and-verify
# below uses the freshly exported key, so on its own it never touches the committed one. A committed
# key that drifted from the circuit source (a circuit edit without a key rebuild) would pass unseen,
# and the gateway would then verify member proofs against a key that no longer matches its circuit.
# PLONK setup over a fixed SRS is deterministic, so the freshly exported key must be byte-identical to
# the committed one. Compare canonically (key order independent) and fail on any difference.
COMMITTED="circuits/build/mno_members_vkey.json"
if [ ! -f "$COMMITTED" ]; then
  echo "  MISSING committed key $COMMITTED"; rm -rf "$BUILD"; exit 1
fi
node -e "
  const fs = require('fs');
  const { isDeepStrictEqual } = require('util');
  const a = JSON.parse(fs.readFileSync('$BUILD/members_vkey.json', 'utf8'));
  const b = JSON.parse(fs.readFileSync('$COMMITTED', 'utf8'));
  // isDeepStrictEqual is order-independent for object keys and recurses correctly, so it is exact for
  // the whole key rather than only its top-level scalars (a JSON.stringify replacer-array whitelist
  // would silently drop nested fields).
  if (!isDeepStrictEqual(a, b)) {
    console.error('  MISMATCH: freshly built members vkey differs from the committed $COMMITTED.');
    console.error('  If the circuit changed on purpose, promote the key: copy the freshly exported');
    console.error('  members vkey over the committed one and commit it (see docs/PROVING_KEY.md).');
    process.exit(1);
  }
  console.log('  ok, committed members vkey matches the current circuit');
"

echo "--- witness, prove, verify ---"
node test/members/make_input.mjs "$BUILD" >/dev/null
"$SNARKJS" plonk fullprove "$BUILD/input.json" "$BUILD/mno_members_js/mno_members.wasm" "$BUILD/members.zkey" "$BUILD/proof.json" "$BUILD/public.json" >/dev/null
# Verify against the COMMITTED key, not the freshly exported one, so this loop exercises the exact key
# the gateway ships with rather than a throwaway.
"$SNARKJS" plonk verify "$COMMITTED" "$BUILD/public.json" "$BUILD/proof.json"

rm -rf "$BUILD"
echo "MEMBERS PLONK PROVE-AND-VERIFY PASSED"
