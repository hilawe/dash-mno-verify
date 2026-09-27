# Security audit scope

This document was written to scope a formal third-party security audit of dash-mno-verify. No external
audit or specialist review will be commissioned (settled 2026-09-27, see the last section), so it now
serves as the charter for the project's own best-effort assessment. That assessment uses constraint-level
analysis tools, checks against independent implementations, published circuit bug catalogs, and
independent review with repository access. Where the text below says "auditor" or "the audit", read the internal
assessment that uses this document as its target list. The claims, targets, and known limits are
unchanged by that.

Read `docs/DESIGN.md` for the architecture and `docs/THREAT_MODEL.md` for the trust boundaries and the
accepted limits. This document assumes both.

## Current assurance status

The system is a working prototype, validated on real mainnet data, and it is NOT audited. It has had
many rounds of adversarial self-review by models from more than one family, recorded in the
`REVIEW_FINDINGS_*` files at the repository root and summarized in `docs/HANDOFF.md`. Those rounds found
and closed a large number of real defects, and they are useful context for an auditor. They are not a
substitute for an audit, for three reasons.

1. The reviewers had no access to the cryptographic literature an auditor brings to a circuit, and no
   ability to run the kind of tooling (formal verification, constraint-count analysis, symbolic
   execution) an auditor uses on a zero-knowledge (ZK) circuit.
2. The reviews were conducted by the same author who wrote the code, using models that share the
   author's blind spots, which the review record itself notes as a recurring limitation.
3. No reviewer examined the third-party circuit dependency (`circom-ecdsa`), the trusted-setup
   assumption, or the soundness of the constraint system as a whole.

## Claims the audit is asked to validate

The audit should treat these as the properties to attack, not to confirm. Each maps to a mechanism the
auditor can locate in the code.

1. PRIVACY. No party links a platform identity (for example a Discord user id) to an on-chain address,
   voting key, or specific masternode. The verifier learns only a per-request nonce and an unlinkable
   nullifier. (`docs/THREAT_MODEL.md`, "What each party learns"; `core/verifier.js`; the circuits.)
2. SOUNDNESS OF MEMBERSHIP. A valid proof can be produced only by a party controlling a masternode
   voting key present in the accepted deterministic masternode list (DML) tree. A non-member cannot
   forge one. (`circuits/mno_membership.circom`, `circuits/merkle.circom`, the hash160 and voting-key
   derivation, and `circom-ecdsa`.)
3. NULLIFIER CORRECTNESS. One voting key maps to exactly one membership per epoch and context, the
   nullifier is deterministic for a given key and context, and it cannot be made malleable to spend one
   membership twice or to grief another. (The nullifier construction in the circuits, the canonical
   field-element checks in `core/verifier.js` and `common/field.js`, and the spent-set stores.)
4. AUTHORIZATION AND REPLAY RESISTANCE. A proof minted for one platform account cannot grant another,
   and a consumed challenge cannot be replayed. (`core/verifier.js` account binding, `core/stores.js`
   challenge store.)
5. ORACLE INTEGRITY WITHIN THE STATED TRUST MODEL. A host that merely serves the snapshot JSON cannot
   forge a membership set, because the gateway requires a quorum of signatures from pinned oracle keys
   over a root that commits to the leaves. (`core/gateway.js` snapshot validation, `oracle/`.)
6. TRUSTED SETUP. Groth16 for the two heavy circuits, with a per-circuit phase two run as in
   `docs/CEREMONY.md`, and PLONK for the members circuit, both over the public Hermez Powers of Tau, are
   used correctly, and
   its security rests only on the stated one-honest-participant assumption of that universal ceremony.

## Audit targets, in priority order

The ordering is by the cost of a defect. A break in tier 1 defeats the system's core guarantee. A
break in tier 2 defeats it within a narrower trust model. Tier 3 affects a single deployment surface.

### Tier 1, the cryptographic core

