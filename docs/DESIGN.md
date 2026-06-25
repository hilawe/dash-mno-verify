# Design

## The problem

Prove that someone controls a Dash masternode without revealing which one. The proof
must reveal no on-chain address, no key, and no node identity to the people running the
community being gated.

This is an anonymous set-membership problem. The set is the deterministic masternode
list (DML), which is public and on-chain, so it is a trustless membership set. The proof
hides which member signed. The construction is heyanon applied to Dash voting keys: a
Merkle tree of `keyIDVoting` hashes, a zero-knowledge proof of knowledge of the key
behind one leaf, and a nullifier for one-time use.

## Why the voting key

In a DIP-3 registration the owner and voting keys are stored as `hash160` values, while
the operator key is a full BLS public key. The membership set has to be expressible from
public data, and the voting-key hashes already are. The voting key also controls only
governance votes, never funds, so asking a member to prove with it carries no financial
risk. Anchoring on `keyIDVoting` therefore proves "owner or their voting delegate," which
is the right granularity for a social channel. Anchor on `keyIDOwner` instead if you need
the owner specifically.

## The three pieces

1. Oracle. Reads the DML and publishes a Poseidon Merkle root over the voting-key hashes. Public input, deterministic function, so the root is reproducible and a dishonest oracle is publicly detectable.
2. Prover. Runs locally. Proves `Q = d.G`, that `hash160(Q)` is a leaf under the published root, and emits `nullifier = Poseidon(Poseidon(d), epoch, contextHash)`.
3. Gateway. Verifies the proof against the current root, current epoch, the community context, and the one-time challenge, records the nullifier, and returns a grant. Adapters call it and never touch the cryptography.

## The nullifier does three jobs

- Epoch-rotating freshness. One fresh nullifier per epoch. Sell the node and you cannot produce next epoch's proof, so access lapses within one epoch.
- Sybil resistance. For a fixed epoch and context, one key yields one nullifier, so one masternode maps to one membership.
- Cross-context unlinkability. The context hash scopes the nullifier to one platform, community, and role, so the same key produces unrelated nullifiers elsewhere.

## Single-tier versus two-tier

The version in this repo is single-tier: the full proof runs every epoch. It is the
simplest correct design, and a sold node is evicted within one epoch.

If per-epoch proving is too slow, split into two tiers. A one-time-per-season registration
proof does the expensive secp256k1 and hash160 work once and adds a fresh commitment to a
members tree. Per-epoch proofs then become cheap Poseidon-only membership in that tree.
The cost is coarser freshness: because member commitments are unlinkable to nodes, a sold
node cannot be revoked individually, so membership only re-anchors to current ownership at
each season boundary.

## Platform-neutral by construction

The gateway answers one question and returns a yes plus a nullifier. It has no concept of
Discord. Each chat or web platform is a thin adapter that calls the same two endpoints and
maps "verified" to a platform action. The context hash includes the platform string, so
memberships never correlate across platforms.

## The optional Dash Platform contract

`contract/mno-verify.contract.json` defines three document types. The one that earns its
place is `nullifier`, whose unique index on `(epoch, contextHash, nf)` makes Platform
consensus itself reject a double spend, so several gateways can share one tamper-evident
spent set. `dmlRoot` gives every verifier a tamper-evident published root. Platform is an
integrity and availability layer, not a privacy layer: privacy comes entirely from the
zero-knowledge proof, and members never touch a Platform identity.
