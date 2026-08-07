#!/usr/bin/env bash
# Build the reference image. Idempotent, so the other scripts can call it without asking first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="${DOCKER:-$(command -v docker || echo /opt/homebrew/bin/docker)}"
TAG="${DASH_TAG:-v23.1.3}"
IMAGE="${X11REF_IMAGE:-x11ref:${TAG}}"

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