- The circom circuits: `mno_membership.circom` (single-tier), `mno_registration.circom` and
  `mno_members.circom` (two-tier), and `merkle.circom` (inclusion), together with the hash160 and the
  Semaphore-style signal-binding components they compose. Constraint soundness, correct wiring of the
  public signals, absence of under-constrained signals, and correct hash160 and voting-key derivation.
- `circom-ecdsa` (0xPARC), fetched as a pinned external dependency by
  `scripts/setup_circom_ecdsa.sh`. It is demonstration code that its own README states is unaudited and
  not for production. The single-tier membership proof depends on it. This is the single highest-risk
  dependency, and an auditor should assess whether the specific templates used are sound as used, or
  whether they must be replaced.
- The nullifier construction and the canonical-scalar constraint that closes nullifier malleability,
  end to end from the circuit through `core/verifier.js` and `common/field.js`.
- The Groth16 ceremony transcripts, the PLONK members setup, and the committed verification keys in
  `circuits/build`, including whether the keys
  correspond to the committed circuits.

### Tier 2, the gateway and oracle trust boundary

- `core/verifier.js`: the ordering of policy checks before the cryptographic check, the account
  binding, the expected-value handling (the verifier chooses expected values and never reads them from
  the proof), and the fail-closed behaviour.
- `core/gateway.js`: snapshot signature and quorum verification, the version and shaRoot schema checks,
  rate limiting and its keying, and the boot-time refusals.
- `core/stores.js`: the root window, challenge store, and nullifier store, including the leaf-bound
  eviction and the shaRoot invariant recently corrected.
- `core/registration_store.js`: the durable, season-scoped registration records and their crash and
  concurrency behaviour, documented in `docs/REGISTRATION_STORE_DURABILITY.md`.
- `oracle/`: the DML commitment reconstruction (`dml_commitment.js`), the direct-node read
  (`diff_snapshot.js`), and the service and voting-address encodings. The direct-node residuals in the
  next section are the load-bearing limits here.

### Tier 3, the deployment surfaces

- The adapters (`adapters/`), in particular the documented Discord exclusion limitation (the bot cannot
  enforce an individual exclusion while it grants access, recorded in `CLAUDE.md`) and the shared grant
  ledger.
- The Dash Platform data contract (`contract/`) and the nullifier-uniqueness argument, which the
  operator-coordinated schedule constraint in `CLAUDE.md` bounds.

## Known limits and residuals to hand the auditor

These are documented and, in the current design, accepted. An auditor should not spend effort
rediscovering them, and should instead assess whether accepting them is defensible for the intended
deployment.

1. ORACLE TRUST IS A PINNED KEY, NOT THE CHAIN. Signed snapshots authenticate the leaf set against
   trusted oracle keys, not yet against the chain's own `merkleRootMNList` commitment. The fully
   trustless anchor is described in `docs/THREAT_MODEL.md` and is unfinished.
2. DIRECT-NODE MODE IS A TRUSTED-NODE READ. Where the oracle reads a node directly (`oracle/`), two
   residuals remain, both written where they are relied on. The ChainLock signature is not verified, so
   the node is believed when it says a block is ChainLocked. And the proof-of-work check is floored at
   the network `powLimit`, the easiest target the network allows, not the difficulty in force at the
   height, so a real but old or noncanonical block passes. Together a node can no longer fabricate for
   free, but a determined node with real resources is not ruled out. See `TODO.md`.
3. VOTING KEY, NOT COLLATERAL. The nullifier binds the voting key, so masternodes sharing a delegated
   voting key collapse to one membership. The guarantee is one voting key, one membership.
4. ANONYMITY SET SIZE. Privacy is bounded by the eligible set, a few thousand masternodes, and in
   two-tier mode by the members registered in the same season and context, which can be much smaller.
5. TIMING AND METADATA. The cryptography hides the address link, not that a member verified at a time.
6. KEY HANDLING. The single-tier prover reads the raw voting key locally. It never leaves the device
   and controls no funds, but it is a key-handling step.

## Out of scope for a first engagement

- The zero-knowledge virtual machine (zkVM) registration path, which is deferred and artifact-gated
  (`docs/ZKVM_INTEGRATION.md`); it is not wired for production.
