# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-07-29

`main` at `f482028`, pushed, clean tree, 285 tests green (`npm test`, about two and a half minutes).
Node 22.13 or newer. Read this section, then `TODO.md`.

### Where the project is

Unchanged in substance from the sections below. Anonymous zero-knowledge proof of masternode control,
gating a private community. Oracle reads the deterministic masternode list and publishes a Merkle root,
a platform-neutral gateway verifies proofs and issues short access grants, four adapters apply them.
Working prototype, validated on real mainnet data, NOT audited. Do not gate anything of value.

Everything this session touched is the DISCORD ADAPTER and the shared adapter grant ledger. The gateway,
circuits, provers, and oracle are as the sections below describe, apart from one oracle item noted in the
punch list.

### What changed this session

The adapter grant ledger moved from a JSON file rewritten in full behind one global promise queue to a
per-row SQLite store (`node:sqlite`, no npm dependency). Then the Discord access-application code was
rewritten repeatedly under review pressure. Eight review rounds, eight rejections, all folded.

The ledger, settled and reviewed clean:

- `DatabaseSync` is synchronous, so an observation and its durable write are the same instant. That
  deletes the defect shape four earlier rounds kept finding, where state was updated in memory, the
  durable write was enqueued behind the operation doing the updating, and a decision reached the caller
  in between.
- Per-member locking, not one global queue. One member's slow platform call blocks nobody.
- Single-writer enforced by `PRAGMA locking_mode=EXCLUSIVE`. Refused a second opener 90/90 under six-way
  concurrency, independently confirmed by a reviewer including with the holder suspended.
- One clock sample per decision. `#observeClock()` returns it; nothing re-samples.
- Revisions from a database-wide counter, never reused, seeded above existing rows on upgrade.
- Legacy JSON adopted once in a transaction, source renamed `.migrated` only after it commits.

### THE DISCORD PERMISSION PROBLEM, read this before touching that adapter

This consumed most of the session and produced eight rejections. The lesson is not a bug list, it is a
shape.

**Discord permissions are a surface other people edit concurrently, and there is no compare-and-set.**
Every attempt to have the bot reason carefully about permissions it did not set produced a defect worse
than the one it fixed:

- Attempt 1: clear all three managed bits to `null`. But `null` removes the DENY as well as the allow,
  so revoking access from a member an admin had explicitly excluded lifted the exclusion and a
  role-level allow let them in. **Removal granted access.** Survived six rounds because everyone,
  including me, kept asking whether removal removes and never whether it could grant.
- Attempt 2: preserve denials by reading the overwrite first. That is a read-modify-write against a
  CACHE, so a denial the cache had not seen was wiped by the code written to protect it. Also refusing
  to grant over a denial made the ledger's uncertain-apply cleanup strip the member's pre-existing
  access, so declining to grant took access away.
- Attempt 3, current: **the bot owns the per-member overwrite slot on a gated channel.** It refuses to
  touch one carrying a denial, quarantines that channel, and says so. Exclusions are expressed with
  role-level denies. Clearing is unconditional, valid only because of that refusal.

**The guard must sit at the mutation, not at startup.** A startup gate covers the current, reachable
target of one process. `revokeAccess` acts on whatever the record names. The decommission command is a
separate process on a target the bot no longer manages. All four reviewers found that gap independently.

**Residual, documented not solved.** The per-mutation check reads a cached overwrite, so a denial set
moments earlier can still be cleared. This cannot be closed. The claim is narrow on purpose: the bot
refuses to touch a conflict it can SEE.

**Role mode must be monotonic.** Any denied bit on any channel refuses startup, not just the three
managed ones. A role denying `Connect` inverts voice access exactly as one denying `ViewChannel` inverts
text. Adding such a role removes access; removing it grants.

**One ledger serves one guild.** Records carry `guildId`. `isNotOurs` is deliberately separate from
`isGone`, because "cannot act here" is not "nothing to act on": conflating them let a repoint delete the
records of access still live in the old server.

**Channel mode is the default** because a Discord role is visible on the profile card and so discloses
who holds a masternode, which is the fact the proof protects. Role mode warns. Any deployment with a
role id and no explicit `DISCORD_GRANT_MODE` is refused until it states one.

**Bulk removal is a command, not startup behaviour.** `npm run discord:decommission -- <target>`,
preview by default, `--apply` to act, contradictory flags refused. Three rounds of trying to make this
automatic produced a blocker every time, because the program was deciding to delete access from a
reconstruction of an earlier configuration. Startup only REPORTS stale targets, and that report is best
effort: it sees only targets surviving ledger rows still name, so its absence proves nothing. Operators
decommission on every repoint.

### HOW TO RUN REVIEWS ON THIS PROJECT, the most transferable thing learned

Framing changed the results more than the code did.

1. **Never frame a packet as "confirm these fixes".** A round framed that way had two model families
   both return APPROVE on code containing a reproducible blocker that was in the file they were given.
   One examined the exact broken case and reasoned it away in writing.
2. **Tell reviewers to hunt TWINS.** Every round found a fix applied where the previous reviewer pointed
   with the identical shape surviving nearby. Naming that pattern in the packet started producing those
   findings directly.
