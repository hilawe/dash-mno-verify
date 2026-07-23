# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-07-23

### Where things stand

- `main` is at `68d9d77`, working tree clean, 124 tests green (`npm test`, about two minutes).
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

1. Operator-only, host the two 2.3 GB proving keys once. Rebuild with
   `scripts/rebuild_proving_keys.sh`, upload to object storage or IPFS, and fill `url` and `sha256`
   under `largeFiles` in `keys.manifest.json`, so members download rather than rebuild. This cannot
   be done from an agent session (no built keys, no hosting account).
2. Decide the follow-on to Phase 0. The measurement points at a hand-built efficient-ECDSA circuit
   (Spartan or halo2 class) as the only route to cheap wallet custody. Whether to invest in that
   track, or ship with the two measured options (derive at 4.8 GB with the key in the prover, or
   wallet custody on a 16 GB machine), is a design decision for the owner.
3. The P1 remainder in `TODO.md`, chiefly the oracle snapshot testability item, the chain-anchored
   (SPV) oracle, the Platform-backed claim commitment, and Matrix private-room verification.
4. P2 quality and P3 docs items in `TODO.md`, including the README consistency pass (`protx list`
   vs `masternodelist json`, and the stale "what remains" list).

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
