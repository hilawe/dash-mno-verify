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

# Differential derivation check: witness a circuit on the valid input its make_input.mjs wrote and
# compare the circuit's emitted outputs against the independently spelled JS derivations in
# test/derivations.mjs (written to expected_outputs.json by the same make_input run). The witness
# vector lays out as [1, outputs in declaration order, public inputs, private inputs], so output i
# is w[1 + i]. Each argument after the circuit name is key:index into that layout. This pins the
# circomlibjs-vs-circomlib agreement production already depends on (the prover derives the
# commitment in JS to find its leaf, the gateway builds members roots in JS), and it makes a
# derivation rewiring (input order, arity, limb order) fail CI rather than strand members.
derivation_check() {
  local circuit="$1"; shift
  echo "--- derivations: $circuit emits the independently derived outputs ---"
  node "$BUILD/${circuit}_js/generate_witness.js" "$BUILD/${circuit}_js/${circuit}.wasm" \
    "$BUILD/input.json" "$BUILD/d.wtns"
  node_modules/.bin/snarkjs wtns export json "$BUILD/d.wtns" "$BUILD/d.json" >/dev/null
  local pair
  for pair in "$@"; do
    local key="${pair%%:*}" idx="${pair##*:}"
    node -e "
      const w = require('$BUILD/d.json');
      const exp = require('$BUILD/expected_outputs.json')['$key'];
      const got = BigInt(w[$idx]).toString();
      if (got !== exp) { console.error('  MISMATCH $key', got, 'vs', exp); process.exit(1); }
      console.log('  ok $key ' + got.slice(0, 20) + '...');
    "
  done
}

node test/members/make_input.mjs "$BUILD" >/dev/null
derivation_check mno_members nullifier:1

echo "--- compile full mno_membership + mno_registration (fetches circom-ecdsa) ---"
bash scripts/setup_circom_ecdsa.sh >/dev/null 2>&1
"$CIRCOM" circuits/mno_membership.circom   --r1cs --wasm -o "$BUILD" -l node_modules -l circuits/.deps >/dev/null
"$CIRCOM" circuits/mno_registration.circom --r1cs --wasm -o "$BUILD" -l node_modules -l circuits/.deps >/dev/null
echo "  compiled"

# M1: in both key-bearing circuits the d < n constraint must reject a non-canonical private key.
# Take the valid generator-key witness (d = 1), set the key to d + n (same public key, leaf, and
# Merkle path), and assert witness generation fails, since only the d < n constraint can reject it.
m1_reject() {
  local circuit="$1" mk="$2"
  echo "--- M1: $circuit rejects a key d >= the secp256k1 group order ---"
  node "$mk" "$BUILD" >/dev/null
  node test/bad_privkey.mjs "$BUILD/input.json" "$BUILD/bad_input.json"
  if node "$BUILD/${circuit}_js/generate_witness.js" "$BUILD/${circuit}_js/${circuit}.wasm" \
       "$BUILD/bad_input.json" "$BUILD/bad.wtns" >/dev/null 2>&1; then
    echo "  M1 FAILED: $circuit accepted a key >= the group order"; rm -rf "$BUILD"; exit 1
  fi
  echo "  ok, d >= n rejected"
}
m1_reject mno_membership   test/membership/make_input.mjs
derivation_check mno_membership nullifier:1
m1_reject mno_registration test/registration/make_input.mjs
derivation_check mno_registration commitment:1 regNullifier:2

rm -rf "$BUILD"
echo "ALL CIRCUIT CHECKS PASSED"
