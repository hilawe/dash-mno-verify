# Pre-commit self-verification, adoption note

The write-time discipline this repository follows before a commit. The playbook it instantiates
lives outside the repository and is not repeated here. This note is the eight items that playbook
says a repository must write down before its rules mean anything locally, written from this
repository's own facts and its own defect history, because rules imported without local specimens
become ceremony.

## 1. Scope

The full five-rule pass applies to changes in `core/`, `circuits/`, `contract/`, `prover/`, and the
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
| 2026-08-02 | adopt the discipline, add the test gate (`c59efde`) | external, all four (fail-open staged-diff read; concurrency claim wider than the code; a passing-path claim written before the event, twice, the second time inside the fix for the first; lock cleanup that could remove a lock it did not own) | 0 | about 30 min including two suite runs | 32,976 over two passes | yes for rule 5 (the failing path was watched refusing before the external pass ran) and for the fold (hook hardened, two claims narrowed, before landing). No author-side rule caught a defect before the checker, the sixth consecutive data point for that pattern. |
