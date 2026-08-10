# Internal assurance process, no external auditor

This document designs a repeatable internal assurance pass for dash-mno-verify that stands in, as far as
it honestly can, for a formal third-party audit. It is a process design, not a review. Running it
produces a findings report in the repository's usual `REVIEW_FINDINGS_*` form.

Read `docs/SECURITY_AUDIT_SCOPE.md` first. This process is scoped against that document's tiers and
claims, and it deliberately does not claim to cover what that document reserves for a specialist.

This design was itself critiqued before first use by two model families outside the author's, without
repository access, against a six-question charter (blind spots, verification soundness, the structural
tier-1 slice, independence, the stopping rule, and omissions). One returned REQUEST-CHANGES and one
APPROVE-WITH-FIXES, agreeing independently on five points. Every cross-family finding is folded below at
the point it applies. The five were unowned slice seams, a verification bias that silently dropped
uncertain findings, author framing narrowing the readers, a stopping rule with no fatigue control, and a
too-thin tier-1 structural slice. Two single-family additions are also folded, an accepted-risk output
label and a requirement to list unowned seams in the report.

## The honest ceiling, stated first

`docs/SECURITY_AUDIT_SCOPE.md` gives three reasons the internal adversarial rounds are not a substitute
for an audit. Two of them are capability limits, not effort limits, and no amount of additional
model-driven review removes them.

1. The reviewing models bring no cryptographic-literature depth to a circuit and cannot run the tooling
   a circuit audit uses (formal verification, constraint-count analysis, symbolic execution).
2. The reviewers share the author's blind spots, because the author drives them.
3. No model has assessed the third-party circuit dependency, the trusted-setup assumption, or the
   soundness of the constraint system as a whole.

Therefore this process makes a bounded claim. It raises assurance as far as model-driven review can on
tier 2 and tier 3, which are ordinary systems, protocol, and application code, and where the project's
own history shows multi-model review repeatedly finding real defects. On tier 1 it performs
STRUCTURAL-ONLY work (defined at slice S9 below) and it does NOT certify circuit soundness. The tier-1
soundness question is left open for a ZK-circuit specialist, exactly as the scope document recommends.
The final report repeats this boundary so a reader cannot mistake a clean pass for a cleared tier 1.

## Principles carried from the existing review discipline

These come from the project `CLAUDE.md` review sections and the write-time self-verification adoption in
`docs/PRECOMMIT_ADOPTION.md`. They are not new for this process, they are the rules the process runs
under.

- At least one reviewer in every pool has repository access, and only a reviewer with access can move a
  finding to CLOSED. A packet-only reviewer audits the story, not the world.
- The author never closes the author's own finding. Verification of a finding is cross-assigned to a
  reviewer of a different model family or a different agent from the one that raised it.
- A finding is a CANDIDATE until an independent reviewer with access has tried to refute it and failed.
- Uncertainty is never a silent drop. A verifier who cannot resolve a candidate marks it ESCALATED, and
  an escalated candidate stays alive until a second access-holding reviewer or the author resolves it.
- After findings are folded, a FRESH full round runs over the whole changed surface, not a focused
  re-check of the named findings. The loop's fatigue controls are in phase 5.
- The different-family command-line reviewer is framed per module and in plain correctness and
  durability language, because a security-review framing over the cryptographic code trips that
  reviewer's content filter and stops the run. This is a recorded, recurring operational fact.
- The whole pass runs against one FROZEN commit. If the working tree moves, state is re-verified before
  any finding is recorded against it.

## The reviewer pool and model-family independence

Four sources take part, from four model families. Agreement is weighted BY FAMILY, not by head count,
because two reviewers from one family agreeing is one voice.

1. The author-side reader fleet, with repository access. Owns the per-slice adversarial read and, through
   cross-assignment, some of the verification.
2. The different-family command-line reviewer, with repository access. Supplies model-family
   independence and is one of the sources whose verified findings can CLOSE a tier-2 concern.
3. Two additional packet reviewers, each a further model family, WITHOUT repository access. They receive
   a self-contained Markdown packet (the slice source inline and the review charter) and return
   candidate findings and design critique. Because they have no access, they raise CANDIDATES and
   contribute ideas, and they never CLOSE a finding. Their packets are human-mediated, built to
   `~/Downloads/` with the access-mode tag in the filename, and pasted into fresh sessions.

The packet reviewers serve two purposes. On findings, they widen the net with two independent families
that do not share the author-side blind spot. On design, they critique this process and the highest-risk
slice approaches before the finding work starts, which has already happened once and reshaped this
document. A candidate that two independent families raise is much more likely real, which is how their
output is weighted.

### Independence control, neutral-first framing and an inverted pass

Both critique families found, independently, that naming the audit-scope claim in a reader's charter
narrows the reader to that claim and imports the author's framing. Two controls answer it.

