# TODO

Known issues and planned work, in priority order, from a code review of the current state.
This is a working prototype and is not audited. Do not gate anything of real value until at
least the P0 items are done and the system has had an audit.

STARTED, DIRECT NODE MODE ON protx diff (2026-08-02). `oracle/diff_snapshot.js` and
`test/diff_snapshot.test.js` are the block-bound, ChainLock-gated read. NOT WIRED into the oracle CLI
or the gateway yet, deliberately, because the transition below is a decision rather than a detail.

WHAT IT IS WORTH, corrected. An earlier version of this entry said the block-bound check closes the
A to B to A residual. Against an HONEST node it does, which is a real gain over bracketing that could
not detect that case at all. Against a dishonest or buggy node it closes nothing: one server answers
the ChainLock query, `known_block`, `diff.blockHash`, and `mnList`, so it can return matching hashes
with an arbitrary list, and reading the lock first does not stop it choosing both answers. This is a
TRUSTED-NODE read, not a chain-authenticated one, and pinned signer trust is still load-bearing until
the `merkleRootMNList` check exists. That check is what makes the difference, and `protx diff` already
carries the coinbase transaction and merkle branch it needs.

What it does. Reads `getbestchainlock` FIRST so the node cannot pick a block to suit the answer,
refuses if the node reports a lock for a block it does not have, then calls `protx diff 1 <height>` and
REFUSES unless the response's own `blockHash` equals the locked hash. That last check is what closes
the A to B to A read residual documented in `oracle/snapshot.js`: the old read could not detect it at
all, because `masternodelist json` says nothing about which block it describes. Filters on `isValid`,
which is the on-chain committed validity flag and the same set the old read selected with status
ENABLED. Every guard is pinned by a test that fails when the guard is removed.

TWO THINGS NEEDED BEFORE IT CAN BE WIRED.

1. **DONE, the transition window.** The root still changes, but a v2 and a v3 root at one height now
   coexist in the gateway's window instead of the newer replacing the older, so an oracle can switch
   without locking out every prover still holding a tree in the old order. Safe rather than a
   loosening: the two roots commit to the SAME leaf set and differ only in build order, so proving
   against either proves membership in the same set. Bounded by the ordinary window and age rules, so
   a v2 root ages out on its own once the oracle stops publishing them and there is no switch to
   remember to turn off. The window counts HEIGHTS rather than records, so running two orders does not
   halve the accepted history. (`core/stores.js`, `core/gateway.js`, `test/root_windows.test.js`)

   Original statement of the problem, kept because the reasoning still governs anything that touches
   leaf ordering: **the root CHANGES, so this is a breaking transition, not a drop-in.** The old read ordered leaves
   by the collateral outpoint, because that is what keys `masternodelist json`. The collateral outpoint
   is NOT a field of the DIP4 simplified entry, since it is not committed on chain, so it is absent
   from `protx diff`, and the canonical order there is `proRegTxHash`. Aligning with DIP4's own order
   is right, because the eventual `merkleRootMNList` check merkleizes in exactly that order, but the
   same set of masternodes now produces a different root. Snapshots are marked `version: 3` and carry
   `order: "proRegTxHash"` so nothing can treat a v2 and v3 root as interchangeable. The transition
   needs deciding: whether the gateway accepts both during a window, and what a prover holding a v2
   tree does. Nothing is wired until that is settled.
2. **DONE 2026-08-03. The response shape is OBSERVED against live mainnet.** A container node
   (colima, per the project rule that a native `dashd` is a dead end on this Mac) finished its
   reindex and caught up to height 2,515,929, and `oracle/diff_snapshot.js` was run against it end
   to end. It built a real v3 snapshot in 1.3 seconds: 2,972 entries in `mnList`, 2,069 with
   `isValid` true, ordered by `proRegTxHash`, `chainlocked: true`, block hash equal to the
   ChainLock's.

   Every assumption is now measured rather than inferred. `proRegTxHash` is 64 lowercase hex on all
   2,972 entries with no duplicates. `votingAddress` is a string on every entry. `isValid` is a real
   boolean, not a string. `getbestchainlock` returns `blockhash`, `height`, and `known_block: true`,
   the exact shape the builder assumes. The strict boundary checks added over the review rounds
   (typed fields, lowercase hex, boolean validity, duplicate refusal) therefore accept real mainnet
   data, which was not a given: they could as easily have been guesses that refused everything.

   The response also carries `merkleRootMNList`, `cbTx`, and `cbTxMerkleTree`, so the on-chain
   commitment check below has its material in hand.

   STILL TRUE, and not softened by this: one server answered every query, so it remains a
   TRUSTED-NODE read until that commitment check exists. Observing the shape says nothing about
   whether the list is the chain's.

   `MNO_CLI_MAX_BUFFER` IS NOW SETTLED, by measurement rather than reasoning. The full `protx diff`
   response for 2,972 masternodes at height 2,515,929 is 1,828,817 bytes, about 1.74 MiB, against a
   64 MiB default, so roughly 37x headroom. The default was reasoned up from Node's 1 MB and never
   observed failing; it is now observed not failing on a real mainnet list, and the number is
   recorded so a future reader can judge growth rather than re-derive it. Note this is the LARGEST
   form of the call (baseBlock 1, so the whole list rather than a delta).

Once wired, this delivers the P1 (direct node mode, removing pinned-key trust for the common
deployment), closes the read residual, and leaves `protx diff`'s `cbTx` and `cbTxMerkleTree` already in
hand so the on-chain commitment check becomes an increment rather than a separate integration.

OPEN, TWO ITEMS THE RECORD FORMAT CANNOT EXPRESS (2026-08-02). Both came out of the round 12
confirmation as blockers, and both were left rather than patched, because each has already had one
patch fail in a new place and the reason is the same: a grant record holds ONE deadline and ONE target
set, and these need per-target state.

- **A failed orphan revoke can still extend the old target's deadline.** The renewal writes a covering
  record naming both targets with the NEW deadline, revokes the orphan, then writes the final record.
  If the revoke fails, the prior record is restored, which handles the common case. If that restore
  ALSO fails, or the process dies after the covering write, the durable row stays as both targets at
  the new deadline and the old access is extended, with the sweep not firing at the original time to
  retry. The fix needs per-target deadlines and a pending-revoke state, retrying the orphan revocation
  at ITS deadline independently of the new grant. That is a record-schema change.
- **The non-repairing policy covers first grants and not renewals.** `repairs` is opt-in, so an adapter
  without a repair pass gets a compensating revoke when a FIRST grant fails. A renewal that revokes the
  old target and then fails to apply the new one keeps the new record with nothing behind it, and for
  Matrix and Telegram nothing will ever retry. Either the compensating policy extends to migrations, or
  those two adapters get a real stored-record repair pass before they can safely opt in.

These are the same shape as the exclusion gap below: a design the current record format cannot express,
which is why each attempt fails somewhere new. Four consecutive folds introduced blockers, and the two
of those that were patches on this exact machinery are the reason these are written down instead. Pick
them up together, with the confirmation report open, and change the record format once rather than
patching around it a third time.

ANSWERED, THE CHAIN ANCHOR FOR THE SNAPSHOT (2026-08-02). The largest open trust assumption has a
known answer now, confirmed by the Dash Core lead against the consensus code, and it is a design item
rather than a question.

`merkleRootMNList` in the coinbase special transaction IS the canonical commitment, and it is
consensus-enforced: every block connect recomputes the list root and rejects the block on mismatch
(`src/evo/specialtxman.cpp`). It commits the DIP4 SIMPLIFIED masternode list, entries sorted by
`proRegTxHash` and merkleized with the same algorithm as the block transaction merkle root.

Committed: `proRegTxHash`, `confirmedHash`, network addresses, `pubKeyOperator`, `keyIDVoting`,
`isValid`, plus type and Platform fields for evonodes. NOT committed: the owner key, payout scripts,
and the collateral outpoint.

**This project is directly covered.** The leaf is built from `keyIDVoting` (`common/dml.js`,
`oracle/snapshot.js`), which is a committed field, so no ProRegTx inclusion proof is needed. A design
that proved the owner key or collateral ownership instead would also need the ProRegTx, provable by
ordinary transaction merkle inclusion.

The verification chain: recompute the root from the snapshot, compare against `merkleRootMNList`,
prove the coinbase transaction is in the block via its merkle branch, verify the header.
`getmnlistdiff` / the `MNLISTDIFF` P2P message hands over the coinbase transaction plus
`cbTxMerkleTree` pre-packaged. That replaces "a quorum of pinned oracle keys is honest" with "this
block header is on the real chain", pinned by header proof-of-work from a checkpoint, which is the
standard light-client approach.

Foot-guns to design against, all named by the Core lead:

