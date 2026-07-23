# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-07-23

### Where things stand

- 133 tests green (`npm test`, about two minutes).
- 2026-07-23, the oracle snapshot assembly is factored into `oracle/snapshot.js` behind an
  injectable `call()`, with the tip-consistency guard pinned by fixture tests in
  `test/oracle_snapshot.test.js`, and the README consistency pass is done.
- 2026-07-23, a full multi-reviewer round over that change set was folded. The real findings and
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
   enforced 8 GB cgroup, prover alone), so the 8 GB fit is demonstrated. What remains before
   integration is claimed is the integration scope in `TODO.md` (the measured guest is a benchmark
   statement, its journal does not yet match the registration publics and its tree hash differs, so
   wiring it in starts with a design pass), plus measuring the STARK-to-SNARK wrap step if the
   design picks a wrapped receipt.
   The still-open owner decision is whether to fund the purpose-built efficient-ECDSA circuit as
   the wallet-custody research track.
3. The P1 remainder in `TODO.md`, chiefly the chain-anchored (SPV) oracle, the Platform-backed
   claim commitment, and Matrix private-room verification.
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
