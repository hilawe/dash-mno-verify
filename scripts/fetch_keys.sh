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

# Fail early on a missing or invalid manifest, since the loops below read it through process
# substitution and would otherwise see empty input and silently fetch nothing.
node -e "require('./keys.manifest.json')" >/dev/null || { echo "keys.manifest.json is missing or invalid"; exit 1; }

# Remove the in-progress temp file if the script is interrupted mid-download (Ctrl+C), so a partial
# 2.3 GB file is not left behind. The temp name is fixed per destination, so a re-run would overwrite it
# anyway, but this avoids the orphan in the first place. CURRENT_TMP is set only while a download is in
# flight, and the loops run in this shell (process substitution below), so the trap sees it.
CURRENT_TMP=""
cleanup() { [ -n "$CURRENT_TMP" ] && rm -f "$CURRENT_TMP"; }
trap cleanup EXIT INT TERM

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
  CURRENT_TMP="$tmp"
  mkdir -p "$(dirname "$dest")"
  echo "  $name ..."
  if ! curl -fsSL "$src" -o "$tmp"; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  could not download $name from $src"
    return 1
  fi
  local got
  got=$(sha256_of "$tmp")
  if [ "$got" != "$sha" ]; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  CHECKSUM MISMATCH for $name (expected $sha, got $got). The source does not match"
    echo "  keys.manifest.json, so it is stale. The existing file, if any, was left untouched."
    return 1
  fi
  if ! mv "$tmp" "$dest"; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  could not move $name into place"
    return 1
  fi
  CURRENT_TMP=""
}

echo "fetching small artifacts from $BASE"
while IFS=$'\t' read -r name dest sha url; do
  if ! fetch_one "$name" "$dest" "$sha" "$url"; then
    echo "  The '$TAG' release may not be published yet, or MNO_KEYS_BASE_URL is wrong. Rebuild locally"
    echo "  with scripts/rebuild_proving_keys.sh (membership + registration) and scripts/prove_members.sh,"
    echo "  or point MNO_KEYS_BASE_URL at where the artifacts live."
    exit 1
  fi
done < <(node -e "for (const f of require('./keys.manifest.json').files) console.log([f.name,f.dest,f.sha256,f.url||''].join('\t'));")

if [ "$WANT_LARGE" = "1" ]; then
  echo "fetching large proving keys (--large)"
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
    if ! fetch_one "$name" "$dest" "$sha" "$url"; then
      echo "  Fill in this entry's url, set MNO_KEYS_BASE_URL to where the large keys live (they cannot"
      echo "  be on the GitHub release), or rebuild it with scripts/rebuild_proving_keys.sh."
      exit 1
    fi
  done < <(node -e "for (const f of (require('./keys.manifest.json').largeFiles||[])) console.log([f.name,f.dest,f.sha256||'',f.url||''].join('\t'));")
fi

echo "All requested artifacts fetched and verified against keys.manifest.json."
