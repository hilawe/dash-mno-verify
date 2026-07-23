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
- This measures the derive-the-key statement. The signature-verifying (`sig`) and recovery-hinted
  (`rec`) variants are sibling guests measured on the same backend, per the statement
  joint-optimization in the cost doc, and their results are recorded there.
- The `reg` variant is guest v2, the production five-claim statement of `docs/ZKVM_INTEGRATION.md`
  (commitment and registration nullifier via circomlib-parameterized Poseidon, the frozen 136-byte
  journal). Its host run uses the pinned golden-vector witness, so the entire journal is asserted
  against the circomlibjs-pinned constants of the `vectors/` crate, and the bench's capped step runs
  this variant, since it is the statement that ships.

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

### Container path

Platform caveat, confirmed here on 2026-07-13: the RISC Zero toolchain has no linux/aarch64 build, and
the `rzup` installer rejects it with "Unsupported architecture: linux/aarch64". So the plain container
build fails on an Apple Silicon Mac, because colima runs an ARM64 Linux virtual machine. Two ways
around it.

On a native x86_64 Linux host, no platform flag is needed:

    docker build -t r0-registration .
    docker run --rm --memory=16g r0-registration

On an Apple Silicon (ARM64) host, build and run for amd64 under emulation, which works but is slow and
gives numbers that are not representative, so use it only to confirm the build:

    docker run --privileged --rm tonistiigi/binfmt --install amd64
    docker build --platform linux/amd64 -t r0-registration research/risc0-registration
    docker run --rm --platform linux/amd64 --memory=16g r0-registration

The container runs `scripts/bench.sh`, which builds in release mode and runs the host under GNU
`time -v`, so the output ends with a `Maximum resident set size` line. For a representative Phase 0
number, run on a native x86_64 Linux host sized like a masternode (start with a 16 GB box), or use the
native macOS arm64 path below, not the emulated container.

### Native path

Install the toolchain, then build and run:

    curl -L https://risczero.com/install | bash    # installs rzup
    rzup install                                    # installs the RISC Zero toolchain and r0vm
    cd research/risc0-registration
    scripts/bench.sh                                # release build, run, peak-memory measurement

On Linux `scripts/bench.sh` uses GNU `time -v`. On macOS it falls back to `/usr/bin/time -l`, whose
`maximum resident set size` is in bytes.

### Continuous integration path (real x86_64, no server to provision)

The workflow at `.github/workflows/risc0-registration-bench.yml` builds and runs the prover on a
GitHub-hosted `ubuntu-latest` runner, which is real x86_64 Linux with about 16 GB of memory, so it needs
no machine of your own. Trigger it from the Actions tab (it is a `workflow_dispatch`), or by pushing a
change under `research/risc0-registration/`. Because the runner is about 16 GB, this doubles as the gate
test, does the proof fit a roughly 16 GB masternode-class box. If the run step is killed for memory, that
is the answer. If it completes, read the `Maximum resident set size` line. For a target larger than the
runner, use a native x86_64 Linux box with more memory instead.

The workflow's final step re-runs the production `reg` variant inside an enforced 8 GB cgroup (`systemd-run`
with `MemoryMax=8G` and swap off), the acceptance bar as tightened on 2026-07-23. That step passing
demonstrates the 8 GB fit the cost doc currently marks as pending; an out-of-memory termination is
the honest negative answer. It caps the prover alone, so it does not yet represent a box that is
also running Dash Core at full cache; a representative-box run stays worthwhile beyond it.

## Version alignment

The RISC Zero crate versions and the fork tags in the `[patch.crates-io]` block are set to the 3.0.5
release, and cargo resolves them cleanly (verified 2026-07-13, the `k256`, `sha2`, and `crypto-bigint`
entries resolve to the RISC Zero forks at the expected tags, so the guest acceleration will engage). If
your `rzup` installs a different major or minor version, realign these to it following the current RISC
Zero starter template, or the acceleration will silently not engage and the numbers will be wrong.

## Honest status

The dependency graph resolves cleanly against RISC Zero 3.0.5 (verified 2026-07-13 with cargo, in a
Linux container), and the host prover API matches the current starter template. The host and guest code
has NOT yet been compiled, because the RISC Zero toolchain has no linux/aarch64 build and this Apple
Silicon Mac has no native Rust or RISC Zero toolchain (see the platform caveat above). The compile and
any measured number still need a supported platform, a native x86_64 Linux box, a native macOS arm64
build, or continuous integration. Treat a green build with a peak-memory line under the cap as the
signal to keep RISC Zero in the Phase 0 benchmark, and a memory blow-past as the signal to weight the
lookup-modernized SNARK and folding candidates instead.
