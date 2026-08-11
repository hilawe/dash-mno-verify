# Ecne (0xPARC ecosystem) R1CS soundness checker, containerized.
#
# Ecne reasons about whether an R1CS constraint system UNIQUELY DETERMINES its outputs from its inputs,
# which is the mathematical core of "under-constrained": if an output is not uniquely determined, a
# prover can choose it, which for these circuits is the forge-a-membership failure. A pass is real
# evidence of determinism for the circuit checked; Ecne's own docs note a non-pass means Ecne could not
# PROVE soundness, not that the circuit is unsound. Large circuits (the ECDSA path) may need trusted-
# function decomposition or may not complete, which is expected and stated.
#
# Provenance, like tools/x11-reference: the tool is cloned from upstream and the resolved commit is
# printed at build time rather than vendored. A container because the host carries no Julia toolchain.
#
# JULIA 1.7 ON PURPOSE. Ecne's pinned dependencies (via its Manifest) use Base internals such as
# @_pure_meta that newer Julia removed, so 1.10 fails to precompile them. 1.7 is the version Ecne's
# README targets and its Manifest matches, so the pinned dependency set precompiles cleanly.
FROM julia:1.7-bullseye

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# `just` is Ecne's task runner. Installed from its published install script into /usr/local/bin.
RUN curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to /usr/local/bin \
 && just --version

# The pin. Empty ECNE_COMMIT clones master and the build prints what it resolved to, the value to record.
ARG ECNE_COMMIT=
RUN set -eu; \
    git clone https://github.com/franklynwang/EcneProject /ecne; \
    cd /ecne; \
    if [ -n "${ECNE_COMMIT}" ]; then git checkout "${ECNE_COMMIT}"; fi; \
    echo "ECNE_COMMIT=$(git rev-parse HEAD)"; \
    rm -rf Circom_Functions; \
    git clone https://github.com/iden3/circomlib Circom_Functions

WORKDIR /ecne
RUN just install

# Run: julia --project=. src/Ecne.jl --r1cs /work/<c>.r1cs --name <c> --sym /work/<c>.sym
