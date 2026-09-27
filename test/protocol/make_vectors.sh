#!/usr/bin/env bash
# Regenerate test/vectors/proof_protocol.json: a Groth16 and a PLONK proof of the one-constraint
# multiplier (3 * 11 = 33), each with its verification key. The Groth16 key has one local contribution,
# which is fine for a test vector with no security meaning and would never be for a real circuit.
# Needs circom (set CIRCOM) and the 2^15 Powers of Tau (fetched and hash-checked).
set -euo pipefail
CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
bash scripts/fetch_ptau.sh 15 circuits/build/pot15.ptau
"$CIRCOM" test/protocol/multiplier.circom --r1cs --wasm -o "$T" >/dev/null
echo '{"a":"3","b":"11"}' > "$T/input.json"
"$SNARKJS" groth16 setup "$T/multiplier.r1cs" circuits/build/pot15.ptau "$T/g0.zkey" >/dev/null
"$SNARKJS" zkey contribute "$T/g0.zkey" "$T/g.zkey" --name=vector -e="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" >/dev/null
"$SNARKJS" zkey export verificationkey "$T/g.zkey" "$T/g_vkey.json" >/dev/null
"$SNARKJS" groth16 fullprove "$T/input.json" "$T/multiplier_js/multiplier.wasm" "$T/g.zkey" "$T/g_proof.json" "$T/g_public.json" >/dev/null
"$SNARKJS" plonk setup "$T/multiplier.r1cs" circuits/build/pot15.ptau "$T/p.zkey" >/dev/null
"$SNARKJS" zkey export verificationkey "$T/p.zkey" "$T/p_vkey.json" >/dev/null
"$SNARKJS" plonk fullprove "$T/input.json" "$T/multiplier_js/multiplier.wasm" "$T/p.zkey" "$T/p_proof.json" "$T/p_public.json" >/dev/null
node -e '
const fs = require("fs"), t = process.argv[1], r = (f) => JSON.parse(fs.readFileSync(`${t}/${f}`, "utf8"));
const out = {
  note: "Test vectors for test/proof_protocol.test.js, from test/protocol/make_vectors.sh. The one-constraint multiplier, 3 * 11 = 33. No security meaning.",
  groth16: { vkey: r("g_vkey.json"), proof: r("g_proof.json"), publicSignals: r("g_public.json") },
  plonk: { vkey: r("p_vkey.json"), proof: r("p_proof.json"), publicSignals: r("p_public.json") },
};
fs.writeFileSync("test/vectors/proof_protocol.json", JSON.stringify(out, null, 2) + "\n");
' "$T"
echo "wrote test/vectors/proof_protocol.json"
