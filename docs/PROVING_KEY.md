# Distributing the proving key

The full membership circuit needs three artifacts to make a proof: the circuit wasm
(witness generator), the PLONK proving key (`mno_membership.zkey`, about 2.3 GB), and the
verification key (about 2 KB). Only the verification key is in the repo. This page explains
how the large proving key reaches provers.

## The key is reproducible, not hosted

PLONK setup is deterministic. Given the same r1cs and the same universal SRS, it always
produces the same proving and verification keys. Every input to that is public:

- the circuits in this repo,
- circom-ecdsa pinned to a fixed commit by `scripts/setup_circom_ecdsa.sh`,
- the public Hermez Powers of Tau (the 2^20 SRS).

So the proving key does not need to be hosted at all. A prover rebuilds it locally:

```bash
npm ci
CIRCOM=/path/to/circom bash scripts/build_proving_key.sh
```

This compiles the circuit, downloads the SRS, runs the PLONK setup, then proves a test
witness with the rebuilt key and verifies it against the committed verification key. A
passing check means the locally built proving key is the canonical one, so a prover never
has to trust a downloaded multi-GB blob.

The build needs about 3 GB of disk, a 1.15 GB SRS download, and several minutes.

## Optional: host the artifacts for convenience

Rebuilding is the trustless default, but it is heavy to ask of every prover. An operator
may host the prebuilt `mno_membership.zkey` and the wasm so clients can download instead of
rebuild. Two things make that safe:

1. Publish the sha256 of the hosted files, and have clients check it.
2. Either way, the client confirms correctness the same way the build script does, by proving a witness and verifying against the committed verification key.

One practical note on hosting. A GitHub release asset is capped at 2 GB, and the proving
key is larger, so it cannot be a single release asset. The options are to split it into
parts under 2 GB and recombine, or to host it on object storage (S3, R2, or similar) or on
IPFS.

## What the prover expects

`prover/prover.js` reads `circuits/build/mno_membership.zkey` and
`circuits/build/mno_membership_js/mno_membership.wasm`. Run `scripts/build_proving_key.sh`
once (or download the artifacts into `circuits/build/`) before proving. The verification
key is already in place, committed, so the gateway needs no extra step to boot.
