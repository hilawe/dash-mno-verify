# TODO

Known issues and planned work, in priority order, from a code review of the current state.
This is a working prototype and is not audited. Do not gate anything of real value until at
least the P0 items are done and the system has had an audit.

The full adversarial review of 2026-06-26 is the source of truth, committed at
`REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md`. The B1 relay path (a valid proof relayed by a
stranger granted the stranger) is closed for the supported adapter flow: the gateway binds the
requesting account into the signal hash the proof commits to, and `/v1/verify` rejects with
`account-mismatch`, before the proof verify and nullifier spend, unless the submitted account equals
the one the challenge was minted for. Both account values are still adapter-supplied, so this closes
the relay through the adapters but is not yet an authoritative gateway identity boundary against a
direct unauthenticated HTTP caller. Making it authoritative needs adapter-to-gateway authentication
(the "Authenticate the gateway" P1 item, which also derives the account from the authenticated
adapter). None of this needs a circuit change, because the signal hash is a public input mixed
outside the circuit. B2 (one registration grants every community in a season) is fixed gateway-side
with one members tree per (season, context). M1 (the nullifier was malleable under a non-canonical
private key) is fixed in the circuits: both `mno_membership` and `mno_registration` now constrain
`d < n` (the secp256k1 group order), so `d + n` is rejected and one node yields one nullifier per
epoch. The proving and verification keys were regenerated for the new constraint
(`scripts/rebuild_proving_keys.sh`), and `check_circuits.sh` fails if a key `>= n` is ever accepted
again.

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
- [x] Context-scope the members tree (review finding B2). There is one members tree per (season, contextHash), not one per season, so a member registered for one community is absent from another community's tree and cannot prove there. The registration store indexes records per (season, context), the gateway serves a per-context root from `/v1/challenge`, `/v1/verify`, and `GET /v1/members?context=`, and the prover fetches its own context's tree. A gateway and state change, no circuit change, so the committed keys stay valid. (`core/season.js`, `core/registration_store.js`, `core/gateway.js`, `prover/two_tier.js`)

### P0 follow-up, the shared Dash Platform registration backend

- [ ] Back the registration store with Dash Platform so several gateways share one record set, mirroring the `nullifier` backend. The `registration` document type already exists in the contract with the unique index on (season, contextHash, regNullifier). Until this lands, `MNO_MODE=two-tier` with `MNO_STORE=platform` fails loudly at boot rather than running a non-shared store and risking a double grant. Needs a funded testnet identity and DAPI seed config. (`core/platform_store.js`, `core/gateway.js`, `scripts/register_contract.mjs`)

## P1, before any non-local or public deployment

