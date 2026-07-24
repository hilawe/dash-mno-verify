# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-07-24

### What this is

An anonymous zero-knowledge proof that someone controls a Dash masternode, used to gate a private
community (first adapter, Discord) without revealing which node or address. An oracle reads the
deterministic masternode list (DML) from a Dash Core node and publishes a Merkle root the proofs are
checked against. A platform-neutral gateway verifies proofs and manages short access grants, and four
adapters (Discord, Telegram, Matrix, web) speak to it. Two proving modes: single-tier (`MNO_MODE=single`,
one membership proof per epoch) and two-tier (a heavy seasonal registration proof plus a cheap
per-epoch members proof). Read `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, and `docs/DEPLOY.md` for the
full picture. Status: working prototype, validated on real mainnet data, NOT audited. Do not gate
anything of value until the `TODO.md` blockers are closed and it has had an audit.

- Repo: `~/Code/dash-mno-verify`, public at `github.com/hilawe/dash-mno-verify` (gh authed as `hilawe`).
- `main` is at `8cb4174`, working tree clean, 188 tests green (`npm test`, about two minutes).

### Where things stand

The 2026-06-26 security arc is closed. B1 (account relay), B2 (context-scoped members trees), M1
(nullifier malleability), M2 (season-rollover race), M3 (oracle root hardening and signed snapshots),
and M5 (gateway authentication) are all done, and the mechanism of each is in the checked items of
`TODO.md`. A clean-room design exercise validated the architecture (two independent greenfield designs
by other model families, from requirements alone, both converged on the shipped design).

The main active work is the zkVM registration integration, the durable fix for the member-side proving
cost (the 2.3 GB PLONK proving key). Its state:

- Research phase COMPLETE and reviewed to convergence. A RISC Zero prototype (`research/risc0-registration/`)
  implements and measures the registration statement. Four full multi-model adversarial rounds (Codex
  CLI, Codex app, Gemini, Grok) found NO statement-soundness hole, and every real finding was in test
  and measurement scaffolding and was folded. Cross-implementation golden vectors (`test/vectors/zkvm_golden.json`)
  are reproduced by circomlibjs (JS) and light-poseidon (Rust), so circomlib-compatible Poseidon in the
  guest holds and cross-engine nullifier identity is guaranteed.

- Cost questions ANSWERED and decisions MADE (owner, 2026-07-23/24), all in `docs/REDUCING_PROVING_COST.md`
  and `docs/ZKVM_INTEGRATION.md`:
  - The derive-the-key statement FITS an 8 GB masternode: 4.8 GB measured under an enforced 8 GB cgroup
    at `segment_limit_po2 = 19` (the production statement is 9.6 GB / 77 min at default segments,
    where the three in-guest Poseidon hashes dominate at 26x the accelerated remainder, and the
    segment size, not the statement, sets the memory ceiling).
  - Wallet custody ships as a per-community-and-season OPT-IN (not per member, because derive and
    custody emit different registration nullifiers for the same node, so mixing them in one community
    would allow a double registration). Derive is the default.
  - The receipt path is the UNWRAPPED STARK receipt (transparent, no trusted setup; ~4.8 MB receipt,
    ~400-820 ms verify), not wrapped Groth16 (tiny/fast but reintroduces a trusted setup and adds ~33
    min plus a docker dependency to the member prove).

- Shipping integration (steps 4 and 5 of the `docs/ZKVM_INTEGRATION.md` work plan) LARGELY BUILT and
  reviewed to convergence (a full multi-model round plus per-slice focused reviews). Done:
  - Step 4: the oracle dual-root v2 snapshot. `buildSnapshot` emits `version: 2` and a SHA-256 `shaRoot`
    over the same leaves (`common/dml_sha_root.js`); the signed message versions to v2 covering the
    shaRoot (v1 byte-identical, neither signature replayable as the other); the gateway recomputes both
    roots; `MNO_REQUIRE_SHA_ROOT` (and a durable current-season zkVM declaration) refuse a downgraded v1
    snapshot; `validateSnapshot` enforces the v1/v2 schema (v2 must carry a well-formed shaRoot, v1 must
    not).
  - Step 5, the engine-neutral verify spine: `verifyRegistrationCore` runs one policy pipeline for any
    engine, with per-engine decoders (`decodePlonkRegistrationClaims`, the five-signal array;
    `decodeZkvmRegistrationClaims`, the frozen 136-byte journal). PLONK behavior is byte-for-byte
    preserved.
  - Step 5, the SHA-256 root window: `RootWindows` (`core/stores.js`) holds both roots per snapshot in
    one ring buffer, so the Poseidon and SHA-256 views are structurally in lockstep (a v2-then-v1
    sequence cannot leave a stale SHA-256 root past its Poseidon partner's eviction).
  - Step 5, the durable per-(season, context) engine-and-statement declaration: the first registration
    in a bucket declares its (engine, statement); a later append with a different declaration is rejected
    inside the serialized commit; the store `append` fails closed on a missing declaration (the legacy
    default is read-only); `seasonHasEngine` feeds the downgrade rule.
  - Step 5, per-request engine dispatch: `verifyZkvmRegistration` is the engine sibling of
    `verifyRegistration` (each pins its own engine); `MNO_REGISTRATION_ENGINE`/`MNO_REGISTRATION_STATEMENT`
    configure the gateway (validated at boot); a zkVM gateway refuses to boot until the receipt verifier
    is wired.
  - Step 5, the verification-concurrency bound: a `Semaphore` caps concurrent expensive verifies
    (`MNO_VERIFY_CONCURRENCY`) with a bounded wait queue (`MNO_VERIFY_QUEUE_MAX`), gating only the crypto
    check and shedding a 503 when full; an overloaded `/v1/verify` restores the taken one-time challenge
    (`ChallengeStore.restore`, cap-respecting) so a transient overload does not burn the member's nonce.

### Canonical numbers and decisions, and their one source

- Prover-cost numbers (peak RAM, segment size, proving time per variant): `docs/REDUCING_PROVING_COST.md`,
  "Phase 0 results, measured on RISC Zero". Do not restate them elsewhere without pointing there.
- The zkVM integration design, the settled decisions (statement, receipt path, custody opt-in), and the
  work plan: `docs/ZKVM_INTEGRATION.md`.
- The 2026-06-26 review findings and their status: `REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` and
  `TODO.md`.
- Every tunable is an `MNO_*` env var read in `core/config.js`.

### Standing policies and gotchas

- Every non-trivial change gets an independent adversarial review from a different model family than the
  author (`CLAUDE.md`). VERIFY every finding against ground truth before acting: this session saw two
  confident BLOCK verdicts that were false positives (a missed adapter closure, an already-present key
  dedup), and a real security bug that was already fixed.
- A FULL multi-model round gates "done", not just per-slice focused reviews. The full round over the
  accumulated step-4/5 surface found three cross-slice blockers the per-slice reviews could not see (two
  of them consequences of fixes deferred in earlier slices). Build slices with focused reviews, then run
  a full round before considering the body of work complete.
- Do not regenerate the proving/verification keys without the owner's sign-off. B1/B2 were closed without
  circuit changes on purpose, so the committed keys stay valid.
- Artifact-gated, wired but unproven, like the Platform nullifier backend: the live STARK receipt verifier
  needs the real RISC Zero `r0vm` binary and receipts, unavailable in-session, so a zkVM-engine gateway
  refuses to boot until it is wired. The Platform registration backend is likewise deferred (needs a
  funded testnet identity and DAPI seed) and, when wired, must implement `declarationFor`,
  `seasonHasEngine`, and the per-bucket declaration enforcement.
- No Rust toolchain in-session: all Rust (`research/risc0-registration/`) is validated by CI, not
  locally. The RISC Zero bench runs on x86_64 CI only (ARM64 container limit documented in its README).
  Local circom on this arm64 Mac runs the x86 binary under Rosetta with `CIRCOM=/tmp/circom`.
- Anything in `~/Downloads/` is a view-only convenience copy, never a source (per global `CLAUDE.md`). The
  authoritative session log is THIS file.
- Public repository: no AI tool is named in any committed file, and a review is described generically.
  Writing style and authorship rules are in `CLAUDE.md`.

### Punch list, in order

Owner-only or decision-first (cannot be done from an agent session):

1. Host the two 2.3 GB proving keys once. Rebuild each with `scripts/build_proving_key.sh <circuit>`
   (the non-promoting path that verifies against the committed key without touching it), upload to
   object storage or IPFS, and fill `url` and `sha256` under `largeFiles` in `keys.manifest.json`.
2. Decide whether to fund the purpose-built efficient-ECDSA circuit as the wallet-custody research track
   (custody is now reachable via the zkVM at 4.8 GB for more proving time, and the custom circuit would
   make it cheap in time too). Owner decision.
3. Pasta's ChainLock DM reply is pending (the direct-node reframe is already folded when it arrives). The
   follow-up #dev-talk post draft is in `~/Downloads/pasta_followup_post.md`.
4. Commit the `Cargo.lock` files for `research/risc0-registration/` from a machine with a Rust toolchain,
   then restore `--locked` in the two workflows (tracked in `TODO.md`).

Buildable next (in rough priority):

5. The registration proof lease (root freshness versus the long registration proof, `docs/ZKVM_INTEGRATION.md`
   "Root freshness against a long proof"). Needs a small PROSE design decision first: a registration
   challenge with an issuance time versus a longer registration-root window (which interacts with the
   shared freshness model). Decide, then build. Pure gateway logic, no artifact needed.
6. The live STARK verifier and the HTTP receipt-body routing (artifact-gated on `r0vm`, with the
   dispatch, decoder, root store, and boot guards already built and waiting for the drop-in).
7. The custody guest, work-plan step 7 (`docs/ZKVM_INTEGRATION.md`): the production form of the benchmark
   `sig` variant, whose registration-nullifier scheme needs its own design note and review first (it
   cannot key on the private key the custody prover lacks).
8. The P1 remainder in `TODO.md`: direct node mode (read the DML from a trusted Core node at the last
   ChainLocked block, removing oracle-key trust for the common case; SPV nodeless verification demoted to
   deferred research), the Platform-backed claim commitment, the shared Platform registration backend,
   and Matrix private-room verification.
9. P2 quality items in `TODO.md`.

## History

### 2026-07-23 to 2026-07-24 detailed session log (superseded by CURRENT STATE above)

Append-only record of the per-slice work that produced the current state. Kept for the reasoning and the
per-step test counts. The CURRENT STATE above is the authoritative summary.

- The oracle snapshot assembly was factored into `oracle/snapshot.js` behind an injectable `call()`, with
  the tip-consistency guard (height AND block hash re-read) pinned by `test/oracle_snapshot.test.js`, and
  a README consistency pass. A full multi-reviewer round folded: the tip guard compares block hash as well
  as height (a same-height branch swap forces a retry), a golden-snapshot test, the empty-leaf refusal, the
  tree hasher moved to `common/dml_root.js` (re-export shim at the old path), the README quickstart sets
  `MNO_ALLOW_UNSIGNED_ORACLE=1`, and the acceptance-bar history reconciled. A residual A-to-B-to-A read case
  is documented, closed by the direct-node / `protx diff` chain-anchor work.
- Guest v2 (the production five-claim statement) was built and its journal matched the circomlibjs-pinned
  bytes on CI. Four full multi-model rounds over the zkVM surface found no statement-soundness hole. Folds
  across the rounds: one shared golden fixture both suites regenerate and compare; a fully-varied second
  witness (d=n-2, nontrivial secret, season above 2^32, right-hand path) so the guest `check` validates the
  whole journal, not just that the guest ran; an executor-only `host check` rejecting d in {0, n, n+1},
  non-canonical fields, and bad path bits/lengths; a Node receipt-verification harness with request-size and
  image-id binding; the wrap step under the 8 GB cap; the RISC Zero components pinned (r0vm/cargo-risczero
  3.0.6, guest rust 1.97.0, cpp 2024.1.5); an OOM classifier corrected to a scope-local systemd
  `Result=oom-kill`/exit-137 signal; `verify --repeat` guarded; and doc corrections (journal root is raw
  bytes, the direct-node read needs a ChainLocked tip). A registration proof lease
  (`MNO_REG_PROOF_MAX_AGE`) was specified in the design, and season pinned to u64 across both engines.
- The heavy bench settled the cost questions (see CURRENT STATE): derive fits 8 GB at po2 19; wallet
  custody reopened as an opt-in; the unwrapped STARK receipt chosen; custody per-community not per-member.
- Step 4 (oracle dual-root v2 snapshot) landed and was reviewed (a major fail-open on version/shaRoot type
  coercion was folded). Then the step-5 slices: the engine-neutral spine (a real pre-existing memory-DoS in
  `readBody` was found and fixed), the SHA-256 root window, the durable declaration, per-request dispatch,
  and the concurrency bound. A full multi-model round over the accumulated surface found three cross-slice
  blockers (the downgrade rule ignoring durable declarations, the two root windows able to drift, the
  engine-neutral core failing open on missing engine/statement), all folded, and two false-positive BLOCKs
  from the packet reviewers were verified false and dismissed. The concurrency bound took three review
  iterations to get the load-shedding path right (a consumed-challenge defect, a restore-refused-on-full
  defect, and an unbounded cap-bypass, each found and folded).

### Sessions through 2026-07-22 (superseded by CURRENT STATE above)

Summarized from the working notes that preceded this file.

- Built the working prototype end to end: the oracle, the five circuits, the two proving modes
  (single-tier and two-tier), the gateway, and the four adapters, validated on real mainnet data.
- Ran the 2026-06-26 adversarial review and closed its blockers and majors across multiple review rounds by
  two independent model families. Real bugs caught and fixed included a double-spend via non-canonical field
  elements, a grant-ledger persistence race, and an epoch-boundary bleed.
- Landed the no-roles Discord grant mode (channel-overwrite grants so a profile does not reveal masternode
  control), the epoch sweep that revokes lapsed grants, the persisted globally-serialized grant ledger,
  gateway-owned epoch timing, and the operator key-distribution workflow.
- Ran the clean-room design exercise and folded its findings into `TODO.md`.
- Reframed the proving-cost research track, answered the ring-signature feasibility gate (not feasible over
  the full set), built the RISC Zero registration prototype with its CI bench workflow, added the
  signature-statement and recovery-hinted variants, and recorded the measured three-way results in
  `docs/REDUCING_PROVING_COST.md`.
- Shareable member and reviewer material (plain explainer, runbook, evaluation guide, threat model, cost
  doc) is exported to the operator's local `~/Downloads/` as Markdown and PDF when needed, and the PDFs
  are built through Chrome headless, since this Mac has no pandoc.
