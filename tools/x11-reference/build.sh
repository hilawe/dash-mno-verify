#!/usr/bin/env bash
# Build the reference image. Idempotent, so the other scripts can call it without asking first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="${DOCKER:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
TAG="${DASH_TAG:-$(cat "$HERE/PIN")}"
# THE TAG ALONE WAS THE CACHE KEY, so editing harness.cpp or the Dockerfile left the old image in
# place and every later run verified against a binary that no longer matched the sources. A reviewer
# appended "#error" to harness.cpp and watched build.sh report "already built" and exit 0. Folding a
# hash of the build inputs into the image name makes a stale image impossible to reach by accident.
INPUTS_HASH="$(cat "$HERE/Dockerfile" "$HERE/harness.cpp" "$HERE/PIN" | shasum -a 256 | cut -c1-12)"
IMAGE="${X11REF_IMAGE:-x11ref:${TAG}-${INPUTS_HASH}}"

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "no container runtime. On this project's Mac that is colima: run 'colima start' first." >&2
  exit 1
fi

if "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 && [ -z "${X11REF_REBUILD:-}" ]; then
  echo "$IMAGE already built (X11REF_REBUILD=1 to force)"
  exit 0
fi

echo "building $IMAGE from Dash Core $TAG, which clones upstream and takes a few minutes the first time"
"$DOCKER" build --build-arg "DASH_TAG=${TAG}" -t "$IMAGE" "$HERE"
