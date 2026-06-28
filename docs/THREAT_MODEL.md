# Threat model

## What each party learns

- Community admins and the adapter. They learn a platform identity (for example a Discord user id) and an unlinkable nullifier. They never learn an address, a voting key, or which node.
- The gateway. It learns a per-request nonce and the nullifier. It never learns an address or key.
- The oracle. It reads only public chain data, so it learns nothing private.
- A network eavesdropper. It may learn that a member is verifying, but nothing that links them to a node.

No party links a platform identity to an on-chain address. That is the property the
design exists to provide.

## What the design defends against

- Forged membership. The Merkle root is built from public DML data by a deterministic function, so anyone can recompute it and catch a snapshot whose leaves do not produce its root. Recomputation only proves internal consistency, so the gateway also requires the snapshot to carry a quorum of signatures from pinned oracle keys (`MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`). The signature covers the root, which commits to the leaves, so a host that merely serves the JSON cannot forge a membership set, and running several independent signers means an attacker must compromise the quorum rather than one machine. The gateway refuses to start without pinned keys unless `MNO_ALLOW_UNSIGNED_ORACLE` is set.
- Replay to another account. The challenge nonce is bound to the requesting account, and the proof is bound to the nonce through the signal hash, so a proof for one account does not grant another.
- Sybil and double join. The epoch-and-context nullifier means one masternode voting key maps to one membership per epoch (see the delegation limit below).
- Stale membership. Roots are accepted only within a small recent window, and a fresh proof is required each epoch, so a sold or banned node loses access quickly.

## Known limits, stated plainly

- Oracle trust is a pinned key, not the chain itself. Signed snapshots authenticate the leaf set against trusted oracle keys, so the membership set comes from a key the operator chose to trust, with a quorum to spread that trust. The signature does not yet prove the leaves against the chain's own masternode-list commitment. A fully trustless check would verify the leaves against the on-chain DML commitment (the coinbase `merkleRootMNList`) under verified block headers, so no oracle key is trusted at all. The signed snapshot already carries the block hash, which is the anchor that check would build on.
- Voting key, not collateral. The nullifier binds the masternode voting key the proof controls, not the collateral outpoint. The guarantee is one voting key, one membership, not one collateral, one membership. Masternodes that share a delegated voting key therefore collapse to one membership, and an operator who votes for several nodes with one delegated key gets one membership for all of them. Re-anchoring to the collateral would require the proof to bind the collateral outpoint, a larger circuit change.
- Anonymity set. Privacy is only as large as the eligible set, which is the masternode count, a few thousand. Narrowing eligibility shrinks the set and weakens privacy.
- Timing and metadata. The cryptography hides the address link, not the fact that a member verified at a given time. Batch or delay if on-chain timing correlation is a concern.
- Nullifier griefing. Base Platform contracts use ownership-based writes, not per-type access control. The defense is that the gateway is the only writer and a nullifier is unpredictable until a valid proof is submitted, so it cannot be squatted in advance. Platform enforces uniqueness, the gateway enforces validity, and neither alone is sufficient.
- Key handling. The prover reads the raw voting key locally. It controls no funds, and it never leaves the device, but it is still a key-handling step. A variant that consumes an ECDSA signature instead keeps the key in the wallet at a higher circuit cost, and needs care to make the nullifier deterministic.
- Trusted setup. If the circuit uses Groth16, it needs a per-circuit ceremony. Prefer a transparent setup (PLONK or halo2) for a community tool.

## Before any real deployment

Done: RIPEMD-160 is implemented in-repo and the in-circuit hash160 is validated against the
generator vector on every push. The full `mno_membership.circom` compiles against
circom-ecdsa, and the proving system is PLONK over the public Hermez Powers of Tau, a
transparent universal setup with no per-circuit ceremony. The verification key is committed
and the gateway boots with it.

Still required:

1. Build and distribute the PLONK proving key (about 2 GB) and the circuit wasm to provers.
2. Run the oracle against a real Dash node, and decide single-tier versus two-tier from measured proving time.
