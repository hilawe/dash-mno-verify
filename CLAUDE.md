# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. AGENTS.md is a symlink to
this file so a Codex review shares the same context.

## What this is

An anonymous proof that someone controls a Dash masternode, used to gate access to a private
community without revealing which masternode or which address. The proof is zero-knowledge (ZK):
the verifier learns only a one-time nonce and an unlinkable nullifier, never the voting key, the
collateral, the address, or which node proved.

A platform-neutral verification gateway exposes HTTP endpoints. Four adapters (Discord, Telegram,
Matrix, web) speak to it. An oracle reads the deterministic masternode list (DML) from Dash Core and
publishes a Merkle root the proofs are checked against. Read docs/DESIGN.md and docs/DEPLOY.md first.

Status: working prototype, validated on real mainnet data, not audited. Do not gate anything of value
until the blockers in REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md are closed.

## Module layout

- `oracle/` reads the masternode list (`masternodelist json` from Dash Core) and builds the DML tree.
- `circuits/` the five circom circuits. hash160, Merkle inclusion, the Semaphore-style signal binding,
  the single-tier membership circuit, and the two-tier registration and members circuits.
- `prover/` the proving CLIs, single-tier (`prover.js`) and two-tier (`two_tier.js`).
- `core/` the gateway and its state.
  - `gateway.js` the HTTP server and request handlers. IMPORTING IT BOOTS NOTHING: the module exports
    `createGateway({ config })`, and `node core/gateway.js` boots and listens through an entry-point
    guard at the foot of the file. The returned handle owns the server (built, not listening), the
    timers, and the stores. `close()` gives them back, walking the same release list a failed boot
    walks. Tests drive it in-process (`test/gateway_module.test.js`) rather than spawning it.
  - `verifier.js` the policy checks plus the PLONK proof check. `verifyMembership` and
    `verifyRegistration`.
  - `stores.js` the in-memory root, nullifier, and challenge stores.
  - `registration_store.js` durable, season-scoped registration records (file or memory backend),
    the atomic commit point for a two-tier registration.
  - `season.js` `SeasonMembers`, the season-scoped members tree (a cache rebuilt from records) and
    the serialization that closes the season-rollover race.
  - `members_tree.js` the Poseidon members tree. The root is maintained INCREMENTALLY by a frontier,
    and a rebuild from durable records is one carry-stack pass. `levels()`/`pathFor()` still do the
    full padded build and are the only expensive path; the gateway never calls them.
  - `platform_store.js` the Dash Platform nullifier backend for sharing state across gateways.
- `adapters/` the four platform front ends.
- `contract/` the Dash Platform data contract (nullifier and registration document types).
- `common/` shared encoding (context hash, signal hash, epoch and season math, DML leaf).

## Two proving designs

- Single tier (`MNO_MODE=single`). One proof per epoch proves DML membership directly. Heavier per
  use, no registration step.
- Two tier (`MNO_MODE=two-tier`). A heavy seasonal registration proves masternode control once and
  emits a member commitment, then a cheap per-epoch proof shows membership in the members tree.

`MNO_STORE` selects the nullifier backend: `sqlite` (the DEFAULT, durable, single gateway),
`memory` (ephemeral, opt-in via `MNO_ALLOW_EPHEMERAL_NULLIFIERS`), or `platform` (shared across
gateways, and currently refuses to start unless `MNO_PLATFORM_ASSUME_SCHEDULE` names this gateway's
exact schedule). `core/config.js` holds every tunable, all read from `MNO_*` environment variables
through `buildConfig(env)`, which a test can call with a synthetic environment. NOTHING IS BUILT AT
IMPORT: `createGateway()` reads `process.env` when it is called, so a malformed setting refuses at
boot rather than making an import throw.

Settings a deployment MUST attend to, because two of them refuse to boot:

- `MNO_REGISTER_CONTEXTS`, the context hashes this gateway accepts registrations for. Two-tier mode
  REFUSES to start without it, or without `MNO_ALLOW_ANY_REGISTER_CONTEXTS=1` for local dev.
- `MNO_PLATFORM_ASSUME_SCHEDULE`, which must equal the computed schedule id rather than being a bare
  flag. Platform mode refuses otherwise. THE SCHEDULE ACROSS GATEWAYS IS THE OPERATOR'S JOB: see the
  constraint below.
