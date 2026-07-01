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
produces a multi-gigabyte key. PLONK here uses a universal trusted setup, the public Hermez Powers of
Tau, reused across circuits with no per-circuit ceremony. It is not setup-free, since it is secure only
if one participant in that ceremony was honest, so the problem this document addresses is the key size,
and removing the trusted setup entirely is a separate benefit the STARK option below also brings.

## What already softens it, and what does not

The two-tier design already pays the heavy proof only once per season (registration), then uses a small
35 MB key for the cheap per-epoch proof. Hosting the large key turns "rebuild with circom" into
"download one checksummed file." Proving on the masternode puts the key on hardware the member already
runs. Those make the 2.3 GB a non-issue for a masternode operator, but none of them delete it. The
member still holds the key to make the heavy proof, because the proof must be made with the voting key
under the member's control.

The only thing that removes the 2.3 GB is a smaller circuit, which means a different proving backend.

## The design lever that decides the cost

Before the backend, there is a statement choice that drives the constraint count more than the backend
does. Proving the private-key-to-public-key derivation is a full secp256k1 scalar multiplication, the
dominant cost above, and it is not what accelerated tooling targets. If instead the member signs a
deterministic message (for example the gateway challenge nonce) with the voting key, the statement only
has to verify that signature, which is exactly the operation zkVM precompiles and halo2 chips
accelerate. That can cut the expensive part by an order of magnitude, so it is the first thing to
settle, and it is what keeps the prover memory below in range. It carries two conditions. The signature
has to be deterministic (RFC 6979), or the nullifier has to be derived from a stable value rather than
the signature, so one voting key still yields one nullifier per epoch. And the signing has to be
something a member can do with a standard wallet or Dash RPC. This is the same key-handling tradeoff
the threat model notes, now as a lever for cost, not only for key exposure.

## The options

1. A zero-knowledge virtual machine with a STARK backend (SP1, RISC Zero). Write the membership check as
   a normal Rust program and prove its execution. A STARK has no per-circuit proving key to download and
   no trusted setup. These virtual machines ship accelerated support for secp256k1 and SHA-256, the two
   most expensive parts above, but the prototype has to confirm the exact accelerated operations each
   one exposes, because the acceleration often targets ECDSA verification, key recovery, or generic
   curve operations rather than the private-key-to-public-key scalar multiplication this statement
   needs, and it has to confirm the guest can keep the public key and the hash preimages private. The
   Merkle tree would move from Poseidon to SHA-256 (see the scoping note below), and the nullifier would
   use a standard hash. RIPEMD-160 has no common precompile, so it would run as plain instructions,
   which is acceptable because it hashes only 32 bytes. The real risk to watch is prover memory, not
   disk. A STARK prover over many cycles can want tens of gigabytes of RAM, which on a lightweight
   masternode would be worse than the 2.3 GB disk file it replaces. The signature-based statement above
   is what keeps the cycle count, and so the memory, in range, and the prototype has to measure peak
   prover memory against real masternode hardware and treat exceeding it as this option failing, not a
   detail. Subject to that, this is the least hand-rolled path to a no-large-key proof, and the
   recommended one to prototype first.
2. A hand-written halo2 circuit. Smaller than the current circom circuit, and free of a trusted setup
   only if it uses an inner-product commitment rather than the common KZG commitment, which itself needs
   a universal setup and gives a different verifier cost. It is more work than the virtual machine,
   because the elliptic-curve and hash gadgets are assembled by hand. The mature secp256k1 tooling is an
   ECDSA verification chip, which fits only if the statement is redesigned to consume a signature rather
   than derive the public key from the private key, a design change with its own nullifier-determinism
   care (see the threat model's key-handling limit).
3. A folding scheme (Nova, SuperNova, HyperNova). Folding targets incremental computation over many
   uniform steps, which a one-shot membership proof does not have at the top level. The only repetition
   to exploit is inside the scalar multiplication, the double-and-add loop, so folding helps here only
   if the statement is restructured so that loop is the folded step, a significant redesign, and a
   practical verifier still needs a compression or wrapping step. It has the least off-the-shelf tooling
   for this exact statement, so it is the highest research risk and not a natural fit as written.
4. Optimizing the current circom circuit. Realistic gains are marginal because the non-native secp256k1
   arithmetic is intrinsic to the approach, so this does not reach the goal.

Switching the Merkle hash is not local to the prover. The oracle publishes the DML root, so it has to
publish the matching SHA-256 root. And the cheap per-epoch members proof uses its own Poseidon tree. If
that proof stays in circom it keeps Poseidon, so the two trees would use different hashes during a
partial migration, and if the whole stack moves to the virtual machine both trees and the oracle move
together. Either way it needs compatibility tests that the prover, the gateway, and the oracle agree on
the root.

## Recommendation

Prototype option 1 before committing to any rewrite, in the signature-based form from the design lever
above. A proof of concept implements the membership statement in a virtual machine (verify the member's
signature over the challenge to recover the voting public key, compute `keyIDVoting`, verify the SHA-256
Merkle inclusion, compute the nullifier, bind the challenge signal) and measures the prover-side numbers on a
masternode-class machine, namely the proof time, the peak prover memory, and the proof size, and the
gateway-side numbers, namely the verification time and whether a succinct wrapping step is needed to
keep the gateway fast enough at its request rate. The gateway verifies off-chain, so a larger STARK
proof and a heavier verify are tolerable, and the proof can be wrapped to a succinct SNARK if the raw
verify is too slow, at the cost of reintroducing a wrapper setup. If those numbers are acceptable, the
full work is a replacement of the circom and snarkjs proving layer, not a patch.

## The validation burden

A new circuit has to prove the same statement as the current one, with the same public-signal
semantics (nullifier, root, epoch, context hash, signal hash), or the security properties in the threat
model no longer hold. So a migration needs an equivalence review of the new statement against the
current one, a fresh security audit of the new prover and verifier, and a transition plan. The
transition can run both stacks in parallel during a cutover, or cut over cleanly with a new key tag and
a re-published oracle that uses the matching Merkle hash. A STARK removes the trusted setup entirely, so
on that axis the move is a strict improvement over the current universal-setup PLONK, at the cost of
depending on the virtual machine's own soundness and its accelerated operations.

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
