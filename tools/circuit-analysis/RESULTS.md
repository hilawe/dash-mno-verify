# Circuit analysis results

What the free circuit-analysis tools in this directory have established about the circom circuits, and
what remains. The runs are reproducible: `bash tools/circuit-analysis/run.sh` for the static pass and
`bash tools/circuit-analysis/ecne/run.sh <circuit>` for a determinism check. Read
`docs/SECURITY_AUDIT_SCOPE.md` for the full tier-1 picture this feeds.

This raises the tier-1 floor above the STRUCTURAL-ONLY level the audit-scope document originally claimed
for internal review. No external audit or specialist review will be commissioned, so the component named in
the residual below was assessed internally instead, recorded in the last section of this file.

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

What that left open, narrowed to one named component (the section "ECDSAPrivToPub, assessed internally"
below records what has since been checked):

- Whether `ECDSAPrivToPub` in `circom-ecdsa` is sound as used. It is unaudited demonstration code by its
  own documentation. The composition wrapper checks everything around it. It does not check it, and it does
  not check the `pubkey = privkey * G` binding it is responsible for.
- The trusted-setup ceremony assumption, which no constraint-level tool addresses.

## Differential derivation checks, in CI

Determinism says the circuits compute ONE function of their inputs. The differential derivation checks in
`scripts/check_circuits.sh` address the adjacent question of whether it is the INTENDED function, the same
way the hash160 vector and the X11 reference harness do for their components. Each production circuit is
witnessed on a valid input and the outputs it emits are compared against an independently spelled JS
derivation (`test/derivations.mjs`, written against circomlibjs):

- `mno_members`: the per-epoch nullifier, Poseidon3(secret, epoch, contextHash).
- `mno_membership`: the nullifier, Poseidon3(Poseidon4(privkey limbs), epoch, contextHash).
- `mno_registration`: the commitment, Poseidon1(secret), and the registration nullifier,
  Poseidon3(Poseidon4(privkey limbs), season, contextHash).

The seam this pins is the circomlibjs-versus-circomlib agreement production already depends on: the prover
derives the commitment in JS to find its members-tree leaf, and the gateway builds members roots in JS
that the in-circuit Merkle check must reproduce. Every comparison was mutation-checked at write time
(swapped input order, a dropped key limb, a wrong witness index, a perturbed commitment input, each
watched failing and each mutant confirmed to parse and apply). What this does not establish: anything
about Poseidon itself, or about the ECDSA component. The chains are checked as wirings of Poseidon against
an independent spelling of the same wiring, on fixed vectors, and the chains have no input-dependent
branching.

## ECDSAPrivToPub, assessed internally, 2026-09-27

No external audit or specialist review will be commissioned, so the residual above was taken as far as
internal checking reaches. This section covers `ECDSAPrivToPub(64, 4)` from `circom-ecdsa` at the pinned
commit d87eb70, which is still the head of upstream's only branch, and the two circuits that call it. The question is whether a prover can make the component output anything other than
`privkey * G`. The checks below approach it from five directions, and the last part of the section says
what they do not settle.

### 1. Every constant against an independent implementation

`tools/circuit-analysis/ecdsa/check_constants.mjs` compares the component's constants with OpenSSL's
secp256k1 through `node:crypto`, not with the generator circom-ecdsa used.

- All 8,160 entries of the stride-8 table equal `j * 2^(8i) * G`, with canonical coordinates on the curve.
- The group order `get_secp256k1_order(64, 4)`, which the callers' `privkey < n` bound compares against,
  equals n.
- THE DUMMY POINT IS `255 * G`, NOT THE `2^255 * G` THAT `ecdsa.circom` LINE 30 DOCUMENTS. Both the k=3 and
  k=4 branches of `get_dummy_point` carry `255 * G`, which is also table entry `powers[0][255]`. The value
  entered upstream in commit 436665b (March 2022) beside the comment "TODO check that this is correct", and
  a search of the upstream issues and the bug catalogs below found no report of it. One downstream project
  that pins the same commit patched it on 2026-08-28 (Zilliqa zkp_recovery_app, commit 0f628c4). Section 2
  shows it does not change what the component outputs here.