- NEUTRAL-FIRST. The reader fleet and the packet finding-reviews receive their slice and a general
  adversarial charter (correctness, authorization, replay, durability, information leaks, resource
  exhaustion, state-machine and concurrency faults) and are NOT told which audit-scope claim the slice
  bears on. The claim mapping is applied later, at synthesis, by the orchestrator.
- INVERTED PASS. For each load-bearing property a slice is expected to hold, at least one reader is
  told to assume the property is FALSE and to construct the input that breaks it, rather than to confirm
  it holds. This turns the reader away from the author's expectation and toward a counterexample.

Neither control removes author framing entirely, because the author still freezes the commit and cuts
the slices. It is reduced, not eliminated, and the residual is recorded in the report.

## The review slices

The codebase is partitioned into slices that each map to an audit tier. The claim a slice bears on is
withheld from the reader under neutral-first framing and recorded here only for the orchestrator's use at
synthesis. The slice boundaries follow the module layout so a reader holds a coherent surface.

| Slice | Files | Tier | Claim(s) for synthesis |
|-------|-------|------|------------------------|
| S1 verifier | `core/verifier.js`, `common/field.js` | 2 | 3 nullifier, 4 authorization and replay |
| S2 gateway | `core/gateway.js`, `core/config.js` | 2 | 4 authorization, 5 oracle integrity |
| S3 stores | `core/stores.js` | 2 | 3 nullifier, 4 replay |
| S4 registration durability | `core/registration_store.js`, `core/season.js`, `core/members_tree.js` | 2 | 2 membership soundness, 3 nullifier |
| S5 oracle | `oracle/dml_commitment.js`, `oracle/diff_snapshot.js`, `oracle/node_client.js` | 2 | 5 oracle integrity |
| S6 shared encoding | `common/oracle_sig.js`, `common/` context, signal, epoch, season, DML leaf, `common/x11/` | 2 | 1 privacy, 5 oracle integrity |
| S7 adapters | `adapters/` (Discord, Telegram, Matrix, web, shared grant ledger) | 3 | 4 authorization, deployment exclusion limit |
| S8 contract | `contract/` | 3 | 3 nullifier uniqueness, schedule constraint |
| S9 circuits, STRUCTURAL ONLY | `circuits/*.circom`, `scripts/setup_circom_ecdsa.sh`, `scripts/fetch_keys.sh`, `circuits/build` VKs | 1 | 2 soundness (structure), 6 trusted setup (usage) |
| S10 seams, COMPOSITION ONLY | the boundaries between S1 through S8, not their interiors | 2, 3 | every cross-slice claim |

### S9, the structural-only tier-1 slice

S9 is STRUCTURAL ONLY throughout. It cannot, and does not, pronounce on constraint soundness. Within
that ceiling it does the following, which are all observable without cryptographic-literature depth and
which both critique families asked to be made explicit.

1. Public-signal wiring, and whether each declared public input is actually constrained.
2. That no signal the design treats as private is marked public or leaked into a public input.
3. Correspondence between the documented nullifier construction (hash order, domain separation, epoch
   and context binding) and the actual template instantiation and signal wiring.
4. That the committed verification keys correspond to the committed circuit sources and to the exact
   setup artifacts the fetch scripts pin, by rebuild-and-compare rather than by assertion.
5. That the dependency pin and fetch scripts resolve to the stated commit.
6. A constraint-count and template-instantiation dump, committed as a baseline, so a later specialist
   and a later commit can both see whether the circuit grew or shrank unexpectedly.
7. Dead or unused signals, and any hardcoded debug or test parameters left reachable in a build path.

### S10, the composition-only seam slice

Both critique families found that one reader per slice leaves nobody owning the seams, where composed
races, inconsistent epoch and season handling, and cross-module policy ordering live. S10 owns exactly
those seams and none of the slice interiors. Its reader traces at least one full successful path end to
end (adapter through gateway, challenge store, oracle root, verifier, nullifier store) and then inverts
every intermediate value in turn, asking whether the composed system still refuses what it should. It
enumerates the seams it exercised and the seams it did not, and the unexercised seams become a named
residual in the report rather than an unstated gap.

## The phases

The process is six phases. The orchestrator stays in the loop between phases and reads each phase's
result before starting the next, so a surprising result in one phase can redirect the next.

### Phase 0, scope freeze, tooling check, and design critique

- Freeze the candidate commit and re-verify the working tree is clean against it.
- Confirm the different-family command-line reviewer is runnable end to end with a trivial smoke run,
  and resolve the current frontier model slug from its configuration rather than assuming one.
- Confirm the per-slice partition against the live file list, since files move.
- Build a DESIGN-CRITIQUE packet of this process and send it to the two additional packet-reviewer
  families for independent critique before the finding work starts. Fold any real weakness in the plan
  before phase 1. This step has run once and reshaped this document.

### Phase 1, the reader fleet

