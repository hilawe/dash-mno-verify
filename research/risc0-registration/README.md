# RISC Zero registration-proof prototype

A Phase 0 measurement scaffold for the proving-cost research track (see
`docs/REDUCING_PROVING_COST.md`). It is not part of the shipping system, it is a throwaway prototype
whose only job is to produce three numbers for the once-per-season registration statement in a
zero-knowledge virtual machine (zkVM), so the decision to move off the current circom and PLONK stack
can be made on measured data rather than estimates.

## What it measures, and the one number that decides everything

The gate for the whole transparent-proof direction is peak prover memory for the heavy registration
proof on masternode-class hardware. This prototype reports, for one registration proof:

- peak resident memory (the go/no-go number),
- proving wall-clock time,
- proof (receipt) size, and
- the executed cycle count.

Go/no-go: treat a peak resident set above roughly 12 GB on a 16 GB node as this candidate failing. An
8 GB node is not expected to be a credible target. Independent estimates for a non-native secp256k1
scalar multiplication in a zkVM scatter from single-digit to tens of gigabytes, which is exactly why
this must be measured rather than assumed.

## The statement it proves

This is the registration statement, matching the semantics of the current circuit, in the derive-the-key
form:

1. `P = d * G` on secp256k1, deriving the voting public key from the private key `d`.
2. `keyID = hash160(compressed P)`, that is RIPEMD-160 of SHA-256, the `keyIDVoting`.
3. Merkle inclusion of `keyID` under a public root, using a SHA-256 tree over the `hash160` leaves.
4. `nullifier = SHA-256(0x02 || d || epoch || contextHash)`, keyed on the secret `d` so it is unique
   per voting key and not grindable over the public leaves.
5. Commit the public journal (root, epoch, contextHash, signalHash, nullifier), and nothing else.

The private key, the public key, the `keyID`, and the Merkle path are private witness and are never
committed.

### Deliberate scoping choices for the prototype

- The dominant cost is step 1, the secp256k1 scalar multiplication, which RISC Zero accelerates through
  its `k256` and `sha2` support (wired through the `[patch.crates-io]` block in `Cargo.toml`).
- RIPEMD-160 has no accelerator, so it runs as plain instructions. That is acceptable because it hashes
  only 32 bytes.
- The Merkle tree here is a SHA-256 tree over the `hash160` leaves. That is chosen to use the SHA-256
  accelerator and to avoid any hash migration, and it is representative for the memory measurement. It
  is not the exact production tree, and the roots-and-hashes section of `docs/REDUCING_PROVING_COST.md`
  covers that separately.
- This measures the derive-the-key statement. The signature-verifying variant is the next measurement,
  per the statement joint-optimization in the cost doc, and belongs in a sibling guest so the two can be
  compared on the same backend.

## Layout

    research/risc0-registration/
      Cargo.toml            workspace, and the [patch.crates-io] acceleration block
      rust-toolchain.toml   host toolchain pin
      Dockerfile            container build and run, the recommended path on this Mac
      scripts/bench.sh      wraps the run with a peak-memory measurement
      host/                 builds a synthetic witness, runs the prover, prints the numbers
      methods/              embeds and builds the guest
      methods/guest/        the registration statement above

## Building and running

Two paths. Use the container path on this Mac, which has `docker` and `colima` but no native Rust or
RISC Zero toolchain.

### Container path (recommended here)

    colima start                 # bring up the Linux VM that backs docker
    cd research/risc0-registration
    docker build -t r0-registration .
    docker run --rm r0-registration

The container runs `scripts/bench.sh`, which builds in release mode and runs the host under GNU
`time -v`, so the output ends with a `Maximum resident set size` line. For a representative number, run
the container on a host sized like a masternode (start with a 16 GB Linux box) rather than a laptop VM,
and constrain memory with `docker run --memory=16g` to model the target.

### Native path

Install the toolchain, then build and run:

    curl -L https://risczero.com/install | bash    # installs rzup
    rzup install                                    # installs the RISC Zero toolchain and r0vm
    cd research/risc0-registration
    scripts/bench.sh                                # release build, run, peak-memory measurement

On Linux `scripts/bench.sh` uses GNU `time -v`. On macOS it falls back to `/usr/bin/time -l`, whose
`maximum resident set size` is in bytes.

## Version alignment (read before the first build)

The RISC Zero crate versions in the `Cargo.toml` files and the fork tags in the `[patch.crates-io]`
block must all match one RISC Zero release. The versions committed here are placeholders. Set them to
the release your `rzup` installed, following the current RISC Zero starter template, or the guest
acceleration will silently not engage and the memory number will be wrong. This is the first thing to
fix if the build fails or if the cycle count looks far larger than expected.

## Honest status

This is a scaffold. It has not been compiled or run in this environment, because the Rust and RISC Zero
toolchains are not installed here. The numbers must be taken on representative hardware. Treat a green
build and a peak-memory line under the cap as the signal to keep RISC Zero in the Phase 0 benchmark, and
a memory blow-past as the signal to weight the lookup-modernized SNARK and folding candidates instead.