Each check was watched failing on a planted error in a scratch copy of the library: a table limb changed
by one, an order limb changed by one, and a dummy limb changed by one, each reported with its own
diagnostic.

### 2. The adder argument

`Secp256k1AddUnequal` is constrained to the right sum only when its two inputs have different x
coordinates. With two identical inputs its constraints reduce to 0 = 0 and its output is free, and with a
point and its negation they cannot be satisfied. That is the same shape a published review found in a
descendant library's point addition (zkbugs, Telepathy circuits). What matters is whether any adder whose
output the component keeps can ever receive equal x coordinates. Reading the selection formula
(`ecdsa.circom` lines 71 to 115):

- An adder's output is KEPT only when an earlier window was non-zero and its own window is non-zero. Its
  inputs are then `S * G`, with S the scalar accumulated so far (1 <= S < 2^(8i)), and `w * 2^(8i) * G` with
  1 <= w <= 255. A kept adder never takes the dummy as a zero window's stand-in. It can take `255 * G` as a
  real partial sum (key 511 does, at window 1), which has the dummy's value and is still `S * G` with
  S = 255.
- Same x means S = +-w * 2^(8i) mod n. Both sides are below 255 * 2^248 < n as integers and S < w * 2^(8i),
  so S = w * 2^(8i) mod n is impossible. S + w * 2^(8i) < 2^256 < 2n, so S = -w * 2^(8i) mod n needs
  S + w * 2^(8i) = n exactly, which happens only at the last window with privkey = n. There the adder
  receives a point and its negation (the same x, a different y) and cannot be satisfied, so privkey = n
  (not a valid key) cannot be proved at all.
- So NO KEPT ADDER EVER RECEIVES TWO EQUAL POINTS, FOR ANY 256-BIT PRIVATE KEY. This holds without the
  callers' `privkey < n` bound, which exists for the nullifier (review finding M1), not for the adders.
- A DISCARDED adder can receive two identical points, for keys whose low 16 bits are 0x00ff (255 * G against
  the dummy 255 * G) or whose two low windows are both zero (the dummy against itself). Its free output is
  ignored exactly. Simplified, the formula is `partial[i] = h(1 - z) * adder + h z * partial[i-1] +
  (1 - h)(1 - z) * mux`, with h = `has_prev_nonzero[i-1]` and z = `iszero[i]`, so the adder's output enters
  with coefficient `h(1 - z)`, which is zero exactly when it is discarded, whatever value it takes. No
  discarded adder receives a point and its negation, so no valid key is left unprovable.

The script checks each integer bound, then replays the selection formula over 2,014 keys (14 edge, 2,000
random), confirming every one reaches `privkey * G` with no kept adder colliding, and that privkey = n is
flagged. The replay models the formula, not the constraint system, so it checks the case analysis above
rather than the circuit.

### 3. The compiled component on real keys

`tools/circuit-analysis/ecdsa/check_witness.mjs` compiles the component, runs its witness calculator, and
compares each output with OpenSSL. It needs about 9 seconds a key, and a 200-key run takes about 30
minutes.

- 11 edge keys, among them the 5 that drive a discarded adder through two identical points or start the
  walk from the all-zero placeholder, each give `privkey * G`, and each full witness satisfies every R1CS
  constraint, which the witness calculator alone does not guarantee.
- 200 random keys give `privkey * G` (the first 5 also checked against the R1CS).
- privkey = 0 gives the placeholder (0, 0), which is not a curve point, and a witness that satisfies the
  R1CS (see item A2 below).
- privkey = n is refused by the witness calculator at the carry range check inside the last adder's cubic
  constraint, the adder the case analysis says receives a point and its negation.

This is the honest witness only. It shows the component computes the right function on these keys, not
that no other witness exists.

### 4. circom's own under-constraint inspection

`circom --inspect` on the component flags range-check outputs that are unused by design, the final
`has_prev_nonzero[31]` output that nothing reads, and `<--` assignments at three sites. Each of those is
followed by the constraint that pins it: the product coefficients of `BigMultNoCarry` by evaluation at
`ka + kb - 1` points, and the two carry assignments of `CheckCarryToZero` by the carry equation and its
range check.

