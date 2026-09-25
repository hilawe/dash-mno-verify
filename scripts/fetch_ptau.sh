#!/usr/bin/env bash
# Fetch one Hermez Powers of Tau file (the public universal SRS every proving key here is built from)
# and verify it against the blake2b-512 hash the snarkjs README publishes for it, before anything uses
# it. A cached copy is verified the same way as a fresh download.
#
# WHY THIS EXISTS. The build scripts downloaded the SRS from the Hermez bucket on Google Cloud Storage
# and checked nothing. On 2026-09-25 that bucket began answering 403 for every file, which turned the
# CI circuits job red and left the proving keys impossible to rebuild from the documented public
# inputs. The files are fixed public ceremony outputs. This repository keeps its own copy on a release
# and treats every source as untrusted, using whatever a URL serves only if its hash equals the
# published one. The upstream URL stays as a fallback in case the bucket is restored.
#
# In the default scripted builds a wrong SRS was already caught later, since prove_members.sh compares
# the resulting verification key with the committed one and build_proving_key.sh (outside its promote
# mode) verifies a proof against the committed key. The promote mode and the manual recipe in
# circuits/README.md make no such comparison. The hash covers all of them, and it fails at the
# download, where it names its cause, rather than minutes later as an unexplained key mismatch.
#
# The hashes are copied from the "Prepared (phase2) Ptau files" table in the snarkjs README (iden3/
# snarkjs, read 2026-09-25). The copies on this repository's release are local copies that matched
# them that day.
#
# Usage: scripts/fetch_ptau.sh <power> <dest>      power is 15 or 20
# Env:   MNO_PTAU_BASE_URL       mirror base (default: this repository's ptau-hermez-v1 release)
#        MNO_PTAU_UPSTREAM_BASE  upstream base (default: the original Hermez bucket)
set -euo pipefail

POWER="${1:-}"
DEST="${2:-}"
case "$POWER" in
  15) BLAKE2B="982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e" ;;
  20) BLAKE2B="89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b" ;;
  *) echo "fetch_ptau: unsupported power '$POWER' (expected 15 or 20)" >&2; exit 2 ;;
esac
[ -n "$DEST" ] || { echo "fetch_ptau: missing destination path" >&2; exit 2; }

# The parent is created BEFORE the destination is inspected, because creating it can change what the
# destination resolves to (a destination of "new/.." is not a directory until "new" exists).
DEST_DIR="$(dirname "$DEST")"
mkdir -p "$DEST_DIR"

# The destination must be a regular file or absent. A directory would pass the checks below and then
# receive the verified file INSIDE it, exiting 0 with nothing verified at the path the caller named.
if [ -e "$DEST" ] && [ ! -f "$DEST" ]; then
  echo "fetch_ptau: $DEST exists and is not a regular file" >&2
  exit 2
fi

NAME="powersOfTau28_hez_final_${POWER}.ptau"
MIRROR="${MNO_PTAU_BASE_URL:-https://github.com/hilawe/dash-mno-verify/releases/download/ptau-hermez-v1}/$NAME"
UPSTREAM="${MNO_PTAU_UPSTREAM_BASE:-https://storage.googleapis.com/zkevm/ptau}/$NAME"

# Streamed, so the 1.2 GB 2^20 file is never held in memory. Node is already a requirement of every
# script that calls this, and it hashes blake2b-512 the same on Linux and macOS, where b2sum is absent.
blake2b_of() {
  node -e '
    const h = require("crypto").createHash("blake2b512");
    const s = require("fs").createReadStream(process.argv[1]);
    s.on("data", (c) => h.update(c));
    s.on("end", () => console.log(h.digest("hex")));
    s.on("error", (e) => { console.error(e.message); process.exit(1); });
  ' "$1"
}

# A cached file that fails the check is refused rather than replaced, since it is the operator's file
# and it may be the only copy they have. The message says what to do.
if [ -f "$DEST" ]; then
  if [ "$(blake2b_of "$DEST")" = "$BLAKE2B" ]; then
    echo "  $NAME: cached copy at $DEST verified"
    exit 0
  fi
  echo "fetch_ptau: $DEST does not match the published hash for $NAME. Remove it and re-run." >&2
  exit 1
fi

# A symlink at the destination that did not verify above would be REPLACED by the rename below, which
# silently undoes an operator's choice to keep the file elsewhere. Refuse it instead. (A link to a
# verified copy was already accepted above, since that branch only reads through it.)
if [ -L "$DEST" ]; then
  echo "fetch_ptau: $DEST is a symbolic link to something other than a verified copy. Fix or remove it." >&2
  exit 2
fi

# Each attempt downloads to a temp file created EXCLUSIVELY (mktemp) beside the destination, so the
# rename is atomic and no other writer shares it. A fixed name ($DEST.download) let a concurrent run
# overwrite the file between the hash check and the rename, and let a symlink planted at that name
# steer curl's write onto the destination itself.
#
# Cleanup is on EXIT. An interruption EXITS nonzero rather than cleaning up and carrying on, which
# would otherwise fall through to the next source and could still exit 0.
TMP=""
trap 'if [ -n "$TMP" ]; then rm -f "$TMP"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Progress on a terminal, quiet in CI logs, and curl's error text is kept in both. A source that
# accepts the connection and then stalls is abandoned (under 1 KB/s for a minute) so the fallback is
# still reached. There is no cap on total time, since the 2^20 file is 1.2 GB on a slow link.
if [ -t 2 ]; then CURL_FLAGS=(-fL --progress-bar); else CURL_FLAGS=(-fsSL); fi
CURL_FLAGS+=(--connect-timeout 30 --speed-limit 1024 --speed-time 60)

for src in "$MIRROR" "$UPSTREAM"; do
  echo "  $NAME: downloading from $src"
  TMP="$(mktemp "$DEST_DIR/.$NAME.XXXXXX")"
  if ! curl "${CURL_FLAGS[@]}" "$src" -o "$TMP"; then
    echo "  could not download from $src" >&2
    rm -f "$TMP"; TMP=""
    continue
  fi
  if [ "$(blake2b_of "$TMP")" = "$BLAKE2B" ]; then
    # Check the destination AGAIN just before installing, since a link or directory can appear there
    # during a long download. This narrows the window to the moment before the rename. It does not
    # close it.
    if [ -L "$DEST" ] || { [ -e "$DEST" ] && [ ! -f "$DEST" ]; }; then
      echo "fetch_ptau: $DEST changed during the download and is no longer a regular file" >&2
      exit 2
    fi
    chmod 0644 "$TMP"   # mktemp creates 0600, and curl's own output used to be world-readable
    # rename(2) rather than mv. mv moves a file INTO a destination that is a directory and reports
    # success, and a directory can appear at the destination while the download runs. rename(2)
    # replaces a file or fails, and a failure here exits nonzero under set -e with the temp cleaned up.
    node -e '
      try { require("fs").renameSync(process.argv[1], process.argv[2]); }
      catch (e) { console.error(`fetch_ptau: could not put the verified file at ${process.argv[2]} (${e.code})`); process.exit(1); }
    ' "$TMP" "$DEST"
    TMP=""
    echo "  $NAME: verified against the published blake2b-512 hash"
    exit 0
  fi
  echo "  $src served a file that does not match the published hash for $NAME, refused" >&2
  rm -f "$TMP"; TMP=""
done

echo "fetch_ptau: no source served a verified $NAME" >&2
exit 1
