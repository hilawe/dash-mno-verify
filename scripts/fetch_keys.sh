#!/usr/bin/env bash
# Download the prebuilt circuit artifacts and verify them against keys.manifest.json, so a
# prover or gateway does not have to compile and run a setup. This covers the cheap members
# proving key and the circuit wasms. The two ~2.3 GB proving keys (membership, registration)
# are not hosted here because they exceed GitHub's 2 GB asset limit; rebuild those with
# scripts/build_proving_key.sh or host them yourself.
#
# Set MNO_KEYS_BASE_URL to where the assets live (default: this repo's release for the tag
# in keys.manifest.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

TAG=$(node -e "console.log(require('./keys.manifest.json').tag)")
BASE="${MNO_KEYS_BASE_URL:-https://github.com/hilawe/dash-mno-verify/releases/download/$TAG}"
echo "fetching circuit artifacts from $BASE"

node -e "for (const f of require('./keys.manifest.json').files) console.log(f.name + '\t' + f.dest + '\t' + f.sha256);" |
while IFS=$'\t' read -r name dest sha; do
  mkdir -p "$(dirname "$dest")"
  echo "  $name ..."
  if ! curl -fsSL "$BASE/$name" -o "$dest"; then
    echo "  could not download $name from $BASE"
    echo "  The '$TAG' release may not be published yet (it is re-cut whenever a circuit changes,"
    echo "  for example the M1 d<n constraint). Publish it with the rebuilt artifacts, point"
    echo "  MNO_KEYS_BASE_URL at where they live, or rebuild locally with"
    echo "  scripts/rebuild_proving_keys.sh (membership + registration) and scripts/prove_members.sh."
    exit 1
  fi
  got=$(sha256_of "$dest")
  if [ "$got" != "$sha" ]; then
    echo "  CHECKSUM MISMATCH for $name (expected $sha, got $got). The hosted artifact does not"
    echo "  match keys.manifest.json; the release for tag '$TAG' is likely stale. Rebuild or re-publish."
    exit 1
  fi
done

echo "All hostable artifacts fetched and verified against keys.manifest.json."