3. **Ask whether an operation can do the OPPOSITE of its purpose.** This single question found the worst
   defect in the component's history after six rounds had missed it. Generalise it: can revoking grant,
   can granting remove, can a guard cause a larger failure than it reports, can reporting-only code
   mutate, can refusing to start be worse than starting.
4. **Ask whether a SIMPLIFICATION quietly removed a guarantee.** Deleted code cannot be reviewed by
   reading what remains.
5. **Ask reviewers to separate what they READ from what they could only INFER.** Packet reviewers cannot
   run `discord.js`; both wrote confident completeness claims about exactly that. Given the split, they
   used it honestly.
6. **The executing reviewer does the load-bearing work here.** Every correct finding came with a
   reproduction; every wrong finding, and every missed blocker, came from reasoning alone.
7. **Check that a pasted review describes code that still exists.** Two rounds were partly wasted on
   reviews of superseded commits. Grep the packet for the identifiers the fix introduced before trusting
   it, and rebuild packets from the current commit every time. Delete stale packets from `~/Downloads`.
8. **Watch for identical reviews.** One round produced two byte-identical "independent" reviews. Two
   families do not write identical prose; that is one data point, not two.

### Gotchas that cost real time

- `node --check` passes on a temporal-dead-zone error. Import the module to catch initialization order.
- `await new Promise(() => {})` does NOT keep Node's event loop alive. A test holder using it exited with
  code 13, released a lock, and produced a false blocker I committed and then withdrew. `kill(pid, 0)`
  succeeds on an unreaped zombie, so it reported that holder "alive".
- An edit can silently fail to match and leave the file unchanged. I reported a test fix as landed when
  it had not applied. Read the file back; do not trust the edit.
- `typeof [] === "object"`, so an array slipped a marker schema check.
- 53 tests bind loopback and fail with `EPERM` in review sandboxes. Not real failures.
- `an aged-out root is dropped at request time even between refresh ticks` is a slow, timing-sensitive
  gateway test that flakes occasionally. Passed on re-run at 7 to 9 seconds.
- Sixteen tests were found across these rounds whose names claimed coverage their assertions did not
  provide, several of them mine. When writing a test for a crash, terminate something. When writing one
  for ordering, record the sequence.

### Punch list, in order

1. **A fresh round on `f482028`.** Eight rounds, eight rejections, and the last one's fixes have not been
   reviewed. Build packets from the current commit; use the framing above.
2. **A periodic re-check of the current target**, not only at startup. A startup pass is a snapshot, so
   an effect Discord applies after it runs waits for the next restart. Cheap in channel mode.
3. **Confirm the `dash-cli` read buffer against a real node.** `MNO_CLI_MAX_BUFFER` (64 MB) was reasoned
   from the 1 MB default, never observed failing. One oracle run against a full node settles it.
4. **The three smaller items**: prevention rather than recovery for an implausible forward clock jump, a
   model-based crash harness that interrupts at every write boundary, and deciding what mixed
   `hashVersion` gateways in one cluster should do.
5. **Direct node mode** and **the durable privacy-preserving Platform claim**. These two are what
   actually gate real use, and neither has been started.
6. **An audit.** Still none. Do not gate anything of value.

### Breaking changes for any existing deployment

- Adapter ledgers are SQLite: `DISCORD_GRANTS_DB`, `TELEGRAM_GRANT_LEDGER_DB`, `MATRIX_GRANT_LEDGER_DB`.
  The old variables now name the JSON file to import once.
- Matrix and Telegram refuse a ledger record with no room or chat id.
- Discord defaults to channel mode; a role id with no explicit `DISCORD_GRANT_MODE` refuses to start.
- Discord refuses to start on a role carrying any deny overwrite, or on ledger records from another guild.
- Keep adapter ledgers on local storage. SQLite locking is unreliable on network filesystems.

## CURRENT STATE, 2026-07-26 (after the third review round)

277 tests green, nothing skipped. `main` is pushed.

### What the round found, and what it cost to check

Two plain defects of mine, both fixed and both pinned by tests that fail against the code they were
written for. `grant()` was the fourth clock decision site and the one missed when the other three were
fixed, so it could refuse a renewal on a reading it never persisted. And the revision counter restarted
at 1 on any database lacking it, which is exactly the shape of a database written by the previous
commit, so the backstop failed on precisely the databases needing it.

### The episode worth remembering

Rewriting the exclusion test properly (the reviewer correctly said two ledgers in one process prove
nothing) appeared to show the exclusive lock leaking about one run in six under concurrency. It does
not. The holder child ended with `await new Promise(() => {})`, which does NOT keep Node's event loop
alive, so it printed its ready signal and exited with code 13, releasing the lock. The diagnostic said
the holder was "alive" because `kill(pid, 0)` succeeds on an unreaped zombie.

With a holder that stays alive, and the parent asserting liveness before concluding anything, a second
opener is refused 90 out of 90 under six-way concurrency, and a reviewer had independently confirmed
refusal including with the holder suspended. A false blocker was committed and then withdrawn in the
next commit; both are in the history deliberately.

The lesson is the one the reviews keep teaching from the other side. A test that does not do what its
name says will mislead in whichever direction it happens to fail. Eight such tests were found by
reviewers across three rounds; this one I wrote myself and it produced a false alarm rather than a
false pass. Assert the precondition before trusting the conclusion.

