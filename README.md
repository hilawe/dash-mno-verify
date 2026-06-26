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
- `docs/` the design writeup and the threat model.

## Status

Early and experimental, but the hardest correctness question is settled. RIPEMD-160 is implemented in-repo, and the full in-circuit hash160 is validated against a known vector on every push by the CI `circuits` job (also runnable with `scripts/check_circuits.sh`), so the in-circuit leaf provably equals the off-chain one.

What remains before gating anything of value:

1. Wire `circom-ecdsa` into the build so the full single-tier `mno_membership.circom` compiles end to end. The in-circuit hash160 it depends on is already validated.
2. Use a transparent trusted setup (PLONK or halo2), or run a proper Groth16 ceremony.
3. Confirm the public-signal order against the compiled `public.json` and keep `core/verifier.js` in sync.

## Quickstart

```bash
npm install

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

## License

MIT. See `LICENSE`.