One reader agent per slice S1 through S10, run in parallel, each with repository access, each under
neutral-first framing and carrying the inverted pass for its slice's load-bearing properties. Each
returns STRUCTURED findings (file, line, severity, the property broken, and a concrete failure scenario
with inputs and the wrong outcome). A reader that finds nothing returns an empty finding set, which is a
result, not a gap.

### Phase 2, the different-family pass

The different-family command-line reviewer runs with repository access over the highest-value slices,
one framed run per slice group so each run stays under the content filter and holds a focused surface.
This pass supplies model-family independence with access and is the pass whose findings, once verified,
can CLOSE a tier-2 concern. Its framing is plain correctness and durability, scoped to the module under
review. In parallel, the two packet-reviewer families receive per-slice packets and return candidate
findings, and a packet candidate is CLOSED only after an access-holding reviewer confirms it in phase 3.

### Phase 3, dedup and adversarial verification

Candidate findings from phases 1 and 2 are deduplicated by file and line, then each survivor is handed
to independent verifiers with repository access, prompted to REFUTE it and to check the claim against
the code.

- A candidate that a MAJORITY of independent verifiers cannot refute is CONFIRMED. The majority is of an
  ODD number of verifiers (three by default), and the agent that raised the finding is EXCLUDED from its
  own verification.
- A candidate a verifier can show is unsupported is REFUTED, with the refuting reason recorded so a
  later round does not resurface it.
- A candidate a verifier can neither confirm nor refute is ESCALATED, never dropped. An escalated
  candidate is resolved by a second access-holding reviewer or by author clarification before the phase
  closes. Uncertainty keeps a finding alive rather than ending it.

Verification is cross-assigned so no agent verifies its own finding, which holds the author-never-closes
rule at the agent level.

### Phase 4, synthesis and report

Surviving CONFIRMED findings are merged, ranked most-severe first, and each is mapped back to the
audit-scope claim and tier it bears on (the mapping withheld from readers is applied here). The report is
written in the repository's `REVIEW_FINDINGS_*` form. It has three mandatory sections that keep the
claim bounded.

- WHAT THIS PASS COVERED AND CONFIRMED, per tier and claim.
- SEAMS AND RESIDUALS THIS PROCESS DID NOT OWN, listing the cross-slice surfaces S10 did not exercise
  and the independence residual from author framing, so a clean pass is not over-read.
- WHAT REMAINS FOR A SPECIALIST, restating the tier-1 soundness residual, the trusted-setup assumption,
  and the third-party circuit dependency as items this process did not and could not close.

### Phase 5, fold and the bounded fresh-round loop

Confirmed findings are folded under the normal write-time discipline, each with a mutation-checked
regression test. After a fold, a fresh full round runs over the changed surface. Both critique families
warned that an unbounded loop lets reviewer fatigue masquerade as convergence, so the loop is bounded.

- At most THREE fresh full rounds. The LEADING model family ROTATES each round, so the same family does
  not read the same code every pass.
- A round that returns nothing real does not by itself end the loop. A different access-holding agent
  re-runs it once to confirm the empty result before the loop is declared converged.
- After the third round, or an earlier confirmed-empty round, the work shifts from full-surface sweeps
  to TARGETED DIFFERENTIAL reviews of the exact folded diffs and their immediate dependencies.
- If real findings remain when the cap is reached, the loop does not silently continue. It stops with an
  explicit STOP-WITH-RESIDUAL-RISK decision recorded in the report, naming what is unresolved.

This loop is bounded in agents as well as rounds. Each round's readers are fresh-context agents scoped to
one slice, so context does not accumulate across rounds, and the round cap plus the per-slice scope keep
the total agent count and token cost bounded rather than open-ended.

## Outputs and their status labels

- CONFIRMED, a defect an independent access-holding reviewer could not refute. Eligible to be folded.
- REFUTED, a candidate shown unsupported and dropped, with the refuting reason recorded.
- ESCALATED, a candidate neither confirmed nor refuted, kept alive until a second access-holding
  reviewer or the author resolves it. Never a silent drop.
- ACCEPTED-RISK, a CONFIRMED finding the operator decides not to fix in this internal phase, recorded
  with the reason and carried into the report rather than quietly closed.
- STRUCTURAL-NOTED, a tier-1 observation about wiring or correspondence within this process's reach,
  marked so it is never read as a soundness verdict.
- RESIDUAL, a tier-1 soundness, dependency, or trusted-setup item, or an unowned composition seam, that
  this process cannot or did not reach, carried verbatim into the report's residual sections.

## What this process is not

It is not an audit and does not lower the tier-1 audit recommendation in `docs/SECURITY_AUDIT_SCOPE.md`.
Its value is that it raises tier-2 and tier-3 assurance to the ceiling of model-driven review before any
paid engagement, so a later specialist engagement spends its budget on the cryptographic core rather than
on defects this pass can find more cheaply. A clean run of this process is evidence that the systems and
application surface has been worked hard. It is not evidence that the circuits are sound.