### Where single-writer actually stands

Enforced by the database on local storage, with two limits that are real and now stated everywhere
rather than implied:

- **Local storage only.** The exclusion is the filesystem's, and SQLite documents that locking is
  unreliable on network filesystems, where two hosts can both believe they hold it.
- **Process life only.** A process terminated between a platform request being accepted and taking
  effect releases the lock with that request still in flight. A replacement can expire the grant,
  remove it, and forget the member, after which the request lands. No local lock closes this. The real
  mitigation is startup reconciliation against platform state, which Matrix has and Discord does not.

### Next

1. The three `_r3` review packets are still outstanding and predate today's fixes.
2. Discord startup reconciliation, the only real mitigation for the terminated-mid-request gap.
3. The oracle read-buffer check against a real node.

## CURRENT STATE, 2026-07-26 (third attempt at one property)

273 tests green. The adapter grant ledger is a SQLite database. Read the section below for what that
change is and why; read this section for what was wrong with it twice.

### The property, and two failed attempts at it

The property is that a grant and a removal for one member must never interleave. Within one process a
per-member promise chain gives it. Across processes nothing did, and two reviewers reproduced live
platform access with no ledger record behind it, which nothing can then take away.

The first attempt claimed SQLite closed this "by construction". Wrong: SQLite serializes individual
statements, and a grant is a statement, then an await on a platform call, then another statement.

The second attempt was a lease row with a staleness timeout. Also rejected, and the reasons are worth
keeping so nobody rebuilds it. The timeout has to exceed the longest quiet period, and the default
sweep intervals of 60 and 300 seconds were already longer than the 30-second window, so a live but
idle bot lost its ledger routinely. The old owner's next operation silently took the claim back,
because refreshes were not conditioned on still holding it. A backward wall-clock step made the age
negative, which read as stale and handed the ledger over. And no adapter released it on shutdown, so
the documented immediate restart never existed. Every one of those came from having to decide when a
claim had gone stale.

### What it is now

The database is opened with `PRAGMA locking_mode=EXCLUSIVE`. The kernel holds it for the life of the
process and releases it when the process ends, however it ends. A second process is refused. There is
no staleness window, no heartbeat, no ownership fencing, and no signal handler to forget. A test
really terminates a child process and restarts immediately.

Tests that need to inspect the database while a ledger is open pass `exclusive: false`, which is a
test seam in the same spirit as `putFn`. Production passes nothing and gets the lock.

Two other defects from the same round, both single-process and both real:

- The clock was sampled TWICE per decision, once to persist and once to decide, and time can cross an
  expiry boundary between them. `#observeClock()` now returns its sample and every decision uses that
  exact value. This was the same "acted on state that was not durable" shape the SQLite move was meant
  to end, surviving where there were two observations rather than one.
- The row revision restarted at 1 on every insert, so a row could be deleted and reinserted at the
  same revision and a stale conditional delete would match the fresh row anyway. It is now a
  database-wide counter that is never reused.

### On the reviews themselves

Six tests were found to claim coverage they did not provide, including ones written in this session.
The worst was a "process that died" test that kept the supposedly dead instance running in-process.
Both are rewritten. When writing a test for a crash, terminate something.

One process note: the Grok packet used in the last round was the earlier build, so its findings were
against superseded code and added nothing. Rebuild every packet from the current commit, and check the
reviewer is describing code that still exists before acting on it.

### Next

A fresh round over this, the third on the same property. Build packets from the current commit.

## CURRENT STATE, 2026-07-26 (the SQLite migration)

The adapter grant ledger is a SQLite database now, not a JSON file rewritten in full behind one global
queue. 268 tests green. Everything in the round-4 section below still stands except where it describes
the ledger's storage.

Why it matters more than a storage swap. Four rounds found defects in the old arrangement, and the
recurring shape was always the same: state updated in memory, the write that would make it durable
enqueued behind the operation doing the updating, and a decision returned to the caller in between.
`node:sqlite`'s `DatabaseSync` is synchronous, so observed and persisted are now the same instant and
there is no window to lose. Nothing enqueues a save any more because there is no save to enqueue. The
only asynchronous things left are the platform calls themselves.

Locking is per member instead of one global queue, so a slow platform call for one member no longer
blocks every other member's grant.

On running two adapter processes against one ledger, be careful, because the first version of this
section claimed more than was true and a review round rejected it. SQLite serializes individual
statements. It does not serialize a grant or a removal, each of which is a statement, then an await on
a platform call, then another statement. The per-member lock that spans that gap is a promise chain in
memory and binds only its own process. Two processes could therefore interleave a removal and a fresh
grant for one member, and an unconditional delete then discarded the fresh row and left live access
with no record. Two independent reviewers found it, one with a reproduction.

It is closed in two layers, and the distinction matters if anyone touches this. The sweep's delete is
conditional on the row revision it read, which does not make two processes safe but makes the worst
case recoverable, meaning the record survives and a member whose access was removed by a stale sweep
gets it back by re-verifying. A startup lease then stops the situation arising: a second process
refuses to start while a first holds the ledger, a clean shutdown releases the claim so an ordinary
restart is immediate, and a claim left by a process that died goes stale after 30 seconds and is taken
over. Shared state itself does behave as described, since the clock floor is read from the database on
every observation and raised with a MAX so a lagging process cannot pull another's floor down.

