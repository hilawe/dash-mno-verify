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

The single-tier design runs the full proof every epoch. It is the simplest correct design,
and a sold node is evicted within one epoch.

The reason to split into two tiers is proving cost. Measured on a 16 GB laptop, the
single-tier membership proof takes minutes (the PLONK proving key is about 2.3 GB to load
and the circuit is roughly 174k constraints), while the cheap members proof takes about 7
seconds. When proving runs on a member's own machine every epoch, that gap is the whole
argument. The two-tier flow does the expensive secp256k1 and hash160 work once per season
in a registration proof that adds a fresh commitment to a members tree, then every epoch
runs only a Poseidon-only membership proof in that tree. The cost is coarser freshness:
because member commitments are unlinkable to nodes, a sold node cannot be revoked
individually, so membership re-anchors to current ownership only at each season boundary.

Both tiers are wired. With `MNO_MODE=two-tier` the gateway loads the registration and
members keys, keeps a members tree, and exposes `POST /v1/register` (verify a registration
proof, append the commitment) plus `GET /v1/members` (so a prover can fetch the tree and
build its path). The per-epoch challenge and verify then run against the members-tree root
instead of the DML root. `scripts/two_tier_demo.mjs` runs the whole flow, register then
per-epoch prove, through the real verify functions.

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
