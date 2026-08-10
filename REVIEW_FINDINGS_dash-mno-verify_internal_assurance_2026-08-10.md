# Internal assurance findings, 2026-08-10

Findings from one run of the internal assurance process (`docs/INTERNAL_ASSURANCE_PROCESS.md`) against
the frozen commit `54f5719`. The process substitutes, within a stated ceiling, for a formal third-party
audit. It raises assurance on the systems and application surface (tiers 2 and 3 of
`docs/SECURITY_AUDIT_SCOPE.md`) and performs structural-only work on the tier-1 cryptographic core. It
does not certify circuit soundness. The residual sections at the end state what this run did not and
could not close.

## Method

The run used four model families. A ten-agent reader fleet with repository access read the code slice by
slice under neutral-first framing, with an inverted pass on each load-bearing invariant. A different
model family with repository access reviewed the highest-value slices independently through a
command-line tool. Each candidate was then verified by an independent agent of a different family from
the one that raised it, tasked to refute or reproduce it, and to escalate rather than drop on
uncertainty. Two further model families reviewed the process design before the run and reshaped it. The
verification stage reproduced findings by execution where feasible.

The verification stage confirmed 14 candidates and refuted 7, including two the different-family reviewer
had rated high. The refutations are recorded below so a later round does not re-raise settled candidates.

## Remediation status

The blocker and the two majors are folded, each with a mutation-checked regression test, and each reviewed
by a different model family before it was called done.

- **A1 folded.** The load path now forces a file barrier for a complete, newline-terminated tail before it
  is trusted, closing the unsynced-tail gap. Approved by a different-family pass on the first review.
- **A3 folded.** The direct-node command-line read is asynchronous, so it no longer blocks the gateway
  event loop. Approved by a different-family pass on the first review.
- **A2 folded, after a six-round review loop.** The first fix sat on a path production never reaches; a
  redesign then drew three findings, and a third round found the real structural defect, that a strand
  corrupted every later registration, not just the stranded member's own retry. At that point the unit
  crossed the write-time playbook's rule-7 trigger, so its contract was written to
  `docs/MEMBERS_TREE_RECONCILIATION.md` and the remaining findings folded as divergences from it: `commit`
  reconciles the cache before it assigns a position or checks capacity, an index-versus-tree guard fails
  closed, both verifier anchor checks recover a durable duplicate, and the pre-capacity duplicate check is
  keyed by the registration nullifier. A fresh full pass then returned APPROVE with one non-blocking
  refusal-reason residual, recorded in the contract. The eight contract invariants are confirmed to hold.

FOLLOW-UP FOLD, 2026-08-10. Six of the confirmed minors are now folded, each with a mutation-checked test
except where noted:

- A7 folded. A nullifier-store read that fails before the irreversible spend is tagged `beforeSpend` in
  `core/verifier.js`, and `core/gateway.js` restores the one-time nonce for it rather than burning it. A
  failure at the spend itself is left uncertain and fails closed.
- A8 folded. The per-account challenge rate-limit key drops the context, matching the verify path's
  deliberate account-only keying, so the limit is not multiplied by joining communities.
- A9 folded. `MNO_ORACLE_REFRESH` is capped so its millisecond product cannot overflow the 32-bit timer
  and clamp to 1 ms.
- A10 folded as a startup WARNING (not a boot refusal), because a max-age at or below the refresh interval
  is an unusual but legitimate prefer-refuse-stale choice, so it is flagged rather than forbidden.
- A11 folded. The coinbase parser refuses trailing bytes after the transaction, matching the sibling
  partial-Merkle parser.
- A12 folded. The Matrix sync loop wraps its poll in a try/catch so a transient homeserver error backs off
  and retries instead of crashing the bot. NO automated test: the bot entrypoint is a top-level script
  with hardcoded homeserver dependencies and is not structured for injection, and the fix mirrors the
  loop's existing tested `!res.ok` backoff.

SECOND FOLD, 2026-08-10, folds two more and accepts three residuals.

- A6 folded. `smlMerkleRoot` in `oracle/dml_commitment.js` refuses a masternode list past a 50,000-entry
  bound before it maps, sorts, and double-hashes it, so an oversized node response cannot stall the
  request-serving loop. The mainnet list is near 2,972 and the count is economically bounded to low
  thousands, so the bound is large headroom. Mutation-checked.
- A13 folded. `dmlRoot` and `membersRoot` in `contract/mno-verify.contract.json` now set
  `canBeDeleted:false`, matching the nullifier and registration types, so a published root cannot be
  swapped by delete-then-recreate. Mutation-checked in `test/contract_schema.test.js`.