Operationally: the database path is `DISCORD_GRANTS_DB`, `TELEGRAM_GRANT_LEDGER_DB`,
`MATRIX_GRANT_LEDGER_DB`. The old variables keep their old meaning and name the JSON file, which is
imported once on first start, in one transaction, and only then renamed with a `.migrated` suffix. An
interrupted migration leaves the database untouched, and a malformed record fails the whole migration
rather than adopting part of it.

### The 2026-07-26 round

Four reviewers, three verdicts worth recording. Two independent model families found the cross-process
blocker above, one with a working reproduction, which is the strongest signal this process produces. A
third found a genuine minor, where two processes could both migrate the legacy file and the second
would then fail on a rename whose source the first had already moved; a missing source is now treated
as already done. A fourth reported that the write-ahead log files were left world readable, and that
one is a false positive: the modes were checked directly here and by two of the other reviewers, and
they are 0600 in both the fresh case and the already-in-WAL-mode reopen case it described. The
directory is now created 0700 anyway, since that costs nothing.

Worth carrying forward as a process note: the reviewer that reasoned without running anything produced
the only wrong finding, and the two that reproduced their claims produced the right ones.

Next: the fix above changes a locking model, so it wants a fresh round rather than a focused
confirmation.

## CURRENT STATE, 2026-07-25 (late session, round 4)

### Read this first

A FOURTH review round ran after the section below was written, and its fold is the newest state.
`main` is now past `04144c1`, 263 tests green.

Round 4 was a full-repo-access review deliberately aimed at what no earlier round had read, namely
the code that changed after the round-3 packets were built plus the modules never packaged at all.
It returned ten findings and, unlike every earlier round, no false positives. Seven were in the
never-reviewed set, which is the finding about the process as much as about the code.

All nine actionable findings are folded and each was verified against the code first. The tenth
(`membersRoot` not context-scoped) was already recorded in the P1.5 Platform schema item and needed
nothing. `TODO.md` now has the "P1, from the 2026-07-25 review rounds" section that the previous
handoff pointed at but that had never been written, carrying both the five round-3 leftovers and the
round-4 residuals.

The one that matters most: the two-tier prove command shown to members named
`--secret member.secret.json`, a file registration has never created, and passing an explicit
`--secret` switches the prover out of the context lookup that would have found the real one. That
path had presumably never worked for anyone following the instructions, and the same wrong command
was in three docs. Three deep rounds missed it because they were all looking at concurrency. The
replacement test cross-checks any named path against `defaultSecretPath`, so the flag cannot come
back in a form registration does not produce.

Also folded: the grant rejection now persists the clock it refused against before returning (its test
fails against the old code, verified by reverting); Matrix and Telegram act on the target recorded in
each grant rather than whatever is currently configured, with orphan revocation on a target change;
the Telegram reconciliation gate prints a recovery command that actually satisfies the gate, verified
by round-tripping it; the Discord interaction handler no longer ends the process on a transient
gateway failure; the oracle has read timeouts and publishes atomically; and the web adapter drops
lapsed sessions and bounds its request body properly.

Two things to carry forward. The `dash-cli` buffer raise is reasoning from the 1 MB default, not an
observed failure, so it wants one run against a real node. And Matrix and Telegram now refuse to load
a ledger record with no room or chat id, which is a breaking upgrade for any existing deployment.

The recommended next step is unchanged and now has four rounds behind it: move adapter grant state to
SQLite instead of patching the file-and-queue machinery again.

## CURRENT STATE, 2026-07-25 (earlier session, superseded above for anything that conflicts)

### What this is

