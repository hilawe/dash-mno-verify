# TODO

Known issues and planned work, in priority order, from a code review of the current state.
This is a working prototype and is not audited. Do not gate anything of real value until at
least the P0 items are done and the system has had an audit.

The full adversarial review of 2026-06-26 is the source of truth, committed at
`REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md`. The open pre-deploy blockers it raises are account
binding (B1, the proof binds to the nonce, not the requesting account) and context-scoped members
roots (B2, one registration grants every community in a season). Both change the committed proving
and verification keys, so they are held for the owner to decide the anchor choices before any
re-setup. A skipped test in `test/gateway_http.test.js` documents B1 in the suite.

## P0, the two-tier state model (one redesign, three symptoms)

The two-tier flow now keeps a durable, season-scoped, atomically-recorded registration set,
with the members tree rebuilt from it. This was one fix across three symptoms. It is a gateway
and state change, not a circuit change, so the committed proving keys stay valid. Done
file-backed, which needs no funded identity. The shared Dash Platform backend is the remaining
follow-up below.

- [x] Season-scope the members tree and the accepted root window. A fresh empty tree starts at each season boundary and stale-season roots stop being accepted, so a node that registered in an earlier season cannot keep proving after selling the masternode. Members re-register each season, which re-proves current ownership. (`SeasonMembers` in `core/season.js`, used by `core/gateway.js`)
- [x] Make registration state durable. The tree survives a restart because it is rebuilt from persisted records, so a restart no longer strands every member. File-backed now (`FileBackend` in `core/registration_store.js`). The shared cross-gateway Platform backend is the follow-up below.
- [x] Record each registration atomically. One durable record holds the season, context hash, registration nullifier, commitment, and index, deduped by a unique key, so a crash can no longer spend the nullifier without recording the commitment. (`core/verifier.js`, `core/registration_store.js`, the `registration` type in `contract/mno-verify.contract.json`)
- [x] Close the season-rollover race (review finding M2). Rollovers and member commits run on one serialized queue in `SeasonMembers`, and a commit re-checks the season before it appends, so a rollover during the proof verify can never publish a stale-season root or append to a stale tree. The durable write and the tree mirror happen together inside that section, so the durable index and the leaf position are always assigned in step. The proof verify stays outside the queue, so it never stalls challenges and per-epoch verifies. (`core/season.js`, `core/verifier.js`, `core/gateway.js`)

### P0 follow-up, the shared Dash Platform registration backend

- [ ] Back the registration store with Dash Platform so several gateways share one record set, mirroring the `nullifier` backend. The `registration` document type already exists in the contract with the unique index on (season, contextHash, regNullifier). Until this lands, `MNO_MODE=two-tier` with `MNO_STORE=platform` fails loudly at boot rather than running a non-shared store and risking a double grant. Needs a funded testnet identity and DAPI seed config. (`core/platform_store.js`, `core/gateway.js`, `scripts/register_contract.mjs`)

## P1, before any non-local or public deployment

