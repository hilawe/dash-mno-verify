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
  - `gateway.js` the HTTP server and request handlers.
  - `verifier.js` the policy checks plus the PLONK proof check. `verifyMembership` and
    `verifyRegistration`.
  - `stores.js` the in-memory root, nullifier, and challenge stores.
  - `registration_store.js` durable, season-scoped registration records (file or memory backend),
    the atomic commit point for a two-tier registration.
  - `season.js` `SeasonMembers`, the season-scoped members tree (a cache rebuilt from records) and
    the serialization that closes the season-rollover race.
  - `members_tree.js` the Poseidon members tree. A reference build that recomputes the root, not yet
    incremental.
  - `platform_store.js` the Dash Platform nullifier backend for sharing state across gateways.
- `adapters/` the four platform front ends.
- `contract/` the Dash Platform data contract (nullifier and registration document types).
- `common/` shared encoding (context hash, signal hash, epoch and season math, DML leaf).

## Two proving designs

- Single tier (`MNO_MODE=single`). One proof per epoch proves DML membership directly. Heavier per
  use, no registration step.
- Two tier (`MNO_MODE=two-tier`). A heavy seasonal registration proves masternode control once and
  emits a member commitment, then a cheap per-epoch proof shows membership in the members tree.

`MNO_STORE` is `memory` or `platform`. `core/config.js` holds every tunable, all read from `MNO_*`
environment variables.

## Security invariants (do not weaken without a clear reason)

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

The adversarial review of 2026-06-26 is the source of truth, committed at
`REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` (and `.pdf`). The prioritized remediation list is in
`TODO.md`. The headline open blockers are account binding (B1, the proof binds to the nonce, not the
requesting account) and context-scoped members roots (B2, one registration grants every community in
a season). Both change the committed proving and verification keys, so they need a re-setup and the
owner's sign-off on the anchor choices. Do not regenerate keys without that.

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

A non-trivial change gets an independent review from a different model than the one that wrote it.
If Claude Code wrote the change, run `git review` (uncommitted) or `git review-branch main` (branch
vs main), which call `codex review`. Fix every blocker and major, or push back with a specific reason.
The reviewer is read-only and advisory. It never edits the working tree.