ACCEPTED RESIDUALS, recorded rather than folded, each for a stated reason:

- A4 and A5, the root-pin edges. Both are self-healing (the challenge nonce is consumed but the nullifier
  is not, so no membership is lost and a re-challenge recovers), and NEITHER is reachable on shipped
  defaults (A4 needs a burst of at least MNO_ROOT_WINDOW registrations for one context inside a single
  challenge's lifetime; A5 needs a lowered root window or a list grown far past today's size). Folding
  them means giving the per-context members RootStore the same pin awareness the DML window has, which
  touches the root-pin architecture that the A2 fold showed is defect-prone, so the risk-to-reward for a
  self-healing, not-reachable edge does not justify the change now. Revisit if a deployment lowers
  MNO_ROOT_WINDOW or the list grows by roughly an order of magnitude.
- A14, the Platform-contract creator restriction. A funded identity could front-run a predictable unique
  key (a future height or season) and, with immutability, block the honest oracle write. The fix is an
  owner-scoped unique index, a contract redesign. The Platform path is not wired in code and is documented
  as not live, and the multi-gateway Platform mode already rests on an operator-coordinated schedule
  rather than the contract, so this is deferred with that path rather than folded now.

The refuted candidates and the tier-1 residuals are unchanged.

## Confirmed findings

Severities are the verifier's independent re-assessment, which downgraded several first-pass ratings once
reachability and blast radius were checked against shipped defaults.

### Blocker

**A1. A complete, newline-terminated registration record is trusted on restart with no file durability
barrier.** `core/registration_store.js` (load and reconcile path, around lines 656 and 719 to 740, 791).
Maps to claim 2 (membership soundness), tier 2, and to the contract in
`docs/REGISTRATION_STORE_DURABILITY.md`.

A registration is appended as `JSON.stringify(record) + "\n"` in one `appendFile`, then a separate
`fh.sync()` forces it. A force-termination between those two awaits leaves a complete, newline-terminated,
unsynced record. On restart a fresh backend has both dirty flags clear, so the barrier-then-load path
never fires, and the torn-tail repair branch is skipped because the line ends in a newline. Only the
directory entry is synced, which forces the name-to-inode mapping, not the data blocks. The maps are
installed and `has()` returns true. Reproduced by execution against `54f5719`: file syncs 0, directory
syncs 1, `has()` true. A power failure after that restart can still lose the record, so a read that
returned true becomes false, the non-monotonic failure the module exists to prevent. The torn-tail shape
(newline stripped) does force the file, which is the asymmetry that isolates the defect.

Direction: on load, force a file-level barrier for a complete-but-unproven trailing record before it is
admitted, matching the torn-tail path, so no public read reflects unsynced bytes.

### Major

**A2. An uncertain durable write that ultimately throws strands a durably registered member outside the
in-memory members tree for the rest of a running season.** `core/registration_store.js` (around lines 997
and 1010) and `core/season.js` (around lines 180 and 196). Maps to claim 2 (membership soundness), tier
2.

When the initial sync throws, the recovery barrier succeeds and makes the record durable, and then the
recovery reconcile read throws transiently, the append rethrows the original error. `SeasonMembers.commit`
sees the rejection and skips the members-tree append, so the durable record is not mirrored in the cache.
On retry the record is seen as a duplicate, so the tree append is skipped again. No path rebuilds the
cached tree from durable records within a running season. Reproduced: durable records `[A@0, B@1]` with a
live tree holding only `[B]`, so the served members root omits the durable member. The member holds a
spent season registration nullifier yet cannot build a valid Merkle path until a rollover or restart. The
machinery at `registration_store.js:960` guards the opposite direction (a failed write reported as a
commit) and does not cover a durable write whose caller throws for a non-durability reason. Gated behind a
rare double-fault interleaving, so major rather than blocker, but an irreversible per-member denial when
it occurs.

Direction: distinguish, at the `commit` boundary, a durable-and-committed record whose post-write read
failed from a genuinely failed write, so the members-tree append is not skipped for a record already on
disk. Or rebuild the cached context from durable records when a commit's post-write step fails.

**A3. In direct-node mode without an RPC URL, a synchronous subprocess call blocks the gateway event
loop.** `oracle/node_client.js` (around lines 105 to 106), reached from `core/gateway.js` refresh
(`refreshRoots`, around lines 775 and 792). Maps to claim 5 (oracle integrity, availability aspect), tier
2.

The command-line branch calls `execFileSync`, and the refresh timer runs `buildDiffSnapshot` on the
gateway's own event loop. Awaiting a synchronous return does not defer it, so each call freezes all HTTP
handling and timers for the subprocess duration, up to the 30 second timeout, and the refresh issues
several such calls. Confirmed by reading the wiring end to end. Confined to the command-line fallback of a
mode already marked not-for-value, and the RPC path is asynchronous and unaffected, and healthy responses
are sub-second, so the freeze is short in normal operation.