- `MNO_REGISTER_ROOT_MAX_AGE` (900s), how stale a DML root a registration may anchor to.
- `MNO_RATE_CHALLENGE_ACCOUNT`, `MNO_RATE_VERIFY_ACCOUNT`, `MNO_RATE_DML`, `MNO_RATE_INGRESS`,
  `MNO_RATE_KEYS`.

## Deployment constraint, Platform nullifier mode is coordinated by hand

Platform mode exists so several gateways enforce ONE spent set, and the contract's unique index on
(epoch, contextHash, nf) is what makes that safe. But epoch and season NUMBERS are derived from the
configured lengths, and nothing in the contract records which lengths produced a given document. So
two gateways sharing one contract under different schedules would write documents whose keys mean
different things, which either reopens a spent tag or permanently denies a legitimate one.

The gateway does what it can locally: it refuses to start unless `MNO_PLATFORM_ASSUME_SCHEDULE`
names its exact schedule, it records that assertion in a marker file bound to both the schedule and
the contract id, and it refuses if a later boot disagrees with what it recorded. All of that is
LOCAL. The marker is a file on one machine and the state it protects is shared, so a second gateway
with its own marker can assert an incompatible schedule and neither will notice.

UNTIL THE CONTRACT CARRIES A SCHEDULE DECLARATION, the constraint is this: every gateway sharing a
contract must be configured with the same `MNO_EPOCH_SECONDS` and `MNO_SEASON_SECONDS`, and that is
enforced by the operator rather than by the software. A single-gateway Platform deployment has no
exposure, since the only marker and the only state agree by construction. A multi-gateway one is
running on an operational promise, and setting `MNO_PLATFORM_ASSUME_SCHEDULE` is where that promise
is made. This is a deliberate deferral, not an oversight: adding the declaration is a contract
migration, and the Platform path is not live yet.

## Security invariants (do not weaken without a clear reason)

- THE DISCORD ADAPTER CANNOT CURRENTLY ENFORCE AN EXCLUSION, and no Discord-native mechanism fixes
  that. Two independent facts combine, both verified in the installed `discord.js` 14.26.4 source:
  - A member-level deny is not protectable. `permissionOverwrites.edit()` rebuilds both bitfields from
    its own cache and sends them whole, and Discord has no compare-and-set, so a deny the cache has
    not seen is destroyed by any change the bot makes to that member's entry.
  - A role-level deny does not exclude anybody the bot grants to. `GuildChannel.memberPermissions`
    applies the member overwrite's ALLOW last, after role denies and role allows, so the bot's own
    grant overrides the exclusion. The role entry survives untouched and is simply outranked.

  An earlier version of this file claimed role-level denies were the supported, safe mechanism. That
  was wrong, and the mistake was confusing "the bot does not edit the role entry" with "the role entry
  still has effect". Do not restore that claim.

  Any real exclusion has to be OWNED BY THE BOT and checked as part of admission, before it grants,
  rather than expressed in Discord permissions and hoped to survive. Until that exists, the honest
  statement is that an operator cannot exclude an individual from a gated channel while this bot is
  granting access to it.

- The verifier runs all policy checks before the cryptographic check and hard-fails on an invalid
  proof. The `expected` values are ones the gateway chose or knows, never values read from the proof.
  A proof can assert only the nullifier and that some valid node authorized it. It can never talk the
  gateway into accepting the wrong root, epoch, context, or challenge.
- A challenge is one-time. Taking it consumes it, so a nonce cannot be replayed.
- One masternode maps to one membership per epoch, enforced by the nullifier set. Known limit, the
  nullifier binds to the voting key, not the collateral outpoint, so delegated voting keys collapse
  into one membership. The honest framing is "one voting key, one membership".
- Two-tier registration is durable and season-scoped. The members tree is only a cache rebuilt from
  the registration records, so a crash never strands a member and a restart never loses one. A season
  boundary starts a fresh empty tree, so a past-season root stops verifying and a member must
  re-register, which re-proves current control.
- The registration record is the atomic commit point. One write holds both the registration nullifier
  (the per-season spend) and the member commitment, unique on (season, contextHash, regNullifier), so
  the spend and the membership can never diverge.
