# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-07-23

### Where things stand

- 2026-07-24, step 5 continued: the verification-concurrency bound. A `Semaphore` (core/stores.js)
  caps concurrent expensive verifies (`MNO_VERIFY_CONCURRENCY`, default 4) with a bounded wait queue
  (`MNO_VERIFY_QUEUE_MAX`, default 256), gating ONLY the crypto check via an engine-agnostic `gate`
  threaded through verifyMembership/verifyRegistration (default pass-through, so PLONK behavior is
  preserved), and sheds a 503 when full. An overloaded `/v1/verify` restores the taken one-time
  challenge (`ChallengeStore.restore`, cap-respecting so bounded) so a transient overload does not
  burn the member's nonce; on a genuine flood it honestly tells the member to request a new one.
  Reviewed by a different model over three iterations (the semaphore was confirmed correct first; then
  a consumed-challenge defect, a restore-refused-on-full defect, and an unbounded cap-bypass were each
  found and folded; final re-check APPROVE). 188 tests green. Only step-5 remainders now: the live
  STARK verifier + HTTP receipt routing, and the registration proof lease (deferred for a prose
  design pass on challenge-vs-window).

- 2026-07-24, step 5 continued: per-request engine dispatch. `verifyZkvmRegistration` is the engine
  sibling of `verifyRegistration`, decoding the frozen journal, running the same policy pipeline
  before an injected receipt verify, and using the SHA-256 root view. Each wrapper pins its own
  engine (a mismatched declaration is rejected before any decode/verify/commit).
  `MNO_REGISTRATION_ENGINE`/`STATEMENT` configure the gateway (validated at boot), and a zkVM gateway
  refuses to boot until the receipt verifier is wired (deferred, artifact-gated). PLONK stays the
  default and its behavior is preserved. Reviewed by a different model (APPROVE-WITH-FIXES: pin the
  engine per wrapper, folded; re-check APPROVE). Remaining step-5 pieces: the live STARK verifier and
  the HTTP receipt-body routing, the registration lease, and the concurrency bound.

- 2026-07-24, the three outside-reviewer packets came back on the full zkVM shipping surface. Two
  returned BLOCK and both were verified FALSE POSITIVES against ground truth: Gemini claimed the
  object-vs-positional `commit` signature broke all registrations, but the gateway wires an adapter
  closure between `verifyRegistrationCore` (object) and `SeasonMembers.commit` (positional), and 172
  tests pass; the Codex app claimed a quorum collapse from duplicate oracle keys, but
  `config.oraclePubkeys` already deduplicates by canonical fingerprint. Grok returned APPROVE. The
  Codex app also raised two REAL items, now folded: the registration store `append` fails closed on a
  missing engine/statement (no silent legacy default on a new write, the read default stays only in
  `declarationOfRecord`), and `validateSnapshot` enforces the version schema independent of mode (a
  v2 snapshot must carry a well-formed shaRoot, a v1 must not). Its root-window drift finding was
  already fixed by the RootWindows fold. Tests added for the fail-closed append and the v1/v2 schema.

- 2026-07-24, step 5 continued: the durable per-(season, context) engine-and-statement declaration.
  Each (season, context) is bound to a single statement, declared by its first registration and
  enforced on every later one inside the serialized append, so derive and custody cannot mix in one
  community (which would allow a double registration, since they emit different registration
  nullifiers for the same node). An impossible pair (PLONK custody) is rejected, and legacy records
  default to plonk/derive. Reviewed by a different model (APPROVE, after folding a validator
  prototype-key hardening and two persistence tests: the concurrency winner and a real legacy-record
  reopen). 169 tests green. Remaining step-5 pieces: the live STARK verifier (artifact-gated), engine
  dispatch, the registration lease, and the concurrency bound. A FULL multi-model round over the
  accumulated step-4-and-step-5 surface is the next checkpoint (only per-slice focused reviews so
  far).