### 5. The overflow bounds of the modular checks

`tools/circuit-analysis/ecdsa/check_bounds.mjs` follows the adder's two modular checks with interval
arithmetic over 64-bit input limbs, which is what the adder's inputs always are. A field equation implies
the same integer equation only if its values stay below r / 2, where r is the BN254 scalar field modulus
(r / 2 is about 2^252.6).

| | cubic check, m = 200 | quadratic check, m = 132 |
|---|---|---|
| input registers | below 2^198 | below 2^132 |
| after reduction | below 2^245 | below 2^167 |
| honest carries against their range check | below 2^181, range 2^184 | below 2^103, range 2^106 |
| carry equations, any admitted carry | below 2^249 | below 2^171 |
| honest quotient against its limbs | below 2^181, 192 bits | below 2^103, 128 bits |

Every value the circuit holds stays below 2^249, so every constraint implies its integer equation, and the
declared overflow parameters bound what is fed in. The quadratic check has no margin (registers below
2^132 against m = 132), and holds. The intervals are conservative, so a pass is sufficient. The script was
watched failing three ways: with the cubic parameter lowered to 196 and the quadratic to 131, each reported
as an input register over its bound, and with the cubic raised to 205, reported as carry equations reaching
2^254. The same bounds were derived independently in a review with repository access, which also confirmed
the adder's uniqueness algebra (a nonzero x difference fixes both output coordinates) and that
CheckInRangeSecp256k1 accepts exactly 0 <= v < p.

### 6. The published bug catalogs

The circom entries of these sources were mapped onto the pinned code:

- 0xPARC zk-bug-tracker (github.com/0xPARC/zk-bug-tracker) and the zkSecurity zkbugs dataset
  (github.com/zksecurity/zkbugs).
