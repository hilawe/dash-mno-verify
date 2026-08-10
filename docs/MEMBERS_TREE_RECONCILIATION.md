# Members-tree cache reconciliation, the specification

Written 2026-08-10 under the pre-commit playbook's rule 7. The members-tree cache reconciliation crossed
rule 7's mechanical trigger during the internal assurance fold: the A2 strand was repaired three times
across review rounds (a first fix on the wrong path, a redesign, and three follow-on findings inside the
redesign), and each round found its defect inside the previous round's fix. That is the signature of a
unit whose contract was never written down, so the trigger point (the verifier), the rebuild (season.js),
and the ordering rules each carried their own copy of the intended behaviour and the copies drifted. This
is that contract. The code is checked against it.

`core/season.js` `SeasonMembers` holds a per-(season, context) members tree that is a CACHE rebuilt from
the durable registration records in `core/registration_store.js`. `core/verifier.js`
`verifyRegistrationCore` is the only place a registration retry is handled. `core/gateway.js` wires the
two together.

## What it establishes

For the current season, every context's cached members tree eventually reflects ALL of that context's
durable registration records, so a durably registered member can build a valid Merkle path from a
`/v1/members` read without waiting for a season rollover or a process restart.

## What it does not establish (the trust boundary)

- Nothing about a second gateway writing the same durable records. The registration backend is documented
  single-writer, and a multi-gateway Platform deployment imposes its own total order and is out of scope.
- That the cache is correct at every instant, only that it converges. A read taken in the window between a
  strand and its recovery can miss the stranded member, which is why recovery is triggered on the retry
  the member themselves makes.

## The strand this exists to close