- 2026-07-24, step 5 continued: the SHA-256 root window. A second `RootStore` (`shaRoots`) is kept in
  lockstep with the Poseidon `dmlRoots` by the `updateRootWindows` helper on adoption and a paired
  `dropOlderThan` on aging, so a zkVM registration root check sees exactly the snapshots the Poseidon
  check does. Pinned by `test/root_windows.test.js` (v2 populates both, v1 only Poseidon, both age by
  one cutoff, ring-buffer bound in step). Reviewed by a different model, APPROVE, no findings; its
  suggestion to fold both windows behind one `RootWindows` facade is deferred to the engine-dispatch
  step (it would churn the current call sites and that step adds the callers that make it worth it).
  162 tests green.

- 2026-07-24, step 5 (first slice) of the zkVM integration: the engine-neutral registration-verify
  spine. `verifyRegistration` is split into `verifyRegistrationCore` (one policy pipeline for any
  engine) plus per-engine decoders (`decodePlonkRegistrationClaims`, the existing five-signal array,
  and `decodeZkvmRegistrationClaims`, the frozen 136-byte journal pinned against the fixture), with
  the crypto check injected so the zkVM path reuses the pipeline. PLONK behavior is byte-for-byte
  preserved (reviewer-confirmed). The gateway serves `shaRoot` on `/v1/dml`, and `/v1/register` has
  its own larger body cap (`MNO_MAX_REGISTER_BODY_BYTES`) for the receipt while other endpoints keep
  the small cap. The review caught a real pre-existing memory-DoS in `readBody` (the size guard never
  stopped the data listener), now fixed to count bytes, drop chunks, and destroy the request on
  overflow. 158 tests green. Still to do in step 5: the SHA-256 root store, the live STARK verifier
  wired at boot (artifact-gated), per-request engine dispatch, the durable per-(season, context)
  engine-and-statement declaration, the registration proof lease, and the verification-concurrency
  bound (see `docs/ZKVM_INTEGRATION.md` step 5).

- 2026-07-24, step 4 of the zkVM integration (the shipping code) landed: the oracle dual-root v2
  snapshot. `buildSnapshot` now emits `version: 2` and a SHA-256 `shaRoot` derived from the same
  leaves (`common/dml_sha_root.js`, pinned against the shared fixture), the signed message versions
  to v2 covering the shaRoot (v1 byte-identical, neither signature replayable as the other), the
  gateway recomputes the shaRoot alongside the Poseidon root, and `MNO_REQUIRE_SHA_ROOT=1` makes a
  zkVM deployment refuse a downgraded v1 snapshot. 150 tests green (13 new). Next is step 5 (gateway
  claims-object refactor, engine dispatch, the STARK verifier, the durable engine declaration, the
  registration lease, and the measured limits).

- 2026-07-24, the heavy bench reported and settles the cost questions. The production statement FITS
  8 GB: at `segment_limit_po2 = 19` it peaked at 4.8 GB under an enforced 8 GB cgroup (passed), for
  about 2 extra minutes (86 vs 84). The wallet-custody rejection is REOPENED, because the memory
  ceiling is set by segment size not statement, so the signature variant also dropped to 4.8 GB at
  po2 19: custody is now available at 4.8 GB for more proving time, an owner decision, not a
  rejection. Receipt path measured: unwrapped STARK is transparent, a 4.8 MB receipt (small for a
  once-per-season upload; exceeds only the configurable 2 MB `MNO_MAX` default, not a real limit, and
  the 6.4 MB was the avoidable base64 tax of JSON) verifying in about 400-820 ms; wrapped Groth16 is
  769 bytes, verifies in about 5-14 ms, but adds about 33 min and a docker dependency to the member's
  prove and reintroduces a trusted setup. Both fold into `docs/REDUCING_PROVING_COST.md` and
  `docs/ZKVM_INTEGRATION.md`. Receipt path DECIDED 2026-07-23 (owner): the unwrapped STARK receipt,
  keeping the no-trusted-setup property. The accepted cost is a non-JavaScript verifier in the
  gateway (checksum-pinned) plus a raised `MNO_MAX` and a binary receipt upload. Wallet custody DECIDED
  2026-07-23 (owner): ships as an opt-in, per community and season, NOT per member, because the two
  statements necessarily emit different registration nullifiers for the same node (keyed on the
  private key the custody prover lacks), so mixing them in one community would allow a double
  registration. Derive is the default. The custody guest's nullifier scheme needs its own design
  note and review before implementation (work-plan step 7 in `docs/ZKVM_INTEGRATION.md`).