Direction: run the node read off the request-serving loop, or use the asynchronous subprocess form, or
refuse the command-line branch inside the gateway process.

### Minor, confirmed

Each is reproduced and real, and each is bounded to a narrow trust model, an operator misconfiguration, or
a liveness edge that self-corrects. They are worth fixing, and none is a soundness break.

- **A4. Two-tier members roots are not covered by the challenge root-pin.** `core/gateway.js:545`,
  `core/season.js` RootStore, `core/stores.js:13`. The F4 pin protects only the single-tier DML window, so
  once `MNO_ROOT_WINDOW` (default 8) registrations land in a context within a challenge's lifetime, the
  members root the challenge was minted against is evicted and a valid proof is refused as
  stale-or-unknown-root. Settled sub-question: the nonce is consumed, the nullifier is not, so no
  membership is lost and it self-heals on re-challenge. Claim 4, tier 2. Could approach major under a
  sustained season-open registration burst.
- **A5. The DML root window can evict a pinned root in two narrow cases.** `core/stores.js:232` (the
  height window ignores the pin) and `core/stores.js:308` (the leaf bound evicts a pinned height when all
  candidates are pinned, which is intended). Not reachable on shipped defaults. Same self-healing failure
  mode as A4. Claim 4, tier 2.
- **A6. A hostile configured node can stall the loop with an oversized but shape-valid list.**
  `oracle/diff_snapshot.js:262`, `oracle/node_client.js:97`. Node-mode only, bounded to about 64 MiB by the
  byte cap, no per-entry count bound, so a maximal response is roughly a 300 ms single stall. Claim 5, tier
  2. A per-entry count bound closes it.
- **A7. A pre-commit internal failure consumes the nonce and is reported as a client error.**
  `core/gateway.js:1245` and `:1557`. A transient nullifier-store read failure before proof verification
  burns the one-time nonce and returns HTTP 400, forcing a new nonce and a regenerated proof. The design
  already restores the nonce for the overloaded transient but not for other transients. Claim 4, tier 2.
  Reasonable reviewers could call the Platform-backend impact major.
- **A8. The per-account challenge rate limit is keyed with the context, so it multiplies per context.**
  `core/gateway.js:1169`. The verify path deliberately keys by account alone and its own comment rejects
  adding the context, so the two paths disagree, and the documented per-account meaning is not enforced on
  the challenge path. The per-source aggregate limit still binds. Claim 4, tier 2.
- **A9. An oversized refresh interval silently becomes a one-millisecond interval.** `core/config.js:42`,
  `core/gateway.js:1025`. No upper bound, and the millisecond product overflows the 32-bit timer so Node
  clamps it to 1 ms, turning "refresh rarely" into fastest-possible refresh. Operator misconfiguration,
  reproduced. Tier 2.
- **A10. A refresh interval longer than the max-age produces periodic loss of service.**
  `core/config.js:99` and `:118` are validated independently. With refresh longer than max-age, the root
  ages out before the next refresh and the challenge endpoint returns 503 until it. Operator
  misconfiguration. Tier 2. A boot-time cross-check closes it.
- **A11. The coinbase parser accepts trailing bytes after the transaction.** `oracle/dml_commitment.js:355`
  does not require the reader to be at end of input, so appending a byte to a valid coinbase yields the
  same parsed height and masternode root and is accepted, while the sibling partial-Merkle parser does
  reject trailing bytes. Reproduced. End-to-end forgery is closed by the caller's X11 block-hash and
  proof-of-work checks (`oracle/diff_snapshot.js:231`), so this is a parser-strictness gap, not an
  exploitable one. Claim 5, tier 2.
- **A12. The Matrix adapter sync loop crashes the process on a transient homeserver error.**
  `adapters/matrix/bot.js:256`. The top-level `for(;;)` loop does not wrap its fetch, so a connection reset
  or a non-JSON 200 is an unhandled rejection that terminates the bot, while the same file's request
  handlers catch. Reproduced. Tier 3.
- **A13. Two Platform-contract types are immutable but deletable.** `contract/mno-verify.contract.json`
  root types set `documentsMutable:false` but omit `canBeDeleted:false`, which the nullifier and
  registration types set, so a root can be swapped by delete-then-recreate at the same key. Owner-only, and
  the Platform path is documented as not live. Claim 5, tier 3.