- Entry serialization is VERSION-DEPENDENT. Legacy versus basic BLS `pubKeyOperator` encoding at v19,
  evonode Platform fields, and the newer extended-address netInfo each change the entry hash bytes.
  Byte-exact serialization across versions is where independent implementations usually break. Test
  vectors live in `test/functional/feature_dip4_coinbasemerkleroots.py` in Dash Core.
- The merkle computation inherits the odd-node duplication quirk (CVE-2012-2459). Use the same
  `ComputeMerkleRoot` semantics and reject mutated trees in the inclusion proof.
- `isValid` is part of the commitment. A PoSe-banned node is still IN the list with `isValid=false`,
  so membership alone is not enough. ALREADY HANDLED: `oracle/snapshot.js` filters on
  `status === "ENABLED"`, the same set as `protx list valid`.
- Dropping the header-checkpoint assumption as well needs ChainLock verification, whose quorum keys
  are committed via `merkleRootQuorums` in the same coinbase transaction. That is the full DIP4
  light-client bootstrap and is overkill before a first audit, but it is the path to fully trustless.

What this changes here: the oracle stops being a trusted publisher and becomes a snapshot whose
correctness a verifier can check for itself. `docs/DESIGN.md` currently says the leaf set is
authenticated "against a trusted key, not yet against the chain's own masternode-list commitment", and
that sentence is the thing this work closes.

KNOWN GAP, THE DISCORD ADAPTER CANNOT ENFORCE AN EXCLUSION (2026-08-01). An operator has no way to
keep a specific person out of a gated channel while this bot is granting access to it. Two facts
combine, both verified in the installed `discord.js` 14.26.4 source and both found by reviewers on the
same day the opposite was claimed here:

- A member-level deny is not protectable. `permissionOverwrites.edit()` rebuilds both bitfields from
  its own cache and sends them whole, and Discord has no compare-and-set, so a deny the cache has not
  seen is destroyed by any change the bot makes to that entry.
- A role-level deny does not exclude anybody the bot grants to. `GuildChannel.memberPermissions`
  applies the member overwrite's ALLOW last, after every role deny and role allow, so the bot's own
  grant outranks the exclusion. The role entry survives untouched and simply has no effect.

This file, `CLAUDE.md`, the Discord README, and the code comments briefly claimed role-level denies
were the supported safe mechanism. That was wrong. The mistake was reading "the bot does not edit the
role entry" as "the role entry still has effect". Do not restore that claim.

The only design that can work is an exclusion OWNED BY THE BOT and checked as part of admission,
before it grants and before any repair reapplies from a stored record, rather than expressed in
Discord permissions and hoped to survive. Sketch, not yet built: an operator-managed list of account
ids, durable next to the grant ledger, consulted by `applyAccess` and `repairAccess`, with existing
managed allows taken back when an exclusion is added. It needs its own design pass and its own review,
and it is the one genuinely new feature in the current backlog rather than a bug fix.

Until it exists, this is a documented limitation and not a silent one. It is stated in `CLAUDE.md` as
a security invariant, in the Discord README where operators will look, and above the two mutation
sites in `adapters/discord/permissions.js`.

ROLE MODE HAS BEEN REMOVED (2026-07-30). A verified member is added to the private channel with a
per-user permission overwrite, and that is the only mode. A Discord role is visible on the member's
profile card to everyone in the server, so granting one announced who holds a masternode, which is
the fact this whole construction exists to keep private. It defeated the system by design rather than
by defect, so hardening it further was the wrong answer and it should not have been reachable by
setting one environment variable. One of the round 9 reviewers recommended the same removal
independently, on the ground that Discord offers no compare-and-set for that surface. Removing it also
removed the part of the adapter nobody could verify: every role finding in every review was marked
INFERRED, because no reviewer could execute those semantics and neither can the tests.
`DISCORD_GRANT_MODE=role` and `DISCORD_MNO_ROLE_ID` now refuse to start. Role targets survive in ONE
place on purpose, `npm run discord:decommission -- role:<id>`, so an operator can take back access an
earlier deployment granted, and the bot refuses to start while any role grant remains in the ledger.
Removing a mode must not strand the access it granted.

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

## Testability, the gateway is a module rather than a script (2026-08-04)

- [x] Make `core/gateway.js` importable. It used to open the durable stores, load the verification
  keys, fetch a root, start its intervals, and bind a listening socket as a side effect of being
  imported, so nothing in it could be unit-tested. Every property of a handler had to be proven
  through a spawned process or one level down in the stores, and one test resorted to grepping the
  file's source text for a call it had no other way to observe. That was the root cause behind
  several sessions of weak tests, not a matter of taste.

  The module body is now `createGateway({ config })`, with `node core/gateway.js` still booting and
  listening through an entry-point guard at the foot of the file. The handle owns what the boot
  created: the server (built, not listening), the timers, and the stores. `close()` gives them back,
  and the release list it walks is the same one a FAILED boot walks, so a refusal after the nullifier
  store is open no longer strands an open database with no handle to reach it through. `close()` is
  one memoized teardown shared by every caller, so a second call cannot release the stores while the
  first is still draining requests, and a closed gateway refuses to listen again.

  `core/config.js` is now `buildConfig(env)` and builds nothing at import, so a test can construct a
  fully validated config for a synthetic environment and a malformed ambient setting refuses at boot
  rather than making the import throw. The one setting that escaped the config entirely
  (`MNO_ORACLE_ALLOW_HTTP`, read inside `loadOracle`) is now passed in, since a security-bearing
  exception the supplied config could not control was this change failing quietly. (`core/gateway.js`, `core/config.js`, `core/stores.js`, `core/nullifier_sqlite.js`,
  `core/platform_store.js`, `test/gateway_module.test.js`)

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

- [ ] Back the registration store with Dash Platform so several gateways share one record set, mirroring the `nullifier` backend. The `registration` document type already exists in the contract with the unique index on (season, contextHash, regNullifier). Until this lands, `MNO_MODE=two-tier` with `MNO_STORE=platform` fails loudly at boot rather than running a non-shared store and risking a double grant. Needs a funded testnet identity and DAPI seed config. When this work happens, use the community `dash-platform-sdk` (github.com/pshenmic/dash-platform-sdk) as the JS SDK, per the owner's 2026-07-23 direction, evaluating it against the wired official `dash` package at the same time. It is Platform-only (fine here, the oracle talks to Core directly) and its v1.4.x error handling is happy-path, so wrap its calls defensively. (`core/platform_store.js`, `core/gateway.js`, `scripts/register_contract.mjs`)

## P0, durable per-epoch claims (2026-07-24 review round)