- 133 tests green (`npm test`, about two minutes).
- 2026-07-23, the oracle snapshot assembly is factored into `oracle/snapshot.js` behind an
  injectable `call()`, with the tip-consistency guard pinned by fixture tests in
  `test/oracle_snapshot.test.js`, and the README consistency pass is done.
- 2026-07-23, zkVM track progress. Guest v2 (the production five-claim statement) is built and its
  journal matched the circomlibjs-pinned bytes on CI. It measured 9.6 GB and 77 minutes at default
  segments (the three in-guest Poseidon hashes cost about 26x the accelerated remainder) and failed
  the 8 GB cap, so the fit now rests on the in-flight `segment_limit_po2 = 19` reruns, and the
  wallet-custody rejection reopens if those bring the 9.6 GB variants down too. A full multi-reviewer
  round (Codex CLI, Codex app, Gemini, Grok) over the whole zkVM surface found no statement-soundness
  hole and was folded: one shared golden fixture (`test/vectors/zkvm_golden.json`) both suites
  regenerate and compare, an executor-only guest soundness gate (`host check`, rejecting d in {0, n,
  n+1}, non-canonical fields, bad path bits and lengths, plus a valid right-hand path), a Node-side
  receipt verification harness with request-size and image-id-binding checks, the wrap step run under
  the 8 GB cap with docker-cgroup peak capture, the RISC Zero toolchain components pinned to
  the exact versions the green runs used (r0vm and cargo-risczero 3.0.6, guest rust 1.97.0, cpp
  2024.1.5) with a version-recording CI step (committing the Cargo.lock files is a further follow-up
  needing a local cargo run, since no Rust toolchain is available in-session), and doc corrections (the journal root is raw
  bytes not hex, the direct-node read needs a ChainLocked tip not "read at the ChainLocked block",
  and the stale 8 GB-demonstrated claim).
- 2026-07-23, a second reviewer pass (the packet reviewers returning) added three findings the first
  fold did not cover, now folded: the capped bench step captures its exit status so an expected OOM
  no longer aborts the later receipt-path steps; a registration proof lease
  (`MNO_REG_PROOF_MAX_AGE`) is specified in the design because the 77-minute proof can outlast the
  oracle recency window (the sharpest catch, root freshness versus a long proof, tracked as a gateway
  work item); and season is pinned to u64 across both engines since the zkVM journal encodes it as 8
  bytes while PLONK would accept any field element. No new statement-soundness hole was found.
- 2026-07-23, a THIRD full pass (the follow-up-rounds discipline) again found no statement-soundness
  hole and caught six weaknesses in the fold's own test and measurement scaffolding, now folded. The
  key one: the guest `check` compared only pass/fail, so it proved the guest RAN but not that it
  committed the right journal, and every accepted case used d=1/secret=1. Fixed by adding a
  fully-varied second golden witness (d=n-2, nontrivial secret, season above 2^32, different context,
  right-hand path with a 0x03 sibling), pinned in the shared fixture and both vector suites, and by
  making `check` assert each accepted case's exact 136-byte journal (via `guest_journal` returning
  the bytes), so a guest that ignored upper key bits or hardcoded a field would now fail. Also: the
  Node harness now actually decodes the request body and verifies the decoded bytes with wrong-image
  and corrupt-receipt rejections, the host `verify` reports single-request latency (not a 10x loop)
  and asserts tampered-journal rejection, the capped bench step treats only a kernel-recorded OOM as
  a valid negative and propagates any other failure, the bench watches the shared fixture path, and
  the docker-wrap memory measurement is recorded as an honest limitation (RISC Zero's Groth16
  container is a separate cgroup with no `--cgroup-parent`, so a definitive capped wrapped number
  needs a dedicated runner). The Rust half of this fold is validated by CI, not locally (no Rust
  toolchain in-session).