- The upstream circom-ecdsa issues and pull requests. The one security fix, a range check in `BigMod`
  (PR #10), is already in the pinned code, and `BigMod` is not compiled into these circuits. Issue #35 asks
  about an on-curve check for the adder's output, which section 2 addresses for this usage.
- The published 2022 audit of circom-bigint and circomlib by the 0xPARC community, the Ethereum Foundation,
  and Veridise (report VAR-circom-bigint.pdf, commit 7505e5c of github.com/0xbok/circom-bigint). The pinned
  `bigint.circom`, `bigint_4x64_mult.circom`, and `bigint_func.circom` are byte-identical to that commit,
  checked by comparing the files. The report states it proved the library's templates correct against
  their specifications in Coq, and it notes that several templates carry input assumptions their callers
  must meet. It did not cover the secp256k1 files, and whether those files meet the library's input
  assumptions is what section 5 checks.

None of the mapped shapes was found present and reachable. Two named ones in particular do not apply. The
circom-pairing defect of a `BigLessThan` output computed but never asserted does not, because both callers
assert `dlt.out === 1`. The circomlib `Decoder` weakness does not, because `Multiplexer` asserts
`success === 1`. No `Num2Bits` or `Bits2Num` is wide enough to alias. The gateway rejects public signals
that are not canonical field elements, and the pinned snarkjs PLONK transcript includes the public
signals.

### Items found

- A1, the dummy point constant. `255 * G` against a documented `2^255 * G`. By sections 2 and 3 it does not
  change the component's output for any key, so the circuits are left as they are, because changing the
  constant changes the circuit and every key built from it. If the circuits are ever rebuilt (for example
  for a Groth16 ceremony), adopt the corrected constant then, along with A2 and A3.
- A2, a private key of 0 is accepted. It yields the placeholder (0, 0) and the leaf
  hash160(0x02 || 0^32) = 3625c4a2ea974760a816368fd15de771594476e7, which is not the zero leaf the oracle
  already refuses. Both full circuits, `mno_membership` and `mno_registration`, produce a satisfying witness
  for key 0 against a tree holding that leaf. Whether any live masternode carries that voting key id has
  not been checked. Anyone can prove with key 0, so a masternode whose voting key id were set to that value
  would be provable by anyone, one membership per epoch per context under a nullifier anyone can compute.
  Only the node's owner can set its voting key id, and an owner can already hand out a real voting key, so
  this gives nobody a capability the owner could not already grant. SINCE 2026-09-27 THE ORACLE LEAVES THAT
  LEAF OUT of the tree, in both `oracle/snapshot.js` and `oracle/diff_snapshot.js`, and logs the node. It
  leaves the leaf out rather than refusing the snapshot, because Dash Core accepts any non-null voting key
  id and a refusal would let that one owner stop the oracle. `KEY_ZERO_LEAF` in `common/dml.js` names the
  value, `test/hash160.test.js` derives it independently, and `scripts/check_circuits.sh` runs the real
  hash160 circuit on (0, 0) in CI and checks it emits the same value. A circuit constraint
  `privkey != 0` at the next rebuild would close it at the source.
- A3, the single-tier nullifier Poseidon(Poseidon(privkey), epoch, context) and the registration nullifier
  Poseidon(Poseidon(privkey), season, context) share one layout, and `contextHash` does not record the mode,
  so the two are equal when an epoch number equals a season number for one context. Under the default
  schedule they cannot meet (the current epoch is 2960 and the current season 230), and a gateway accepts
  only the current epoch or season. They could meet only if two deployments for the same community and role
  ran the two modes with an epoch length equal to the other's season length. The observer holding both
  stores could then tell that the same unnamed key used both. Adding the mode to `contextHash` separates
  them with no circuit change, at the cost of a context cutover at a season boundary. A domain tag inside
  the circuits does the same at the next rebuild.

### What this does not settle

- NO SOLVER HAS PROVEN THE COMPONENT'S OUTPUT UNIQUE. Ecne and Picus prove uniqueness unconditionally, and
  the adder's output is not unique when its inputs are equal, so neither can certify the adder in
  isolation. The argument that the component is sound as used combines the case analysis in section 2, the
  adder algebra, and the bounds in section 5. Each piece is checked arithmetic and reading, confirmed by a
  second independent derivation, not a machine-checked proof.
- The trusted-setup assumption is untouched by any of this.
- The operational advice stands. Do not gate anything of real value, keep the anonymity set large, and
  keep grants capped.

### Review

One review with repository access re-derived the bounds and the adder algebra, refuted two claims that
had been worded wider than the evidence (both corrected above), and confirmed that key 0 is accepted by
both full circuits. Two further reviews, reading the inlined source without repository access, confirmed
all five claims put to them and found no witness that gives an output other than `privkey * G` for a key
in [1, n). One of those restated the cubic constraint incorrectly, which checking on 200 random values
showed, but its conclusion rests only on the constraint being linear in x3 with coefficient (x1 - x2)^2,
which holds for the real constraint. The other argued that key 0 matters only through a HASH160 preimage,
which misses that a masternode owner sets the voting key id directly, so item A2 stands as written. All
three are readings and checked arithmetic, not machine-checked proofs.

## How to reproduce

    bash tools/circuit-analysis/run.sh output/circomspect.txt         # static pass
    bash tools/circuit-analysis/ecne/run.sh circuits/mno_members.circom
    bash tools/circuit-analysis/ecne/run.sh test/hash160/hash160_test.circom
    bash tools/circuit-analysis/ecne/run.sh tools/circuit-analysis/ecne/wrappers/mno_membership_nonecdsa.circom
    bash tools/circuit-analysis/ecne/run.sh tools/circuit-analysis/ecne/wrappers/mno_registration_nonecdsa.circom
    node tools/circuit-analysis/ecdsa/check_constants.mjs   # constants against OpenSSL, the case analysis
    node tools/circuit-analysis/ecdsa/check_bounds.mjs      # the modular checks' overflow bounds
    node tools/circuit-analysis/ecdsa/check_witness.mjs     # the compiled component, about 30 minutes

The single-tier composition wrapper (`mno_membership_nonecdsa.circom`) runs through the same `run.sh` as
any other circuit, because it supplies the ECDSA output as an ordinary input rather than as a trusted
function. The isolated `ecdsa_privtopub.circom` decomposition instead compiles the ECDSA component
alongside the target and drives Ecne's `solveWithTrustedFunctions` directly, because the Ecne CLI parses
`--trusted` but does not pass it through.
