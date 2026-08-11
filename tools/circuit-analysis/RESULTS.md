# Circuit analysis results

What the free circuit-analysis tools in this directory have established about the circom circuits, and
what remains. The runs are reproducible: `bash tools/circuit-analysis/run.sh` for the static pass and
`bash tools/circuit-analysis/ecne/run.sh <circuit>` for a determinism check. Read
`docs/SECURITY_AUDIT_SCOPE.md` for the full tier-1 picture this feeds.

This raises the tier-1 floor above the STRUCTURAL-ONLY level the audit-scope document originally claimed
for internal review. It does not replace a specialist on the one component named in the residual below.

## Static analysis, circomspect 0.9.0

Zero errors across all circuits. Four warnings, all assessed and benign:

- Two are the intended Semaphore signal binding (`signal sq; sq <== signalHash * signalHash;` in
  `mno_membership.circom` and `mno_members.circom`), where `sq` deliberately feeds nothing else. The
  binding forces `signalHash` into the witness, so the public signal IS constrained. Whether squaring is
  adequate binding is a soundness question, addressed by the Ecne determinism result below.
- Two are `Num2Bits` aliasing warnings in `hash160.circom`. They are benign at the instantiated `n = 64`:
  aliasing needs `n` near the field size (about 254 bits), so at 64 bits each coordinate limb has a unique
  decomposition and is range bounded to 2^64.

## Determinism, Ecne (0xPARC), pinned by commit in PIN

Ecne proves whether an R1CS uniquely determines its outputs from its inputs, compiled unoptimized
(`--O0`). A determined output cannot be chosen by a prover, which is the forge-a-membership failure mode.
Ecne's own convention: a proof of soundness is strong evidence, while a non-proof means Ecne could not
prove soundness, not that the circuit is unsound.

VERIFIED FULLY CONSTRAINED (no trusted functions needed):

- `mno_members` (the two-tier per-epoch membership circuit, the workhorse of the recommended design, and
  the proof a member submits for every access after registration). All 13,909 variables solved, the single
  output uniquely determined, no bad constraints. This circuit INCLUDES the Merkle inclusion
  (`merkle.circom`) and the Poseidon nullifier, commitment, and signal binding, so their determinism is
  established as part of this result.
- `hash160` (the compressed-pubkey to address derivation used by the single-tier and registration
  circuits). Fully constrained, no bad constraints.

So the entire two-tier per-epoch path is verified determinate, and the single-tier and registration
circuits' non-ECDSA components are individually verified.

## The residual, and the one component it names

The single-tier `mno_membership` and the two-tier `mno_registration` circuits both derive the public key
from the private voting key in circuit with `ECDSAPrivToPub` from `circom-ecdsa`. That component is about
383,000 wires, and the full circuits are about 682,000 unoptimized, which is the regime Ecne handles by
TRUSTED-FUNCTION DECOMPOSITION: treat `ECDSAPrivToPub` as a trusted black box and verify the rest. The
decomposition is set up here (`tools/circuit-analysis/ecne/wrappers/ecdsa_privtopub.circom` plus a driver),
and a full run reads the 86 MB main R1CS single-threaded, which is slow but completes rather than failing.

What that leaves for a specialist, unchanged in kind and now narrowed to one named component:

- Whether `ECDSAPrivToPub` in `circom-ecdsa` is sound as used. It is unaudited demonstration code by its
  own documentation. The trusted decomposition verifies everything AROUND it; it does not verify it.
- The trusted-setup ceremony assumption, which no constraint-level tool addresses.

## How to reproduce

    bash tools/circuit-analysis/run.sh output/circomspect.txt         # static pass
    bash tools/circuit-analysis/ecne/run.sh circuits/mno_members.circom
    bash tools/circuit-analysis/ecne/run.sh test/hash160/hash160_test.circom

The ECDSA trusted decomposition compiles the wrapper alongside the target and drives Ecne's
`solveWithTrustedFunctions` directly, because the Ecne CLI parses `--trusted` but does not pass it through.