- 2026-07-23, a FOURTH (confirming) pass again found no statement-soundness hole and confirmed the
  varied fixture and reworked check are genuine, but caught four defects in the third fold's own
  scaffolding, now folded. The notable one: the third fold's OOM classifier was itself buggy (it
  folded `MemoryPeak=...`, never "0", into the OOM boolean, so every nonzero exit still passed as an
  OOM), now replaced with a scope-local signal only (systemd `Result=oom-kill` on the named unit or
  exit 137), so a real prover failure propagates. Also: the extra-sibling negative case no longer
  also adds a bit (it could not isolate the sibling-length boundary), split into extra-sibling-only
  and extra-bit-only; `verify --repeat` rejects zero and malformed values instead of dividing latency
  by zero or silently skipping the verify; and the docker-peak wording is consistently "maximum
  single-container peak" in the workflow and design doc, not "sum". Four rounds have now converged
  with no statement-soundness hole ever found; remaining findings have all been in research-bench
  test and measurement scaffolding.
- 2026-07-23 (earlier), a full multi-reviewer round over the oracle change set was folded. The findings and
  their fixes: the tip guard now compares block hash as well as height, so a same-height branch
  swap mid-read forces a retry instead of publishing a torn signed snapshot, with a retry backoff
  for a syncing node; a golden-snapshot test pins the exact field set, order, and serialization,
  plus a signing smoke test; a voting address decoding to the empty-leaf value is refused; the
  shared tree hasher moved to `common/dml_root.js` (a re-export shim keeps `core/dml_root.js`
  imports working); the README quickstart now sets `MNO_ALLOW_UNSIGNED_ORACLE=1` so the advertised
  path actually boots; and the cost doc's acceptance-bar history was reconciled (see below). One
  reviewer packet came back reviewing a different project entirely and was discarded, so a fresh
  run of that packet is still owed.
- The security arc from the 2026-06-26 adversarial review is done. B1 (account relay), B2
  (context-scoped members trees), M1 (nullifier malleability), M2 (season-rollover race), M3 (oracle
  root hardening and signed snapshots), and M5 (gateway authentication) are all closed. See the
  checked items in `TODO.md` for the mechanism of each fix.
- A clean-room design exercise validated the architecture. Two independent greenfield designs, from
  models in different families than the author, were produced from the requirements alone with no code
  access, and both converged on the shipped design (a Semaphore-style zero-knowledge membership proof
  over the deterministic masternode list, a community-scoped nullifier, the oracle, gateway, and
  adapter split, and epoch-based auto-revoke). The divergences became roadmap items, recorded in
  `TODO.md` (the transparency-log candidate in P2 and the raised priority on the chain-anchored
  oracle in P1).
- The Phase 0 prover-cost benchmark is measured and recorded. The RISC Zero prototype at
  `research/risc0-registration/` runs three statement variants in continuous integration on an x86_64
  runner. Deriving the key peaks at 4.8 GB, and both wallet-custody variants (full signature
  verification and the recovery-hinted efficient-ECDSA form) peak at 9.6 GB, because the recovery
  hint's variable-base scalar multiplication and point decompressions push the trace into the next
  power-of-two zkVM segment. The conclusion is that cheap wallet custody needs a purpose-built
  circuit, not a zkVM variant swap.

### Canonical numbers and their one source

- Prover-cost numbers (peak RAM, segment size, proving time per variant) live in
  `docs/REDUCING_PROVING_COST.md`, section "Phase 0 results, measured on RISC Zero". Do not restate
  them elsewhere without pointing there.
- The review findings and their status live in `REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` and
  `TODO.md`.

### Standing policies and gotchas

- Every non-trivial change gets an independent adversarial review from a different model family than
  the author, per the review discipline in `CLAUDE.md`. Verify findings against ground truth before
  acting on them.
- Do not regenerate the proving and verification keys without the owner's sign-off. B1 and B2 were
  closed without circuit changes on purpose, so the committed keys stay valid.
- The RISC Zero bench runs in CI on x86_64 only. The prototype's README documents the ARM64 container
  limit, and this Mac cannot run it natively.
- Local circom on this arm64 Mac runs the x86 binary under Rosetta with `CIRCOM=/tmp/circom`, per
  `CLAUDE.md`.
- Writing style, authorship, and derived-repository rules are in `CLAUDE.md`. This is a public
  repository, so no AI tool is named in any committed file.