An anonymous zero-knowledge proof that someone controls a Dash masternode, used to gate a private
community without revealing which node or address. An oracle reads the deterministic masternode list
(DML) from a Dash Core node and publishes a Merkle root the proofs are checked against. A
platform-neutral gateway verifies proofs and issues short access grants, and four adapters (Discord,
Telegram, Matrix, web) speak to it. Two proving modes: single-tier (`MNO_MODE=single`, one membership
proof per epoch) and two-tier (a heavy seasonal registration proof plus a cheap per-epoch members
proof). Read `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, and `docs/DEPLOY.md` first. Status: working
prototype, validated on real mainnet data, NOT audited. Do not gate anything of value until the
`TODO.md` blockers are closed and it has had an audit.

Repo: `~/Code/dash-mno-verify`, public at `github.com/hilawe/dash-mno-verify`.

### Where things stand

`main` is at `e3f8787`, pushed, clean tree, 251 tests green (`npm test`, about two minutes).
Node 22.13 or newer is now required (the durable store uses `node:sqlite`).

The 2026-07-24/25 work closed the adversarial-review findings across the gateway, both provers, the
durable stores, and the adapters. THREE full multi-model rounds were run over it. Every one returned
REJECT, and rounds 2 and 3 found their defects predominantly IN THE PREVIOUS ROUND'S FIXES. All
confirmed findings are folded; what remains open is recorded in `TODO.md` under
"P1, from the 2026-07-25 review rounds".

What landed (each verified against the code before folding, several reviewer claims were false or
already fixed and were rejected with reasons):

- A durable per-epoch nullifier store (`core/nullifier_sqlite.js`, `node:sqlite`), now the default.
  `MNO_STORE=memory` and `MNO_NULLIFIER_PATH=:memory:` both need `MNO_ALLOW_EPHEMERAL_NULLIFIERS=1`.
  Mode set before enabling WAL (the -wal/-shm siblings inherit it), directory mode enforced each boot,
  hourly pruning that keeps the current epoch plus `MNO_NULLIFIER_RETAIN_EPOCHS`.
- A monotonic clock guard in the gateway (`core/time_guard.js`): persisted high-water epoch and
  season, fail-closed on unreadable, malformed, or half-malformed marks, flushed to disk, persisted
  regression, and a 503 plus `ok:false` on `/v1/health` while regressed.
- Schedule namespacing: both durable stores record the epoch/season schedule (`scheduleId`) and refuse
  to open under a different one, because changing a length renumbers every period and could otherwise
  rebuild a historical season's registrations. A store predating the header needs `MNO_ASSUME_SCHEDULE=1`.
- Members-tree capacity checked BEFORE the durable write. Past capacity an odd overflow throws and a
  power-of-two overflow silently builds a deeper tree whose root no path can reach; both are refused.
- Member secret handling (`prover/secret_file.js`): exclusive create at 0600, fsync of file AND
  directory, pending-then-accepted status, atomic promotion via a unique temp plus rename, selection
  by context AND season, refusal to reuse a secret from another context. `--voting-key-file` and
  `--voting-key-stdin` added; `--voting-key` still works but warns.
- Adapter access lifecycle (`adapters/common/grant_ledger.js`, extracted from Discord and shared).
  Telegram admission is bound to the verified account via a join-request flow (the old invite link was
  a bearer token anyone could use); admission runs inside the ledger queue so a sweep cannot delete
  the record mid-approval; grants record their chat/room and context; Matrix self-reconciles and
  Telegram gates startup until an operator establishes a closed state.

### The clock design, because it was rewritten three times

Expiry is judged against the wall clock FLOORED AT THE HIGHEST VALUE EVER OBSERVED. Two reviewers
pulled in opposite directions and both were right: a rolled-back clock must not revive an expired
grant, and treating any regression as "revoke everything" turned a one-second NTP correction into a
mass revocation. The floor does neither. Consequences that MUST be preserved if this is touched:

- `grant()` judges an INCOMING deadline against unfloored `now()`. The gateway owns that deadline; using
  the floor there meant a forward glitch rejected every new grant until wall time caught up.
- `sweep` and `admitIfLive` judge EXISTING grants against the floor.
- Every path that observes the clock must persist (`#persistIfMoved`), because an advance is evidence:
  once a grant is treated as expired under a high mark, losing that mark revives it.
- A regression sets the flag WITHOUT moving the mark, so persistence compares both.
- `TELEGRAM_RESET_CLOCK=1` / `MATRIX_RESET_CLOCK=1` is the operator way back from a floor poisoned by a
  large forward jump. Prevention (monotonic-elapsed jump detection) is NOT built and is in `TODO.md`.

### Standing policies and gotchas

- Verify every review finding against the code before folding. This session saw a review of an
  ENTIRELY DIFFERENT codebase, several confident false positives, and findings already fixed. It also
  saw real defects in my own fixes three rounds running, so the fold itself always gets reviewed.
- Tests caught three defects that reviews did not: a nondeterministic sort, an unobserved clock in
  `grant`, and a `__meta` key colliding with the platform user-id keyspace. Keep writing the test that
  tries to break the fix.
- Two test files need loopback listeners; a sandboxed reviewer will see 53 EPERM failures that are
  environment, not defects.
- Public repository: no AI tool is named in any committed file, and a review is described generically.
  Scan before pushing.
- Anything in `~/Downloads/` is a view-only copy, never a source. THIS file is the session log.

### Punch list, in order

1. RECOMMENDED NEXT: move adapter grants and clock metadata to a transactional store (SQLite).
   All three rounds found defects in the whole-file rewrite, hand-rolled queue, and manual fsync
   ordering, and the last two found them in the fixes for the round before. Both reviewers
   independently recommended this over further patching. See `TODO.md` P1.
2. Cross-process ledger safety (two adapter processes on one file, last writer wins). Closed by 1, or
   by a startup lock.
3. Implausible-forward-jump PREVENTION (recovery exists). Needs an injectable monotonic source so the
   fake-clock tests do not read as jumps.
4. A model-based crash harness for the ledger, time guard, and registration store. Proposed
   independently by two reviewers; covers the failure class that produced all three rounds.
5. Owner-only, unchanged: host the two 2.3 GB proving keys; decide the custody research track;
   pasta's ChainLock reply; commit the `Cargo.lock` files.
6. The zkVM live STARK verifier (artifact-gated on `r0vm`) and the registration proof lease.

### Round-3 packets not yet returned

`~/Downloads/{gemini,grok,codexapp}_dash-mno-verify_adversarial_review_round3_2026-07-25.md` were
built against `59a575a`. Gemini and Grok replied and are folded. The codexapp one was not returned,
and the repo-access round for `e3f8787` has NOT been run. Rebuild packets from `e3f8787` rather than
reusing those, since the fold moved.

