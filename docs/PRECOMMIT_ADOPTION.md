# Pre-commit self-verification, adoption note

The write-time discipline this repository follows before a commit. The playbook it instantiates
lives outside the repository and is not repeated here. This note is the eight items that playbook
says a repository must write down before its rules mean anything locally, written from this
repository's own facts and its own defect history, because rules imported without local specimens
become ceremony.

## 1. Scope

The full pass applies to changes in `core/`, `circuits/`, `contract/`, `prover/`, and the
`adapters/` gating paths, since those change behaviour that someone relies on. Rule 3 alone applies
to everything, including edits to `CLAUDE.md` and the review findings, because this repository's own
history shows a false claim shipping in an instruction file rather than in code (see section 5).
Documentation touch-ups with no claim in them need no pass.

## 2. Domain oracles

The oracle question is "what makes this output CORRECT, and which authority says so". This repository
already has most of the answer written down, which is unusual and worth using.

- `CLAUDE.md`, "Security invariants (do not weaken without a clear reason)". Treat that list as the
  primary oracle. A change touching admission, nullifiers, roots, epochs, seasons, or the registration
  record must name which listed invariant governs it.
- THE INSTALLED DEPENDENCY SOURCE, not the documentation of it. The existing entry cites behaviour
  "verified in the installed `discord.js` 14.26.4 source", which is the right standard and should be
  the rule: a claim about third-party behaviour cites the installed version's source, and the version
  number is part of the claim.
- The circuit constraints for anything a proof asserts, and the contract for anything on chain.
- For the two-tier design, the registration record is the stated atomic commit point, so any change
  to registration names whether it preserves the single-write property.

## 3. Invariant classes

The playbook's default minimum is inputs, outputs, failure behaviour, downstream consumers, and the
conditions under which the path does not run at all. Extend with the five this repository's own
defects and load-bearing invariants have come from:

- AUTHORIZATION SEMANTICS OF AN EXTERNAL SYSTEM, where the guarantee lives in someone else's
  evaluation order. The specimen is the role-level deny that survives untouched and is simply
  outranked, so "we did not edit it" was confused with "it still has effect".
- FAIL-CLOSED PROPERTIES. The git history contains "a zkVM deployment can adopt v3, without losing
  the fail-closed property", which is the rule 1 shape exactly: a widening change and a guarantee
  that had to be re-established rather than inherited.
- BOUNDEDNESS BY CONSTRUCTION VERSUS BY TRUST. Also from the history, "the root window is bounded
  again, by construction rather than by trust". When a bound moves from structural to assumed, the
  assumption is the new invariant and needs an enforcement site.
- EPOCH AND SEASON BOUNDARIES, where a past-season root must stop verifying and a fresh tree must
  start empty. Anything touching rollover states which side of the boundary it is on.
- SERIALIZATION AND ORDERING, since rollovers and member commits share one queue and the stated
  guarantee is that a rollover can never run between a commit checking the season and appending the
  member (the M2 fix). Any change near that queue names whether it preserves the ordering.

## 4. Test procedure

- Suite: `npm test`, which is `node --test $(find test -name '*.test.js')`. About 2.5 minutes.
  Never run two suites at once. They contend for one loopback port and hang rather than fail.
- MUTATION METHOD for rule 2: revert the specific behaviour the new test claims to guard, run only
  that test file with `node --test test/<file>.test.js`, confirm it fails, restore, confirm it
  passes. Record the table. Running the whole suite for a mutation is slower and hides which test
  actually caught it.
- FIXTURE RULE: derive fixtures from the constructor or schema the production path uses. For members
  trees and registration records this means building through the real store rather than hand-writing
  a record shape, since a hand-written record can carry a field combination the store cannot produce.
- COVERAGE STATEMENT: before citing `npm test` as evidence, name which test file exercises the
  changed behaviour. If none does, say so rather than citing the suite.