- [x] Durable nullifier and claim storage. DONE for the single-gateway case. `SqliteNullifierStore`
  (`core/nullifier_sqlite.js`, on the Node standard library's `node:sqlite`, so no npm dependency and
  no native build) is now the default `MNO_STORE=sqlite`, keyed `(epoch, context, nf)` with an atomic
  `INSERT ... ON CONFLICT DO NOTHING` as the authority and `synchronous=FULL` so a spend is on disk
  before the caller is told it succeeded. It satisfies the shared store contract, so the verifier is
  unchanged (its `add` already resolved races by re-reading the prior claim). `MNO_STORE=memory` now
  refuses to boot without `MNO_ALLOW_EPHEMERAL_NULLIFIERS=1`, and an unknown store name fails at boot
  instead of falling back. Pruning is wired hourly and keeps the current epoch plus
  `MNO_NULLIFIER_RETAIN_EPOCHS` past ones (floored at 1, because a challenge minted just before a
  rollover is still verified against its own epoch), which closes the unbounded-growth finding. The
  database is 0600 inside a 0700 directory, since it pairs platform accounts with claimed nullifiers.
  The false "memory is fine for one gateway" claims in `docs/PLATFORM.md` and `docs/DEPLOY.md` are
  corrected. 202 tests green, including reopen durability, race-single-winner, prune-window safety,
  and the two boot guards. REMAINING, tracked separately: the account is stored as given rather than
  as a keyed HMAC commitment (the reviewers' suggestion), which is the same work as the P1
  privacy-preserving claim item below and should be done once for both stores; and the multi-gateway
  case still needs the shared Platform backend.
- [ ] (superseded, kept for the design record) Durable nullifier and claim storage. The only bootable two-tier configuration (and default
  single-tier) keeps the per-epoch spent-nullifier set in a process-local `Map`
  (`NullifierStore`, `core/stores.js`), so a gateway restart mid-epoch drops every spend and the
  same member secret can claim a second account in the same epoch, breaking one-membership-per-
  epoch. Registrations are durable; the epoch claims are not. Confirmed independently by two
  full-access reviews, which converged on the same design: a durable local store (SQLite
  preferred over another JSON file, for atomic uniqueness and transactions) with unique key
  `(epoch, contextHash, nullifier)`, an account tag that is a keyed HMAC of (context, account)
  rather than the raw platform id (equality is all re-grant needs), and insert-or-conflict as
  the authoritative operation (the `has()` precheck stays an optimization only). Memory mode
  stays available only behind an explicit `MNO_ALLOW_EPHEMERAL_NULLIFIERS=1`; a non-local
  deployment refuses to boot with ephemeral nullifiers. Fix the false "memory is fine for one
  gateway" claims in `docs/PLATFORM.md` and `docs/DEPLOY.md` when this lands. Tests: spend
  survives reopen, same-account re-grant after reopen, different-account still rejected,
  concurrent inserts one winner, no success before durable commit, corruption fails closed,
  old-epoch pruning, HMAC key rotation keeps the prior key through the active epoch.
  Fold in the same store's UNBOUNDED GROWTH (found independently in the same round): `NullifierStore`
  exposes only has/get/add with no delete or sweep, while its siblings in the same file
  (`ChallengeStore.sweep`, `RateLimiter.sweep`) both bound their maps, so the spent set grows without
  limit for the life of the process (a few thousand members on short epochs is tens of thousands of
  entries per day). The durable design must prune, and the prune window is a correctness boundary,
  not just housekeeping: only epochs older than the accepted-root and re-grant window may be removed,
  because pruning the current epoch reopens exactly the double-claim hole this item exists to close.
  (`core/stores.js`, `core/gateway.js`, `core/config.js`, `docs/PLATFORM.md`, `docs/DEPLOY.md`)

## P1, before any non-local or public deployment

- [x] Close B1, the account relay. The gateway binds the requesting account into the signal hash (`signalHash(nonce, account)` in `common/index.js`), so a proof committed for one account's challenge cannot satisfy another's. `/v1/verify` takes the submitter `account` and rejects with `account-mismatch` unless it equals the account the challenge was minted for, checked before the proof verify and the nullifier spend, so a relayed proof can neither grant the relayer nor burn the real owner's epoch. With `MNO_ADAPTER_SECRET` set (see "Authenticate the gateway" below), only an authenticated adapter can supply that account, so the binding is authoritative and not merely an adapter-relay guard. No circuit change. (`common/index.js`, `core/gateway.js`, all four adapters, `prover/two_tier.js`)
- [x] Idempotent grants. The nullifier store now records the account that first spent each membership tag in the same record as the spend (`NullifierStore` in `core/stores.js`), so the same account can re-verify and re-grant within the epoch if its adapter died after the spend but before applying the grant. The re-grant still needs a fresh valid proof, and a different account hitting the same tag is still rejected, so one voting key still maps to one membership per epoch and context. Keeping the spend and the account in one record (rather than a second grant store) means the two cannot fall out of step, and the property follows the configured store backend. `verifyMembership` reads the prior account from the store's `get()` and gained an injectable `verifyProof` for unit testing (`test/verifier_idempotent.test.js`). The adapters needed no change, because they already apply the grant on `ok`. (`core/stores.js`, `core/verifier.js`, `core/gateway.js`)
- [ ] Durable, privacy-preserving claim on the Platform-backed store. The Platform store shares the spent set across gateways but does not persist the granting account, so re-grant is a memory-mode property and a member whose adapter failed in `MNO_STORE=platform` mode still waits out the epoch. The fix is not to write the raw account: a platform user id (or anything trivially derived from it) in a public document would link that user to masternode control on-chain, the disclosure the design avoids. Persist an account commitment instead (for example `HMAC(cluster-secret, account)` under a secret shared by the operator's gateways, so it is deterministic across them but opaque to the public), add the commitment field to the contract nullifier document, and have `DocumentNullifierStore.get()` return it. This is a deliberate design step (a contract change plus a commitment scheme), so decide it explicitly rather than defaulting it. (`core/platform_store.js`, `contract/mno-verify.contract.json`, `core/gateway.js`)
- [x] Authenticate the gateway (review finding M5). The account-bearing endpoints (`/v1/challenge`, `/v1/verify`) require an adapter bearer token (`Authorization: Bearer $MNO_ADAPTER_SECRET`, compared constant-time) so a direct unauthenticated caller cannot mint a challenge or submit a verify, and the submitted account is vouched for by a trusted adapter (this is what makes B1 authoritative). The gateway fails closed: it refuses to start without the secret unless `MNO_ALLOW_UNAUTH_GATEWAY=1` is set for local use. `/v1/register` is member-driven and proof-authenticated, so it takes no token (guarded by the proof, the registration nullifier, and the rate limit). Per-client rate limiting and the pending-challenge cap remain (`MNO_RATE_*`, `MNO_MAX_PENDING_CHALLENGES`); they bound one source but do not stop a distributed flood, the residual. The reverse-proxy expectation (`MNO_TRUST_PROXY`) is documented at `clientKey`. (`core/gateway.js`, the four adapters, `prover/two_tier.js`)
- [x] Harden the oracle-root path at the gateway (review finding M3, the consistency and freshness half). The gateway recomputes the DML root from the published leaves and rejects a snapshot whose root does not hash from them, requires https for a URL source with a fetch timeout and a streaming size cap, and drops an accepted root once its snapshot ages past `MNO_ORACLE_MAX_AGE`. The age check is on the snapshot's publication timestamp, not chain progress, so it stops a replayed or abandoned snapshot but NOT a live oracle on a stalled Dash node, which can keep re-signing its unchanged root with a fresh timestamp and stay accepted. The chain-progress mitigation is the open direct-node ChainLock item below. This catches a corrupted, inconsistent, or abandoned snapshot, not a compromised or stalled source. (`core/dml_root.js`, `refreshRoots` in `core/gateway.js`, `loadOracle` in `core/stores.js`)
- [x] Authenticate the oracle leaf set (the remaining half of M3). The oracle now signs each snapshot (Ed25519 over root, height, block hash, depth, timestamp; `common/oracle_sig.js`), and the gateway adopts a snapshot only when a quorum of pinned oracle keys has signed it (`MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`), failing closed at boot unless `MNO_ALLOW_UNSIGNED_ORACLE=1`. The signature covers the root, which commits to the leaves, so a host serving the JSON cannot forge a membership set, and a quorum of independent signers means an attacker must compromise several. Signed snapshots must carry a valid 64-hex block hash. The oracle brackets its height, block-hash, and list reads with a height re-check and retries if a block landed mid-read, so the signed block hash and the list it anchors share a tip. Keygen helper `scripts/gen_oracle_key.mjs`; a quorum is built with `scripts/sign_oracle_snapshot.mjs`, which adds a signer's entry to one shared snapshot (recomputing the root first and writing atomically), since independently built snapshots differ by timestamp and would not combine. (`oracle/oracle.js`, `common/oracle_sig.js`, `core/config.js`, `refreshRoots` in `core/gateway.js`, `scripts/sign_oracle_snapshot.mjs`, tests in `test/oracle_sig.test.js` and `test/gateway_http.test.js`)
- [x] Make the oracle snapshot assembly unit-testable, and add a fixture test for the height/list race. The read-and-build lives in `buildSnapshot` (`oracle/snapshot.js`) behind an injectable `call()`, with `oracle/oracle.js` as the thin CLI (source selection, signing, file write). The tree build now goes through the shared `makeDmlRootHasher`, whose equivalence to the full-pad build is pinned by `test/dml_root.test.js`, so the tree code exists once. `test/oracle_snapshot.test.js` pins the race guard (a `getblockcount` moving from `H` to `H+1` across the list read drives a retry and the snapshot comes from the second, consistent bracket), the maxAttempts failure, and the ENABLED-filter, sort, and root-from-leaves behavior. (`oracle/snapshot.js`, `oracle/oracle.js`, `test/oracle_snapshot.test.js`)
- [x] DONE 2026-08-04. Direct node mode, the reframed trust fix (2026-07-23, from community review input on the open chain-anchor question). The gateway operator already runs or trusts a Dash Core node (the oracle requires one, and a dashd follows only the ChainLocked chain, so its masternode list is already protected by the network's strongest reorg guarantee). So let the gateway read the DML from its own trusted node directly, running the snapshot build (`buildSnapshot` in `oracle/snapshot.js`) inline on refresh, and gate the read on ChainLock. The care point (review finding): `masternodelist json` returns the current-tip list, not a historical one, so the gateway cannot simply "read at the last ChainLocked block." The two implementable forms are, first, require the current tip to be ChainLocked before accepting the read (`getbestchainlock` returns the best ChainLock height and hash, so accept the snapshot only when the node's tip equals that hash, otherwise wait and retry, since ChainLocks land within seconds), or second, use the block-bound `protx diff` up to the ChainLocked height and require its self-reported `blockHash` to equal the ChainLock (its output carries `votingAddress` and `isValid`, the fields this build needs). Either removes pinned-oracle-key trust entirely for the common self-hosting case, no signatures, no quorum, no snapshot transport. The first form also closes the A -> B -> A read residual (see the bracket comment in `oracle/snapshot.js`), because a ChainLocked tip cannot be reorged away, while the naive "wait one confirmation" fallback does NOT close it and is not sufficient on its own. The signed-snapshot path stays for split deployments where the gateway cannot reach a trusted node. WIRED as `MNO_DML_SOURCE=node`, using the block-bound `protx diff` form (the second of the two
  implementable forms below). The gateway builds the snapshot itself on each refresh via
  `buildDiffSnapshot`, so nothing is fetched and nothing is signed; everything downstream is
  unchanged, the same validateSnapshot, root recompute, and window. The unsigned-oracle boot refusal
  is now scoped to the snapshot source, since demanding a signature on data nobody published would
  be checking the wrong property. `/v1/health` reports `dmlSource` so an operator can see which
  trust model is running. The node caller is shared with the oracle CLI (`oracle/node_client.js`) so
  the timeout and buffer limits are not re-derived. The oracle CLI also gained `--read block` for
  publishing v3 snapshots. STILL A TRUSTED-NODE READ: one server answers the ChainLock query, the
  block hash, and the list, so it can return matching hashes over an arbitrary set. It becomes
  chain-authenticated only with the merkleRootMNList commitment check.
  (`oracle/snapshot.js`, `oracle/node_client.js`, `core/gateway.js`, `core/config.js`)
- [ ] SPV nodeless verification, demoted to deferred research (was the P1 chain-anchor item). Verifying the leaves against the on-chain `merkleRootMNList` under SPV-verified headers and independently checked ChainLock signatures matters only for a gateway that can neither run nor trust any node, which is a niche deployment, not the common case the clean-room reviews assumed. Keep the analysis (the signed block hash remains the anchor such a check builds on, and `protx diff`'s self-identified block hash remains the block-bound read candidate), but do not spend on it before direct node mode exists. (`oracle/`, `core/gateway.js`)
- [x] Matrix verification in private only. Done: the bot applies the private-room predicate
  (`isPrivateDirectRoomState`, judged against room state as of each message's sync position) to
  commands and pasted proofs, so a proof posted in a non-private room is rejected. The remaining
  usability gap (fresh Matrix DMs often default `history_visibility: "shared"` and fail the strict
  check) is the configured-verification-room P2 item below. (`adapters/matrix/room_privacy.js`,
  `adapters/matrix/bot.js`, `test/matrix_room_privacy.test.js`)
- [x] Member secret and voting-key handling in the two-tier prover (2026-07-24 round, confirmed
  twice). DONE. `prover/secret_file.js` creates the secret with an exclusive
  `open(path, "wx", 0o600)` and fsyncs it BEFORE proving, so a crash during the long registration
  proof cannot lose it. It is recorded `pending` and promoted to `accepted` only after the gateway
  responds, so a re-run resumes that same secret rather than minting one the gateway would reject,
  an accepted file is refused rather than overwritten, and a rejection leaves the file untouched.
  Secrets are named per (platform, community, role, season), and the per-epoch prove locates the
  right one by the challenge's context hash, with the old single filename still honoured so nobody
  who registered earlier is stranded by the rename. `prover/voting_key.js` adds `--voting-key-file`
  (warning when it is group or world readable) and `--voting-key-stdin`, keeps `--voting-key` working
  with a deprecation warning so no member breaks mid-season, and prefers the file over the flag.
  Docs moved to the safer form. 214 tests green, covering never-overwrite, resume-pending,
  accepted-refusal, filename separation, context lookup, and flag precedence. The write-after-response
  alternative stays rejected for the reason recorded below.
  (`prover/secret_file.js`, `prover/voting_key.js`, `prover/two_tier.js`, `prover/prover.js`)
- [ ] (superseded by the entry above, kept for the design record) `prover/two_tier.js` writes `member.secret.json` mode 0644 with a plain overwriting
  `writeFile` BEFORE the `/v1/register` call, so a rejected re-run (same per-season registration
  nullifier) overwrites the accepted secret and strands the member for the season; both provers
  also take the WIF voting key on argv (shell history, process listings). Keep the save before the
  network call (moving it after creates an unrecoverable accepted-but-response-lost case).
  Fix: context-and-season-specific default filename, refuse to overwrite, exclusive
  `open(path, "wx", 0o600)` then write and fsync, store {secret, commitment, contextHash, season,
  status: pending}, mark accepted on success, preserve on rejection or ambiguity, reuse the pending
  secret on retry. Replace `--voting-key <WIF>` with `--voting-key-file` (owner-only permission
  check) or protected stdin; not an env var (visibility varies by OS). One reviewer in the round
  proposed writing the secret only AFTER a successful response instead; rejected deliberately,
  because a gateway that commits while the response is lost then leaves the member with no secret
  at all, the registration nullifier spent for the season, and no recovery (the secret is
  client-side randomness the gateway never sees). Write-before plus exclusive create avoids both
  that and the overwrite bug. (`prover/two_tier.js`, `prover/prover.js`)
- [x] Clock-regression guard (2026-07-24 round). DONE for the period-scoping half. `core/time_guard.js`
  persists the highest epoch and season ever observed (0600, written to a temp file and renamed so a
  crash mid-write cannot truncate the marks away) and every period the gateway derives from the clock
  now goes through it, all ten former `epochNow`/`seasonNow` call sites. A computed value below its
  mark records a sticky regression: `/v1/challenge`, `/v1/verify`, and `/v1/register` answer 503
  `clock-regression`, and `/v1/health` reports `ok: false` with the detail, so readiness is visible
  rather than inferred from failures elsewhere. The read endpoints stay up on purpose so an operator
  can diagnose. Marks are keyed by the configured epoch and season lengths, so changing either
  renumbers the periods and starts fresh instead of reporting a regression that never happened. In
  ephemeral mode (`MNO_STORE=memory`) the marks stay in memory, since there is no durable state to
  protect. `SeasonMembers` gained a `monotonic` option (the gateway sets it) that refuses a backward
  season roll as defense in depth; it is off by default because rebuilding an arbitrary season from
  the durable records is a real property of that class and is worth testing directly. Recovery from a
  far-forward clock jump that was later corrected is to delete the marks file, documented at
  `timeMarksPath` in `core/config.js` and in `docs/DEPLOY.md`. 226 tests green.
  REMAINING (not done here, lower severity): challenge TTL, rate-limit windows, Discord grant sweeps,
  web session expiry, and the oracle age check all still use wall-clock `Date.now()`, so a backward
  step still skews those durations. Move them to a monotonic process clock.
  (`core/time_guard.js`, `core/gateway.js`, `core/season.js`, `core/config.js`)
- [x] Members-tree capacity check before the durable append. DONE. Provenance, corrected after the
  fact: this was FIRST raised on 2026-06-26 as a MAJOR finding ("tree capacity is implicit and
  unchecked", naming both the DML and members trees), and it went unfixed for a month before two
  reviewers in the 2026-07-24 round found it again independently. The DML half had since been closed
  (`common/dml_root.js` refuses a leaf count over capacity, and the gateway validates snapshot leaves
  against it), so the members-tree half was the remainder, and the June finding is now fully closed. `MembersTree` gained `capacity()`/`full()`, `append` throws past capacity, and
  `fromCommitments` refuses an over-capacity record set rather than materializing a deeper tree.
  `SeasonMembers.commit` checks `full()` BEFORE calling `appendDurable`, returning
  `members-tree-full`, so the durable commit point is never written for a registration the tree
  cannot hold (the gateway passes the reason straight through). Both classes take an optional depth
  so the boundary is tested at depth 2 instead of building a 65,536-leaf tree; production uses the
  circuit depth. 233 tests green, including that the power-of-two overflow (the silent
  deeper-tree path) is refused and that the durable write does not run at capacity.
  (`core/members_tree.js`, `core/season.js`)
- [ ] (superseded, kept for the mechanism record) Members-tree capacity, found independently by
  two reviewers; the mechanism below is from tracing the code, and is worse than either described).
  `SeasonMembers.commit` writes the durable record before `tree.append`, and `MembersTree.append` has
  no `2**16` guard. Past capacity the zero-padding loop in `levels()` is skipped, and the failure then
  splits by how far past capacity the bucket is:
  - Odd overflow (the common case, 65,537): the pairwise reduction reaches `poseidon([x, undefined])`
    and throws `TypeError: Cannot convert undefined to a BigInt`. It fails closed, but the durable
    record is already written, so that (season, context) can never be materialized again.
  - Exact power-of-two overflow (131,072): every level length stays even, so `levels()` builds a
    17-level tree with NO error. `root()` returns the depth-17 root while `pathFor` walks only
    `TREE_DEPTH` levels and returns a path to an intermediate node, so the published root is
    unreachable by any path a prover can build and every proof silently fails verification. This
    silent-failure path is the more dangerous of the two.
  Far beyond the current DML size (a few thousand), so exploitability is low, but it violates the
  every-durable-record-materializes invariant and the fix is small. Fix at two layers: check
  `tree.size() < 2 ** TREE_DEPTH` inside the serialized commit BEFORE `appendDurable`, and enforce the
  same per-bucket cap inside the registration store so another caller cannot bypass it. Test
  exactly-at-capacity accept and capacity-plus-one reject at a small parameterized depth, and assert
  the power-of-two case cannot publish a deeper-than-TREE_DEPTH root.
  (`core/season.js`, `core/members_tree.js`, `core/registration_store.js`)
- [x] Telegram and Matrix grant lifecycle (2026-07-24 round). DONE. The Discord ledger's mechanics
  (persist before applying, every operation serialized, atomic replace on save, a failed revoke
  keeping the record so it retries) moved to `adapters/common/grant_ledger.js`, with the record
  validator and the renewal-migration hook injected. Discord re-exports it already carrying its own
  two, so the bot and its 14 tests are unchanged.
  Matrix now records each grant and sweeps it at startup and on an interval, kicking (not banning) a
  member whose epoch lapsed so they can re-verify and be invited again; "already in the room" on
  invite and "not in the room" on kick are treated as success, anything else propagates so the sweep
  retries.
  Telegram's transferable invite link is gone. The gateway binds a proof to one account and the
  adapter used to hand out a bearer link anyone could use; the link now only creates a JOIN REQUEST,
  and `chat_join_request` is approved solely for an account holding a live grant and declined
  otherwise, so a forwarded link grants nobody. The grant is recorded BEFORE the link is issued, so a
  usable link can never exist without a record behind it. Expiry removes the member with a ban
  immediately followed by an unban, which is Telegram's way of removing without leaving a standing
  ban. `allowed_updates` now asks for `chat_join_request`, which grammY does not request by default.
  Both adapters' READMEs document the new permission each needs (Telegram: restrict members; Matrix:
  the kick power level) and the new optional env vars, and the descriptions no longer present either
  as an invite-and-forget gate. 240 tests green, including that a second account is never live under
  another's grant, that a grant survives a restart and is still swept, that a re-verification extends
  rather than being swept, and that a failed revoke retries.
  (`adapters/common/grant_ledger.js`, `adapters/telegram/bot.js`, `adapters/matrix/bot.js`,
  `adapters/discord/grant_ledger.js`)
- [ ] (superseded, kept for the finding record) Telegram and Matrix grant lifecycle. Only Discord enforced epoch expiry
  (durable ledger plus sweep). Telegram converts the account-bound verification into a transferable
  one-use invite link (forwardable, and consumable by a different account) and never removes members;
  Matrix invites the verified account directly but membership survives the epoch. Fix: per-adapter
  durable grant ledger recording the platform user and gateway `expiresAt`, revocation sweep at
  startup and periodically, failed revocations preserved for retry, and for Telegram a join-request
  flow that verifies the joining account before approval instead of a bearer link. Until then, the
  docs must present Telegram and Matrix as protocol demonstrations, not complete access gates.
  (`adapters/telegram/bot.js`, `adapters/matrix/bot.js`, `docs/DEPLOY.md`, README)
- [ ] v2 hash-encoding cutover, operational invariant (2026-07-24 round). The v2 context encoding
  is a different nullifier domain from v1, so a mixed-version deployment treats one community as two
  contexts and one credential can claim in each. Return `hashVersion` in health and challenge
  responses, refuse mixed-version clusters, cut two-tier over at a season boundary, expire or revoke
  old-domain grants, never import v1-context registrations into v2. Also align the non-JS call sites
  and pin cross-language golden vectors for the v2 tuple encoding (colons, quotes and backslashes,
  empty strings, non-ASCII, Unicode supplementary): the RISC Zero bench host still hashes the v1
  string (`research/risc0-registration/host/src/main.rs`), harmless to guest soundness (opaque
  context field) but any future Rust host needs the v2 derivation. (`core/gateway.js`,
  `common/index.js`, `test/`, `research/risc0-registration/host/`)
- [x] Fix the "one masternode, one membership" claim. The copy now reads "one voting key, one membership" in the guarantee statements (README, `docs/DESIGN.md` Sybil resistance, `docs/THREAT_MODEL.md` Sybil/double-join), the threat model gained a "voting key, not collateral" known-limit bullet that states the delegation collapse plainly, and the mechanism comments (`core/stores.js`, `core/verifier.js`, `core/registration_store.js`, and both circuits' nullifier-malleability notes) were swept for consistency. Re-anchoring to the collateral was not done (it would need the proof to bind the collateral outpoint, a larger circuit change) and is recorded as the alternative in the threat model.

## P1, from the 2026-07-25 review rounds

Four multi-model rounds ran over the 2026-07-24/25 work. Rounds 2 and 3 found most of their defects
inside the previous round's fixes, all in the adapter file-and-queue machinery. Round 4 was aimed
instead at the surface no earlier round had read, meaning the code that changed after the round-3
packets were built plus the modules never packaged at all, and seven of its ten findings were in that
never-reviewed set. Its confirmed findings are folded. What follows is what remains.

The standing recommendation, reached independently by two reviewers and unchallenged by round 4, was
to move adapter state to a transactional store rather than keep patching the file-and-queue
machinery, since every round that looked at it found a fresh generation of the same class of defect.
That move is done (the first three items below). The next review round should cover it, and should be
built from the post-migration code rather than from any earlier packet.

- [x] Move adapter grant state to SQLite. DONE. `GrantLedger` is a per-row `node:sqlite` store
  (`DatabaseSync`, no npm dependency, no native build, matching `core/nullifier_sqlite.js`). The
  headline is that it is a correctness change and not only a throughput one: reads and writes are
  synchronous and durable at the point of call, so "observed" and "persisted" are the same instant and
  nothing enqueues a save any more. That deletes the shape every round kept finding defects in, where
  state was updated in memory, the durable write was queued behind the operation doing the updating,
  and a decision reached the caller in between. Locking is now per member rather than one global
  queue, so a slow platform call for one member no longer blocks every other member's grant, and the
  test for that times out rather than failing an assertion if it regresses. Mode 0600 set before WAL,
  `synchronous=FULL` so persist-before-apply means what it says, and `busy_timeout` so two processes
  wait for each other. Supersedes the P1.5 grant-ledger persistence item below.
  (`adapters/common/grant_ledger.js`, `adapters/*/bot.js`)
- [x] Cross-process ledger safety. DONE, but NOT "by construction", which is what this entry claimed
  when the migration landed and what the 2026-07-26 round rejected. SQLite serializes individual
  statements. It does not serialize a grant or a removal, each of which is a statement, then an await
  on a platform call, then another statement. The per-member lock that does span that gap is a promise
  chain in memory, so it binds only the process it lives in. Two processes could therefore interleave a
  removal and a fresh grant for one member, and the sweep's unconditional delete then threw the fresh
  row away and left live access with no record, the exact outcome the lifecycle exists to prevent.
  Two independent reviewers found this, one with a reproduction. The FIRST attempt to close it was a
  hand-rolled lease row with a staleness timeout, and the next round rejected that too. It is worth
  recording why, so nobody rebuilds it: the timeout has to exceed the longest quiet period or a live
  but idle bot loses its ledger (the default sweep intervals, 60s and 300s, were already longer than
  the 30s window); the old owner's next operation silently took the claim back, because refreshes were
  not conditioned on still holding it; a backward wall-clock step made the age negative, which read as
  stale and handed the ledger over; and no adapter released it on shutdown, so the documented immediate
  restart did not exist. Every one of those defects came from having to decide when a claim had gone
  stale.
  Closed instead by not deciding that at all. The database is opened with `PRAGMA
  locking_mode=EXCLUSIVE`, so the kernel holds it for the life of the process and releases it whenever
  the process ends, however it ends. A second process is refused outright. There is no staleness
  window, no heartbeat, no ownership fencing, and no signal handler to forget. Verified by a test that
  spawns a real holder process and is refused while it lives.
  TWO LIMITS, both found by the 2026-07-26 third round and both now stated rather than implied. The
  exclusion is the filesystem's, so it needs local storage; SQLite documents that locking is unreliable
  on network filesystems, where two hosts can both believe they hold it, losing the guarantee and
  risking corruption. And it covers process life only, which is the separate open item below.
  The revision-conditional delete stays as defence in depth, with the revision now drawn from a
  database-wide counter rather than derived from the row. Deriving it from the row restarted it at 1 on
  every insert, so a row could be deleted and reinserted at the same revision and a stale delete would
  match the fresh row anyway. Two reviewers reproduced that independently.
  Shared state itself does work as described: the clock floor is read from the database on every
  observation and raised with a `MAX`. (`adapters/common/grant_ledger.js`)
- [x] The exclusive lock was reported as leaking, and it does not. WITHDRAWN, recorded because the
  episode is instructive. A test written to check that a second process is refused had its holder end
  with `await new Promise(() => {})`, which does not keep Node's event loop alive; the holder printed
  its ready signal and exited with code 13, releasing the lock, and the parent was then admitted. Under
  concurrency that surfaced as an intermittent failure that read as the lock leaking, and the
  diagnostic reported the holder "alive" because `kill(pid, 0)` succeeds on an unreaped zombie. With a
  holder that actually stays alive, and the parent asserting liveness before concluding anything, a
  second opener was refused 90 times out of 90 under six-way concurrency; an independent reviewer had
  already confirmed refusal separately, including with the holder suspended. So the mechanism holds on
  a local filesystem, subject to the two limits below. The lesson is the one the reviews keep teaching
  from the other direction: a test that does not do what its name says will mislead in whichever
  direction it happens to fail, and this one briefly produced a false blocker rather than a false pass.
  (`test/adapter_grant_expiry.test.js`)
- [ ] Access can outlive its record when a process is terminated mid-request (2026-07-26 third round,
  blocker as reported). A process persists a grant, sends the platform request, the platform ACCEPTS
  it, and the process is terminated before the effect lands. The exclusive lock dies with it, a
  replacement starts, finds the grant expired, removes it and deletes the row, and then the original
  request takes effect. Live access with no record, which no later sweep can find. Reproduced by the
  reviewer. This is NOT a regression and no local lock closes it: the holder is gone and the side
  effect is on the platform's servers. It is the one place the non-interleaving property genuinely does
  not hold, and the code, the READMEs, and the handoff now say so instead of implying otherwise.
  The real mitigation is reconciling against actual platform state at startup. Matrix had one and
  Discord now does too (`reconcileGuild` in `adapters/discord/bot.js`): before its first sweep it finds
  every member holding the configured role, or a per-user overwrite on the configured channels, that it
  has no live matching grant for, and takes that access back, refusing to start rather than recording a
  partial pass. SCOPE REDUCED after a THIRD REJECT (2026-07-27), and the reduction is the fix. Every
  blocker across three rounds came from one thing: the bot deciding on its own to delete access in bulk
  on a role or channel it no longer manages, based on a reconstruction of what an earlier configuration
  had been. That produced a pass that skipped itself on ordinary restarts, a role-to-channel switch
  that wedged permanently, and a retired channel that stayed bot-owned so later manual grants were
  stripped. The simple half, checking the CURRENT target, was correct in every round.
  So they are separated. Startup checks the current target every time and never acts on anything else;
  it REPORTS stale targets found in the ledger's records, naming the command. Bulk removal moved to
  `npm run discord:decommission -- <target>`, one target, explicit, with `--dry-run`, run when the
  operator repoints the bot. No marker, no history, no retirement bookkeeping, no intent decision
  before the client exists. (An earlier version of this entry claimed "no path that can wedge"; the
  fifth round found one, where a role id from another guild was persisted into a record that then
  blocked its own repair, so current targets are validated against the guild before startup proceeds.) `parseTargetKey` validates the whole string
  (an earlier version read only the front of it and silently forgot the rest). `readMarker` was deleted
  rather than left as dead code.
  Also: Discord's default grant mode is now `channel`, because a role is visible on the profile card
  and so discloses who holds a masternode, which is the fact the proof protects. Role mode warns at
  startup. Any deployment with a role id and no explicit `DISCORD_GRANT_MODE` is refused until it
  states the mode, and that check deliberately does NOT depend on whether channel ids happen to be
  set; a first version put it inside the no-channel-ids branch, so a deployment carrying an unused
  channel id flipped silently from role to channel mode, taking the proof context with it. (`adapters/discord/bot.js`, `adapters/discord/grant_ledger.js`)
- [ ] The stale-target warning is best effort and cannot be made complete (2026-07-27 fourth round,
  recorded rather than fixed). `staleTargets` reads `ledger.all()`, so it names only targets that
  surviving rows still mention. An old channel holding access that predates the ledger, or whose rows
  have since expired and been swept, produces no warning while the access is still there. Reporting
  only is the right policy, so the fix is honesty rather than more machinery: the README now tells
  operators to decommission on every repoint and says the warning's absence proves nothing, and the
  test says "nothing discoverable" rather than "nothing owed". Revisit only if the ledger ever grows a
  durable record of targets it has ever granted through, which is the same history the rejected designs
  kept getting wrong. (`adapters/discord/grant_ledger.js`)
- [x] Stop reasoning about permission denials the bot does not own (2026-07-29, seventh round on this
  component). Two rounds were spent trying to be careful about a denial a moderator had set: preserve it
  when clearing, refuse to grant over it. Both produced a defect worse than the one they fixed.
  Preserving meant a read-modify-write against a CACHED overwrite, so a denial the cache had not yet
  seen was wiped by the code written to protect it. Refusing to grant over one meant the ledger's
  uncertain-apply cleanup then stripped the member's pre-existing access, so declining to grant took
  access away. The root problem is structural: no compare-and-set exists for a permission surface other
  people edit concurrently, so every careful version was wrong in a new way.
  Resolved by not deciding. Per-member overwrites on a gated channel belong to the bot, it refuses to
  start if it finds one carrying a denial and names the member, and clearing is unconditional and
  therefore correct. Exclusions are expressed with role-level denies. In role mode the configured role
  must be monotonic: ANY denied bit on any channel refuses startup, because adding the role would
  otherwise remove that permission there and removing it would restore it. Not limited to the three
  managed bits; a first version checked only those, which would have caught the reviewer's reproduction
  and missed every other permission.
  Also from that round: admission readiness and cleanup readiness are now separate, so an unreachable
  channel keeps interactions closed without stopping the sweep that revokes expired access (previously
  one bad channel aborted the ready handler before the sweep timer existed); and `isGone` has ONE
  definition, imported by both the bot and the decommission command, because it existed twice and only
  one copy learned discord.js's string error codes.
  (`adapters/discord/grant_ledger.js`, `adapters/discord/bot.js`, `scripts/discord_decommission.mjs`)
- [x] Move the permission-denial guard from startup to each mutation (2026-07-29, eighth round, all four
  reviewers converged). The startup gate covered only the CURRENT, reachable target of ONE process,
  while `revokeAccess` acts on whatever the record names, and the decommission command is a separate
  process operating on a target the bot by definition no longer manages. Three mutation paths were
  reproduced clearing a denial and thereby GRANTING access to an excluded member while reporting
  successful removal. The guard now runs immediately before each mutation and refuses that one mutation,
  keeping the record; a conflicting channel is quarantined rather than exiting the process, which was
  the twin of the readiness split. RESIDUAL, documented not solved: the check reads a cached overwrite,
  so a denial not yet propagated can still be cleared. No compare-and-set exists for Discord
  permissions. (`adapters/discord/bot.js`, `scripts/discord_decommission.mjs`)
- [x] Bind the ledger to one guild. Records carried no guild id, and `isGone` treated
  `GuildChannelUnowned` as "already gone", so after repointing the bot at a different server the sweep
  resolved successfully and DELETED rows for access still live in the old server, which then went
  untracked forever. Caused by the earlier widening of `isGone` that unblocked a stuck renewal.
  `isNotOurs` is now a separate predicate: "cannot act here" is not "nothing to act on". Grants record
  `guildId`, and a foreign record refuses startup naming the old guild. Records predating the field read
  as unknown rather than foreign. (`adapters/discord/grant_ledger.js`, `adapters/discord/bot.js`)
- [x] Stop swallowing transient Discord errors as "target missing". `.catch(() => null)` mapped a 500 or
  a rate limit to "this channel does not exist", which closed admissions until a manual restart: a guard
  causing a larger outage than the blip it reacted to. Only a genuinely gone or foreign target counts;
  anything else propagates so the supervisor retries. (`adapters/discord/bot.js`)
- [x] The decommission command validates its target and preflights both branches. A typo'd channel id
  reported success because `10003` was treated as harmless, and neither branch checked denials. Role
  removal now refuses when the role denies anything anywhere, since removing it would hand those
  permissions back. (`scripts/discord_decommission.mjs`)
- [ ] A startup check cannot catch a platform effect that lands after it (2026-07-27 third round,
  major, reproduced). The bot records a grant, Discord ACCEPTS the request, the bot is terminated
  before the effect appears, the replacement's startup check sees no access, its sweep deletes the
  expired row, and the effect then lands. That member holds access nothing tracks. The startup pass
  narrows this window but cannot close it, because it is a snapshot. The README now says so rather than
  implying the pass covers the case fully. Options: re-run the current-target check periodically rather
  than only at startup (cheap, since it reads channel overwrites and role mode is gone), or keep a
  tombstone for a revoked grant and re-check it after a convergence window. The periodic re-check is
  the simpler of the two and would also catch access an admin adds by hand.
  (`adapters/discord/bot.js`)
- [ ] Warn when the ledger is on a filesystem whose locking cannot be trusted. The exclusive lock is
  only as good as the filesystem's, and an operator can point `*_GRANTS_DB` at anything. A startup
  check that the path is not a network mount, or at minimum a logged warning, would turn a silent loss
  of the guarantee into a visible one. Documented as a requirement for now.
  (`adapters/common/grant_ledger.js`)
- [x] One clock sample per decision (2026-07-26 round, blocker). The clock was sampled twice per
  decision, once to persist it and once to decide on it, and real time can cross an expiry boundary
  between the two. The adapter could refuse an admission on the strength of a reading it had never
  recorded, and a later start with a lower clock then found a floor one tick short of what it had
  already acted on and let the expired grant back in. That is the same "acted on state that was not
  durable" shape the SQLite move was meant to end, surviving in the one place with two observations
  rather than one. `#observeClock()` now returns its sample and every decision uses that exact value.
  Pinned by a test written as the invariant rather than the mechanism: once the ledger has reported a
  grant dead, no restart at any clock may report it live again. (`adapters/common/grant_ledger.js`)
- [x] Concurrent first-start migration (2026-07-26 round, minor). Two processes could both import the
  legacy file, both commit, and the second then fail on a rename whose source the first had already
  moved. A missing source is now treated as already done rather than as a startup failure. The
  exclusive lock above now prevents both reaching it at all. (`adapters/common/grant_ledger.js`)
- [x] Migrate existing deployments off the JSON ledger. DONE. Each adapter passes its old JSON path as
  `importFrom`; on a fresh database that file's grants and clock state are adopted in one transaction,
  and only after it commits is the file renamed with a `.migrated` suffix, so an interrupted migration
  leaves the database untouched and the operator never loses their only copy. A malformed record fails
  the migration whole rather than adopting part of it. The database path is `*_GRANTS_DB` /
  `*_GRANT_LEDGER_DB`; the old variables keep their old meaning as the import source.
- [ ] Prevention, not just recovery, for an implausible forward clock jump. The floor is conservative
  by design and an operator-driven reset gets out of it, but nothing refuses an obviously wrong jump
  at the moment it is observed. A bound on plausible movement between observations would stop the
  floor being poisoned in the first place. (`adapters/common/grant_ledger.js`, `core/time_guard.js`)
- [ ] A model-based crash harness. The durability arguments across the ledger, the registration store,
  the member secret, and now the oracle snapshot are each pinned by hand-written tests at the specific
  points a review happened to name. A harness that interrupts at every write boundary and asserts the
  recovered state is always one of the legal ones would cover the boundaries nobody thought to name.
- [ ] Mixed `hashVersion` clusters. Gateways in one cluster that disagree on the hash version have no
  defined behavior. Decide whether to refuse the mismatch or to negotiate, then pin it.
  (`core/gateway.js`, `common/index.js`)

Residuals left by the round-4 fold, none of them blocking:

- [ ] Confirm the `dash-cli` read buffer against a real node. `execFileSync` defaults to 1 MB and a
  mainnet masternode list in JSON is several times that, so `MNO_CLI_MAX_BUFFER` (64 MB) was added
  alongside the read timeout. This is reasoning from the default, not an observed failure, so it needs
  one run against a full node to confirm the old limit was actually being hit. (`oracle/oracle.js`)
- [ ] Matrix and Telegram now validate that every ledger record names its room or chat, because their
  revoke acts on the recorded target rather than the configured one. A ledger file written before that
  change fails startup with "fix or remove it". Correct, since such a record cannot be revoked
  accurately, but it is a breaking upgrade for an existing deployment and belongs in release notes.
  (`adapters/matrix/bot.js`, `adapters/telegram/bot.js`)
- [ ] Web adapter sessions are in-memory and unsigned, which the file has always said is
  reference-grade rather than production-grade. A lapsed session is now deleted on first sight so a
  backward clock cannot revive it, but that is a mitigation, not the persisted high-water floor the
  chat adapters keep. A real gate wants signed, persisted sessions. (`adapters/web/server.js`)

## P1.5, release hygiene (2026-07-24 round;

- [ ] Bind the prover's fetched members root to the challenge root, so the challenge root is enforced rather than advisory. (`prover/two_tier.js`)
- [ ] Add size guards before the adapters fetch and parse attached proof files. (`adapters/discord/bot.js`, `adapters/telegram/bot.js`)
- [ ] Discord channel-mode preflight on `ready`. Fetch the configured grant channels (or role) once and fail clearly if any is missing or the bot cannot edit its overwrites, so a bad channel id, a deleted role, or a missing permission fails at startup instead of after a member burns a challenge and gets a partial grant. (`adapters/discord/bot.js`)
- [ ] Discord startup grant reconciliation. On `ready`, re-apply non-expired ledger records so the deliberate persist-before-apply path heals after a crash between the save and the apply (the ledger would otherwise claim access that Discord never received until the member re-verifies). Re-applying a role or overwrite is idempotent, so this is safe; confirm with one test. (`adapters/discord/bot.js`, `adapters/discord/grant_ledger.js`)
- [ ] (superseded by "Move adapter grant state to SQLite" in the 2026-07-25 P1 section above, kept for the intermediate option and the test note) Grant ledger persistence at scale. The `GrantLedger` serializes every operation on one queue and rewrites the whole map JSON per change, which head-of-line-blocks unrelated grants behind a slow platform call and does not scale. The right fix is a per-row store (SQLite, native file locking, no whole-map rewrite), which also removes the serialization the JSON rewrite forces. An intermediate is per-user ordering around the platform calls plus a global lock only on the mutate-and-persist section. Also inject the `rename` step (like `writeFileFn`) so the atomic-replace failure path is tested. The ledger moved out of the Discord adapter and is now shared. (`adapters/common/grant_ledger.js`)
- [ ] Use `node:util` parseArgs in the two-tier prover instead of the positional flag parser. (`prover/two_tier.js`)
- [ ] Use an incremental Merkle tree for the members trees, so a registration is O(log n) instead of rebuilding a full 2**16 tree, and bound the number of cached per-context trees per season (an LRU or a per-season cap). Per-context trees (B2) made each registration build its own tree, so the full-rebuild cost now scales with the number of active communities. The unauthenticated denial-of-service path is already closed (an empty context serves the shared empty root without building), so this is a throughput and footprint improvement, not a security fix. (`core/season.js`, `core/members_tree.js`)
- [ ] Pull the oracle snapshot lifecycle (load, validate, canonicalize, recompute, freshness, monotonic-height) behind one `SnapshotStore` boundary, with a `parseSnapshot` that returns canonically-typed `{ height, depth, ts, root, leaves }`. This removes the validate-here, recompute-there, store-raw split in `core/gateway.js` and makes snapshot handling unit-testable without booting the gateway. (`core/gateway.js`)
- [ ] Support a configured trusted-proxy hop count for the rate-limit client key, so a multi-proxy chain resolves the real client instead of assuming a single trusted reverse proxy. (`clientKey` in `core/gateway.js`)
- [ ] Per-adapter bearer tokens instead of one global `MNO_ADAPTER_SECRET`: a small map of token hash to allowed `platform`, rejecting a mismatched platform claim before challenge creation, so a leaked Telegram token cannot mint Discord or web challenges. (`core/gateway.js`, `core/config.js`)
- [ ] Candidate hardening, a public transparency log of accepted DML roots and spent nullifier commitments. An append-only, publicly readable log of every root the gateway accepted and every membership tag it spent would let members audit what the gateway did without learning who is behind any nullifier, since the tags are already unlinkable to nodes and accounts and publishing them discloses nothing new. A gateway that adopted a forged root or granted access outside the spent set would leave visible evidence, which shrinks what a compromised operator can do quietly. The idea came out of the clean-room design exercise, proposed in an independent greenfield design by a different model, and exists in neither the implementation nor the docs, so it needs a design pass (where the log lives, who serves it, whether the Platform `dmlRoot` and `nullifier` documents already cover part of it) before it becomes a work item. (`core/gateway.js`, `core/stores.js`, `contract/mno-verify.contract.json`)
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
- [ ] Supply-chain and licensing (2026-07-24 round), a release-punch-list item, not a soundness one.
  `npm audit --omit=optional` reports highs through `snarkjs` and a vulnerable `ws` pulled via the
  `circomlibjs` chain (reachability from the production gateway not yet analyzed); triage and pin.
  Pin GitHub Actions by commit SHA and checksum downloaded tools. Settle the license position:
  `circom-ecdsa` is GPL-3.0 and the repo is presented as MIT, while the distributed compiled
  artifacts (wasm, R1CS, proving keys) incorporate it, so state a clear license analysis before
  distributing them. (`package.json`, `.github/workflows/`, `keys.manifest.json`, `LICENSE`)
- [ ] Platform schema migration (2026-07-24 round), fold into the P0-follow-up Platform backend work
  rather than treating that item as only a missing backend. The contract is behind the implementation:
  the `registration` document lacks the `engine` and `statement` fields, `membersRoot` is unique by
  season only (not context-scoped), registration ordering is not context-scoped, and `dmlRoot` cannot
  express the dual-root v2 snapshot (shaRoot, block hash, timestamp, version, signatures, leaves).
  Migrate the schema alongside the backend, the query path, the rebuild logic, and testnet proof.
  (`contract/mno-verify.contract.json`, `core/platform_store.js`)

## P3, ergonomics

- [ ] Let `/v1/members` accept `platform`, `community`, and `role` and hash the context server-side, as an alternative to the raw `context` param, so a client need not compute the context hash itself. (`core/gateway.js`)
- [ ] Member-facing gateway URL for the two-tier prove instructions. The adapters fill in their `MNO_GATEWAY_URL` for the `--gateway` value they show members, which is correct when members reach the gateway at the same address. For a split deployment (adapter on an internal address, members on a public one) add an `MNO_PUBLIC_GATEWAY_URL` the adapters prefer for member-facing copy. (`adapters/*`)
- [ ] On a registration-store load, warn if a record's stored `index` does not match its position within the (season, context) bucket. After B2 the index is per-context; old per-season files still load correctly (the prover uses commitment order, not the stored index), so this is an upgrade-clarity check, not a fix. (`core/registration_store.js`)

## Research, the member-side proving cost

- [ ] Remove the 2.3 GB proving key at the source. Hosting the key and proving on the masternode make it a non-issue for an operator, but the durable fix is a smaller or structure-free circuit. The 2.3 GB is three bundled costs, the proof system (a structured-key SNARK has a per-circuit key), the arithmetization (the stale `circom-ecdsa` non-native emulation, most of the constraint count), and the statement (derive the key vs verify a signature, a smaller and backend-dependent factor). The dominant avoidable cost is the arithmetization-and-proof-system combination, not the statement, so a lookup-modernized SNARK, a STARK virtual machine, folding, a purpose-built Spartan-style secp256k1 prover, or a linkable ring signature are all candidates. Run one ablation-first Phase 0 benchmark rather than committing to a backend up front. Gate everything on peak prover memory for the once-per-season registration proof on masternode-class hardware (the acceptance bar was tightened on 2026-07-23 to fitting an 8 GB machine, superseding the original above-12-GB-on-16-GB failure line, see the gate section of the cost doc for both versions), and measure every candidate against the null baseline of just hosting the current key. Full analysis, the candidate set, the statement joint-optimization (prover cost vs nullifier soundness vs key hygiene), the no-forced-hash-migration and no-in-circuit-bridge finding, and the validation burden are in `docs/REDUCING_PROVING_COST.md`. Run as a parallel research track, not a deploy blocker. REFRAME (2026-07-24 round): the cost framing understates the second reason this work matters. `circom-ecdsa` is explicitly unaudited demonstration code per its own README, so replacing it (the zkVM path) or commissioning a constraint audit is a DEPLOYMENT BLOCKER for any mode that ships a key-bearing Circom proof, independent of cost. The zkVM integration resolves this for the two-tier registration proof only; single-tier still rides `circom-ecdsa` and needs its own resolution (audit, replacement, or a documented demo-only status) before any deployment that gates real value.
  - [x] Feasibility gate for the ring-signature candidate, answered, not feasible over the full set. The DML commits the voting key as `hash160(pubkey)`, not as an elliptic-curve point, and a ring needs the points. The points are recoverable only from proposal-vote ECDSA signatures (Dash validates a vote by recovering the key and checking its `hash160`), so only for masternodes that have voted, a partial and shifting subset, and a member that publishes its point to enlarge the ring is de-anonymized through `hash160` matching. Proving membership against `hash160` commitments is instead a zero-knowledge preimage-plus-inclusion proof, which is the SNARK path, so the ring candidate collapses into it rather than beating it. Downgrade it, keep only if a restricted voters-only anonymity set is ever acceptable. (`oracle/oracle.js`)
  - [x] RISC Zero registration prototype, at `research/risc0-registration/`. Built, aligned to RISC Zero 3.0.5, and run on CI (x86_64), measuring three statement variants. The results and the decision they produced (derive-the-key chosen, the 9.6 GB wallet-custody variants rejected) are recorded in `docs/REDUCING_PROVING_COST.md`, Phase 0 results. (`research/risc0-registration/`)
  - [x] Confirm the derive variant under an enforced 8 GB memory cap. Done 2026-07-23 as the bench workflow's final step (`systemd-run` `MemoryMax=8G` swap off): the proof completed in 4:56 at a 4,804,780 kB peak with zero major page faults, so the 8 GB fit is demonstrated for the prover alone. Recorded in the gate section of the cost doc. A representative run beside a busy Dash Core, and the wrap step if the integration picks a wrapped receipt, remain unmeasured. (`.github/workflows/risc0-registration-bench.yml`, `docs/REDUCING_PROVING_COST.md`)
  - [ ] Integrate the zkVM registration path per `docs/ZKVM_INTEGRATION.md`. Settled: two-tier retained, the zkVM receipt replaces only `mno_registration`, an engine-neutral claims object (the SHA-256 root cannot ride the BN254 `publicSignals` array), a pinned SHA-256 tree spec, a dual-root v2 signed snapshot with a deployment-scoped downgrade rule, circomlib-compatible Poseidon as a hard prerequisite (cross-engine nullifier identity), and a durable per-(season, context) engine declaration with season-boundary cutover. Receipt path DECIDED 2026-07-23 (owner): the unwrapped STARK receipt, keeping the no-trusted-setup property, with a non-JavaScript verifier (checksum-pinned subprocess or WASM) in the gateway, a raised `MNO_MAX`, and a binary receipt upload as the accepted costs. Statement fit DECIDED: derive at `segment_limit_po2 = 19` fits an 8 GB machine (4.8 GB measured under the cap, about 86 min). Steps 1 through 3 (protocol bytes and Poseidon vectors, guest v2, receipt-path measurement) are done in `research/` and the bench; steps 4 onward are the shipping integration. (`docs/ZKVM_INTEGRATION.md`, `research/risc0-registration/`, then `oracle/`, `common/oracle_sig.js`, `core/verifier.js`, `core/gateway.js`)
  - [ ] Commit the Cargo.lock files for the research workspace (root, host, guest) so the RISC Zero benchmark builds are reproducible with `--locked`. The `.gitignore` already permits them and the CI records versions, but generating a lockfile needs a local cargo run (no Rust toolchain in-session). Do this from a machine with the toolchain, then restore `--locked` in the two workflows. (`research/risc0-registration/`, `.github/workflows/`)
  - [ ] Registration proof lease (`MNO_REG_PROOF_MAX_AGE`), the root-freshness fix for a long proof (design in `docs/ZKVM_INTEGRATION.md`, "Root freshness against a long proof", from the review round). The registration statement takes about 77 minutes to prove, which can outlast the oracle recency window, so the challenge binds an issuance time and the gateway accepts a registration within a lease covering proving, queueing, and one retry, with the accepted-root window sized to the lease and the stale-ownership exposure stated as one lease bounded by season re-registration. Registration-only; the per-epoch proof keeps its short window. (`core/gateway.js`, `core/config.js`, `core/verifier.js`)

## P3, docs

- [x] The README said the oracle reads `protx list`, but the code uses `masternodelist json`. Updated, along with the repo-layout lines (five circuits, four adapters, both provers). (README)
- [x] The README "what remains" list included completed work. Rewritten to the two real remainders (key hosting with the non-promoting rebuild path named, and the operational hardening left in `TODO.md`), pointing here for the full list. (README)

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
