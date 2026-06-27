#!/usr/bin/env bash
# Rebuild both heavy proving keys (single-tier mno_membership and registration mno_registration) and
# export their verification keys over the committed ones. Run this after changing either circuit, for
# example the M1 d < n constraint that prompted it. Thin wrapper over build_proving_key.sh, which
# fetches circom-ecdsa, downloads the SRS, runs the deterministic PLONK setup, and exports each key.
# mno_members is small and unaffected by M1; rebuild it with prove_members.sh.
#
# Heavy: ~12 GB Node heap per setup and a ~2.3 GB key per circuit, built sequentially. Set CIRCOM to
# the circom binary if it is not on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/build_proving_key.sh" mno_membership
bash "$ROOT/scripts/build_proving_key.sh" mno_registration

echo
echo "Both proving keys rebuilt. Committed verification keys updated:"
echo "  circuits/build/verification_key.json        (single-tier mno_membership)"
echo "  circuits/build/mno_registration_vkey.json   (two-tier registration)"
echo "Re-publish the circuit-keys release with the rebuilt wasms and update keys.manifest.json hashes."