- SHAPE SEARCH (rule 6): after fixing a defect, grep the whole repository for its shape and record
  the search and the hit count. This repository is where that rule was earned: one clock-reading
  defect appeared in FOUR places, each time after being fixed elsewhere, and every instance was
  found by an external reviewer at the cost of a round. Searchable strings that have already paid
  off here: `timeGuard.regressed` and `.regressed` (a flag read without the call that refreshes it),
  `allow(` on limiters (a bucket charged before another can refuse), and `_levels` (a cache used as
  a proxy for work done).

## 5. Evidence map

| Claim of this kind | Authoritative evidence | Freshness |
| --- | --- | --- |
| third-party API behaviour | the INSTALLED package source, with version | re-read on version change, and cite the version in the claim |
| an invariant still holds | the named entry in the invariants list plus the enforcement site | re-read the entry, not your memory of it |
| a proof or circuit property | a run, or the constraint itself | re-run in the turn that claims it |
| "the suite is green" | `npm test` output PLUS the file that covers the change | both, every time |
| anything about a season or epoch boundary | the boundary code and a test crossing it | a run crossing the boundary, not reasoning about it |

THE SPECIMEN THIS REPOSITORY ALREADY OWNS: an earlier `CLAUDE.md` stated role-level denies were the
supported safe mechanism, and the correction records that the error was confusing "the bot does not
edit the role entry" with "the role entry still has effect". That is a claim resting on inference
where the evidence was the library's evaluation order, and it sat in the instruction file that later
work would trust. It is the reason rule 3 applies to documentation commits here.

## 6. Gate inventory

One mandatory gate exists, `tools/hooks/pre-commit`, and it blocks: a commit touching a gated path
refuses to land unless `npm test` passes, with the hook's exit code as the decision.

- GATED PATHS: `core/`, `circuits/`, `contract/`, `prover/`, `adapters/`, `common/`, `oracle/`,
  `test/`, `scripts/`, `tools/`, and the package files. The first four are the minimum an earlier
  draft of this note recommended. `adapters/` and `oracle/` are added because that is where the
  defect history actually clusters (review rounds 9 through 12 were all the Discord adapter, and
  both open chain-anchor blockers are in the oracle), and `common/` because the context hash and
  epoch math feed everything. Documentation-only commits skip the suite.
- CONCURRENCY, TWO LAYERS AT TWO STRENGTHS: an atomic `mkdir` lock excludes two of these hooks
  racing each other, and a best-effort `pgrep` probe refuses when a manually started `node --test`
  is already active, because two suites contend for one loopback port and the second waits forever.
  The probe can miss a suite started between probe and launch, and it matches any `node --test` on
  the host, which errs toward refusing. Neither layer is a general mutual-exclusion guarantee and
  the hook's comments say so. The lock's cleanup is ownership-checked (the holder's pid is recorded
  inside it), so clearing a stale lock cannot be undone by the old holder's trap. A termination the
  trap cannot see leaves the lock behind, and the refusal message names the pid and the removal
  command.
- KNOWN LIMIT, STATED: the suite runs against the working tree, not the staged index, so a
  partially staged tree can pass while the commit content would fail. The stash dance that closes
  this has its own failure modes, so the simple form is kept.
- FAILING PATH, TESTED 2026-08-02: a deliberate `throw` was added to `test/field.test.js`, staged,
  and the commit refused with the suite failure named (pass 380, fail 1, HEAD unchanged). The probe
  was then reverted. The passing path is observed, not assumed, each time a gated commit lands with
  the hook installed and without `--no-verify`, and the trial log records the observation. Being in
  the history alone proves nothing, since `--no-verify` and an unconfigured hooks path both bypass
  the gate.
- INSTALL, ONCE PER CHECKOUT: git does not adopt a hooks path automatically after a clone, so run
  `git config core.hooksPath tools/hooks` in each fresh checkout. `CLAUDE.md` records the same.

## 6b. The three-agent fix review, ON TRIAL here from 2026-08-03

This repository is the trial site for the three-agent stage described in the
playbook. It runs BEFORE the external artifact check, on behaviour-changing commits
touching `core/`, `oracle/`, `common/`, `circuits/`, or `contract/`.

- The three charters are ordering, durability, and tests. Each agent gets the diff,
  the invariant list, and the changed tests. None gets the author's reasoning, and
  none sees another's findings before finishing.
