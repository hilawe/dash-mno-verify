# TODO

Known issues and planned work, in priority order, from a code review of the current state.
This is a working prototype and is not audited. Do not gate anything of real value until at
least the P0 items are done and the system has had an audit.

## P0, the two-tier state model (one redesign, three symptoms)

The two-tier flow keeps the members tree in process memory, built once at startup and never
re-anchored to the current season. These three are the same fix: a durable, season-scoped,
atomically-recorded registration set, with the members tree rebuilt from it. It is a gateway
and state change, not a circuit change, so the committed proving keys stay valid.

- [ ] Season-scope the members tree and the accepted root window. Start a fresh empty tree at each season boundary, so a node that registered in an earlier season cannot keep proving after selling the masternode. Members re-register each season, which re-proves current ownership. (`core/gateway.js`, `core/members_tree.js`)
- [ ] Make registration state durable and shareable. The tree must survive a restart and be identical across gateways. Rebuild it from persisted registration records. Start file-backed, which needs no funded identity, then back it with Dash Platform. (`core/gateway.js`, `core/members_tree.js`, `core/platform_store.js`)
- [ ] Record each registration atomically. Today the registration nullifier is written before the commitment is appended, so a failure in between locks the member out for the season. Use one record holding the season, context hash, registration nullifier, commitment, and index, deduped by a unique index, with the tree rebuilt from records. Add a `registration` document type to the contract with a unique index on (season, contextHash, regNullifier). (`core/verifier.js`, `contract/mno-verify.contract.json`)

## P1, before any non-local or public deployment

- [ ] Idempotent grants. The nullifier is spent before the adapter grants the role, invite, or session, so an adapter failure strands the user until the next epoch. Add a grant record keyed by account, context hash, and epoch, so a re-verify by the same account re-grants instead of failing as already used. (`core/verifier.js`, `core/gateway.js`, adapters)
- [ ] Authenticate and rate-limit the gateway. Anyone who can reach `/v1/verify` or `/v1/register` can force PLONK verification work and fill challenge memory. Add adapter-only shared-secret auth plus rate limiting, and document the local or reverse-proxy expectation. (`core/gateway.js`)
- [ ] Matrix verification in private only. The bot answers `!verify` and accepts pasted proofs in any joined room, so others see the challenge, proof, and nullifier. Restrict it to direct messages or a configured private room. (`adapters/matrix/bot.js`)
- [ ] Fix the "one masternode, one membership" claim. Nullifiers bind to the voting key, not the collateral outpoint, so delegated voting keys collapse into one membership. Either soften the copy to "one voting key, one membership" and note delegation in the threat model, or re-anchor to the collateral. (README, `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, circuits)

## P2, quality

- [ ] Bind the prover's fetched members root to the challenge root, so the challenge root is enforced rather than advisory. (`prover/two_tier.js`)
- [ ] Add size guards before the adapters fetch and parse attached proof files. (`adapters/discord/bot.js`, `adapters/telegram/bot.js`)
- [ ] Use `node:util` parseArgs in the two-tier prover instead of the positional flag parser. (`prover/two_tier.js`)
- [ ] Add `MNO_PLATFORM_IDENTITY_ID` so identity selection is explicit, not the first identity in the wallet. (`core/platform_store.js`, `scripts/register_contract.mjs`)

## P3, docs

- [ ] The README still says the oracle reads `protx list`, but the code uses `masternodelist json`. Update it. (README, `oracle/oracle.js`)
- [ ] The README "what remains" list still includes completed work. Do a consistency pass.

## Solid, do not break

The hash160 path is validated end to end, both the JavaScript vector tests and the in-circuit
RIPEMD160 and hash160 against the secp256k1 generator vector, all in CI. The PLONK members
prove-and-verify loop runs in CI. The oracle matches current Dash Core. Keep these green.

## External blocker

The live Dash Platform write path needs a funded testnet identity and a DAPI seed
configuration (DAPI is the decentralized API that fronts Platform). Once those exist,
`scripts/register_contract.mjs` deploys the contract and the gateway runs with
`MNO_STORE=platform`. Until then the Platform backend is wired and logic-tested but unproven
against live Platform.
