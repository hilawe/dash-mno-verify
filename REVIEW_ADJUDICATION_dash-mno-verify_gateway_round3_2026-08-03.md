# Whole-gateway round 3, four-reviewer adjudication

Four reviewers on the gateway surface at `2c73d1f`. Verdicts: three BLOCK, one
APPROVE-WITH-FIXES. This file is the cross-check, which is the step that decides what gets folded
and in what order. A finding two independent model families reached is far more likely real than
one a single reviewer argued well, and one that reproduces beats both.

Reviewers are described generically per the authorship rule. Family A ran with repository access
and could execute probes. Families B, C, and D reviewed a self-contained packet with no repository
access, so anything they say about runtime cost is reasoned rather than measured.

## Refuted, and why the check mattered

**A fresh-deployment boot failure in the SQLite nullifier store, reported as a blocker.** The claim
was that `chmodSync` runs before the database file exists, so a first boot dies with ENOENT. It
does not. `new DatabaseSync(path)` runs first and creates the file, and the `chmod` follows. Tested
directly on a fresh path: the store constructs, and the file lands at mode 600. The reviewer had
the two statements in the wrong order.

This is the round's reminder that a confidently-argued blocker from a packet reviewer with no
repository access is a hypothesis. It cost about a minute to refute and would have cost an hour to
"fix".

## Confirmed by two or more families, fold these first

| # | Finding | Families | Status |
| --- | --- | --- | --- |
| 1 | The window retained the parsed snapshot object, so a padded but validly signed snapshot was held at every height | 3 | FOLDED in `ff2b663` |
| 2 | A registration can commit after its season has ended (the handler samples the season before the proof, the commit compares only cached state) | 2, both reproduced | OPEN |
| 3 | One valid member can allocate unbounded context trees | 2 (one calls it a blocker) | OPEN, policy DECIDED |
| 4 | Every members-root update rebuilds a full depth-16 tree on the event loop | 2, one measured | OPEN |
| 5 | A torn last line in the registration file permanently refuses boot | 2 | OPEN, REPRODUCED HERE |
| 6 | Health reports ready with no DML root in single-tier mode | 2 | OPEN |

Finding 5 was found by neither the repository-access reviewer nor any earlier round, and it
reproduces in one command: write a registration file whose last line is truncated mid-record, and
`FileBackend.#load` throws an unhandled `SyntaxError` from `JSON.parse`. A crash or power loss
during the append window is enough to produce that file. The registration record is this project's
stated atomic commit point, so a transient crash turns into a durable outage of the whole two-tier
path until an operator hand-edits the file.

Finding 1 is folded, but ONE REVIEWER WENT FURTHER and the extra part is still open. Normalizing
the record stops a source padding it with junk. It does not stop the legitimate leaves themselves
multiplying: at the default eight-height window with both orderings retained during a changeover,
sixteen full leaf arrays can be held at once. That bound is legitimate data and no signature check
or normalization touches it. Treat it as a separate open item, not as covered by `ff2b663`.

## Single-family findings judged real

Ranked by how much they matter, not by who found them.

- **Verification can cross the period it was checked in.** The root, epoch, and season are checked
  BEFORE the expensive proof and never again, so a proof that finishes after a boundary can spend a
  nullifier and return success against a period that has ended, and a two-tier verifier keeps a
  detached root store after a rollover cleared it. This is the most serious single-family finding
  and no other reviewer raised it. It needs its own verification before folding.
- **Registration turns root-window grace into a full-season credential.** Registration accepts any
  windowed root, so a masternode that has just left the list can register against a still-windowed
  older root and hold membership for the whole season. That contradicts the stated rule that
  seasonal re-registration re-proves current control.
- **Two-tier memory mode drops the durable clock guard while keeping durable registrations**, so a
  backward clock step across a restart can rebuild a finished season's tree.
- **The signature array is unbounded and each entry's own key label is ignored**, so a host that
  cannot forge a quorum can still buy synchronous verification work (10,000 invalid checks measured
  at about 1.28 s).
- **Authenticated adapter traffic shares one rate-limit bucket**, because every adapter makes the
  request itself, so one user can deny challenges to everyone behind that adapter.
- **Platform nullifiers are not bound to the epoch schedule**, while both local durable stores
  refuse to open under a changed one.
- **`/v1/dml` has no rate limit** while returning the full leaves array.
- **The registration file is not atomic under write uncertainty**: an append that succeeds while
  close reports an error can duplicate a record on the next load.
- **An invalid `MNO_MODE` silently selects single-tier** and echoes the unvalidated string to
  clients.

## What the round says about the process

- The fixes from the previous round were again the highest-risk surface. Three families
  independently found the same defect inside the previous round's own fix. That is five consecutive
  rounds with the same shape, and it is the argument for the fresh-full-round-after-convergence
  rule rather than trusting a focused confirmation.
- The two-tier path had never been reviewed before this round and produced the majority of the
  serious findings. Surface that has never been looked at is worth more than surface that has been
  looked at four times.
- The packet reviewers with no repository access produced both the refuted blocker AND the
  reproduced torn-line finding that the reviewer with access missed. Neither mode dominates.

## Recommended fold order

1. The torn-line boot failure. Smallest fix, reproduced, and it is a durable outage of the atomic
   commit point.
2. The season-commit race, and the period-crossing verification finding beside it, since both are
   the same shape (a value sampled before an await and trusted after it).
3. The signature-entry bound and the `MNO_MODE` validation, both contained.
4. The context allowlist. DECIDED 2026-08-03: a configured allowlist, rejecting an unknown context
   before the proof verify.
5. The registration anchor policy, the rate-limit keying, the Platform schedule binding, the
   `/v1/dml` limiter, and health readiness.
6. The members-tree rewrite and the retained-leaves bound, as their own change with their own
   review. Both are architectural and neither belongs in a fold.
