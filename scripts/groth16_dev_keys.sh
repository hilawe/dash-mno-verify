#!/usr/bin/env bash
# Build DEVELOPMENT-ONLY Groth16 keys for the two heavy circuits, so the candidate can be proved,
# verified, and measured end to end before the setup ceremony exists.
#
# NOT FOR PRODUCTION, AND NEVER TO BE PUBLISHED. Groth16 needs a circuit-specific phase-two setup, and
# its soundness rests on at least one contributor discarding their secret. These keys have exactly one
# contribution, made on this machine from local randomness, so whoever ran this script could produce
# proofs these keys accept without a voting key. The production keys come only from the ceremony in
# docs/CEREMONY.md. Everything here is written to circuits/build/dev/, which git ignores, and each key
# directory carries a DEV_ONLY notice.
#
# Usage: scripts/groth16_dev_keys.sh [circuit ...]
#   circuits default to mno_membership and mno_registration. Needs the circom binary (set CIRCOM), node
#   deps (npm ci), the pinned circom-ecdsa, and the 2^20 Powers of Tau (fetched and hash-checked, about
#   1.15 GB). Takes a few minutes per circuit.
#
# Point the provers at the result with MNO_CIRCUIT_DIR=circuits/build/dev, and the gateway with
# MNO_VKEY=circuits/build/dev/mno_membership_vkey.json (single tier) or
# MNO_REG_VKEY=circuits/build/dev/mno_registration_vkey.json (two tier).
set -euo pipefail

CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="circuits/build/dev"
PTAU="${PTAU:-circuits/build/pot20.ptau}"
CIRCUITS=("$@")
[ "${#CIRCUITS[@]}" -gt 0 ] || CIRCUITS=(mno_membership mno_registration)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

for c in "${CIRCUITS[@]}"; do
  case "$c" in
    mno_membership | mno_registration) ;;
    *) echo "unknown circuit: $c (expected mno_membership or mno_registration)" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"
cat > "$OUT/DEV_ONLY.txt" <<'EOF'
DEVELOPMENT-ONLY GROTH16 KEYS. One contribution, made from local randomness on the machine that built
them, so that machine could forge proofs these keys accept. Never publish, host, or deploy them. The
production keys come only from the setup ceremony (docs/CEREMONY.md).
EOF

echo "--- fetch circom-ecdsa (pinned commit) ---"
bash scripts/setup_circom_ecdsa.sh >/dev/null

echo "--- Powers of Tau 2^20, verified against its published hash ---"
bash scripts/fetch_ptau.sh 20 "$PTAU"

for c in "${CIRCUITS[@]}"; do
  echo "--- $c: compile ---"
  "$CIRCOM" "circuits/$c.circom" --r1cs --wasm -o "$OUT" -l node_modules -l circuits/.deps >/dev/null
  shasum -a 256 "$OUT/$c.r1cs"

  echo "--- $c: Groth16 phase-two start, one DEV contribution, verification key ---"
  "$SNARKJS" groth16 setup "$OUT/$c.r1cs" "$PTAU" "$OUT/${c}_0000.zkey" >/dev/null
  "$SNARKJS" zkey contribute "$OUT/${c}_0000.zkey" "$OUT/$c.zkey" \
    --name="DEV ONLY, not a ceremony contribution" -e="$(od -An -tx1 -N64 /dev/urandom | tr -d ' \n')" >/dev/null
  rm -f "$OUT/${c}_0000.zkey"
  "$SNARKJS" zkey export verificationkey "$OUT/$c.zkey" "$OUT/${c}_vkey.json" >/dev/null
  echo "    $OUT/$c.zkey and $OUT/${c}_vkey.json (DEV ONLY)"
done

echo
echo "Development keys in $OUT. Read $OUT/DEV_ONLY.txt before using them for anything."
