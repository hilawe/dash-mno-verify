# dash-mno-verify

Anonymous proof that someone controls a Dash masternode, for gating private communities.

A member proves the statement "I control one of the masternodes in the current Dash network" without revealing which one. No address, no key, and no node identity reaches the people running the community. The proof is a zero-knowledge (ZK) set-membership proof anchored to the public deterministic masternode list (DML), with an epoch-rotating nullifier so one masternode maps to one membership and access lapses when the node is sold.

## This is not a Discord bot

The privacy core has nothing to do with any one chat platform. It is a verification gateway that answers a single question, "does this person control a masternode," and returns a yes plus an unlinkable nullifier. Discord is just the first adapter. Telegram, Matrix, a web gate, or a token-gated site are the same gateway with a different thin adapter in front. Anything Discord-specific lives in `adapters/discord/` and nowhere else.

## How it works

Three independent pieces, none of which ever sees a member's address or key.

1. The oracle (`oracle/`) reads the public DML from a Dash Core node and publishes a Merkle root over the set of `keyIDVoting` hashes. Its input and its function are both public and deterministic, so anyone can recompute the root and catch a dishonest oracle.
2. The prover (`prover/`) runs on the member's own machine. It takes the member's voting key and the published root, and produces a ZK proof. The key never leaves the device, and the output proof carries no secret.
3. The gateway (`core/`) verifies a proof against the current root, the current epoch, the community context, and a one-time challenge, then records the nullifier and returns a grant. Adapters call it over two HTTP endpoints and never touch the cryptography.

```
Dash chain ──▶ oracle ──▶ (Merkle root) ──▶ prover (user device) ──▶ ZK proof ──▶ gateway ──▶ adapter grants access
                                  │                                                    │
                                  └────────────── Dash Platform contract (optional) ───┘
                                                  root + nullifier documents
```

## Who learns what

| Party | Discord or platform id | Address or voting key | "A valid node proved" | Which node |
|-------|------------------------|-----------------------|-----------------------|------------|
| Community admins, the adapter | yes | no | yes | no |
| The gateway | a per-request nonce | no | yes, as a nullifier | no |
| The oracle | no | no (public data only) | no | no |

No party links a platform identity to an on-chain address. That is the property the whole design exists to provide.

## Repo layout

- `oracle/` reads `protx list` and emits the Merkle root over voting keys.
- `circuits/` the Circom membership circuit and its build notes.
- `core/` the platform-neutral verification gateway (challenge plus verify).
- `adapters/discord/` the first platform adapter.
- `prover/` the client-side proof generator that runs on the member's machine.
- `contract/` an optional Dash Platform data contract for decentralizing the root and nullifier state.
- `docs/` the design writeup, the threat model, and proving-key distribution.

## Status

Early but runnable end to end. The full single-tier `mno_membership.circom` compiles (about 174k constraints) against `circom-ecdsa`, fetched as an external build dependency by `scripts/setup_circom_ecdsa.sh`. The proving system is PLONK over the public Hermez Powers of Tau, a transparent universal setup with no per-circuit ceremony. The verification key is committed, so the gateway boots out of the box.

The CI `circuits` job compiles every circuit on each push, the full membership circuit included, and validates the in-circuit hash160 against a known vector, so the in-circuit leaf provably equals the off-chain one.

What remains before gating anything of value:

1. Build or distribute the PLONK proving key and the circuit wasm to provers. The key is reproducible from public inputs with `scripts/build_proving_key.sh`, which checks the rebuilt key against the committed verification key, so it does not need hosting. See `docs/PROVING_KEY.md`.
2. Harden the operational pieces: run the oracle against a real Dash node, and move the root and nullifier state onto the Platform contract if you want several gateways to share it. The single-tier versus two-tier choice is now measured (about 63x faster per-epoch with two-tier, 6.7s versus minutes) and both are wired, so pick `MNO_MODE` per deployment.

## Quickstart

```bash
npm install                          # add --omit=optional for an oracle/gateway-only install

# 1) publish a root from a synced Dash Core node
npm run oracle                       # writes oracle/root.json

# 2) run the verification gateway
npm run gateway                      # listens on :8787

# 3) run a platform adapter (Discord shown here)
npm run bot

# a member, on their own machine, turns a challenge into a proof
npm run prove -- --challenge challenge.json --voting-key <WIF>
```

Compiling the circuit and producing the proving and verification keys is a separate step documented in `circuits/README.md`.

## Documentation

To actually run this, start with **`docs/DEPLOY.md`**, the front-to-back guide for an
operator standing up a gated community and for a member getting into one. The deeper
references:

- `docs/DESIGN.md` and `docs/THREAT_MODEL.md`: how it works, and what it does and does not protect.
- `docs/run_on_your_node.md`: pointing the oracle at your own Dash node.
- `circuits/README.md` and `docs/PROVING_KEY.md`: building and distributing the circuit keys.
- `docs/PLATFORM.md`: sharing the spent set across gateways on Dash Platform.
- `adapters/README.md` and `prover/README.md`: the platform adapters and the provers.

## License

MIT. See `LICENSE`.
