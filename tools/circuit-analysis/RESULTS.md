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

OUTPUT DETERMINATE UNDER TRUSTED DECOMPOSITION (ECDSA supplied as a trusted input):

- The single-tier `mno_membership` path, all of it except the ECDSA scalar multiplication. The wrapper
  `tools/circuit-analysis/ecne/wrappers/mno_membership_nonecdsa.circom` reproduces steps 2 through 6 of
  `circuits/mno_membership.circom` verbatim at the same (treeDepth, n, k) = (16, 64, 4), reproduces the
  per-limb `Num2Bits(64)` range checks `ECDSAPrivToPub` applies to `privkey` internally (so removing the
  component does not also remove the constraints it contributed), and replaces the scalar multiplication
  itself with a `pubkey` input, the trusted output of `ECDSAPrivToPub`. Ecne solved 298,941 of 298,945
  variables and reported the single output (the nullifier) uniquely determined (1 of 1 target variables).
  The only four underdetermined signals are `main.dlt.eq[i].isz.inv`, the inverse witnesses of the four
  `IsZero` gadgets inside the `BigLessThan` that enforces the M1 canonical-scalar bound. Those witnesses
  are free by construction (a circomlib `IsZero` assigns `inv <-- in != 0 ? 1/in : 0` as a hint,
  unconstrained when `in == 0`), and the value they feed, `isz.out`, is uniquely determined in every case,
  so the output is not malleable. No other signal in the circuit is underdetermined.

This establishes that everything the single-tier path does around the scalar multiplication (hash160, the
Merkle inclusion, the privkey limb range checks, the M1 canonical-scalar bound, the privkey-derived
nullifier, and the Semaphore signal binding) uniquely determines the nullifier from the witness. Ecne
establishes uniqueness of outputs from inputs, not correspondence to the intended function, and the wrapper
decouples `privkey` from `pubkey`, so nothing here checks that `pubkey = privkey * G`. That binding is
exactly the trusted `ECDSAPrivToPub` and is the residual below.

An earlier version of the wrapper omitted the internal `Num2Bits` range checks, which meant its `privkey`
was less constrained than the production circuit's. A different-model review caught it, the checks were
added, and the run was redone. The verdict shape was identical both times (the same four inverse witnesses
and nothing else), but only the corrected run is the recorded result.

- The two-tier `mno_registration` path, all of it except the ECDSA scalar multiplication, by the same
  construction. The wrapper `tools/circuit-analysis/ecne/wrappers/mno_registration_nonecdsa.circom`
  mirrors the body of `circuits/mno_registration.circom` verbatim at the same (treeDepth, n, k) =
  (16, 64, 4), reproduces the internal `Num2Bits(64)` privkey range checks (from the start this time),
  and supplies the public key as the trusted input. Ecne solved 299,521 of 299,525 variables and reported
  BOTH outputs uniquely determined (2 of 2 target variables): the member `commitment` (Poseidon of the
  member secret) and the `regNullifier` (the per-season, per-context registration spend tag). The only
  four underdetermined signals are again the `main.dlt.eq[i].isz.inv` inverse witnesses inside the
  `BigLessThan` M1 bound, free by construction with their dependent `isz.out` uniquely determined in
  every case. No other signal is underdetermined.

With this, the non-ECDSA logic of ALL THREE production circuits is verified determinate: `mno_members`
directly (no trusted functions), and `mno_membership` and `mno_registration` under the trusted
`ECDSAPrivToPub` decomposition. The single residual component is unchanged.

## The residual, and the one component it names

The single-tier `mno_membership` and the two-tier `mno_registration` circuits both derive the public key
from the private voting key in circuit with `ECDSAPrivToPub` from `circom-ecdsa`. That component is about
383,000 wires, and the full single-tier circuit is about 682,000 unoptimized. Ecne handles that regime by
trusted-function decomposition, treating `ECDSAPrivToPub` as a trusted black box and checking the rest.
Two realizations of that decomposition were attempted, and only the first reached a verdict:

- The composition wrapper above (`mno_membership_nonecdsa.circom`, tracked in `ecne/wrappers/`), which
  supplies the ECDSA output as an input and lets Ecne solve the remaining circuit directly. This is the one
  that ran to a verdict (the R1CS read about two minutes and the solve about twelve, well within the 12 GiB
  VM), and it is the recommended path.
- The isolated component (`ecdsa_privtopub.circom`, also tracked in `ecne/wrappers/`), compiled on its own
  and handed to Ecne as a trusted function alongside the full main circuit through a small ad-hoc Julia
  script calling `solveWithTrustedFunctions` (the Ecne CLI parses `--trusted` but does not pass it through).
  That script is not tracked, because the run it drove never finished: the 86 MB main R1CS read is
  single-threaded (about 49 minutes) and the solve was then OOM-killed on the 12 GiB VM, so this
  realization produced NO verdict and established nothing. The composition wrapper replaces it.

What that leaves for a specialist, unchanged in kind and narrowed to one named component:

- Whether `ECDSAPrivToPub` in `circom-ecdsa` is sound as used. It is unaudited demonstration code by its
  own documentation. The composition wrapper checks everything around it. It does not check it, and it does
  not check the `pubkey = privkey * G` binding it is responsible for.
- The trusted-setup ceremony assumption, which no constraint-level tool addresses.

## How to reproduce

    bash tools/circuit-analysis/run.sh output/circomspect.txt         # static pass
    bash tools/circuit-analysis/ecne/run.sh circuits/mno_members.circom
    bash tools/circuit-analysis/ecne/run.sh test/hash160/hash160_test.circom
    bash tools/circuit-analysis/ecne/run.sh tools/circuit-analysis/ecne/wrappers/mno_membership_nonecdsa.circom
    bash tools/circuit-analysis/ecne/run.sh tools/circuit-analysis/ecne/wrappers/mno_registration_nonecdsa.circom

The single-tier composition wrapper (`mno_membership_nonecdsa.circom`) runs through the same `run.sh` as
any other circuit, because it supplies the ECDSA output as an ordinary input rather than as a trusted
function. The isolated `ecdsa_privtopub.circom` decomposition instead compiles the ECDSA component
alongside the target and drives Ecne's `solveWithTrustedFunctions` directly, because the Ecne CLI parses
`--trusted` but does not pass it through.
