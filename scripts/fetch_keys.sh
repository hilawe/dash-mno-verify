#!/usr/bin/env bash
# Download the prebuilt circuit artifacts and verify them against keys.manifest.json, so a prover or
# gateway does not have to compile and run a setup.
#
# By default this fetches the small artifacts from the GitHub release, which are the cheap members
# proving key and the circuit wasms. The two ~2.3 GB proving keys (membership, registration) exceed
# GitHub's 2 GB release asset limit, so they are listed under "largeFiles", hosted elsewhere (Cloudflare
# R2 today, at each entry's own url), and fetched only with --large. An entry with no sha256 is treated
# as not hosted. Either way, scripts/rebuild_proving_keys.sh rebuilds them from public inputs, and a
# faithful rebuild matches the same sha256. See docs/PROVING_KEY.md.
#
# Usage: scripts/fetch_keys.sh [--large]
# Env:   MNO_KEYS_BASE_URL overrides the base for files WITHOUT their own url (default: this repo's
#        release for the manifest tag). It does not redirect an entry that has a url.
set -euo pipefail

WANT_LARGE=0
[ "${1:-}" = "--large" ] && WANT_LARGE=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node -e "require('./keys.manifest.json')" >/dev/null || { echo "keys.manifest.json is missing or invalid"; exit 1; }

# Remove the in-progress temp file if the script is interrupted mid-download (Ctrl+C), so a partial
# 2.3 GB file is not left behind. CURRENT_TMP is set only while a download is in flight, and the loops
# read here-strings in this shell, so the trap sees it.
#
# The cleanup must END TRUE. It used to be `[ -n "$CURRENT_TMP" ] && rm ...`, which is false when no
# download is in flight, and a script that falls off its end exits with its EXIT trap's status. So
# every fully successful run exited 1 while printing that everything was verified. An interruption
# now exits nonzero rather than cleaning up and carrying on to the next file.
CURRENT_TMP=""
cleanup() { if [ -n "$CURRENT_TMP" ]; then rm -f "$CURRENT_TMP"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

TAG=$(node -e "console.log(require('./keys.manifest.json').tag)")
BASE="${MNO_KEYS_BASE_URL:-https://github.com/hilawe/dash-mno-verify/releases/download/$TAG}"

# Print one manifest list ("files" or "largeFiles"), one entry per line, fields joined with the ASCII
# unit separator (0x1f). It VALIDATES every entry first and exits nonzero on anything malformed, and
# the caller captures its status, so a bad manifest refuses instead of silently fetching nothing and
# then reporting success. (The lists used to be read through process substitution, whose producer's
# failure no caller saw.)
#
# Why 0x1f and not a tab. Tab is IFS WHITESPACE to bash, so two tabs in a row collapse into one and an
# empty field vanishes. An entry with a url but no sha256 then shifted the url into the sha256 slot and
# failed as a checksum mismatch rather than as "not hosted yet". A non-whitespace separator keeps an
# empty field empty. A field that CONTAINS the separator or a newline would shift the fields after it
# (and point the temp-file cleanup at the wrong path), so those are refused here.
manifest_entries() {
  node -e '
    const which = process.argv[1];
    const list = require("./keys.manifest.json")[which] ?? (which === "largeFiles" ? [] : undefined);
    const fail = (msg) => { console.error(`keys.manifest.json ${msg}`); process.exit(1); };
    if (!Array.isArray(list)) fail(`"${which}" is not a list`);
    const out = [];
    list.forEach((f, i) => {
      const at = `${which}[${i}]`;
      if (!f || typeof f !== "object" || Array.isArray(f)) fail(`${at} is not an object`);
      const fields = { name: f.name, dest: f.dest, sha256: f.sha256 ?? "", url: f.url ?? "" };
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v !== "string") fail(`${at}.${k} is not a string`);
        // NUL too, since bash drops it silently and "out/a<NUL>b" would become out/ab.
        if (/[\x00\x1f\r\n]/.test(v)) fail(`${at}.${k} contains a separator, line break, or NUL`);
      }
      if (fields.name === "" || fields.dest === "") fail(`${at} needs a name and a dest`);
      // Only a large entry may leave sha256 empty, meaning "not hosted yet". Otherwise it must be a hash.
      const shaOk = /^[0-9a-f]{64}$/.test(fields.sha256) || (which === "largeFiles" && fields.sha256 === "");
      if (!shaOk) fail(`${at}.sha256 is not a 64-hex sha256`);
      out.push([fields.name, fields.dest, fields.sha256, fields.url].join("\x1f"));
    });
    if (out.length) console.log(out.join("\n"));
  ' "$1"
}

