#!/usr/bin/env bash
# The INTERIM Groth16 setup for the two heavy circuits: one contribution, by the coordinator, on the frozen
# circuits (docs/CEREMONY.md, "Interim setup"). It lets the pilot run before the multi-party ceremony.
#
# What it is. The same chain the ceremony uses, stopped after one contribution. Its soundness rests on this
# one machine having discarded the contribution's randomness, which is fed to snarkjs through the prompt
# from the system's random source, held only in memory, and never written anywhere or passed as an
# argument. The coordinator already runs the gateway that admits members, so this gives no one a power the
# operator does not already have. It is labeled interim everywhere and must not gate anything of value.
# The multi-party ceremony later continues this chain or starts a fresh one, and replaces these keys.
#
# Output: the proving keys, wasm, and verification keys in circuits/build/interim/ (git ignores it), and
# the record circuits/ceremony/INTERIM_SETUP.json (committed).
#
# Usage: scripts/interim_setup.sh     (CIRCOM names the compiler, one of the frozen release binaries)
set -euo pipefail

CIRCOM="${CIRCOM:-circom}"
SNARKJS="node_modules/.bin/snarkjs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="circuits/build/interim"
PTAU="circuits/build/pot20.ptau"
RECORD="circuits/ceremony/INTERIM_SETUP.json"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

if [ -n "$(git status --porcelain)" ]; then
  echo "the working tree has uncommitted changes; the setup is recorded against one commit, so commit first" >&2
  exit 1
fi
if [ -e "$OUT" ]; then
  echo "$OUT already exists; an interim setup is made once. Move it aside deliberately to make another." >&2
  exit 1
fi

echo "--- the circuits and compiler match the freeze ---"
CIRCOM="$CIRCOM" node scripts/freeze_candidate.mjs --check
bash scripts/fetch_ptau.sh 20 "$PTAU"
mkdir -p "$OUT"

for c in mno_membership mno_registration; do
  echo "--- $c ---"
  "$CIRCOM" "circuits/$c.circom" --r1cs --wasm -o "$OUT" -l node_modules -l circuits/.deps >/dev/null
  frozen="$(node -e 'console.log(require("./circuits/ceremony/FREEZE.json").circuits[process.argv[1]].r1csSha256)' "$c")"
  got="$(shasum -a 256 "$OUT/$c.r1cs" | cut -d' ' -f1)"
  [ "$got" = "$frozen" ] || { echo "r1cs $got is not the frozen $frozen" >&2; exit 1; }
  "$SNARKJS" groth16 setup "$OUT/$c.r1cs" "$PTAU" "$OUT/${c}_0000.zkey" >/dev/null
  # The randomness goes through the prompt on stdin, from the system's random source, and nowhere else.
  # It must end in a newline, or the prompt never receives a line and snarkjs stops when stdin closes.
  { od -An -tx1 -N64 /dev/urandom | tr -d ' \n'; echo; } | "$SNARKJS" zkey contribute "$OUT/${c}_0000.zkey" "$OUT/$c.zkey" \
    --name="interim, coordinator only" > "$OUT/${c}_contribute.log" 2>&1
  "$SNARKJS" zkey verify "$OUT/$c.r1cs" "$PTAU" "$OUT/$c.zkey" > "$OUT/${c}_verify.log" 2>&1
  grep -q "ZKey Ok!" "$OUT/${c}_verify.log" || { echo "$c: zkey verify did not report ZKey Ok!" >&2; exit 1; }
  "$SNARKJS" zkey export verificationkey "$OUT/$c.zkey" "$OUT/${c}_vkey.json" >/dev/null
done

node - "$OUT" "$RECORD" <<'EOF'
const fs = require("fs");
const { createHash } = require("crypto");
const [out, record] = process.argv.slice(2);
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// The contribution hash snarkjs prints: the four lines of hex after "Contribution Hash:".
const hashAfter = (log) => {
  const lines = strip(log).split("\n");
  const i = lines.findIndex((l) => /Contribution Hash/.test(l));
  return lines.slice(i + 1, i + 5).map((l) => l.trim().replace(/\s+/g, "")).join("");
};
const circuits = {};
for (const c of ["mno_membership", "mno_registration"]) {
  const verify = strip(fs.readFileSync(`${out}/${c}_verify.log`, "utf8"));
  circuits[c] = {
    r1csSha256: sha(`${out}/${c}.r1cs`),
    wasmSha256: sha(`${out}/${c}_js/${c}.wasm`),
    initialZkeySha256: sha(`${out}/${c}_0000.zkey`),
    contribution: { name: "interim, coordinator only", hash: hashAfter(fs.readFileSync(`${out}/${c}_contribute.log`, "utf8")) },
    zkeySha256: sha(`${out}/${c}.zkey`),
    zkeyBytes: fs.statSync(`${out}/${c}.zkey`).size,
    vkeySha256: sha(`${out}/${c}_vkey.json`),
    zkeyVerify: verify.split("\n").filter((l) => /contribution #|ZKey Ok|Circuit Hash|Beacon/.test(l)).map((l) => l.replace(/^\[INFO\]\s+snarkJS:\s*/, "").trim()),
  };
}
const rec = {
  note: "INTERIM Groth16 setup, one contribution by the coordinator, for the pilot only. Not the multi-party ceremony (docs/CEREMONY.md). Soundness rests on the coordinator's machine having discarded its randomness. Must not gate anything of value.",
  commit: require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  date: new Date().toISOString(),
  phaseOne: "powersOfTau28_hez_final_20.ptau",
  snarkjs: require("./node_modules/snarkjs/package.json").version,
  circuits,
};
fs.writeFileSync(record, JSON.stringify(rec, null, 2) + "\n");
console.log(`wrote ${record}`);
for (const [c, v] of Object.entries(circuits)) console.log(`${c}: contribution ${v.contribution.hash.slice(0, 16)}..., zkey ${v.zkeySha256.slice(0, 16)}..., vkey ${v.vkeySha256.slice(0, 16)}...`);
EOF