### Punch list, in order

1. Operator-only, host the two 2.3 GB proving keys once. Rebuild each with
   `scripts/build_proving_key.sh <circuit>` (the non-promoting path, which verifies the rebuild
   against the committed verification key without touching it), upload to object storage or IPFS,
   and fill `url` and `sha256` under `largeFiles` in `keys.manifest.json`, so members download
   rather than rebuild. This cannot be done from an agent session (no built keys, no hosting
   account).
2. The Phase 0 statement decision is made (2026-07-23). The 9.6 GB wallet-custody variants are
   rejected as exceeding acceptable member hardware, and the derive-the-key statement at 4.8 GB is
   the chosen path, recorded with the acceptance-bar history in `docs/REDUCING_PROVING_COST.md`.
   The 8 GB-cap confirmation run passed on 2026-07-23 (4:56, 4.8 GB peak, no page faults, under an
   enforced 8 GB cgroup, prover alone), so the 8 GB fit is demonstrated. The integration design is
   written and revised once through an independent design review, `docs/ZKVM_INTEGRATION.md`. Its
   settled parts: two-tier retained, zkVM replaces registration only, an engine-neutral claims
   object, a pinned SHA-256 tree spec, a dual-root v2 snapshot with a deployment-scoped downgrade
   rule, circomlib-compatible Poseidon as a hard prerequisite, and a durable engine declaration
   with season-boundary cutover. Still gated on measurement: the receipt verification path (wrapped
   Groth16 versus an unwrapped STARK verifier), decided in work-plan step 3. Step 1 is done
   (2026-07-23): the protocol bytes are frozen (the 136-byte journal appendix in the design doc)
   and the cross-implementation golden vectors pass on both sides, circomlibjs in
   `test/zkvm_vectors.test.js` and light-poseidon in `research/risc0-registration/vectors/` via
   the zkvm-vectors workflow, so the hard prerequisite (circomlib-compatible Poseidon in Rust) is
   answered yes and cross-engine nullifier identity holds. Next are steps 2 (guest v2) and 3
   (receipt-path measurement), both inside `research/` and the bench.
   The still-open owner decision is whether to fund the purpose-built efficient-ECDSA circuit as
   the wallet-custody research track.
3. The P1 remainder in `TODO.md`, chiefly direct node mode (the 2026-07-23 reframe of the
   chain-anchor question after community review input: the gateway reads the DML from its own
   trusted Core node at the last ChainLocked block, removing oracle-key trust for the common case,
   with SPV nodeless verification demoted to deferred research), the Platform-backed claim
   commitment, and Matrix private-room verification.
4. P2 quality items in `TODO.md`.

## History

### Sessions through 2026-07-22 (superseded by CURRENT STATE above)

Summarized from the working notes that preceded this file.

- Built the working prototype end to end, the oracle, the five circuits, the two proving modes
  (single-tier and two-tier), the gateway, and the four adapters, validated on real mainnet data.
- Ran the 2026-06-26 adversarial review and closed its blockers and majors across multiple review
  rounds by two independent model families. Real bugs caught and fixed along the way included a
  double-spend via non-canonical field elements, a grant-ledger persistence race, and an
  epoch-boundary bleed.
- Landed the no-roles Discord grant mode (channel-overwrite grants so a profile does not reveal
  masternode control), the epoch sweep that revokes lapsed grants, the persisted globally-serialized
  grant ledger, gateway-owned epoch timing, and the operator key-distribution workflow.
- Ran the clean-room design exercise described above and folded its findings into `TODO.md`.
- Reframed the proving-cost research track from the clean-room review, answered the ring-signature
  feasibility gate (not feasible over the full set, recorded in `TODO.md`), built the RISC Zero
  registration prototype with its CI bench workflow, added the signature-statement and
  recovery-hinted variants, and recorded the measured three-way results in
  `docs/REDUCING_PROVING_COST.md`.
- Shareable member and reviewer material (the plain explainer, runbook, evaluation guide, threat
  model, and cost doc) is exported to the operator's local `~/Downloads/` as Markdown and PDF when
  needed. The PDFs are built through Chrome headless, since this Mac has no pandoc.