## History

### CURRENT STATE as of 2026-07-24 (superseded by the section above)


### What this is

An anonymous zero-knowledge proof that someone controls a Dash masternode, used to gate a private
community (first adapter, Discord) without revealing which node or address. An oracle reads the
deterministic masternode list (DML) from a Dash Core node and publishes a Merkle root the proofs are
checked against. A platform-neutral gateway verifies proofs and manages short access grants, and four
adapters (Discord, Telegram, Matrix, web) speak to it. Two proving modes: single-tier (`MNO_MODE=single`,
one membership proof per epoch) and two-tier (a heavy seasonal registration proof plus a cheap
per-epoch members proof). Read `docs/DESIGN.md`, `docs/THREAT_MODEL.md`, and `docs/DEPLOY.md` for the
full picture. Status: working prototype, validated on real mainnet data, NOT audited. Do not gate
anything of value until the `TODO.md` blockers are closed and it has had an audit.

- Repo: `~/Code/dash-mno-verify`, public at `github.com/hilawe/dash-mno-verify` (gh authed as `hilawe`).
- `main` is at `8cb4174`, working tree clean, 188 tests green (`npm test`, about two minutes).

### Where things stand

The 2026-06-26 security arc is closed. B1 (account relay), B2 (context-scoped members trees), M1
(nullifier malleability), M2 (season-rollover race), M3 (oracle root hardening and signed snapshots),
and M5 (gateway authentication) are all done, and the mechanism of each is in the checked items of
`TODO.md`. A clean-room design exercise validated the architecture (two independent greenfield designs
by other model families, from requirements alone, both converged on the shipped design).

The main active work is the zkVM registration integration, the durable fix for the member-side proving
cost (the 2.3 GB PLONK proving key). Its state:

- Research phase COMPLETE and reviewed to convergence. A RISC Zero prototype (`research/risc0-registration/`)
  implements and measures the registration statement. Four full adversarial rounds, across three
  model families other than the author's, found NO statement-soundness hole, and every real finding
  was in test and measurement scaffolding and was folded. Cross-implementation golden vectors (`test/vectors/zkvm_golden.json`)
  are reproduced by circomlibjs (JS) and light-poseidon (Rust), so circomlib-compatible Poseidon in the
  guest holds and cross-engine nullifier identity is guaranteed.

- Cost questions ANSWERED and decisions MADE (owner, 2026-07-23/24), all in `docs/REDUCING_PROVING_COST.md`
  and `docs/ZKVM_INTEGRATION.md`:
  - The derive-the-key statement FITS an 8 GB masternode: 4.8 GB measured under an enforced 8 GB cgroup
    at `segment_limit_po2 = 19` (the production statement is 9.6 GB / 77 min at default segments,
    where the three in-guest Poseidon hashes dominate at 26x the accelerated remainder, and the
    segment size, not the statement, sets the memory ceiling).
  - Wallet custody ships as a per-community-and-season OPT-IN (not per member, because derive and
    custody emit different registration nullifiers for the same node, so mixing them in one community
    would allow a double registration). Derive is the default.
  - The receipt path is the UNWRAPPED STARK receipt (transparent, no trusted setup; ~4.8 MB receipt,
    ~400-820 ms verify), not wrapped Groth16 (tiny/fast but reintroduces a trusted setup and adds ~33
    min plus a docker dependency to the member prove).