# fetch_one name dest sha url  -> downloads from url (or BASE/name) to a temp file, verifies the
# checksum, and only then moves it into place, so a stale URL or a partial download never overwrites a
# good existing artifact (a 2.3 GB proving key is expensive to lose).
#
# The temp file is created EXCLUSIVELY (mktemp) beside the destination. It used to be a fixed
# "$dest.download", so two concurrent runs shared it. One could verify it while the other truncated and
# started refilling it, and the first then moved the other's partial bytes over a good file and
# reported success. The final move is rename(2), not mv, since mv puts a file INSIDE a destination that is a
# directory and reports success.
fetch_one() {
  local name="$1" dest="$2" sha="$3" url="$4"
  local src="${url:-$BASE/$name}"
  local dir
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  # A symlink is refused as well. The rename would replace the link itself, silently undoing an
  # operator's choice to keep the key elsewhere. A dangling link slips past a plain -e test, since -e
  # is false for it, so -L is checked first.
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then
    echo "  $dest exists and is not a regular file (a directory, link, or other)"
    return 1
  fi
  # fetch_one runs as an `if !` condition, which switches set -e OFF inside it, so every step whose
  # failure matters is checked by hand.
  local tmp
  if ! tmp="$(mktemp "$dir/.$(basename "$dest").XXXXXX")"; then
    echo "  could not create a temp file beside $dest"
    return 1
  fi
  CURRENT_TMP="$tmp"
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
  # Check the destination AGAIN just before installing. A 2.3 GB download takes minutes, and a link or
  # directory created at the destination meanwhile would otherwise be replaced by the rename. This
  # narrows the window to the moment between this check and the rename. It does not close it.
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  $dest changed during the download and is no longer a regular file, so nothing was installed"
    return 1
  fi
  # mktemp creates 0600, and curl's own output used to be world-readable. A failed chmod must not
  # install a file other accounts on the host cannot read.
  if ! chmod 0644 "$tmp"; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  could not set permissions on the downloaded $name"
    return 1
  fi
  if ! node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$dest" 2>/dev/null; then
    rm -f "$tmp"; CURRENT_TMP=""
    echo "  could not move $name into place at $dest"
    return 1
  fi
  CURRENT_TMP=""
}

# Recovery advice depends on where the entry was fetched from. An entry with its own url is NOT
# redirected by MNO_KEYS_BASE_URL, and one without a url is fetched from exactly that base.
explain_source() {
  local url="$1"
  if [ -n "$url" ]; then
    echo "  This entry is fetched from its own url in keys.manifest.json, which MNO_KEYS_BASE_URL does"
    echo "  not override. If that host is down, point the entry's url at a mirror that serves the same"
    echo "  sha256, or rebuild with scripts/rebuild_proving_keys.sh."
  else
    echo "  This entry is fetched from $BASE. The '$TAG' release may not be published yet, or"
    echo "  MNO_KEYS_BASE_URL is wrong. Point MNO_KEYS_BASE_URL at where the artifacts live, or rebuild"
    echo "  with scripts/rebuild_proving_keys.sh (membership + registration) and scripts/prove_members.sh."
  fi
}

SMALL="$(manifest_entries files)" || { echo "keys.manifest.json is malformed, so nothing was fetched."; exit 1; }
LARGE=""
if [ "$WANT_LARGE" = "1" ]; then
  LARGE="$(manifest_entries largeFiles)" || { echo "keys.manifest.json is malformed, so nothing was fetched."; exit 1; }
fi

echo "fetching small artifacts from $BASE"
while IFS=$'\x1f' read -r name dest sha url; do
  [ -n "$name" ] || continue
  if ! fetch_one "$name" "$dest" "$sha" "$url"; then
    explain_source "$url"
    exit 1
  fi
done <<< "$SMALL"

if [ "$WANT_LARGE" = "1" ]; then
  echo "fetching large proving keys (--large)"
  while IFS=$'\x1f' read -r name dest sha url; do
    [ -n "$name" ] || continue
    if [ -z "$sha" ]; then
      echo "  $name is not hosted yet (no sha256 under largeFiles in keys.manifest.json)."
      echo "  Rebuild it once with scripts/rebuild_proving_keys.sh, or host the rebuilt key on object"
      echo "  storage or IPFS and fill in its sha256 (and a url, or set MNO_KEYS_BASE_URL). See"
      echo "  docs/PROVING_KEY.md."
      exit 1
    fi
    if ! fetch_one "$name" "$dest" "$sha" "$url"; then
      explain_source "$url"
      exit 1
    fi
  done <<< "$LARGE"
fi

echo "All requested artifacts fetched and verified against keys.manifest.json."
