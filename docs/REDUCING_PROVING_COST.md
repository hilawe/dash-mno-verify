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
gigabytes, which is itself the reason it must be measured rather than assumed. An 8 GB node is not a
credible target and 16 GB is plausible but not guaranteed. Treat a peak above roughly 12 GB on a 16 GB
node as that option failing, and fall back to the lookup-modernized universal-setup SNARK below, whose
per-circuit key is far smaller than 2.3 GB even though it does not reach zero.

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
   set size. It is gated first on a feasibility check, because the DML publishes `hash160(pubkey)`, not
   the public keys a ring needs, so it only works if the voting public keys can be assembled (recovered
   from signatures, or bound through a derived commitment). Check that before building anything.
6. Optimizing the current circom circuit in place. Realistic gains are marginal because the non-native
   secp256k1 arithmetic is intrinsic to the approach, so this does not reach the goal on its own.

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
  proof, so the honest position is to ship the raw unwrapped proof and pin "no wrapper" as a design
  constraint, which keeps the no-setup property true. At community scale, a few thousand proofs per
  multi-hour window at tens of milliseconds each is seconds of parallelizable CPU, so no wrapper is
  needed for throughput either.

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
