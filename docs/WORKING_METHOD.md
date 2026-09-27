# Bounded delivery and review

Adopted 2026-09-27 at the owner's request. This is the current working method for this
project. It replaces the review cadence in older project instructions, the three-agent
trial in PRECOMMIT_ADOPTION.md, and the repeated whole-surface rounds in
INTERNAL_ASSURANCE_PROCESS.md. Their defect records remain useful history. Their
mandatory reviewer counts and repeat-until-empty rules do not govern routine work.

## Work toward one runnable outcome

Before a substantive unit, record its behavior, supported configuration, success example,
contrary example, expected cost, and stopping condition in the current handoff. A few
sentences suffice. Group helpers that serve the same outcome. Do not create a separate
review milestone for every helper or wording correction.

The near-term product is a private Discord community using two-tier membership, one
gateway, durable local storage, and an explicitly trusted source of masternode data.
Keep other adapters, shared Platform state, and alternative proof engines outside that
acceptance claim unless the owner expands it. Existing security checks stay in force.

## Match review to consequences

- Presentation and internal documentation receive author verification and applicable
  automated checks. No mandatory independent round is needed for a cosmetic correction.
- Ordinary behavior receives relevant tests and one independent execution review of the
  assembled outcome, including its wiring.
- Admission, permissions, secrets, the trust model, cryptographic checks and the circuits,
  durable state, freshness, and evidence used to approve deployment receive one independent
  repository-access review with a meaningful contrary control. The reviewer is a different
  model family from the implementer, as the existing project rule requires. That is
  independence, not cryptographic assurance. Cryptographic soundness claims need targeted
  analysis (constraint-level tools, checks against an independent implementation, and the
  published circuit bug catalogs), and repeating general code review cannot supply it. No
  external specialist review will be commissioned, so a gap that analysis cannot close stays
  a stated limit.

A misleading acceptance claim belongs in the third category even if it is only prose.
The review must identify the source revision or exact uncommitted files it examined.
Do not add a separate diff-only screen when the execution reviewer already reads the diff.

## Close findings without restarting the project

Repair blockers and major findings, or record a specific supported reason to dispute them.
Confirm consequential repairs against the failing example and the affected connected path.
The implementer's passing tests do not replace that independent confirmation.

Run one full review and at most one focused repair-confirmation pass for a unit. If that
confirmation reveals an unresolved consequential defect, stop declaring the unit complete.
Record the defect and narrow the unit or change the failing design before starting another
bounded repair unit. A count limit never converts a failure into acceptance. Add another
reviewer only for a named unresolved assumption, a disagreement, or a changed trust model.

Do not repeat a clean whole-project sweep because a report sentence changed. Reuse evidence
when its code, inputs, environment assumptions, and measurement validity still apply.
Run relevant checks after changes and the required pre-commit gate when making a commit.
Read the actual continuous-integration job results after an authorized push.

## Keep research finite

For proving work, compare the exact complete registration statement on named hardware.
Report download bytes, disk footprint, peak memory, proving time, verification time,
proof size, key custody, and setup assumptions together. A smaller key alone is not a win.
Separate a synthetic benchmark from a live ownership proof and from an operational pilot.

Use one baseline and one candidate per experiment. State a resource limit and a stopping
condition before running it. Do not build an engine integration until the complete statement
beats the baseline on the declared user requirement. A failed experiment is a valid outcome.
If infrastructure diagnosis makes no progress for about twenty minutes, preserve the error
and use existing fixtures for independent work. Do not label fixture results as live results.

## Record evidence once

Keep one current-state handoff near 500 words, with dated history below it. Link exact
evidence rather than copying mutable test counts into several documents. Record actual
outcomes, remaining limits, and the next action. Do not build a new review counter, dashboard,
or self-auditing harness to enforce this policy.

This document is a workflow instruction, not an executable guarantee. The existing test
gate and application checks provide mechanical enforcement of their own narrower properties.
Judge the method by demonstrated member admission and reliable revocation per unit of effort,
not by the number of tests, commits, mutations, or review rounds.
