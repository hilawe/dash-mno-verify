# Reducing the member-side proving cost

The one real barrier to wide adoption is the size of the membership proving key, about 2.3 GB, and the
memory and time to make a proof with it. This document is the design track for removing that cost at the
source, not just relocating it. It is a plan and a set of options, not a decision.

The analysis below was sharpened by a clean-room design exercise, in which several independent designs
from different model families were produced from the requirements alone, followed by an adversarial
review of the resulting synthesis. The earlier version of this document led with the proven statement as
"the lever that decides the cost." That framing was too narrow, and the corrected account is what
follows.

## Why the key is 2.3 GB, three bundled costs

The membership and registration circuits prove, in zero knowledge (ZK), that the member knows the voting
private key for one entry in the deterministic masternode list (DML). The 2.3 GB is not one thing. It is
three costs bundled together, and separating them is what makes the fix tractable.

1. The proof system. The circuits use PLONK, a succinct non-interactive argument of knowledge (SNARK)
   over the BN254 curve, whose per-circuit proving key scales with the constraint count, so a few
   million constraints produce a multi-gigabyte key. A transparent proof system built on the Fast
   Reed-Solomon Interactive Oracle Proof of Proximity (FRI) has no such structured key at all, its
   prover needs only the compiled circuit, a few megabytes.
