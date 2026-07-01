# Reducing the member-side proving cost

The one real barrier to wide adoption is the size of the membership proving key, about 2.3 GB, and the
memory and time to make a proof with it. This document is the design track for removing that cost at
the source, not just relocating it. It is a plan and a set of options, not a decision.

## Why the key is 2.3 GB

The membership and registration circuits prove, in zero knowledge, that the member knows the voting
private key for one entry in the deterministic masternode list (DML). Three parts of that statement are
what make the circuit large:

- Deriving the secp256k1 public key from the private key. Elliptic-curve scalar multiplication over
  secp256k1 is done inside a proof system whose native field is BN254, so every secp256k1 operation is
  emulated with non-native field arithmetic. This is the dominant cost, on the order of millions of
  constraints (circom-ecdsa's `ECDSAPrivToPub`).
- Computing `keyIDVoting = hash160(pubkey)`, which is SHA-256 then RIPEMD-160, both bit-oriented hashes
  that are expensive as circuit constraints.
- The Merkle inclusion proof against the DML root, using Poseidon at depth 16.

The number of constraints drives the size of the PLONK proving key, so a few million constraints
produces a multi-gigabyte key. The proof system is already transparent (PLONK over the public Hermez
Powers of Tau, no per-circuit trusted ceremony), so the problem is size, not trust.

## What already softens it, and what does not

The two-tier design already pays the heavy proof only once per season (registration), then uses a small
35 MB key for the cheap per-epoch proof. Hosting the large key turns "rebuild with circom" into
"download one checksummed file." Proving on the masternode puts the key on hardware the member already
runs. Those make the 2.3 GB a non-issue for a masternode operator, but none of them delete it. The
member still holds the key to make the heavy proof, because the proof must be made with the voting key
under the member's control.

The only thing that removes the 2.3 GB is a smaller circuit, which means a different proving backend.

## The options

1. A zero-knowledge virtual machine with a STARK backend (SP1, RISC Zero). Write the membership check as
   a normal Rust program and prove its execution. A STARK has no per-circuit proving key to download,
   and these virtual machines ship accelerated precompiles for secp256k1 and SHA-256, the two most
   expensive parts above. The Merkle tree would switch from Poseidon to SHA-256 (which has a precompile
   and which the oracle would then also use, so the two sides still agree), and the nullifier would use
   a standard hash. RIPEMD-160 has no common precompile, so it would run as plain instructions, which is
   acceptable because it hashes only 32 bytes. This is the least hand-rolled path to a no-large-key
   proof, and the recommended one to prototype first.
2. A hand-written halo2 circuit with an existing secp256k1 ECDSA chip. Smaller key than the current
   PLONK circuit, and transparent under an inner-product commitment. It is more work than the virtual
   machine, because the elliptic-curve and hash gadgets are assembled by hand, but the tooling for
   secp256k1 in halo2 is mature.
3. A folding scheme (Nova, SuperNova, HyperNova) for the repeated elliptic-curve operations. Very small
   prover memory and key, but the least off-the-shelf tooling for this exact shape, so highest research
   risk.
4. Optimizing the current circom circuit. Realistic gains are marginal because the non-native secp256k1
   arithmetic is intrinsic to the approach, so this does not reach the goal.

## Recommendation

Prototype option 1 before committing to any rewrite. A proof of concept implements the membership
statement in a virtual machine (derive the public key, compute `keyIDVoting`, verify the SHA-256 Merkle
inclusion, compute the nullifier, bind the challenge signal) and measures the proof time, the peak
memory, and the proof size on a masternode-class machine. The gateway verifies off-chain, so a
larger STARK proof and a heavier verify are acceptable, and the proof can be wrapped to a succinct SNARK
later if a small verify is wanted. If those numbers are acceptable, the full work is a replacement of
the circom and snarkjs proving layer, not a patch.

## The validation burden

A new circuit has to prove the same statement as the current one, with the same public-signal
semantics (nullifier, root, epoch, context hash, signal hash), or the security properties in the threat
model no longer hold. So a migration needs an equivalence review of the new statement against the
current one, a fresh security audit of the new prover and verifier, and a transition plan. The
transition can run both stacks in parallel during a cutover, or cut over cleanly with a new key tag and
a re-published oracle that uses the matching Merkle hash. The move keeps the transparent-setup property,
and a STARK removes even the reliance on the Powers of Tau, at the cost of depending on the virtual
machine's own soundness and its precompiles.

## What not to do

Do not move the proof to a service that receives the voting key. That deletes the 2.3 GB from the
member but hands the key, and therefore which node they control, to the service, which is the exact
disclosure the whole design avoids. A privacy-preserving version (multi-party or collaborative proving,
where the key is secret-shared and no single party learns it) is a real research direction, but it adds
heavy infrastructure and new trust and liveness assumptions, so it is not the near-term path.

## Why this is worth doing

A no-large-key anonymous masternode membership proof is a genuine contribution, not just an
optimization, and it is a natural collaboration with the people already doing zero-knowledge work in
Dash. It is tracked as the durable fix for the member-side cost, to run as a research track in parallel
with deployment rather than as a blocker on it.