- [x] Close B1, the account relay. The gateway binds the requesting account into the signal hash (`signalHash(nonce, account)` in `common/index.js`), so a proof committed for one account's challenge cannot satisfy another's. `/v1/verify` takes the submitter `account` and rejects with `account-mismatch` unless it equals the account the challenge was minted for, checked before the proof verify and the nullifier spend, so a relayed proof can neither grant the relayer nor burn the real owner's epoch. With `MNO_ADAPTER_SECRET` set (see "Authenticate the gateway" below), only an authenticated adapter can supply that account, so the binding is authoritative and not merely an adapter-relay guard. No circuit change. (`common/index.js`, `core/gateway.js`, all four adapters, `prover/two_tier.js`)
- [x] Idempotent grants. The nullifier store now records the account that first spent each membership tag in the same record as the spend (`NullifierStore` in `core/stores.js`), so the same account can re-verify and re-grant within the epoch if its adapter died after the spend but before applying the grant. The re-grant still needs a fresh valid proof, and a different account hitting the same tag is still rejected, so one voting key still maps to one membership per epoch and context. Keeping the spend and the account in one record (rather than a second grant store) means the two cannot fall out of step, and the property follows the configured store backend. `verifyMembership` reads the prior account from the store's `get()` and gained an injectable `verifyProof` for unit testing (`test/verifier_idempotent.test.js`). The adapters needed no change, because they already apply the grant on `ok`. (`core/stores.js`, `core/verifier.js`, `core/gateway.js`)
- [ ] Durable, privacy-preserving claim on the Platform-backed store. The Platform store shares the spent set across gateways but does not persist the granting account, so re-grant is a memory-mode property and a member whose adapter failed in `MNO_STORE=platform` mode still waits out the epoch. The fix is not to write the raw account: a platform user id (or anything trivially derived from it) in a public document would link that user to masternode control on-chain, the disclosure the design avoids. Persist an account commitment instead (for example `HMAC(cluster-secret, account)` under a secret shared by the operator's gateways, so it is deterministic across them but opaque to the public), add the commitment field to the contract nullifier document, and have `DocumentNullifierStore.get()` return it. This is a deliberate design step (a contract change plus a commitment scheme), so decide it explicitly rather than defaulting it. (`core/platform_store.js`, `contract/mno-verify.contract.json`, `core/gateway.js`)
- [x] Authenticate the gateway (review finding M5). The account-bearing endpoints (`/v1/challenge`, `/v1/verify`) require an adapter bearer token (`Authorization: Bearer $MNO_ADAPTER_SECRET`, compared constant-time) so a direct unauthenticated caller cannot mint a challenge or submit a verify, and the submitted account is vouched for by a trusted adapter (this is what makes B1 authoritative). The gateway fails closed: it refuses to start without the secret unless `MNO_ALLOW_UNAUTH_GATEWAY=1` is set for local use. `/v1/register` is member-driven and proof-authenticated, so it takes no token (guarded by the proof, the registration nullifier, and the rate limit). Per-client rate limiting and the pending-challenge cap remain (`MNO_RATE_*`, `MNO_MAX_PENDING_CHALLENGES`); they bound one source but do not stop a distributed flood, the residual. The reverse-proxy expectation (`MNO_TRUST_PROXY`) is documented at `clientKey`. (`core/gateway.js`, the four adapters, `prover/two_tier.js`)
- [x] Harden the oracle-root path at the gateway (review finding M3, the consistency and freshness half). The gateway recomputes the DML root from the published leaves and rejects a snapshot whose root does not hash from them, requires https for a URL source with a fetch timeout and a streaming size cap, and drops an accepted root once its snapshot ages past `MNO_ORACLE_MAX_AGE` (so a stalled, replayed, or inconsistent source stops admitting members). This catches a corrupted or inconsistent snapshot, not a compromised source. (`core/dml_root.js`, `refreshRoots` in `core/gateway.js`, `loadOracle` in `core/stores.js`)
- [x] Authenticate the oracle leaf set (the remaining half of M3). The oracle now signs each snapshot (Ed25519 over root, height, block hash, depth, timestamp; `common/oracle_sig.js`), and the gateway adopts a snapshot only when a quorum of pinned oracle keys has signed it (`MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`), failing closed at boot unless `MNO_ALLOW_UNSIGNED_ORACLE=1`. The signature covers the root, which commits to the leaves, so a host serving the JSON cannot forge a membership set, and a quorum of independent signers means an attacker must compromise several. Signed snapshots must carry a valid 64-hex block hash. The oracle brackets its height, block-hash, and list reads with a height re-check and retries if a block landed mid-read, so the signed block hash and the list it anchors share a tip. Keygen helper `scripts/gen_oracle_key.mjs`; a quorum is built with `scripts/sign_oracle_snapshot.mjs`, which adds a signer's entry to one shared snapshot (recomputing the root first and writing atomically), since independently built snapshots differ by timestamp and would not combine. (`oracle/oracle.js`, `common/oracle_sig.js`, `core/config.js`, `refreshRoots` in `core/gateway.js`, `scripts/sign_oracle_snapshot.mjs`, tests in `test/oracle_sig.test.js` and `test/gateway_http.test.js`)
- [ ] Make the oracle snapshot assembly unit-testable, and add a fixture test for the height/list race. Factor the read-and-build out of the top-level script behind an injectable `call()`, then assert that a `getblockcount` returning `H` on the first call and `H+1` after the list read drives the retry. The race guard is in place; this would pin it before the SPV chain-anchor step. (`oracle/oracle.js`, `test/`)
- [ ] Anchor the oracle to the chain itself (the trustless step beyond signed snapshots). Signing authenticates the leaf set against a pinned oracle key, not against Dash's own masternode-list commitment, so a compromised quorum of oracle keys could still forge. Verify the leaves against the on-chain `merkleRootMNList` (the coinbase special transaction) under SPV-verified block headers, so no oracle key need be trusted. The signed block hash is the anchor that check builds on, and it is also what would let a genuine reorg be told apart from a replayed lower height (the gateway currently rejects any lower height, the safe default that self-heals within `MNO_ORACLE_MAX_AGE`). (`oracle/oracle.js`, `core/gateway.js`)
- [ ] Matrix verification in private only. The bot answers `!verify` and accepts pasted proofs in any joined room, so others see the challenge, proof, and nullifier. Restrict it to direct messages or a configured private room. (`adapters/matrix/bot.js`)
- [x] Fix the "one masternode, one membership" claim. The copy now reads "one voting key, one membership" in the guarantee statements (README, `docs/DESIGN.md` Sybil resistance, `docs/THREAT_MODEL.md` Sybil/double-join), the threat model gained a "voting key, not collateral" known-limit bullet that states the delegation collapse plainly, and the mechanism comments (`core/stores.js`, `core/verifier.js`, `core/registration_store.js`, and both circuits' nullifier-malleability notes) were swept for consistency. Re-anchoring to the collateral was not done (it would need the proof to bind the collateral outpoint, a larger circuit change) and is recorded as the alternative in the threat model.

## P2, quality

- [ ] Bind the prover's fetched members root to the challenge root, so the challenge root is enforced rather than advisory. (`prover/two_tier.js`)
- [ ] Add size guards before the adapters fetch and parse attached proof files. (`adapters/discord/bot.js`, `adapters/telegram/bot.js`)
- [ ] Discord channel-mode preflight on `ready`. Fetch the configured grant channels (or role) once and fail clearly if any is missing or the bot cannot edit its overwrites, so a bad channel id, a deleted role, or a missing permission fails at startup instead of after a member burns a challenge and gets a partial grant. (`adapters/discord/bot.js`)
- [ ] Discord startup grant reconciliation. On `ready`, re-apply non-expired ledger records so the deliberate persist-before-apply path heals after a crash between the save and the apply (the ledger would otherwise claim access that Discord never received until the member re-verifies). Re-applying a role or overwrite is idempotent, so this is safe; confirm with one test. (`adapters/discord/bot.js`, `adapters/discord/grant_ledger.js`)
- [ ] Grant ledger persistence at scale. The `GrantLedger` serializes every operation on one queue and rewrites the whole map JSON per change, which head-of-line-blocks unrelated grants behind a slow Discord call and does not scale. The right fix is a per-row store (SQLite, native file locking, no whole-map rewrite), which also removes the serialization the JSON rewrite forces. An intermediate is per-user ordering around the Discord calls plus a global lock only on the mutate-and-persist section. Also inject the `rename` step (like `writeFileFn`) so the atomic-replace failure path is tested. (`adapters/discord/grant_ledger.js`)
- [ ] Use `node:util` parseArgs in the two-tier prover instead of the positional flag parser. (`prover/two_tier.js`)
- [ ] Use an incremental Merkle tree for the members trees, so a registration is O(log n) instead of rebuilding a full 2**16 tree, and bound the number of cached per-context trees per season (an LRU or a per-season cap). Per-context trees (B2) made each registration build its own tree, so the full-rebuild cost now scales with the number of active communities. The unauthenticated denial-of-service path is already closed (an empty context serves the shared empty root without building), so this is a throughput and footprint improvement, not a security fix. (`core/season.js`, `core/members_tree.js`)
- [ ] Pull the oracle snapshot lifecycle (load, validate, canonicalize, recompute, freshness, monotonic-height) behind one `SnapshotStore` boundary, with a `parseSnapshot` that returns canonically-typed `{ height, depth, ts, root, leaves }`. This removes the validate-here, recompute-there, store-raw split in `core/gateway.js` and makes snapshot handling unit-testable without booting the gateway. (`core/gateway.js`)
- [ ] Support a configured trusted-proxy hop count for the rate-limit client key, so a multi-proxy chain resolves the real client instead of assuming a single trusted reverse proxy. (`clientKey` in `core/gateway.js`)
- [ ] Per-adapter bearer tokens instead of one global `MNO_ADAPTER_SECRET`: a small map of token hash to allowed `platform`, rejecting a mismatched platform claim before challenge creation, so a leaked Telegram token cannot mint Discord or web challenges. (`core/gateway.js`, `core/config.js`)
- [ ] Add a tokened adapter-path integration test: boot the gateway with `MNO_ADAPTER_SECRET`, boot the web adapter with the same secret, and assert its challenge call succeeds while a raw tokenless gateway call fails. Catches the wiring the quickstart risks. (`test/`)
- [ ] HTTP-level verify success and re-grant test. The `/v1/verify` success path (including the idempotent re-grant and its `regranted` response field) is only covered at the unit level (`verifyMembership`), because the gateway has no way to accept a stub proof. Add an injectable proof verifier to `startGateway` (test-only) so a gateway test can drive `/v1/challenge` then `/v1/verify` and assert the success and re-grant response shapes, catching response-shape or account-normalization drift above the unit level. (`core/gateway.js`, `test/`)
- [ ] Extract the Matrix `/sync` batch handling into a pure helper that takes a `RoomStateTracker` and a sync room payload and yields the messages to handle, so limited-timeline, state-before-timeline, and leave-cleanup behavior can be tested without booting the bot. The privacy predicate and the tracker are already unit-tested, so this covers the sync-loop glue. (`adapters/matrix/`, `test/`)
- [ ] Configured Matrix verification room. The `isPrivateDirectRoom` check requires `history_visibility: "joined"`, but a freshly created Matrix direct chat often defaults to `"shared"`, so the strict check fails closed on many real DMs and the member has to change a room setting. Accept an optional `MATRIX_VERIFY_ROOM` (or a small allowlist) that the operator sets up once as a private room, used as a deterministic path with the dynamic direct-room check as the fallback. Document the joined-history requirement in the adapter README setup. (`adapters/matrix/`)
- [x] Close the Matrix time-of-check drift. The adapter now keeps a `RoomStateTracker` fed from every `/sync` batch (the per-room `state` section, then state events interleaved in the timeline) and judges each message against the room state as of that message's position, not a live read afterward. `isPrivateDirectRoomState` is a pure predicate over that snapshot, so it is unit-tested directly, including the regression where a proof posted while a third member was present is rejected even though that member leaves before the next message. This also removed the three Client-Server API reads per message. (`adapters/matrix/room_privacy.js`, `adapters/matrix/bot.js`, `test/matrix_room_privacy.test.js`)
- [x] Make the adapter prove instructions mode-aware. `/v1/challenge` returns `mode`, and a shared `proveInstructions(mode)` helper renders the single-tier (`npm run prove -- --voting-key`) or two-tier (`npm run prove-epoch -- --challenge ... --secret`, with the once-per-season register note) command. The four adapters use it (the web adapter via the server side, so the page shows the right command without duplicating logic). (`common/index.js`, `core/gateway.js`, the four adapters)
- [ ] Return a `Retry-After` hint on a 429 so adapters can back off cleanly instead of treating every rate-limit response the same. (`core/gateway.js`, `RateLimiter` in `core/stores.js`)
- [ ] Generate `keys.manifest.json` from the built artifacts (compute each `sha256` and byte size, refuse to leave stale entries) so a circuit rebuild cannot silently drift the manifest from the hosted wasms. (`scripts/`, `keys.manifest.json`)
- [ ] Factor the canonical-scalar check (`get_secp256k1_order` + `BigLessThan` + `dlt.out === 1`) into a shared `Secp256k1CanonicalScalar(n, k)` circom template used by both key-bearing circuits, so the M1 invariant cannot be applied to one circuit but not the other. Changes the r1cs, so it needs a key re-setup. (`circuits/`)
- [ ] Add `MNO_PLATFORM_IDENTITY_ID` so identity selection is explicit, not the first identity in the wallet. (`core/platform_store.js`, `scripts/register_contract.mjs`)

## P3, ergonomics

- [ ] Let `/v1/members` accept `platform`, `community`, and `role` and hash the context server-side, as an alternative to the raw `context` param, so a client need not compute the context hash itself. (`core/gateway.js`)
- [ ] Member-facing gateway URL for the two-tier prove instructions. The adapters fill in their `MNO_GATEWAY_URL` for the `--gateway` value they show members, which is correct when members reach the gateway at the same address. For a split deployment (adapter on an internal address, members on a public one) add an `MNO_PUBLIC_GATEWAY_URL` the adapters prefer for member-facing copy. (`adapters/*`)
- [ ] On a registration-store load, warn if a record's stored `index` does not match its position within the (season, context) bucket. After B2 the index is per-context; old per-season files still load correctly (the prover uses commitment order, not the stored index), so this is an upgrade-clarity check, not a fix. (`core/registration_store.js`)

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