- Findings are UNIONED and then verified against the code. Neither dismissed by
  majority nor accepted on assertion.
- THE ENDPOINT: ten qualifying commits. If the stage never catches something first,
  it is deleted rather than kept as ceremony. Each pass adds a row to the trial log
  below with a `3AGENT` prefix so its record is separable from the external one.

WHAT PASS 1 ACTUALLY SHOWED, recorded while it is fresh because it is more specific
than "the stage works":

- THE CHARTER DID THE WORK, NOT THE AGENT COUNT. Two of three agents found the same
  two easy defects. The finding that mattered, and that no external round had caught
  either, came from the one charter that forced MEASUREMENT rather than reading. When
  adding a charter, ask what it makes an agent DO, not what it makes it look at.
- ONE AGENT STALLED OUTRIGHT, mid-run, with two tool calls outstanding and no result
  for over an hour. A queued message could not reach it, because delivery happens on
  the next tool round and that is exactly what a stalled agent is not having. The
  recovery is to re-run that charter with a tighter, budgeted prompt; the stalled one
  had the heaviest prompt of the three. Budget the charters.
- THE STAGE DOES NOT REPLACE THE EXTERNAL PASS, and this pass is the evidence rather
  than an assurance: after all three agents were folded, the external check still found
  four real problems, every one of them in the TESTS and comments rather than the code.
  The agents were better at the product than at the artifacts about it.

Why three and not the five originally proposed: the agents share this author's
model family and blind spots, so more of them mostly buys correlated opinions.
Ordering, durability, and tests are the three shapes this repository's own defect
history actually produces.

## 7. Checker setup

- Prompt at `/tmp/precommit_check_dash-mno-verify.md`, staged diff at
  `/tmp/precommit_diff_dash-mno-verify.patch`, per-project names for the same collision reason as the
  review prompts.
- Give the checker the diff INLINE and forbid repository-wide searching. An exploring run is the one
  that ends without a verdict.
- Independence: the checker must not be the context that authored the change. A different model
  family is preferred, and this repository's review history already uses several.
- Fallback: a fresh-context agent of the same family, weighted lower.

## 8. Trial log

Append one row per pass. The playbook's re-trial protocol names this repository as the next data
point, and the single question is whether the AUTHOR-SIDE pass catches any defect before the
external checker does. Both prior trials say it does not. An entry where the answer to the last
column is "no" for every rule is a real result and is recorded rather than omitted.

