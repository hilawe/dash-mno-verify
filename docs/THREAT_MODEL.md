# Threat model

## What each party learns

- Community admins and the adapter. They learn a platform identity (for example a Discord user id) and an unlinkable nullifier. They never learn an address, a voting key, or which node.
- The gateway. It learns a per-request nonce and the nullifier. It never learns an address or key.
- The oracle. It reads only public chain data, so it learns nothing private.
- A network eavesdropper. It may learn that a member is verifying, but nothing that links them to a node.
- Other members of the server. This depends on the grant mechanism, not the proof. A public grant like a Discord role is visible on a member's profile to anyone in the server, so it reveals that they hold a masternode (though never which one). The Discord adapter's channel grant mode avoids this by adding the member to the private channel with a per-user permission overwrite, which does not show on the public profile. Choose the grant mode for your exposure needs (see `adapters/discord/README.md`).

No party links a platform identity to an on-chain address. That is the property the
design exists to provide.

## What the design defends against

- Forged membership. The Merkle root is built from public DML data by a deterministic function, so anyone can recompute it and catch a snapshot whose leaves do not produce its root. Recomputation only proves internal consistency, so the gateway also requires the snapshot to carry a quorum of signatures from pinned oracle keys (`MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`). The signature covers the root, which commits to the leaves, so a host that merely serves the JSON cannot forge a membership set, and running several independent signers means an attacker must compromise the quorum rather than one machine. The gateway refuses to start without pinned keys unless `MNO_ALLOW_UNSIGNED_ORACLE` is set.
- Replay to another account. The challenge nonce is bound to the requesting account, and the proof is bound to the nonce through the signal hash, so a proof for one account does not grant another.
- Sybil and double join. The epoch-and-context nullifier means one masternode voting key maps to one membership per epoch (see the delegation limit below).
- Stale membership. Roots are accepted only within a small recent window, and a fresh proof is required each epoch. The Discord adapter enforces this on its side with a sweep that revokes access once a member's epoch grant lapses and they have not re-verified, so a sold or banned node loses access rather than keeping a one-time grant forever.

## Known limits, stated plainly

- Oracle trust is a pinned key, not the chain itself. Signed snapshots authenticate the leaf set against trusted oracle keys, so the membership set comes from keys the operator chose to trust, with a quorum to spread that trust across independent signers. The signature does not yet prove the leaves against the chain's own masternode-list commitment. A fully trustless check would verify the leaves against the on-chain DML commitment (the coinbase `merkleRootMNList`) under block headers verified by proof of work or a ChainLock, so no oracle key is trusted at all. That step is substantial for two reasons. The gateway would have to act as a light client, verifying headers or ChainLocks, parsing the coinbase special transaction, and reconstructing the masternode list at a height through the `protx diff` protocol. And the on-chain commitment is a SHA-256 tree over the serialized masternode entries, not the circuit's Poseidon tree over the voting-key hashes, so the two roots are not comparable directly and the on-chain set must be rebuilt and shown to match the proof tree's leaves. The signed snapshot already carries the block hash, which is the anchor that check would build on.
- Voting key, not collateral. The nullifier binds the masternode voting key the proof controls, not the collateral outpoint. The guarantee is one voting key, one membership, not one collateral, one membership. Masternodes that share a delegated voting key therefore collapse to one membership, and an operator who votes for several nodes with one delegated key gets one membership for all of them. Re-anchoring to the collateral would require the proof to bind the collateral outpoint, a larger circuit change.
- Anonymity set. Privacy is only as large as the eligible set, which is the masternode count, a few thousand. Narrowing eligibility shrinks the set and weakens privacy.
- Timing and metadata. The cryptography hides the address link, not the fact that a member verified at a given time. Batch or delay if on-chain timing correlation is a concern.
- Nullifier griefing. Base Platform contracts use ownership-based writes, not per-type access control. The defense is that the gateway is the only writer and a nullifier is unpredictable until a valid proof is submitted, so it cannot be squatted in advance. Platform enforces uniqueness, the gateway enforces validity, and neither alone is sufficient.
- Key handling. The prover reads the raw voting key locally. It controls no funds, and it never leaves the device, but it is still a key-handling step. A variant that consumes an ECDSA signature instead keeps the key in the wallet at a higher circuit cost, and needs care to make the nullifier deterministic.
- Trusted setup. If the circuit uses Groth16, it needs a per-circuit ceremony. Prefer a transparent setup (PLONK or halo2) for a community tool.

## Before any real deployment

Several pieces are already in place. RIPEMD-160 is implemented in-repo and the in-circuit
hash160 is validated against the generator vector on every push. The full
`mno_membership.circom` compiles against circom-ecdsa, and the proving system is PLONK over
the public Hermez Powers of Tau, a transparent universal setup with no per-circuit ceremony.
The verification key is committed and the gateway boots with it. The oracle reads a real Dash
node and signs each snapshot, and the gateway requires a quorum of pinned oracle keys and
fails closed without them. The canonical-scalar constraint closes the nullifier malleability,
and the verifier rejects non-canonical public signals. Adapters authenticate to the gateway,
the verify binds the submitter account, and two-tier registration is durable and season-scoped
with per-context members trees. The pipeline has been exercised on real mainnet data on a
Raspberry Pi.

Four things still remain.

1. A formal third-party security audit. The code has had a careful adversarial self-review, which is not the same as an audit.
2. Hosting for the PLONK proving keys, about 2.3 GB each, so provers can fetch them rather than rebuild them locally. The circuit wasm and the small per-epoch members key are already published.
3. The fully trustless oracle anchor against the chain's own masternode-list commitment, described in the oracle-trust limit above. The oracle is currently trusted as a quorum of pinned keys.
4. The member-side cost. Each member runs the prover locally with a large proving key, which is the main adoption question to settle for a given community.
