#!/usr/bin/env bash
# Rebuild test/vectors/x11_round_vectors.json from the reference.
#
# The block cases are NOT regenerated here. They are real mainnet headers and their real names, and
# where they came from is a synced node rather than this harness, so overwriting them from a locally
# built binary would replace external evidence with something this repository produced. What this does
# is recompute the per-round vectors and then CHECK the block cases against the reference, which is the
# right way round.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build.sh"
exec node "$HERE/generate.mjs" "$@"