- The multi-gateway Dash Platform nullifier mode, whose safe operation currently rests on an operator
  promise about matching schedules across gateways rather than on the contract, and is not live
  (`CLAUDE.md`, deployment constraint).
- Proving-key hosting and the member-side proving cost, which are adoption and operations questions,
  not security ones (`docs/REDUCING_PROVING_COST.md`).

An operator may choose to bring the first two into scope, and doing so is reasonable if either path is
close to going live. They are listed as out of scope only to keep a first audit focused on what gates
value today.

## Artifacts to provide the auditor

- The repository at a named commit, including `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, this document,
  and `docs/REGISTRATION_STORE_DURABILITY.md`.
- The circuits and their build inputs, and `scripts/setup_circom_ecdsa.sh` so the dependency is
  reproducible at its pin.
- The `REVIEW_FINDINGS_*` history as context for what has already been examined, with the caveat above
  that it is self-review.
- The deployment and operations docs (`docs/DEPLOY.md`, `docs/RUNBOOK.md`) for the runtime trust model.

## What the self-reviews establish, and what they do not

The adversarial rounds establish that the mechanical and design-level defect surface has been worked
hard, and they give an auditor a defect history to calibrate against. They do not establish circuit
soundness, the safety of the third-party circuit dependency, the correctness of the trusted-setup
usage, or resistance to an adversary with cryptographic depth the reviewing models did not have. Those
are exactly the questions a first audit exists to answer.

FREE AUTOMATED CIRCUIT ANALYSIS HAS SINCE RAISED PART OF THIS FLOOR, and an auditor should read
`tools/circuit-analysis/RESULTS.md` before scoping tier 1. Static analysis (circomspect) is clean, and a
determinism checker (Ecne) has PROVEN that `mno_members` (the two-tier per-epoch membership circuit,
including its Merkle inclusion and its Poseidon nullifier, commitment, and signal binding) and `hash160`
are fully constrained, so their outputs cannot be chosen by a prover. This is a stronger statement than the
structural-only reach the internal process claims elsewhere, and it means the two-tier per-epoch path's
determinism is no longer an open question for the auditor. It does NOT settle the residual: the single-tier
and registration circuits derive the public key in circuit with `ECDSAPrivToPub` from `circom-ecdsa`, which
the automated tools reach only by treating that component as trusted, so whether that unaudited component is
sound as used, and the trusted-setup assumption, remained open. The effect was to narrow tier 1 toward that
one named component. That component was then assessed internally on 2026-09-27 (`tools/circuit-analysis/
RESULTS.md`, "ECDSAPrivToPub, assessed internally"), which checked every constant against OpenSSL, worked the
case analysis for its point additions, ran the compiled component on 211 keys, and mapped the published bug
catalogs onto it. What that assessment does not settle is stated there.

## Decision on an external audit

SETTLED 2026-09-27. No external audit or specialist review will be commissioned for this project. The
recommendation that stood here (engage a zero-knowledge circuit specialist for tier 1 first, then a protocol
and application reviewer) is withdrawn, because the engagement it prepared for will not happen. The
reasoning is proportion. The system gates access to a community, not funds, and the operational
mitigations (do not gate anything of real value, keep the anonymity set large, cap grants) are the control
that does not depend on anyone's review.

What takes the audit's place, for every tier:

- The claims, targets, and known limits above, used as the charter for internal rounds.
- Constraint-level and static tools on the circuits (circomspect, Ecne, circom's own inspection), with the
  runs recorded in `tools/circuit-analysis/`.
- Checks against independent implementations (OpenSSL for the curve, circomlibjs for Poseidon, Dash Core's
  own X11 for block hashing), and the published circuit bug catalogs.
- Independent review with repository access of every consequential change, per `docs/WORKING_METHOD.md`.

The limit that comes with it is stated rather than deferred. No one outside the project has examined the
circuits, the trusted setup rests on the public Powers of Tau ceremony with no independent examination of
its use here, and a clean internal round is not an audit. A reader deciding whether to rely on this system
should weigh it that way.
