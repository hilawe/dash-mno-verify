#!/usr/bin/env bash
# Compile the circuits and validate them against known answers. Runs locally and in CI.
# Set CIRCOM to the circom binary (defaults to `circom` on PATH).
set -euo pipefail

CIRCOM="${CIRCOM:-circom}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUILD="$(mktemp -d)"
echo "circom: $($CIRCOM --version)"

# Compile a test circuit, witness it on its generated input, and assert the single packed
# output equals the expected value its make_input.mjs wrote.
check() {
  local name="$1" src="$2" mk="$3"
  echo "--- $name ---"
  node "$mk" "$BUILD" >/dev/null
  "$CIRCOM" "$src" --wasm -o "$BUILD" -l node_modules >/dev/null
  local base; base="$(basename "$src" .circom)"
  node "$BUILD/${base}_js/generate_witness.js" "$BUILD/${base}_js/${base}.wasm" "$BUILD/input.json" "$BUILD/w.wtns"
  node_modules/.bin/snarkjs wtns export json "$BUILD/w.wtns" "$BUILD/w.json" >/dev/null
  node -e "
    const w = require('$BUILD/w.json'), fs = require('fs');
    const exp = BigInt('0x' + fs.readFileSync('$BUILD/expected.txt','utf8').trim());
    const got = BigInt(w[1]);
    if (got !== exp) { console.error('  MISMATCH', got.toString(16), 'vs', exp.toString(16)); process.exit(1); }
    console.log('  ok ' + got.toString(16).padStart(40,'0'));
  "
}

check "ripemd160 known-answer"   test/ripemd160/ripemd160_test.circom test/ripemd160/make_input.mjs
check "hash160 generator vector" test/hash160/hash160_test.circom     test/hash160/make_input.mjs

echo "--- compile mno_members (Poseidon recurring circuit) ---"
"$CIRCOM" circuits/mno_members.circom --r1cs --wasm -o "$BUILD" -l node_modules >/dev/null
echo "  compiled"

rm -rf "$BUILD"
echo "ALL CIRCUIT CHECKS PASSED"
