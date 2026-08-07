#!/usr/bin/env bash
# Differential fuzz of every round against the reference, over lengths the vectors never reach.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build.sh"
exec node "$HERE/fuzz.mjs" "$@"
