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

1. Oracle. Reads the DML and publishes a Poseidon Merkle root over the voting-key hashes, alongside the ordered real leaves. Public input, deterministic function, so the root is reproducible. The gateway recomputes the root from the published leaves and rejects any snapshot whose root does not hash from them, which catches an inconsistent or transport-corrupted snapshot. Recomputation only proves internal consistency, so the oracle also signs the snapshot (Ed25519 over the root, height, block hash, depth, and timestamp), and the gateway adopts a snapshot only when a quorum of pinned oracle keys has signed it (`MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`). The signature covers the root, which commits to the leaves, so a host that merely serves the JSON cannot forge a membership set. The gateway fails closed, refusing to start without pinned keys unless `MNO_ALLOW_UNSIGNED_ORACLE` is set. This authenticates the leaf set against a trusted key, not yet against the chain's own masternode-list commitment, which the signed block hash is the anchor for (see the threat model). A URL source must be https, is fetched with a timeout and a streaming size cap, and an accepted root is dropped once its snapshot ages past `MNO_ORACLE_MAX_AGE`.
2. Prover. Runs locally. Proves `Q = d.G`, that `hash160(Q)` is a leaf under the published root, and emits `nullifier = Poseidon(Poseidon(d), epoch, contextHash)`.
3. Gateway. Verifies the proof against the current root, current epoch, the community context, and the one-time challenge, records the nullifier, and returns a grant. The account-bearing endpoints (`/v1/challenge`, `/v1/verify`) require an adapter bearer token (`Authorization: Bearer $MNO_ADAPTER_SECRET`) when that secret is set, so the account is vouched for by a trusted adapter rather than chosen by any HTTP caller, which is what makes the B1 account binding authoritative. The gateway refuses to start without that secret unless `MNO_ALLOW_UNAUTH_GATEWAY=1` is set for local use. `/v1/register` is member-driven and proof-authenticated, so it takes no token; its guards are the registration proof, the once-per-(season, context) registration nullifier, and the rate limit. All request endpoints are rate-limited per client and the pending-challenge map is capped, and the read-only endpoints (`/v1/members`, `/v1/dml`, `/v1/health`) are public. Adapters call the gateway and never touch the cryptography.

## The nullifier does three jobs

- Epoch-rotating freshness. One fresh nullifier per epoch. Sell the node and you cannot produce next epoch's proof, so access lapses within one epoch.
- Sybil resistance. For a fixed epoch and context, one voting key yields one nullifier, so one voting key maps to one membership. The circuit constrains the private key `d` below the secp256k1 group order `n`, so `d` is the canonical scalar in `[0, n)`. Without that, `d` and `d + n` share a public key (the same leaf) but hash to different nullifiers, which would let one node mint two memberships per epoch (review finding M1). The nullifier is derived from `d`, the voting private key, not from the public `hash160(Q)` leaf, so it stays unlinkable to the published leaf set. Because it binds the voting key and not the collateral, masternodes that share a delegated voting key collapse to one membership (see the threat model's delegation limit).
- Cross-context unlinkability. The context hash scopes the nullifier to one platform, community, and role, so the same key produces unrelated nullifiers elsewhere.

## Idempotent grants

The gateway spends the membership nullifier before the adapter applies the grant (a role, an invite, a session). If the adapter dies in between, a naive design strands the member until the next epoch, because the nullifier is already spent. The nullifier store records the account that first spent each tag in the same record as the spend, so that same account can re-verify and re-grant within the epoch. The re-grant still needs a fresh valid proof, so knowing the account is not enough, and a different account that hits the same tag is rejected, so one voting key still maps to one membership per epoch and context. Keeping the spend and the account in one record means there is no second store to fall out of step with the spent set.

The Platform-backed store shares the spent set across gateways but does not persist the account, because writing a platform user id (or anything derived from it) into a public document would link that user to masternode control on-chain, the disclosure this design exists to prevent. So re-grant is a memory-mode property for now. A durable, privacy-preserving claim on Platform (an account commitment under a shared cluster secret, plus a contract field) is a deliberate next step, not a silent default.

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
members keys and exposes `POST /v1/register` (verify a registration proof, then write one
durable record holding the season, context, registration nullifier, and member commitment)
plus `GET /v1/members?context=<hash>` (so a prover can fetch its community's tree and build
its path). There is one members tree per (season, context), each a cache rebuilt from that
bucket's records, so a member registered for one community is absent from another community's
tree and cannot prove there (review finding B2). Each tree survives a gateway restart and
starts empty at each season boundary, which is what forces a sold node to lose access once
its season ends. The per-epoch challenge and verify then run against that context's
members-tree root instead of the DML root. `scripts/two_tier_demo.mjs` runs the whole flow,
register then per-epoch prove, through the real verify functions.

## Platform-neutral by construction

The gateway answers one question and returns a yes plus a nullifier. It has no concept of
Discord. Each chat or web platform is a thin adapter that calls the same two endpoints and
maps "verified" to a platform action. The context hash includes the platform string, so
memberships never correlate across platforms.

## The optional Dash Platform contract

`contract/mno-verify.contract.json` defines four document types. The one that earns its
place is `nullifier`, whose unique index on `(epoch, contextHash, nf)` makes Platform
consensus itself reject a double spend, so several gateways can share one tamper-evident
spent set. `registration` plays the same role for the two-tier flow, with a unique index on
`(season, contextHash, regNullifier)` so one voting key registers once per season and
context, and each gateway rebuilds the members tree from those records. `dmlRoot` gives
every verifier a tamper-evident published root, and `membersRoot` publishes a per-context
members-tree root. Platform is an integrity and availability layer, not a privacy layer.
Privacy comes entirely from the zero-knowledge proof, and members never touch a Platform
identity.