- Rollovers and member commits are serialized on one queue in `SeasonMembers`. A rollover can never
  run between a commit checking the season and appending the member, so a stale-season root is never
  published. This is the M2 fix. The expensive proof verify runs outside the queue, so it never stalls
  challenges and per-epoch verifies.

## Known blockers and where work is tracked

The adversarial review of 2026-06-26 is the source of truth for the gateway and circuit blockers,
committed at `REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` (and `.pdf`). Later rounds that covered
the Discord adapter and the shared grant ledger are committed alongside it, most recently
`REVIEW_FINDINGS_dash-mno-verify_discord_round10_2026-07-31.md`. Every finding in those adapter rounds
is folded; they are kept as the record of what was wrong and why, which is what the handoff points back
to. The prioritized remediation list is in
`TODO.md`.

B1 (account binding) and B2 (context-scoped members roots) ARE IMPLEMENTED and are no longer open.
The verify path rejects a proof whose submitted account differs from the one the challenge was
minted for (`account-mismatch`), and two-tier challenges and verifies run against the requested
context's own members tree rather than one shared per season. This paragraph described them as the
headline open blockers well after both had landed, which is worse than saying nothing: an agent
reading it could undo correct work or redo finished remediation. Check the code before trusting any
status claim here.

## Build, keys, and tests

- `npm ci` for the full toolchain, or `npm ci --omit=optional` for the oracle and gateway only.
- `npm test` runs the Node test suite. `scripts/check_circuits.sh` and `scripts/prove_members.sh` run
  the circuit checks and a real PLONK members prove-and-verify in CI.
- The gateway boots from committed verification keys in `circuits/build`. The cheap members proving
  key and the wasm files come from the `circuit-keys-v1` release, fetched and checksum-verified by
  `scripts/fetch_keys.sh`. The two large proving keys are rebuilt with `scripts/build_proving_key.sh`.
- Local circom on an arm64 Mac runs the macOS x86 binary under Rosetta. Set `CIRCOM=/tmp/circom`.
  `circom-ecdsa` is fetched as a pinned external dependency by `scripts/setup_circom_ecdsa.sh`, not
  vendored.
- Keep CI green. The validated paths are the hash160 vectors and in-circuit checks, the PLONK members
  prove-and-verify loop, the oracle matching current Dash Core, and the optional-dependency split.

## Style and authorship

This is a public repository.

- No em-dashes anywhere. Use commas, parentheses, or separate sentences. Plain hyphens only.
- No semicolons in body prose. They are fine only as list separators.
- Define each acronym at first use.
- Use a bulleted or numbered list for three or more parallel points.
- No mention of Claude, Anthropic, or any AI tool in any file, commit, or the repository. Hilawe
  Semunegus is the author.
- Commit and push only when asked. Never force-push without asking.

## Review discipline

AFTER PUSHING, CHECK THAT CI IS ACTUALLY GREEN. The rule below has always said keep CI green and
nothing made anyone look, so it stayed red from 2026-07-30 to 2026-08-04 across roughly fifteen
pushes while every local run passed. The failure was invisible locally by construction: CI installs
with `npm ci --omit=optional` and a local checkout has the optional packages, so only CI could see
it. One command after a push, and read the conclusion rather than assuming:

    gh run list --limit 1 --json conclusion,status --jq '.[0]'

If it is red, fix it before starting the next change. A red CI that everyone has stopped reading is
worth less than no CI, because it also hides the next failure. Note the suite reports a different
count in each job (479 with the full install, 400 plus 79 skipped without the optional packages), so
a green `checks` job alone does NOT mean the adapters were exercised; that is what the `full` job is
for.

A non-trivial change gets an independent review from a different model than the one that wrote it.
If Claude Code wrote the change, run `git review` (uncommitted) or `git review-branch main` (branch
vs main), which call `codex review`. Fix every blocker and major, or push back with a specific reason.
The reviewer is read-only and advisory. It never edits the working tree.

Upstream of that review, every behaviour-changing commit runs the write-time self-verification pass
instantiated for this repository in `docs/PRECOMMIT_ADOPTION.md` (scope, domain oracles, invariant
classes, test procedure, evidence map, gates, checker, trial log). The mandatory test gate is
`tools/hooks/pre-commit`. It is not adopted automatically on clone, so run
`git config core.hooksPath tools/hooks` once per checkout.