- [ ] Idempotent grants. The nullifier is spent before the adapter grants the role, invite, or session, so an adapter failure strands the user until the next epoch. Add a grant record keyed by account, context hash, and epoch, so a re-verify by the same account re-grants instead of failing as already used. (`core/verifier.js`, `core/gateway.js`, adapters)
- [ ] Authenticate the gateway (the remaining half of review finding M5). Per-client rate limiting on `/v1/challenge`, `/v1/verify`, and `/v1/register`, plus a pending-challenge cap, are now in place (`RateLimiter` in `core/stores.js`, the `MNO_RATE_*` and `MNO_MAX_PENDING_CHALLENGES` knobs), which bounds what one source can spend but does not stop a distributed flood or vouch for the submitting account. Add adapter-only shared-secret auth so the `account` is authenticated rather than caller-supplied (this also closes the supply side of B1), and document the reverse-proxy expectation (`MNO_TRUST_PROXY`). (`core/gateway.js`)
- [x] Harden the oracle-root path at the gateway (review finding M3, the consistency and freshness half). The gateway recomputes the DML root from the published leaves and rejects a snapshot whose root does not hash from them, requires https for a URL source with a fetch timeout and a streaming size cap, and drops an accepted root once its snapshot ages past `MNO_ORACLE_MAX_AGE` (so a stalled, replayed, or inconsistent source stops admitting members). This catches a corrupted or inconsistent snapshot, not a compromised source. (`core/dml_root.js`, `refreshRoots` in `core/gateway.js`, `loadOracle` in `core/stores.js`)
- [ ] Authenticate the oracle leaf set (the remaining half of M3). Recomputing the root from leaves that come from the same snapshot does not stop a compromised source from publishing a forged but self-consistent `{leaves, root}` over an attacker-chosen masternode set, which `/v1/challenge` would then serve. Authenticate the leaves against Dash Core directly, a signature over the root, or Platform-published data, so the gateway trusts the membership set and not just its internal consistency. This same authentication is what would let a genuine reorg be told apart from a replay. The gateway currently rejects any lower-height snapshot (the safe default, which self-heals within `MNO_ORACLE_MAX_AGE`), and a signed block hash would let a real chain reset be adopted at once. (`refreshRoots` in `core/gateway.js`, `oracle/oracle.js`)
- [ ] Matrix verification in private only. The bot answers `!verify` and accepts pasted proofs in any joined room, so others see the challenge, proof, and nullifier. Restrict it to direct messages or a configured private room. (`adapters/matrix/bot.js`)
- [ ] Fix the "one masternode, one membership" claim. Nullifiers bind to the voting key, not the collateral outpoint, so delegated voting keys collapse into one membership. Either soften the copy to "one voting key, one membership" and note delegation in the threat model, or re-anchor to the collateral. (README, `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, circuits)

## P2, quality

- [ ] Bind the prover's fetched members root to the challenge root, so the challenge root is enforced rather than advisory. (`prover/two_tier.js`)
- [ ] Add size guards before the adapters fetch and parse attached proof files. (`adapters/discord/bot.js`, `adapters/telegram/bot.js`)
- [ ] Use `node:util` parseArgs in the two-tier prover instead of the positional flag parser. (`prover/two_tier.js`)
- [ ] Pull the oracle snapshot lifecycle (load, validate, canonicalize, recompute, freshness, monotonic-height) behind one `SnapshotStore` boundary, with a `parseSnapshot` that returns canonically-typed `{ height, depth, ts, root, leaves }`. This removes the validate-here, recompute-there, store-raw split in `core/gateway.js` and makes snapshot handling unit-testable without booting the gateway. (`core/gateway.js`)
- [ ] Support a configured trusted-proxy hop count for the rate-limit client key, so a multi-proxy chain resolves the real client instead of assuming a single trusted reverse proxy. (`clientKey` in `core/gateway.js`)
- [ ] Return a `Retry-After` hint on a 429 so adapters can back off cleanly instead of treating every rate-limit response the same. (`core/gateway.js`, `RateLimiter` in `core/stores.js`)
- [ ] Add `MNO_PLATFORM_IDENTITY_ID` so identity selection is explicit, not the first identity in the wallet. (`core/platform_store.js`, `scripts/register_contract.mjs`)

## P3, docs

- [ ] The README still says the oracle reads `protx list`, but the code uses `masternodelist json`. Update it. (README, `oracle/oracle.js`)
- [ ] The README "what remains" list still includes completed work. Do a consistency pass.

## Testing

- The Node suite (`npm test`) covers the stores, the season machinery, and the gateway's
  negative paths. `test/season_rollover.test.js` pins the season scoping and the rollover
  serialization (M2). `test/gateway_http.test.js` boots the real gateway on a loopback port and
  asserts the policy-layer rejections (missing fields, unknown nonce, replay, tampered public
  signals, expired nonce) that run before any proof verify, the M3 oracle-trust rejections (a
  root that does not match its leaves, a stale snapshot), and the M5 guards (per-client challenge
  rate limit, pending-challenge cap), plus a skipped test documenting B1.
- `test/dml_root.test.js` pins the load-bearing M3 invariant: the gateway's fast root recompute
  produces the same root as the full-pad build the oracle and `MembersTree` use.
- The circuit checks and a real PLONK members prove-and-verify run in CI via
  `scripts/check_circuits.sh` and `scripts/prove_members.sh`.

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