The members tree is appended in `SeasonMembers.commit`, in the same serialized section as the durable
write, so a crash between the two re-derives the member on the next RESTART rebuild. Within a running
process, though, the cache is not rebuilt on its own. A durable write can land and its `commit` still
throw AFTER it (the registration store's retry barrier holds but its confirming reread fails), and then
the tree append is skipped while the record is durable. Nothing rebuilds the cache mid-season, so the
member is durable yet absent from the tree until a rollover or a restart.

## The invariants, and where each is enforced

1. THE CACHE IS A DURABLE-RECORD PREFIX AT THE END OF EVERY COMMIT. The tree is appended only in `commit`,
   so it can only lag the durable records, never lead. A strand makes it lag, and a later commit that
   appended onto a lagging cache would assign the new member a tree position below the durable index the
   store hands back, breaking the prefix property and under-counting the capacity guard. So `commit`
   RECONCILES the cache (`_reconcileIfBehind`) before it reads the cached size for capacity or assigns a
   position, and re-acquires the context because the rebuild replaces the object. Because a commit only
   appends, a size deficit is a sufficient divergence test: the cache is behind exactly when it holds fewer
   members than the durable records. A SECOND GUARD then refuses the append when the durable index the
   store assigned does not equal the tree size (`index-tree-mismatch`), so a position and its durable index
   can never disagree even if reconciliation were somehow incomplete.
2. RECOVERY IS TRIGGERED ON EVERY RETRY PATH. A member stranded by a prior request is put back by whichever
   path the retry reaches.
   - The SEQUENTIAL retry short-circuits at `registrationStore.has()` in `verifyRegistrationCore` and never
     reaches `commit`, so recovery is called from that already-registered branch.
   - A retry whose anchor ages out AFTER its proof, because a concurrent request stranded the member during
     the proof, is caught by the post-proof anchor recheck, which re-checks `has()` and recovers before it
     would return stale-or-unknown-root.
   - The CONCURRENT retry that does reach `commit` is reconciled by commit's pre-append `_reconcileIfBehind`
     (invariant 1), so a stranded member is back in the tree before the duplicate is even reported.
3. RECOVERY RUNS BEFORE THE ANCHOR-FRESHNESS RULE, AT BOTH ANCHOR CHECKS. An already-durable registration
   bought its season when it was first proved, so recovering its cache entry does not depend on the current
   DML root being fresh. Both the initial anchor check and the post-proof recheck in
   `verifyRegistrationCore` defer to the duplicate lookup and recovery, after the season and context checks,
   so a stranded member whose anchor has aged out (or who has left the masternode list and cannot make a
   fresh proof) is still recovered. A genuinely NEW registration (`has()` false at both points) still faces
   the anchor rule and is refused on a stale anchor.
4. RECOVERY PRESERVES THE ROOT WINDOW. The rebuild reuses the context's existing `RootStore` object and
   appends the new root, rather than starting a fresh store, so a root a live challenge was minted against
   survives up to ordinary window eviction and an in-flight verification holding the store still resolves.
   Enforced in `_rebuildTreePreservingRoots`, distinct from `_materializeFrom`, which builds a fresh store
   only for a first materialization where there is no prior window to keep.
5. RECOVERY NEVER ROLLS THE CACHE BACKWARD. A rollover queued ahead of a recovery call can advance the
   cache past the request's season while it waits. `recoverMember` checks the cache season and returns a
   `season-rolled` no-op on a mismatch rather than calling `_roll`, which throws under the monotonic clock
   and would surface as a misleading request error. The member's season has ended, so there is nothing to
   recover into the live tree.
6. RECOVERY VERIFIES NO PROOF. The durable record is the authority a proof already established, so
   recovery runs no crypto check. This is why it is safe to reach it on the cheap `has()`/duplicate path
   without a gate slot.
7. RECOVERY IS BOUNDED WORK. An ordinary replay with no deficit pays one durable read and a size compare,
   no tree hashing. A rebuild fires only on a real deficit, and the first rebuild closes the deficit, so a
   caller who reaches this path (past season, context, and the per-client registration limiter) cannot
   drive repeated rebuilds.

## Output, and the member-facing contract

Recovery is a side effect. The retry still answers `already-registered` (`ok:false`), and the member then
reads `/v1/members`, which now serves them because the tree was reconciled. A durable duplicate is
answered `already-registered` rather than `members-tree-full` or `stale-or-unknown-root`, because a
duplicate needs no new leaf and no durable write: a read-only check keyed by the registration nullifier
(the same identity the durable append uses) runs ahead of both the capacity refusal and the durable write.
It is keyed by the nullifier, not the commitment, so it does not mistake a distinct registration that
happens to share a member secret (a different nullifier, the same commitment) for a duplicate. `already-registered` is
deliberately not turned into an idempotent success, because the duplicate path does not verify that the
submitted commitment matches the durable record, so it does not bless a mismatched replay. A future
idempotent success response would have to look up the record for the exact registration nullifier, compare
its commitment, and return its durable index.

## Known residual, refusal reason only

One refusal-reason edge is accepted rather than fixed, because it touches no durable state. When an
already-durable duplicate reaches `commit` exactly as the season boundary crosses, the pre-capacity
duplicate check can answer `already-registered` before the live-season recheck would have answered
`season-rolled-retry`. Both are refusals, the member is already registered for the season named, and the
path writes nothing, appends no leaf, and changes no root, so the only difference is which refusal reason a
rare concurrent retry sees. Closing it would reorder the season recheck ahead of the duplicate check for no
gain in correctness, so it is left as recorded here.

## Test coverage

The invariants are pinned in `test/season_rollover.test.js`: the reconciliation on the already-registered
retry preserving prior roots (invariants 2, 3, 4), a normal commit after a strand keeping leaf order a
durable prefix and the index-vs-tree guard failing closed (invariant 1), the concurrent retry through
`commit` (invariant 2), the post-proof recovery when the anchor ages out during the proof (invariants 2,
3), and the backward-roll no-op (invariant 5). Each fails when its behaviour is reverted, checked by
mutation.