| date | change | rule that caught it FIRST, or external, or escaped | false alarms | author-side time | checker tokens | did the rule change the outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-09 | FOURTH ROUND fold: two durability blockers, a mixed-declaration false signal, guard removal (`5478fa7`) | EXTERNAL caught all, and this is the first round this session where the findings were PRE-EXISTING rather than inside the previous fix, so the unit is converging. Two blockers (a repair path that trusted page-cache bytes with no barrier, and a directory flush that was skipped on retry), one major (a bucket mixing declarations made seasonHasEngine lie), and one major resolved by NARROWING the contract the author had overclaimed rather than adding code. The external round also did what the author could not: built the deterministic interleaving that PROVED the generation guard unreachable, so the guard was removed rather than kept as untested defence. TOOLING NOTE worth more than the findings: the first external run was killed by the reviewer's own content filter over the crypto-heavy gateway code; a re-run scoped to the store and framed as plain crash-durability completed cleanly. A security-bearing review can be blocked by security-adjacent vocabulary, so scope tightly and frame neutrally. | 0 | about 4 h | about 290,000 external over two runs (one filtered, one REQUEST-CHANGES) | yes, decisively. The two blockers were real data-loss paths and would have shipped, and the guard removal turned an untested unreachable branch into code that matches what is reachable and tested. Seventeenth data point. The rule-7 specification is what made the fourth round's findings land as clean divergences rather than another repair scramble. |
| 2026-08-09 | RULE 7 INVOKED: wrote `docs/REGISTRATION_STORE_DURABILITY.md` and folded the third round's three findings as divergences (`450d25f`) | RULE 7 IS THE STORY. `FileBackend`'s reconciliation/durability state machine had been repaired six times across three passes with four repairs introducing the next finding, the exact trigger, but the trigger was reached by feel after round three rather than mechanically after round two, which is the method miss to record. Writing the one-page contract made the three findings fall out as divergences instead of three more reactive patches. RULE 2 in its SHARPENED form did the discriminating work: findings 2 and 4 got deterministic tests that fail when reverted, but the finding-1 generation guard SURVIVED every mutation, and rather than read that as "safe" the author recorded it as UNTESTED (rule-4 recorded reason) after two attempts to drive the deciding interleaving through fs hooks were non-deterministic. RULE 6 shape search: every write to the two flags grepped and confirmed to live only in `#mark()` and `#reconcile`'s continuations. A test written earlier this session was found FLAKY under the rework (1 in 5) because it was coupled to an internal read-index numbering and its target interleaving became unreachable under single-flight; removed with its property shown covered elsewhere, not silenced. | 0 so far | about 3 h | external (fourth fresh full round) in flight at write time | the mechanical rule-7 trigger is the durable lesson: it should have fired after round two. The generation guard is the honest gap, kept because it is correct and fail-safe and handed to the different-family round to test, which is the playbook's own conclusion that the checker, not the author-side pass, is what catches these. Sixteenth data point. |
| 2026-08-04 | 3AGENT PASS 2: the retained-leaves bound on the root window (`MNO_ROOT_WINDOW_MAX_LEAVES`) | THE STAGE CAUGHT FIRST AGAIN, and this time in two charters independently. ORDERING found a real defect in the code: the bound evicted single RECORDS off the front while the height trim above it deliberately evicts whole HEIGHTS, so during a changeover it kept the v3 record at a height and evicted its v2 sibling, locking out a prover holding the v2 tree at a height whose v3 root was still accepted. Reproduced before fixing. TESTS found two surviving mutations the author had not tried: every case used equal-sized records so a single pass would have passed them all, and no case sat exactly at the bound so the comparison's inclusivity was unpinned. DURABILITY correctly returned "this change touches no durable write", having traced it rather than assumed it. The external pass then found two more, both about claims rather than code: the default's neutrality claim held only for the default MNO_ROOT_WINDOW, and re-adoption at an existing key was uncovered. A fresh full pass found two more of the same kind. | 0 | about 2 h | about 260,000 external over three passes (APPROVE-WITH-FIXES, APPROVE-WITH-FIXES, APPROVE) | yes, decisively, and this is the second consecutive pass where the stage caught first. The ordering defect would have shipped: it fires only when the bound binds, which the default makes rare, and it silently undoes the coexistence guarantee the window was redesigned to provide. ALSO A METHOD NOTE: one mutation the author ran was a SYNTAX ERROR rather than a mutant (changing `while` to `if` orphaned a `break`), and it was reported as a catch until `node --check` was run on the mutated file. Check that a mutant PARSES before believing the test caught it. Fifteenth data point, and 2 of 10 on the three-agent trial. |
| 2026-08-04 | make `core/gateway.js` importable, and `core/config.js` a `buildConfig(env)` factory | external caught 16 real across six passes, EVERY ONE in the lifecycle code written this session and none in the wrapped body (pass 1 confirmed mechanically that the re-indentation moved and dropped nothing, and that `buildConfig(process.env)` deep-equalled the old object). THE HEADLINE IS THE FRESH FULL PASS. Four focused rounds converged to APPROVE, and the fresh full pass immediately after found two majors and a moderate that none of them was near (close() waited for the SERVER rather than for request handlers, so a disconnected client's handler ran on into released stores; a bind IN PROGRESS could outlive the teardown; and the config module still validated the ambient environment at import). Rule 2 caught four first, all defects in TESTS. The second fresh full pass then caught a fifth of the same kind that rule 2 had missed, that the cleanup tests counted close() calls rather than proving release, so a close() replaced by a body setting only a flag passed every one of them. The list: an atomicity test that survived a sequential-charge mutant because the code's own short-circuit made both behave identically in the one direction tested; a close-idempotence test that survived because the emptied release list already provided the property the store-level guard was for; a two-tier adopt test that closed during the read rather than in the gap it was written for; and a handler-drain test that released the handler before observing, a race the correct code happens to win. | 0 | about 6 h, most of it mutation runs and five folds | about 1,170,000 over six passes (REQUEST-CHANGES x3, APPROVE, then a FRESH FULL pass returning REQUEST-CHANGES with 3, a second fresh full pass returning APPROVE-WITH-FIXES with 1, and a confirmation returning APPROVE) | yes, decisively, twice over. Rounds 2 and 3 found nothing but defects in the previous round's fixes (five majors became four, which became one). Then the fresh-full-pass rule paid for itself in a single use: stopping at the round-4 APPROVE would have shipped a teardown that releases a database out from under a running request handler. Rule 6's shape search found the import-time-side-effect pattern does not recur (every other such module is a pure entry point, and the Discord adapter had already solved it by extraction). The three-agent stage was NOT run, so its trial stays at 1 of 10. Fourteenth data point. |
| 2026-08-03 | fold round 3 item 6, rate-limit keying, dml limit, Platform schedule, health readiness (`45ebc02`) | external caught 2 real (a false claim about NUL bytes in the key format, and comments asserting the fairness property generally when it holds only for an authenticated adapter) plus two missing test branches. Rule 2 caught one first: the nonce-ordering test PASSED under mutation because a 429 body carries no `reason` field, so asserting "reason is not X" was trivially true. | 0 | about 1.5 h | 24,000 over one pass (FIX-FIRST) | yes. The conditional nature of the fairness guarantee is now stated in the code rather than assumed, and the nonce test was rewritten to actually use the nonce. Thirteenth data point. |
| 2026-08-03 | fold round 3 item 5, registration anchor policy (`60036fd`) | external caught 8 real across two passes (a recheck at the wrong level, since the commit is queued after it; no test of the actual age bound; a throwing predicate; four claims wider than the code; the first-match timestamp bug; and the predicate replacing rather than adding to the window rule). Rule 1 caught one first: wiring the recheck exposed that the commit's refusal branches mutate the tree, so an unrecognised refusal shape would have appended a member with no durable record. | 0 | about 2 h | 46,000 over two passes (FIX-FIRST twice) | yes, decisively. The first-match timestamp would have refused registrations on any stable network, and it existed only in the fix. Twelfth data point. |
| 2026-08-03 | 3AGENT PASS 1: incremental members tree (`49332c5`) | THE STAGE CAUGHT FIRST, which no author-side pass had done before. Three findings, all verified by me against the code: the convert-after-push root divergence, the commitments-by-reference desync, and THE ONE I MISSED ENTIRELY, that the change moved the 20s stall from the commit path to the recovery path (measured 62.3s at 30,000 members against a constant 7.7s). The external pass then found four more, all in the TESTS and comments rather than the code. | 0 | about 3 h including agent wait and re-measurement | 69,000 external over two passes (FIX-FIRST twice) | yes, decisively. The recovery regression would have shipped: no external round had caught it either, because catching it required MEASURING rather than reading, and only the agent whose charter forced measurement found it. |
| 2026-08-03 | 3AGENT trial pass 0 (mislabelled, see row above): round-5 leftovers, /v1/members regression path and the atomic Platform marker | rule 2 caught one first: the clock-marks fixture omitted the schedule fields, so TimeGuard discarded it as a different numbering and the test passed against an unregressed clock. The fixture rule (derive it from what the real writer produces) is what named it. | 0 | about 40 min | 0, no external pass on this one | the three-agent stage was NOT yet run as separate agents here; this row records the two findings folded and the fixture catch, and the stage's own endpoint (ten qualifying commits) starts from the next behaviour-changing commit. Recorded honestly rather than claiming a trial that did not happen. |
| 2026-08-03 | fold round 3 items 3-4, signature bound, mode validation, context allowlist (`e313aa2`) | rule 2 caught BOTH, before any external pass: a test that HUNG under mutation instead of failing (a bare assert.rejects leaking the spawned gateway, reproducing this repo's own orphaned-suite gotcha), and a test that passed under mutation because it reused one key label 500 times and was caught by the duplicate check rather than the cap. A third mutation passing revealed the length cap has no verdict-level test at all, which is now stated in the test rather than implied. | 0 | about 1.5 h, most of it mutation runs | 0 (no external pass; the three changes are contained and rule 2 did the work) | yes. Three of the four artifacts changed as a result, two tests rewritten and one claim narrowed. Eleventh data point, and the first where the author-side rules caught everything and no external pass was run. |
| 2026-08-03 | fold round 3 items 1-3, torn tail and period rechecks (`da56e1d`) | external caught 7 real (a season check placed before an await that made it prove nothing, a falsy empty-string reason that would have granted, two unchecked awaits before a grant, a claim wider than its stated model, a candidate rule that refused on trailing whitespace, and a missing mutation). Rule 2 caught one first: a mutation PASSED, revealing a test that seeded the tag and took the early branch, never reaching the code under test. | 0 | about 2.5 h | 42,000 over two passes (FIX-FIRST twice) | yes, materially. Three of the seven were defects in the fix itself, not the original code. Tenth data point, and the second time rule 2's mutation step caught something before the checker. |
| 2026-08-02 | fold the four-reviewer chain-anchor round (`cbbb1cd`) | external caught 3 real (an unknown status string still silently dropped, four comments claiming cross-request consistency the design does not provide, and missing coverage for five changed behaviours). Rule 2 caught two on its own, the FIRST author-side catches recorded here: a mutation that did NOT fail its test, revealing the test claimed coverage of a half-defect that is closed by construction, and a test asserting a state the code cannot reach (current() below maxHeight). | 1 refuted (a coercion the type guard above already prevents) | about 2 h including six suite runs | 110,000 over three passes (FIX-FIRST, FIX-FIRST, FIX-FIRST with two of three resolved) | yes, materially. The fold restructured the store, made the coexistence guard unconditional, and corrected two of my own tests. NINTH data point, and the first where an author-side rule caught something first, both times rule 2's mutation step rather than the invariant list. |
| 2026-08-02 | chain-anchor majors, current() adoption order and the end-to-end refresh-path test (`7b3ac96`) | external caught 3 real (a negative test phase that could false-pass against unchanged state when no refresh tick ran; a comment telling a gateway story the gateway path refuses; a test name claiming provable where the probe shows window acceptance). All comment-or-test level, none in the shipped store fix. | 0 | about 50 min including suite and mutation runs | 76,795 over two passes (FIX-FIRST, PROCEED) | yes for the test (the delay-based negative phase was replaced with rejection-report synchronization and re-mutation-checked). Eighth data point: the external pass again caught first, and for the first time every catch was in the verification artifacts rather than the product code, which is the discipline working upstream. |
| 2026-08-02 | chain-anchor blockers, snapshot claims and RPC boundary (`4b45a2c`) | external caught 3 real (duplicate check ran after the validity filter; diagnosis-order regression; no signed-path containment coverage). Author-side rules produced the artifacts (13 mutation-verified tests, invariant list) but caught no defect first. | 1 (a coercion claim the untouched type guard above the regex already prevents, disputed and the checker confirmed the dispute on re-check) | about 45 min including three suite runs | 38,673 over two passes (FIX-FIRST, PROCEED) | yes: the fold restructured the boundary (validation before filter) and added the signed-path containment test that reproduces the original blocker against the old code. Seventh data point: external still catches first. First false alarm recorded. |
| 2026-08-02 | adopt the discipline, add the test gate (`c59efde`) | external, all four (fail-open staged-diff read; concurrency claim wider than the code; a passing-path claim written before the event, twice, the second time inside the fix for the first; lock cleanup that could remove a lock it did not own) | 0 | about 30 min including two suite runs | 32,976 over two passes | yes for rule 5 (the failing path was watched refusing before the external pass ran) and for the fold (hook hardened, two claims narrowed, before landing). No author-side rule caught a defect before the checker, the sixth consecutive data point for that pattern. |