- Shipping integration (steps 4 and 5 of the `docs/ZKVM_INTEGRATION.md` work plan) LARGELY BUILT and
  reviewed to convergence (a full multi-model round plus per-slice focused reviews). Done:
  - Step 4: the oracle dual-root v2 snapshot. `buildSnapshot` emits `version: 2` and a SHA-256 `shaRoot`
    over the same leaves (`common/dml_sha_root.js`); the signed message versions to v2 covering the
    shaRoot (v1 byte-identical, neither signature replayable as the other); the gateway recomputes both
    roots; `MNO_REQUIRE_SHA_ROOT` (and a durable current-season zkVM declaration) refuse a downgraded v1
    snapshot; `validateSnapshot` enforces the v1/v2 schema (v2 must carry a well-formed shaRoot, v1 must
    not).
  - Step 5, the engine-neutral verify spine: `verifyRegistrationCore` runs one policy pipeline for any
    engine, with per-engine decoders (`decodePlonkRegistrationClaims`, the five-signal array;
    `decodeZkvmRegistrationClaims`, the frozen 136-byte journal). PLONK behavior is byte-for-byte
    preserved.
  - Step 5, the SHA-256 root window: `RootWindows` (`core/stores.js`) holds both roots per snapshot in
    one ring buffer, so the Poseidon and SHA-256 views are structurally in lockstep (a v2-then-v1
    sequence cannot leave a stale SHA-256 root past its Poseidon partner's eviction).
  - Step 5, the durable per-(season, context) engine-and-statement declaration: the first registration
    in a bucket declares its (engine, statement); a later append with a different declaration is rejected
    inside the serialized commit; the store `append` fails closed on a missing declaration (the legacy
    default is read-only); `seasonHasEngine` feeds the downgrade rule.
  - Step 5, per-request engine dispatch: `verifyZkvmRegistration` is the engine sibling of
    `verifyRegistration` (each pins its own engine); `MNO_REGISTRATION_ENGINE`/`MNO_REGISTRATION_STATEMENT`
    configure the gateway (validated at boot); a zkVM gateway refuses to boot until the receipt verifier
    is wired.
  - Step 5, the verification-concurrency bound: a `Semaphore` caps concurrent expensive verifies
    (`MNO_VERIFY_CONCURRENCY`) with a bounded wait queue (`MNO_VERIFY_QUEUE_MAX`), gating only the crypto
    check and shedding a 503 when full; an overloaded `/v1/verify` restores the taken one-time challenge
    (`ChallengeStore.restore`, cap-respecting) so a transient overload does not burn the member's nonce.

### Canonical numbers and decisions, and their one source

- Prover-cost numbers (peak RAM, segment size, proving time per variant): `docs/REDUCING_PROVING_COST.md`,
  "Phase 0 results, measured on RISC Zero". Do not restate them elsewhere without pointing there.
- The zkVM integration design, the settled decisions (statement, receipt path, custody opt-in), and the
  work plan: `docs/ZKVM_INTEGRATION.md`.
- The 2026-06-26 review findings and their status: `REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` and
  `TODO.md`.
- Every tunable is an `MNO_*` env var read in `core/config.js`.

### Standing policies and gotchas

- Every non-trivial change gets an independent adversarial review from a different model family than the
  author (`CLAUDE.md`). VERIFY every finding against ground truth before acting: this session saw two
  confident BLOCK verdicts that were false positives (a missed adapter closure, an already-present key
  dedup), and a real security bug that was already fixed.
- A FULL multi-model round gates "done", not just per-slice focused reviews. The full round over the
  accumulated step-4/5 surface found three cross-slice blockers the per-slice reviews could not see (two
  of them consequences of fixes deferred in earlier slices). Build slices with focused reviews, then run
  a full round before considering the body of work complete.
- Do not regenerate the proving/verification keys without the owner's sign-off. B1/B2 were closed without
  circuit changes on purpose, so the committed keys stay valid.
- Artifact-gated, wired but unproven, like the Platform nullifier backend: the live STARK receipt verifier
  needs the real RISC Zero `r0vm` binary and receipts, unavailable in-session, so a zkVM-engine gateway
  refuses to boot until it is wired. The Platform registration backend is likewise deferred (needs a
  funded testnet identity and DAPI seed) and, when wired, must implement `declarationFor`,
  `seasonHasEngine`, and the per-bucket declaration enforcement.
- No Rust toolchain in-session: all Rust (`research/risc0-registration/`) is validated by CI, not
  locally. The RISC Zero bench runs on x86_64 CI only (ARM64 container limit documented in its README).
  Local circom on this arm64 Mac runs the x86 binary under Rosetta with `CIRCOM=/tmp/circom`.
- Anything in `~/Downloads/` is a view-only convenience copy, never a source (per global `CLAUDE.md`). The
  authoritative session log is THIS file.
- Public repository: no AI tool is named in any committed file, and a review is described generically.
  Writing style and authorship rules are in `CLAUDE.md`.

### Punch list, in order

IN FLIGHT (2026-07-24): a multi-model adversarial round over the accumulated code is open on
branch `review/hash-doc-fixes`. One full-access reviewer confirmed the two hash and doc fixes
made this round and both new findings; two more model reviewers are pending. The fixes made,
the confirmed items still to fold (nullifier durability on restart is P0, secret-file handling),
three new findings (clock rollback, tree-capacity ordering, hash-encoding cutover), and the
triage corrections are all captured in `REVIEW_ROUND_2026-07-24.md`. Resume there.

Owner-only or decision-first (cannot be done from an agent session):

1. Host the two 2.3 GB proving keys once. Rebuild each with `scripts/build_proving_key.sh <circuit>`
   (the non-promoting path that verifies against the committed key without touching it), upload to
   object storage or IPFS, and fill `url` and `sha256` under `largeFiles` in `keys.manifest.json`.
2. Decide whether to fund the purpose-built efficient-ECDSA circuit as the wallet-custody research track
   (custody is now reachable via the zkVM at 4.8 GB for more proving time, and the custom circuit would
   make it cheap in time too). Owner decision.
3. Pasta's ChainLock DM reply is pending (the direct-node reframe is already folded when it arrives). The
   follow-up #dev-talk post draft is in `~/Downloads/pasta_followup_post.md`.
4. Commit the `Cargo.lock` files for `research/risc0-registration/` from a machine with a Rust toolchain,
   then restore `--locked` in the two workflows (tracked in `TODO.md`).

Buildable next (in rough priority):

5. The registration proof lease (root freshness versus the long registration proof, `docs/ZKVM_INTEGRATION.md`
   "Root freshness against a long proof"). Needs a small PROSE design decision first: a registration
   challenge with an issuance time versus a longer registration-root window (which interacts with the
   shared freshness model). Decide, then build. Pure gateway logic, no artifact needed.
6. The live STARK verifier and the HTTP receipt-body routing (artifact-gated on `r0vm`, with the
   dispatch, decoder, root store, and boot guards already built and waiting for the drop-in).
7. The custody guest, work-plan step 7 (`docs/ZKVM_INTEGRATION.md`): the production form of the benchmark
   `sig` variant, whose registration-nullifier scheme needs its own design note and review first (it
   cannot key on the private key the custody prover lacks).
8. The P1 remainder in `TODO.md`: direct node mode (read the DML from a trusted Core node at the last
   ChainLocked block, removing oracle-key trust for the common case; SPV nodeless verification demoted to
   deferred research), the Platform-backed claim commitment, the shared Platform registration backend,
   and Matrix private-room verification.
9. P2 quality items in `TODO.md`.


### 2026-07-23 to 2026-07-24 detailed session log (superseded by CURRENT STATE above)

Append-only record of the per-slice work that produced the current state. Kept for the reasoning and the
per-step test counts. The CURRENT STATE above is the authoritative summary.

- The oracle snapshot assembly was factored into `oracle/snapshot.js` behind an injectable `call()`, with
  the tip-consistency guard (height AND block hash re-read) pinned by `test/oracle_snapshot.test.js`, and
  a README consistency pass. A full multi-reviewer round folded: the tip guard compares block hash as well
  as height (a same-height branch swap forces a retry), a golden-snapshot test, the empty-leaf refusal, the
  tree hasher moved to `common/dml_root.js` (re-export shim at the old path), the README quickstart sets
  `MNO_ALLOW_UNSIGNED_ORACLE=1`, and the acceptance-bar history reconciled. A residual A-to-B-to-A read case
  is documented, closed by the direct-node / `protx diff` chain-anchor work.
- Guest v2 (the production five-claim statement) was built and its journal matched the circomlibjs-pinned
  bytes on CI. Four full multi-model rounds over the zkVM surface found no statement-soundness hole. Folds
  across the rounds: one shared golden fixture both suites regenerate and compare; a fully-varied second
  witness (d=n-2, nontrivial secret, season above 2^32, right-hand path) so the guest `check` validates the
  whole journal, not just that the guest ran; an executor-only `host check` rejecting d in {0, n, n+1},
  non-canonical fields, and bad path bits/lengths; a Node receipt-verification harness with request-size and
  image-id binding; the wrap step under the 8 GB cap; the RISC Zero components pinned (r0vm/cargo-risczero
  3.0.6, guest rust 1.97.0, cpp 2024.1.5); an OOM classifier corrected to a scope-local systemd
  `Result=oom-kill`/exit-137 signal; `verify --repeat` guarded; and doc corrections (journal root is raw
  bytes, the direct-node read needs a ChainLocked tip). A registration proof lease
  (`MNO_REG_PROOF_MAX_AGE`) was specified in the design, and season pinned to u64 across both engines.
- The heavy bench settled the cost questions (see CURRENT STATE): derive fits 8 GB at po2 19; wallet
  custody reopened as an opt-in; the unwrapped STARK receipt chosen; custody per-community not per-member.
- Step 4 (oracle dual-root v2 snapshot) landed and was reviewed (a major fail-open on version/shaRoot type
  coercion was folded). Then the step-5 slices: the engine-neutral spine (a real pre-existing memory-DoS in
  `readBody` was found and fixed), the SHA-256 root window, the durable declaration, per-request dispatch,
  and the concurrency bound. A full multi-model round over the accumulated surface found three cross-slice
  blockers (the downgrade rule ignoring durable declarations, the two root windows able to drift, the
  engine-neutral core failing open on missing engine/statement), all folded, and two false-positive BLOCKs
  from the packet reviewers were verified false and dismissed. The concurrency bound took three review
  iterations to get the load-shedding path right (a consumed-challenge defect, a restore-refused-on-full
  defect, and an unbounded cap-bypass, each found and folded).

### Sessions through 2026-07-22 (superseded by CURRENT STATE above)

Summarized from the working notes that preceded this file.

- Built the working prototype end to end: the oracle, the five circuits, the two proving modes
  (single-tier and two-tier), the gateway, and the four adapters, validated on real mainnet data.
- Ran the 2026-06-26 adversarial review and closed its blockers and majors across multiple review rounds by
  two independent model families. Real bugs caught and fixed included a double-spend via non-canonical field
  elements, a grant-ledger persistence race, and an epoch-boundary bleed.
- Landed the no-roles Discord grant mode (channel-overwrite grants so a profile does not reveal masternode
  control), the epoch sweep that revokes lapsed grants, the persisted globally-serialized grant ledger,
  gateway-owned epoch timing, and the operator key-distribution workflow.
- Ran the clean-room design exercise and folded its findings into `TODO.md`.
- Reframed the proving-cost research track, answered the ring-signature feasibility gate (not feasible over
  the full set), built the RISC Zero registration prototype with its CI bench workflow, added the
  signature-statement and recovery-hinted variants, and recorded the measured three-way results in
  `docs/REDUCING_PROVING_COST.md`.
- Shareable member and reviewer material (plain explainer, runbook, evaluation guide, threat model, cost
  doc) is exported to the operator's local `~/Downloads/` as Markdown and PDF when needed, and the PDFs
  are built through Chrome headless, since this Mac has no pandoc.
