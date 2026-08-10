# The circuit static-analysis image.
#
# This builds circomspect (Trail of Bits), a static analyzer for circom that flags under-constrained
# signals, unused signals, and dangerous patterns, which is the bug class that matters most for the
# circuits here (a prover forging a valid witness for a node it does not control). The point of the
# image, like tools/x11-reference, is provenance and reproducibility: the analyzer is fetched from
# crates.io at a recorded version rather than vendored, and the run script mounts the repository's own
# circuit sources and their fetched include trees, so the result describes exactly the circuits that
# ship.
#
# Linux rather than the host, for the project's usual reason: the toolchain is predictable here, and
# nothing about the host's setup leaks into the result. The host has no Rust toolchain, so building the
# analyzer natively would perturb it; the container keeps that out of the working tree.
FROM rust:1-slim-bookworm

# The pin. Passing an empty version installs the latest published circomspect and the build prints what
# it resolved to, which is the value to record in PIN. Moving the pin is then a deliberate commit of its
# own, the same discipline tools/x11-reference uses for its upstream tag.
ARG CIRCOMSPECT_VERSION=

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    if [ -n "${CIRCOMSPECT_VERSION}" ]; then \
      cargo install circomspect --version "${CIRCOMSPECT_VERSION}"; \
    else \
      cargo install circomspect; \
    fi; \
    command -v circomspect

# The analyzer needs no entrypoint of its own; run.sh drives it with the circuit paths and the include
# trees mounted from the repository at run time.
