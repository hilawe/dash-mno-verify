#!/usr/bin/env bash
# Download the prebuilt circuit artifacts and verify them against keys.manifest.json, so a prover or
# gateway does not have to compile and run a setup.
#
# By default this fetches the small, always-hosted artifacts: the cheap members proving key and the
# circuit wasms. The two ~2.3 GB proving keys (membership, registration) exceed GitHub's 2 GB release
# asset limit, so they are listed under "largeFiles" and fetched only with --large, and only once an
# operator has hosted them and filled in each entry's url and sha256 in keys.manifest.json (see
# docs/PROVING_KEY.md). Until then, rebuild them with scripts/rebuild_proving_keys.sh.
#
# Usage: scripts/fetch_keys.sh [--large]
# Env:   MNO_KEYS_BASE_URL overrides the base for files without their own url (default: this repo's
#        release for the manifest tag).
set -euo pipefail

WANT_LARGE=0
[ "${1:-}" = "--large" ] && WANT_LARGE=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

TAG=$(node -e "console.log(require('./keys.manifest.json').tag)")
BASE="${MNO_KEYS_BASE_URL:-https://github.com/hilawe/dash-mno-verify/releases/download/$TAG}"

# fetch_one name dest sha url  -> downloads from url (or BASE/name) to a temp file, verifies the
# checksum, and only then moves it into place, so a stale URL or a partial download never overwrites a
# good existing artifact (a 2.3 GB proving key is expensive to lose).
fetch_one() {
  local name="$1" dest="$2" sha="$3" url="$4"
  local src="${url:-$BASE/$name}"
  local tmp="$dest.download"
  mkdir -p "$(dirname "$dest")"
  echo "  $name ..."
  if ! curl -fsSL "$src" -o "$tmp"; then
    rm -f "$tmp"
    echo "  could not download $name from $src"
    return 1
  fi
  local got
  got=$(sha256_of "$tmp")
  if [ "$got" != "$sha" ]; then
    rm -f "$tmp"
    echo "  CHECKSUM MISMATCH for $name (expected $sha, got $got). The source does not match"
    echo "  keys.manifest.json, so it is stale. The existing file, if any, was left untouched."
    return 1
  fi
  mv "$tmp" "$dest"
}

echo "fetching small artifacts from $BASE"
node -e "for (const f of require('./keys.manifest.json').files) console.log([f.name,f.dest,f.sha256,f.url||''].join('\t'));" |
while IFS=$'\t' read -r name dest sha url; do
  if ! fetch_one "$name" "$dest" "$sha" "$url"; then
    echo "  The '$TAG' release may not be published yet, or MNO_KEYS_BASE_URL is wrong. Rebuild locally"
    echo "  with scripts/rebuild_proving_keys.sh (membership + registration) and scripts/prove_members.sh,"
    echo "  or point MNO_KEYS_BASE_URL at where the artifacts live."
    exit 1
  fi
done

if [ "$WANT_LARGE" = "1" ]; then
  echo "fetching large proving keys (--large)"
  node -e "for (const f of (require('./keys.manifest.json').largeFiles||[])) console.log([f.name,f.dest,f.sha256||'',f.url||''].join('\t'));" |
  while IFS=$'\t' read -r name dest sha url; do
    # Only sha256 is required. An empty url falls back to MNO_KEYS_BASE_URL, so a mirror that hosts
    # every artifact under one base still works without a per-entry url.
    if [ -z "$sha" ]; then
      echo "  $name is not hosted yet (no sha256 under largeFiles in keys.manifest.json)."
      echo "  Rebuild it once with scripts/rebuild_proving_keys.sh, or host the rebuilt key on object"
      echo "  storage or IPFS and fill in its sha256 (and a url, or set MNO_KEYS_BASE_URL). See"
      echo "  docs/PROVING_KEY.md."
      exit 1
    fi
    fetch_one "$name" "$dest" "$sha" "$url" || exit 1
  done
fi

echo "All requested artifacts fetched and verified against keys.manifest.json."