- **A14. Platform authority documents have no creator restriction.** `contract/mno-verify.contract.json`
  sets no creation restriction, so a funded identity could front-run a predictable unique key (a future
  height or season) and, with immutability, block the honest oracle write. The Platform path is not wired
  in code and is documented as not live. Claim 5, tier 3. Scoping the unique index to the owner identity
  closes it.

## Refuted candidates, recorded so they are not re-raised

- **R1. The partial-Merkle parser does not amplify a small input into many allocations.** The read guard
  throws on truncation as soon as 32 real bytes are unavailable, so the buffer count is bounded by input
  bytes over 32, a one-to-one factor, not the 900,000 allocations claimed. An a-priori count bound is
  legitimate hardening but the described denial does not hold.
- **R2. The season boundary crossing during an awaited append is not a defect.** The members tree is a
  cache rebuilt from durable records, the record is written scoped to its season, and the verify path binds
  the season to the guarded clock, so no stale-season root is honored. The absent post-append recheck is a
  deliberate omission, because a recheck could only trigger a compensating delete, a worse failure mode.
- **R3. A challenge minted near a season boundary carries a consistent season and root.** There is no yield
  between sampling the season and materializing its tree, so the stored root always matches the stored
  season. The verify-in-next-season rejection is the intended recoverable behavior.
- **R4. The non-unique registration season-index cannot collide on a built path.** The leaf index is
  bucket-scoped and assigned by a single serialized writer, the load path refuses gaps, and leaf order is
  re-derived rather than read from the stored index. Making the index unique would wrongly reject
  legitimate registrations from different contexts in the same season.
- **R5. The web adapter's session deadline fails closed on every malformed value.** The numeric comparison
  admits only a finite future value, and every value a JSON response can carry (missing, null, string,
  boolean, object) yields no admission. The other adapters guard it because their sweep arithmetic
  misbehaves on NaN, not because the web path fails open.
- **R6. Discarding the voting-address version byte is correct.** The commitment hashes the 20-byte voting
  key id, not the base58check version prefix, which is a display artifact outside the consensus commitment.
  Same key id means the same correct leaf.
- **R7. String-coercing the service value does not produce a wrong-but-accepted encoding.** A single-element
  array stringifies to the scalar and yields the correct canonical 18 bytes. Multi-element arrays and
  objects fail the strict host and port parse. It is a many-to-one map onto the right bytes, not a
  collision.

## Structural-noted, tier-1 (from the structural-only circuit slice)

These are within non-specialist reach and are observations, never soundness verdicts.

- The committed verification keys are the only build outputs under version control, so nothing in the
  repository binds a committed key to the committed circuit sources. A rebuild-and-compare would close it.
  The committed membership triple verifies and the public-signal counts match the sources.
- The universal setup artifact is fetched over HTTPS with no checksum pin, unlike the key manifest which
  checksums every artifact. A substituted artifact would break the deterministic-rebuild claim silently.
- The two large proving keys carry empty checksum and URL fields, so they can only be rebuilt, not
  fetch-verified. This is a documented deliberate deferral.
- The nullifier construction matches the documented hash order, arity, and epoch, season, and context
  binding across all three circuits. Whether the arity-based domain separation between the commitment and
  the nullifier is sufficient is a soundness question reserved for the specialist.
- Baseline captured for a later specialist and a later commit: constraint counts are members 9,341,
  membership 253,845, registration 254,259, all at tree depth 16, and the dependency pin resolves to the
  stated commit. The library dependency uses a caret range rather than an exact pin.

## Seams and residuals this process did not own

- The composition-only seam reader traced the challenge-to-verify and oracle-adoption paths and did not
  find a distinct cross-module defect beyond A4, which it corroborated. The Platform multi-gateway path and
  the zkVM registration path were not exercised, consistent with their being out of scope and not live.
- Author framing is reduced by neutral-first and inverted passes but not eliminated, since the author
  froze the commit and cut the slices. Two of the four families had no repository access, so their role was
  to raise candidates and critique, not to close.

## What remains for a specialist

This run does not, and by the stated ceiling cannot, close the tier-1 soundness questions. These are the
items a paid engagement exists to answer, unchanged by a clean systems-and-application pass.

- Circuit constraint soundness: whether the constraint system admits a witness that does not correspond to
  a real masternode voting key, including under-constrained signals and the sufficiency of the arity-based
  domain separation noted above.
- The third-party circuit dependency, which its own documentation states is unaudited and not for
  production, and which sits on the single-tier critical path.
- Correct use of the proving-system setup and whether the committed verification keys correspond, as a
  cryptographic fact rather than the structural rebuild-and-compare check, to the committed circuits.

A clean run of this process is evidence that the systems and application surface has been worked hard. It
is not evidence that the circuits are sound.