2. The arithmetization. The dominant part of the constraint count is `circom-ecdsa`, a brute-force
   emulation of secp256k1 arithmetic over the BN254 field that predates modern lookup arguments. Much of
   the 2.3 GB is this stale arithmetization, not an inherent property of the SNARK family. A lookup-based
   arithmetization (Plookup, LogUp, Lasso, or a mature library such as halo2's secp256k1) does the same
   elliptic-curve work at a fraction of the constraints, which shrinks the key several-fold while staying
   a structured-key SNARK.
3. The statement. Deriving the public key from the private key is one fixed-base secp256k1 scalar
   multiplication. Verifying an Elliptic Curve Digital Signature Algorithm (ECDSA) signature is heavier
   in a plain circuit, two scalar multiplications plus a modular inversion, but it can be cheaper in a
   backend whose accelerated path targets signature verification. So the statement is a real but smaller
   and backend-dependent factor, not the primary one.

On top of these, the leaf hash `keyIDVoting = hash160(pubkey)`, which is SHA-256 then RIPEMD-160, and
the Merkle inclusion against the DML root add constraints, but they are not where the bulk of the cost
lives.

The dominant avoidable cost is the arithmetization and proof-system combination. The statement is a
secondary lever, and it matters most for prover memory and for key handling, discussed below.

## What already softens it, and what does not

The two-tier design already pays the heavy proof only once per season (registration), then uses a small
35 MB key for the cheap per-epoch proof. Hosting the large key turns "rebuild with circom" into
"download one checksummed file." Proving on the masternode puts the key on hardware the member already
runs. Those make the 2.3 GB a non-issue for a masternode operator, but none of them delete it. The
member still holds the key to make the heavy proof, because the proof must be made with the voting key
under the member's control.

The only thing that removes the 2.3 GB is a smaller circuit or a proof system with no structured key,
which means a different proving backend, a different arithmetization, or both.

## The gate that decides everything, prover memory on real hardware

The single measurement that decides the whole question is peak prover memory for the heavy
once-per-season registration proof on masternode-class hardware. Independent estimates for a non-native
secp256k1 scalar multiplication in a transparent prover scatter widely, from single-digit to tens of
gigabytes, which is itself the reason it must be measured rather than assumed.

The acceptance bar moved once, and the record of both versions is kept here. As pre-declared before
the measurement, an 8 GB node was written off as not credible, 16 GB was treated as the plausible
target, and the failure line was a peak above roughly 12 GB on a 16 GB node. The measured results
then came in low enough to make an 8 GB node reachable, and the bar was tightened (owner decision,
2026-07-23) to fitting an 8 GB machine, on the grounds that requiring members to hold 16 GB boxes
fails the adoption goal this track serves. Under the original bar the 9.6 GB variants pass, and under
the tightened bar they fail, which is why the decision below rejects them. The capped confirmation run is done. On 2026-07-23 the bench workflow's final step ran the derive
variant inside an enforced 8 GB cgroup with swap off (`systemd-run` `MemoryMax=8G`
`MemorySwapMax=0`) on an x86_64 runner, and the proof completed in 4 minutes 56 seconds at a
4,804,780 kB peak resident set with zero major page faults, so the 8 GB fit is demonstrated for the
prover alone, not inferred from headroom. The remaining caveat is representativeness, the cap
covered the prover by itself, so a box simultaneously running a memory-hungry Dash Core at full
cache is still unmeasured, and so is the STARK-to-SNARK wrap step if the integration design chooses
a wrapped receipt.

## The candidates

These are a set to benchmark against each other, not a ranked list with a predetermined winner.

0. The null baseline, keep the current stack and host the key. The deployment already hosts the key, so
   the member downloads one checksummed file. Any rewrite must beat this on a cost-benefit basis,
   because the rewrite invalidates the existing audit and takes on new assumptions, and its whole payoff
   is deleting a one-time hostable download. State the baseline explicitly so the rewrite is measured
   against it, not against nothing.
1. A lookup-modernized structured-key SNARK (halo2 or PLONK with lookup arguments). Keeps the proof
   system family but replaces the stale `circom-ecdsa` arithmetization, plausibly cutting the key to the
   low hundreds of megabytes. This is the lowest-risk path, because it does not take on transparent-proof
   soundness conjectures or a young arithmetization-friendly hash. It still has a per-circuit proving key
   (smaller) and a universal structured reference string (SRS).
2. A zero-knowledge virtual machine (zkVM) with a STARK backend (scalable transparent argument of
   knowledge), for example SP1 or RISC Zero. Write the membership check as a normal program and prove its
   execution, with no per-circuit key and no ceremony. Benchmark both statement forms (derive the key,
   and verify a signature), because the zkVM's accelerated secp256k1 path may target signature
   verification and so favor the signature statement. The real risk is prover memory, per the gate above.
3. A folding scheme (Nova, SuperNova, HyperNova). Folding makes peak prover memory proportional to one
   step of a uniform loop rather than the whole computation, and the secp256k1 double-and-add loop is a
   natural fit. This is the structural answer to the memory risk, worth prototyping if the zkVM memory is
   marginal.
4. A purpose-built transparent secp256k1 membership prover in the Spartan family (for example the
   published spartan-ecdsa work). Sum-check-based, transparent, no large key, and it is the closest
   existing artifact to this exact statement, so it is a strong candidate even though it needs adaptation
   to the exact Dash `hash160` and DML semantics and an audit.
5. A linkable ring signature or one-out-of-many proof over the voting-key set (Groth-Kohlweiss,
   Triptych, Lelantus). This solves anonymous membership natively over secp256k1 with a key-image that
   is a nullifier, needing no circuit, no proving key, and no ceremony, with a proof logarithmic in the
   set size, but a feasibility check settles it against this candidate (see below). A ring operates over
   the public keys as elliptic-curve points, and the DML commits the voting key as `hash160(pubkey)`,
   not as a point, so the points would have to be assembled from elsewhere, and they cannot be.
6. Optimizing the current circom circuit in place. Realistic gains are marginal because the non-native
   secp256k1 arithmetic is intrinsic to the approach, so this does not reach the goal on its own.

The ring-signature feasibility check (candidate 5) is already settled, against it. A ring needs the
voting public keys as points, and Dash commits each voting key only as `KeyIdVoting`, the `hash160` of
the point. The point is recoverable only from a proposal-vote ECDSA signature, which Dash uses to
validate the vote, so it is available for masternodes that have voted but not for the rest, giving a
partial and shifting anonymity set rather than the full list. A member that publishes its point to
enlarge the ring is de-anonymized, because anyone matches `hash160` of that point to a specific list
entry. Proving membership against `hash160` commitments is instead a zero-knowledge preimage-plus-
inclusion proof, which is the SNARK path, so the ring candidate collapses into it rather than beating it.
That is also the positive reason the current design proves knowledge of the `hash160` preimage in zero
knowledge, it is the natural construction when the chain commits a hash rather than a point.

## The statement choice, a joint optimization

Whether to keep the derive-the-key statement or switch to verifying a signature is not a hard default in
either direction. Settle it on three axes together, not on prover cost alone.

- Prover cost. In a zkVM the accelerated ECDSA-verification path may make the signature statement the
  faster and lower-memory choice, while in a hand-written circuit the single fixed-base scalar
  multiplication of key derivation is lighter. This is a measurement, not an assumption.
- Nullifier soundness. A private-key-derived nullifier is unique and not grindable, but it requires the
  private key inside the prover. A signature-derived nullifier is a Sybil break unless the circuit
  enforces deterministic (RFC 6979) nonces, because standard ECDSA lets a prover produce many valid
  signatures over one message, each yielding a different nullifier. A nullifier keyed on a public
  identifier is grindable over the public list. So the signature path does not get a sound nullifier for
  free.
- Key hygiene. A signature statement lets the voting key stay in the wallet and sign through the remote
  procedure call (RPC), never entering the prover, which is a real operational gain that the
  key-derivation statement forgoes.

These pull against each other. The clean private-key nullifier wants the key in the prover, and key
hygiene wants it out, so decide by measuring prover cost and then honoring the nullifier-soundness
constraint, rather than by fixing the statement first.

## Phase 0 results, measured on RISC Zero

The prototype in `research/risc0-registration/` implements the registration statement in the RISC Zero
zkVM and measures three variants on continuous integration, on an x86_64 runner sized like a
masternode-class box. The heavy proof runs once per season, and the peak resident memory is the gate
number.

| Variant | Key custody | Peak RAM | Trace segment | Proving time |
| --- | --- | --- | --- | --- |
| Derive the key, benchmark (no Poseidon) | raw key enters the prover | 4.8 GB | 2^19 | 4.6 min |
| Verify a wallet signature, benchmark | key stays in the wallet | 9.6 GB | 2^20 | 9.2 min |
| Efficient-ECDSA, recovery-hinted, benchmark | key stays in the wallet | 9.6 GB | 2^20 | 9.1 min |
| Production statement (`reg`), default segments | raw key enters the prover | 9.6 GB | 2^20 | 84 min |
| Production statement (`reg`), segment po2 19, 8 GB cap | raw key enters the prover | 4.8 GB (fits) | 2^19 | 86 min |
| Signature (wallet custody), benchmark, po2 19 | key stays in the wallet | 4.8 GB | 2^19 | (benchmark) |

An important correction (2026-07-23). The first three rows are benchmark variants that emit the
public values as raw bytes and do NOT compute the circomlib-parameterized Poseidon commitment and
nullifier the production statement requires. The 4.8 GB derive figure, and the earlier claim that the
derive statement is "demonstrated on an 8 GB-capped run," are about that Poseidon-free benchmark, not
the shipping statement. The production statement (`reg`, guest v2) was then measured, and its three
in-guest Poseidon hashes cost about 7.9 million cycles, roughly 26 times the entire accelerated
remainder (key derivation, hash160, and the SHA-256 Merkle path). That pushed the trace into the 2^20
segment, so at default segments the production statement peaks at 9.6 GB and takes 77 minutes, and the
8 GB-capped CI step terminated it. So the 8 GB fit is NOT currently demonstrated for the shipping
statement.

Both levers reported (2026-07-23), and the segment lever is decisive. Forcing `segment_limit_po2 = 19`
brought the production `reg` statement from 9.6 GB to a measured 4.8 GB peak, and it PASSED under an
enforced 8 GB cgroup with swap off (systemd scope Result=success), for about 2 extra minutes of
proving (86 versus 84). So the production statement fits an 8 GB machine, now demonstrated for the
shipping statement, not just the Poseidon-free benchmark. The memory ceiling is set by the segment
size, essentially independent of the statement, which is the second finding: the wallet-custody
signature variant at po2 19 also dropped to 4.8 GB (from 9.6 GB at default). The earlier 9.6 GB
wallet-custody rejection was therefore a segment-size artifact, and it is reopened, because wallet
custody at 4.8 GB is now reachable. The cost of forcing small segments is time, not memory, and it is
modest for the derive path. Separately, the Poseidon cost is still the real structural lever on time,
and a faster pure-Rust Poseidon or a future zkVM BN254 field accelerator would cut the 26x, which is
the durable path for proving time.

On the benchmark variants themselves, the efficient-ECDSA form was expected to halve the elliptic-curve
work relative to a full signature verification and so approach the derive cost. It reduced the
arithmetic but not the memory. Its single scalar multiplication is variable-base, heavier than the
derive path's fixed-base multiplication with generator precomputation, and parsing the hint points
requires point decompressions. Those extra field operations push the execution trace over the boundary
between the zkVM's 2^19 and 2^20 segment sizes, and the prover memory is set by that power-of-two
segment, so the recovery variant lands in the same 2^20 bucket as the full verification and takes the
same 9.6 GB.

So on this zkVM, wallet custody costs about 9.6 GB whichever of the two forms is used, and only key
export reaches 4.8 GB. The savings of the efficient-ECDSA reformulation are real in a purpose-built
circuit, the published spartan-ecdsa work reaches about 8,000 constraints for this exact relation, but a
zkVM's fixed overhead and segment quantization absorb the win. Cheap wallet custody is therefore
reachable, but through a hand-built efficient-ECDSA circuit in a system like Spartan or halo2, a larger
effort on a different stack, not a variant swap inside the zkVM.

The design position, updated with the measured reruns. Deriving the key is the chosen statement, and
its 8 GB fit is now demonstrated (4.8 GB under the enforced cap at po2 19), so the derive path ships:
it removes the 2.3 GB proving-key download entirely (a zkVM has no structured per-circuit key), it
fits an 8 GB masternode, and its custody posture matches what the current PLONK prover already
requires, the voting key used locally on the member's own machine or masternode.

The wallet-custody question is genuinely reopened by the same measurement, and it is now a real choice
rather than a rejection. Because the segment size, not the statement, sets the memory ceiling, a
wallet-custody statement (the member signs, the key never enters the prover) also fits about 4.8 GB at
po2 19. The trade is time: wallet custody does more elliptic-curve work, so it proves slower than the
derive path at the same memory. So the axis is no longer "derive fits, custody does not," it is
"custody is available at 4.8 GB for more proving time, if the stronger key-hygiene property is worth
that time." This is an owner decision, recorded here as open, not silently defaulted. The
purpose-built efficient-ECDSA circuit (the spartan-ecdsa-class effort above) remains the durable way
to make custody cheap in time as well as memory, but it is no longer the ONLY way to reach custody at
all.

## Roots and hashes, no forced migration and no in-circuit bridge

Switching the membership tree to a SNARK-friendly hash is not forced, and no in-circuit proof that a
re-published root commits to the same set as the on-chain root is needed for the current trust model.
The masternode list is public, so the oracle recomputes the matching root off-circuit and the gateway
checks root equality off-circuit, which is exactly what the build already does (the M3 recompute). Two
consequences follow.

- If the chosen backend has a native SHA-256 accelerator, keep SHA-256 for the DML inclusion and avoid
  any hash migration. A SNARK-friendly hash (Poseidon) is worth adopting only for the gateway-owned
  members tree, where there is no external root to reconcile.
- An in-circuit bridge proof, that a Poseidon root commits to the same set as the on-chain
  `merkleRootMNList`, is only needed for the separate trustless-anchor goal (verifying against the chain
  with no oracle trust). It is heavy, because it must recompute the double-SHA-256 tree over the full
  masternode entries, so it belongs to that track, not to this one, and it is an oracle-side cost
  amortized across all members rather than a per-member cost.

## The trusted-setup question, stated precisely

A transparent FRI-based system removes the ceremony and the structured key, which is a real operational
and liveness win for a permissionless community with no natural ceremony coordinator. Two honest
caveats keep the claim from being oversold.

- It is not a soundness upgrade. It trades a one-time Powers of Tau assumption, which holds if a single
  ceremony participant was honest, for conjectural FRI and Fiat-Shamir soundness plus the collision
  resistance of a younger arithmetization-friendly hash.
- It is silently reversible. To shrink a proof, a zkVM wraps its STARK in a Groth16 or PLONK proof,
  which brings a setup back. Verification here is off-chain on a small server and tolerates a large
  proof, so the default position is to ship the raw unwrapped proof, which keeps the no-setup
  property true. At community scale, a few thousand proofs per multi-hour window at tens of
  milliseconds each is seconds of parallelizable CPU, so no wrapper is needed for throughput
  either. (This "no wrapper" position is now the decision, 2026-07-23. The step-3 measurements
  confirmed the wrapped path buys only a tiny receipt the server does not need, at the price of a
  circuit-specific Groth16 ceremony and about 33 extra minutes plus docker on every member's prove,
  so the gateway ships the unwrapped STARK receipt and keeps the no-setup property. The accepted
  cost is a non-JavaScript verifier component in the gateway, pinned by checksum. See the receipt
  section of `docs/ZKVM_INTEGRATION.md`.)

## Phase 0, the ablation-first benchmark

Before committing to any rewrite, run one competitive benchmark, on the worst-case masternode hardware
floor, with a hard memory cap, against the null baseline of hosting the current key. For each candidate,
measure proof time, peak prover memory, proof size, and gateway verification time. Run a same-backend
ablation among the statement forms (derive the key, verify a standard signature, verify a recovered or
transformed signature) so that cost is attributed to the right variable rather than inferred across
incomparable designs. The candidate that fits the memory cap with the least new trust and the smallest
per-member artifact wins. Only then is the full replacement of the circom and snarkjs proving layer worth
starting. This is the "validate the most consequential assumption with a thin end-to-end slice before
treating the architecture as settled" discipline, applied to the one number, prover memory, that decides
the outcome.

## The validation burden

A new prover has to prove the same statement as the current one, with the same public-signal semantics
(nullifier, root, epoch, context hash, signal hash), or the security properties in the threat model no
longer hold. So a migration needs an equivalence review of the new statement against the current one, a
fresh security audit of the new prover and verifier, and a transition plan. The transition can run both
stacks in parallel during a cutover, or cut over cleanly with a new key tag and, if the hash changed, a
re-published oracle that uses the matching Merkle hash. A transparent backend removes the trusted setup
entirely, which on that axis is a strict improvement over the current universal-setup PLONK, at the cost
of depending on the backend's own soundness and its accelerated operations.

## What not to do

Do not move the proof to a service that receives the voting key. That deletes the 2.3 GB from the member
but hands the key, and therefore which node they control, to the service, which is the exact disclosure
the whole design avoids. A privacy-preserving version (multi-party or collaborative proving, where the
key is secret-shared and no single party learns it) is a real research direction, but it adds heavy
infrastructure and new trust and liveness assumptions, so it is not the near-term path.

## Why this is worth doing

A no-large-key anonymous masternode membership proof is a genuine contribution, not just an
optimization, and it is a natural collaboration with the people already doing zero-knowledge work in
Dash. It is tracked as the durable fix for the member-side cost, to run as a research track in parallel
with deployment rather than as a blocker on it.

## Where the integration is specified

The decided statement's path into production (journal layout, the dual-root snapshot, receipt
verification at the gateway, the engine cutover rule, and the ordered work plan) is in
`docs/ZKVM_INTEGRATION.md`.
