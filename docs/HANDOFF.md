# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

## CURRENT STATE, 2026-08-04 (later). THE GATEWAY IS A MODULE, AND FOUR REVIEW PASSES ARE FOLDED

Everything below this section is superseded. The older CURRENT STATE blocks are kept as history.

### 1. WHERE TO START

Nothing is half-done and nothing waits on a reviewer. Read section 6 (punch list) and take item 1,
which is now the retained-leaves bound. Read section 3 before writing code.

### 2. WHAT LANDED, and what it is worth

**`core/gateway.js` is importable, which was punch-list item 1 and the root cause behind several
sessions of weak tests.** It used to open the durable stores, load the verification keys, fetch a
root, start its intervals, and bind a listening socket as a side effect of anyone importing it. So
nothing in it could be unit-tested: every property of a handler had to be proven through a spawned
process or one level down in the stores, one test had resorted to grepping the file's source text,
and the rate-limit atomicity property could only be shown on `allowAll` rather than through the path
that uses it. The module body is now `createGateway({ config })`, and `node core/gateway.js` still
boots and listens through an entry-point guard at the foot of the file.

**`core/config.js` is `buildConfig(env)`**, with `config` being that function applied to
`process.env`. A test can now build a fully validated config for a synthetic environment, which is
what makes the boot refusals ordinary function behaviour rather than a subprocess exit code.

**The lifecycle is the new code, and therefore the risky part.** The handle owns the server (built,
not listening), the timers, and the stores. `close()` gives them back, walking the SAME release list
a failed boot walks, so a refusal after the nullifier store is open no longer strands an open
database with no handle to reach it through. It is one memoized teardown shared by every caller. It
waits for a refresh in flight, for a bind in progress, for the server to close, and for in-flight
request handlers to finish, it attempts every release even when one throws, and a closed gateway
refuses to listen again. Every one of those clauses is there because a review pass found the case,
and every one has a test that fails when it is removed.

**Twenty-five new tests exist because of the change and could not have existed before it**
(21 in `test/gateway_module.test.js`, 3 in `test/nullifier_sqlite.test.js`, 1 in
`test/platform_store.test.js`). Suite is 517, all passing, and all three CI jobs green on `3a6aadf`. The one
worth knowing: both orderings of the rate-limit charge are now proven through the real
`/v1/challenge` path, in both directions, where before only the ordering that reads more naturally
was covered and a short-circuiting sequential charge passed it.

### 3. WHAT THIS SESSION CONFIRMS ABOUT THE PROCESS

- **THE THREE-AGENT STAGE CAUGHT FIRST, in two charters independently**, on the window bound (trial
  pass 2 of 10, recorded in `docs/PRECOMMIT_ADOPTION.md`). Ordering found a real defect in the code:
  the bound evicted single RECORDS while the trim above it evicts whole HEIGHTS, so a changeover pair
  was split and a prover holding the older leaf ordering was locked out at a height whose newer root
  was still accepted. Tests found two mutations the author had not tried. Durability correctly
  returned "no durable write is reachable from an evicted record", having traced it rather than
  assumed it. Both prior sessions said the author-side pass never catches first, and it now has, twice.
- **A mutant must PARSE before its result means anything.** One reported catch this session was a
  syntax error: changing a `while` to an `if` orphaned the `break` inside it, so the module failed to
  load and every test failed for an unrelated reason. `node --check` the mutated file first.

- **Every finding across six external passes was in the NEW code, none in the wrapped body.** The
  first pass confirmed mechanically that the re-indentation moved, dropped, and reordered nothing,
  and that `buildConfig(process.env)` deep-equalled the old exported object. All sixteen findings
  were in the lifecycle surface written this session. That is the seventh consecutive round to behave
  this way, and it is now the most reliable fact about this repository.
- **A FOCUSED CONFIRMATION IS NOT A FULL PASS, and this session is the cleanest evidence yet.** Four
  focused rounds converged to APPROVE. The fresh full pass immediately after found two majors and a
  moderate, none of them adjacent to anything the focused rounds had named. The rule that a converged
  round is followed by a fresh full round paid for itself in one use.
- **A mutation that survives is a finding about the TEST, and four did.** The first atomicity test
  survived a sequential-charge mutant because the code's own short-circuit made the two behave
  identically in the direction tested. The close-idempotence test survived because the gateway's
  emptied release list provided the property the store-level guard was supposed to. The two-tier
  adopt test survived because it closed during the read rather than in the gap it was written for.
  The handler-drain test survived because releasing the handler and then checking the store is a race
  the correct code happens to win, so the assertion became "close() has NOT returned", checked before
  the handler is released. Each was rewritten to observe the thing itself, and each then failed under
  its mutant.
- **A test can fail at BASELINE and be right about the code.** The shared-bucket direction of the
  atomicity test failed the first time it ran because with a shared cap of one, only one probe fits
  per release, so the second probe was measuring the shared limiter rather than the account's
  allowance. The instrument was wrong, not the gateway.
- **Rule 6 shape search, done and clean.** Every other module with import-time side effects
  (`adapters/*/bot.js`, `adapters/web/server.js`, `oracle/oracle.js`, `prover/*.js`) is a pure entry
  point, imported by nothing. The Discord adapter had already met this shape and solved it by
  extraction (`access.js`, `grant_ledger.js`, `permissions.js` exist because `bot.js` logs in at
  import). The gateway was the last instance.

### 4. THE REVIEW RECORD, since the shape of it is the lesson

Round 1 REQUEST-CHANGES, five majors and two minors. Round 2, after the fold, REQUEST-CHANGES with
four more, every one a defect in a round-1 FIX. Round 3 REQUEST-CHANGES with one, a defect in a
round-2 fix. Round 4 APPROVE. Fresh full pass: REQUEST-CHANGES with three. Second fresh full pass:
APPROVE-WITH-FIXES with one (the cleanup tests counted close() calls rather than proving release, so
a close() that only set a flag passed them all). Confirmation after that fold: APPROVE.

**THE FRESH FULL PASS THEN FOUND TWO MAJORS AND A MODERATE THAT ALL FOUR FOCUSED PASSES HAD MISSED,
which is the whole argument for the rule that requires it.** Stopping at round 4's APPROVE would have
shipped every one of them:

- `close()` waited for the SERVER, which waits for connections, not for the async request handlers.
  A client that disconnects mid-request leaves its handler running with no connection to wait for, so
  teardown released the stores underneath it. Reproduced as "statement has been finalized" on the
  read path. On the two-tier path a disconnected registration could continue into its durable append
  after `close()` returned.
- A bind IN PROGRESS could outlive the teardown. `close()` only closed a server it found already
  listening, and binding is asynchronous in a cluster worker or whenever a hostname is resolved, so
  the socket could come up behind a gateway with stopped timers and released stores, with the
  one-shot teardown already settled and unable to close it.
- `export const config = buildConfig(process.env)` meant importing the config module still VALIDATED
  the ambient environment, so a malformed `MNO_GATEWAY_PORT` in the shell made importing the gateway
  throw. The same defect the import-time boot was, one level down, and it made the new claim not
  quite true. No config is built at import now.

The three-agent fix review (section 6b of `docs/PRECOMMIT_ADOPTION.md`) was NOT run on this commit,
so the trial stays at 1 of 10. This session's operating rules excluded spawning agents without being
asked for them. Recorded rather than quietly skipped, because the trial's whole value is an honest
denominator.

### 5. WHAT FORCED REWORK THIS SESSION

- Three new tests survived their mutants and had to be rewritten, each because the assertion observed
  a consequence some other guard also produced. Feeds the existing rule 2 (attack the observation,
  not the fix).
- A fourth was caught not by rule 2 but by the second fresh full pass: every cleanup test counted
  `close()` calls, so a `close()` replaced by a body setting only a flag passed all of them. Feeds
  rule 2 as well, with a sharper form. Counting a call is not observing a release.
- One test failed at BASELINE for a reason in the test rather than the code (with a shared rate cap of
  one, only one probe fits per release, so the second probe measured the wrong limiter). No rule
  covers this and none is proposed; it is the ordinary cost of writing a real instrument.
- Mutating a socket-lifecycle defect leaves ORPHANED `node --test` processes, because the mutant's
  whole symptom is a socket that outlives the teardown. Two of them later blocked the pre-commit gate,
  which is the repository's existing loopback-contention gotcha arriving by a new route. Stop stray
  runs before committing after socket mutations.
- A MUTATION THAT DOES NOT PARSE IS NOT A MUTATION, and one was reported here as a catch before that
  was noticed. Changing a `while` to an `if` orphaned the `break` inside it, so the file failed to
  load and every test "failed" for a reason having nothing to do with the guard. Run `node --check`
  on the mutated file and only believe the result if it parses. Now written into section 3.

### 6. PUNCH LIST, in the order recommended

1. **The `merkleRootMNList` commitment check**, which is what turns the node read from trusted-node
   into chain-authenticated. `protx diff` already returns `cbTx` and `cbTxMerkleTree`.
2. **A review round** covering direct node mode, the module refactor, and the window bound together.
3. **The packet reviews by the other model families**, for the accumulated work. Not run this
   session, and worth doing once there is a body of change to put in front of them rather than
   per-commit. The packet recipients are named in the private tooling notes, not here.
4. **The audit.** Still none. Separately, `circom-ecdsa` is unaudited demonstration code by its own
   README, a deployment blocker for any mode shipping a key-bearing Circom proof.

DONE THIS SESSION, was item 1: **the retained-leaves bound.** `MNO_ROOT_WINDOW_MAX_LEAVES` (default
4 x 65,536, 0 disables) bounds the leaves the root window retains, evicting the oldest HEIGHTS whole
after the height trim. The window's memory had been finite only as the product of three limits that
know nothing about each other, measured at 3.1 MiB for 16 records at the live mainnet size and
64.7 MiB at full tree capacity. It never fires under the default height window at today's list size.

### 7. KNOWN OPEN, unchanged from the section below except where noted

- A close error after a successful durable write can duplicate a registration.
- A challenge can be minted for a season that ended during materialization.
- Registration readiness ignores the anchor age.
- The Platform marker is local while the state it protects is shared. Constrained and documented.
- The oracle CLI can publish v3 (`--read block`) but the transition for existing v2 consumers has not
  been exercised end to end outside tests.
- NEW, and small: `DocumentNullifierStore.close()` and the Platform backend's `close()` exist and are
  wired, but the Platform path is not live, so neither has been exercised against a real client.

<!-- superseded by the section above, kept append-only -->
## CURRENT STATE, 2026-08-04. COMPLETE SESSION HANDOFF

`main` at `c909cb3`, pushed, clean tree. Suite 493 with the full install, 414 passing and 79 skipped
without the optional packages. All three CI jobs green (`checks`, `full`, `circuits`). 24 commits
this session. Everything below this section is superseded; the older CURRENT STATE blocks are kept
as history.

### 1. WHERE TO START

Nothing is half-done and nothing waits on a reviewer. Read section 6 (punch list) and take item 1.
Read section 4 (the lessons) before writing code, because they are about how this session kept
producing defects rather than about any one defect.

### 2. THE ENVIRONMENT, which changed materially

- **A mainnet Dash Core node is now SYNCED and running**, container `dash-mno-node`, height
  2,516,184, progress 1.000000. That took two failed attempts on a 5.7 GiB colima VM before the
  diagnosis landed (the VM, not the dbcache) and a rebuild at 12 GiB succeeded. It is the reason two
  long-standing "unobserved" caveats could be closed.
- The colima VM is SHARED. About 25 containers run in it, including the dashmate local network and
  two other projects' long-lived containers. Stopping the VM stops all of them, so a restart is a
  cross-project decision, not a local one. One container (`inspiring_lewin`) was lost to the last
  VM bounce because it had been created with `--rm`.
- Dash Core v23.1.8 was released 2026-08-04 (patch, bugfixes, recommended). The running container is
  `dashpay/dashd:latest` pulled before that. Not urgent, but worth knowing.

### 3. WHAT LANDED, grouped by what it means

**Direct node mode (`6184bcb`), the headline.** `MNO_DML_SOURCE=node` makes the gateway read the
masternode list from its own node, gated on ChainLock, instead of fetching a signed snapshot. For a
self-hosting operator that removes the publisher, the signing keys, the quorum, and the transport.
Downstream is deliberately identical; only the origin differs. STILL A TRUSTED-NODE READ: one server
answers the ChainLock query, the block hash, AND the list, so it can return matching hashes over an
arbitrary set. Chain authentication needs the `merkleRootMNList` check, and `protx diff` already
carries the material.

**Both of its blockers closed first, by measurement not argument.** The `protx diff` response shape
is now OBSERVED against live mainnet (2,972 entries at height 2,515,929; every field this build
reads checked for type and form), and `MNO_CLI_MAX_BUFFER` is settled (1.74 MiB actual against a
64 MiB default, about 37x headroom). The strict boundary checks added over the review rounds
therefore accept real mainnet data, which was not a given.

**The members tree stopped stalling the gateway (`49332c5`, `b94b92d`).** It rebuilt all 65,536
leaves on every append, about 9 seconds per root and 20 for a first-context commit, all blocking the
event loop, so one ordinary registration made the gateway unresponsive. It now keeps its root with a
frontier, and a rebuild is one carry-stack pass costing N minus popcount(N) plus depth. Measured:
4,096 members went from 9.1s to 0.61s, and recovery is never worse than before at any size.

**CI had been red since 2026-07-30 and nobody looked (`f8e6989`).** `discord.js` is optional, CI
installs without it, and four test files imported it at the top level so they failed to LOAD rather
than skip. Invisible locally by construction. A new `full` job now installs everything, so the
Discord adapter has CI coverage for the first time. `CLAUDE.md` names the one command to run after a
push.

**The documentation had started contradicting the code (`7641af3`).** `CLAUDE.md` called account
binding and context-scoped roots the headline OPEN blockers long after both landed, named the wrong
default nullifier store, and described the members tree as not yet incremental one commit after it
became incremental. Worse than silence, because it would have caused an agent to undo correct work.

**Five review rounds and a paired experiment, all folded.** Rate limits are charged atomically; the
registration commit observes both clock periods and refuses a regressed clock; the account
identifier is bounded in bytes; the Platform marker is race-safe and bound to its contract id; the
torn-tail recovery handles both interruption shapes; signature work is bounded by configured keys.

**The Platform single-gateway constraint is explicit (`99445e7`).** Taken deliberately instead of
building a contract migration for a path that is not live. Its own section in `CLAUDE.md`.

### 4. THE FOUR LESSONS, which matter more than any single fix

1. **Most of what each review round found was in the PREVIOUS round's fixes.** Six consecutive
   rounds. The newest code is the riskiest surface, and this is now the most reliable fact about
   this repository.
2. **After fixing a defect, search for its SHAPE.** One clock-reading defect appeared in FOUR places,
   each time after being fixed elsewhere, twice in one session, once with a comment already in the
   file explaining the trap. Every instance cost an external round. This is now global playbook
   rule 6, and on its first real use it found `/v1/health` not reporting the DML source.
3. **The mutations an author picks prove the least.** Four tests were caught vacuous. Every author
   mutation had the same shape, revert the fix and confirm the test notices, which is guaranteed to
   pass because the test was written while looking at that fix. The useful mutations attack the
   OBSERVATION: delete a branch whose value is performance, satisfy the assertion by another route,
   rename what the assertion reaches into. Global playbook, rule 2.
4. **A gate that observes the system can match itself, and a gate that fires falsely is worse than
   none.** The stray-process check used `pgrep -f core/gateway.js`, which matches any process whose
   arguments contain that string, so it blocked a commit because of the text of its own commit
   message. Global playbook, rule 5a. Crono had already solved this shape for its vocabulary gate,
   and the playbook now cites crono's exclusion-list form as the general one.

### 5. A CORRECTION TO A PUBLISHED CLAIM, do not carry it forward

Commit `6184bcb`'s message explains the gate's invisible false positive by saying `ps` truncates long
argument lists. THAT IS WRONG, and it was only caught because someone asked whether verifying before
writing it up was prudent. `ps` displayed 4,052 characters without trouble. The real cause was the
diagnostic itself: its debug line ended `| grep -v grep`, and the matching process had "grep" in its
own command, so the filter deleted the evidence. Six matching lines became one. The fix is right; the
published reason for one of its symptoms is not. History was not rewritten for it.

### 6. PUNCH LIST, in the order recommended

1. **Make `core/gateway.js` importable.** It starts an HTTP server on import, so nothing in it can be
   unit-tested. ROOT CAUSE behind this session's weak tests: it forced a source-text grep as a
   tripwire (since replaced by a store-level invariant), and it is why rate-limit atomicity had to be
   proven at the unit level rather than through the path that uses it. Higher value than another
   review round.
2. **The retained-leaves bound.** The root window can hold up to sixteen full leaf arrays during a
   changeover. Legitimate data, so normalization does not touch it.
3. **A review round**, covering direct node mode and item 1 together. Not before, since rounds are
   worth most when significant new code exists.
4. **The `merkleRootMNList` commitment check**, which is what turns the node read from trusted-node
   into chain-authenticated. `protx diff` already returns `cbTx` and `cbTxMerkleTree`.
5. **The audit.** Still none. Separately, `circom-ecdsa` is unaudited demonstration code by its own
   README, a deployment blocker for any mode shipping a key-bearing Circom proof.

### 7. KNOWN OPEN, recorded rather than fixed

- A close error after a successful durable write can duplicate a registration.
- A challenge can be minted for a season that ended during materialization.
- Registration readiness ignores the anchor age.
- The Platform marker is local while the state it protects is shared. Constrained and documented.
- The oracle CLI can publish v3 (`--read block`) but the transition for existing v2 consumers has not
  been exercised end to end outside tests.

### 8. PROCESS STATE

- **The three-agent fix review is ON TRIAL**, dash-mno-verify only, 1 of 10 qualifying commits used.
  Its first pass caught a regression no external round had (recovery cost growing with member count),
  and the finding came from the one charter that forced MEASUREMENT rather than reading. Details and
  the endpoint are in `docs/PRECOMMIT_ADOPTION.md` section 6b.
- **The trial log has 10 rows.** Read it before assuming the author-side rules work: for most of
  their history they caught nothing before the external checker did.
- **A transfer packet for crono** is at
  `~/Downloads/multi-agent-and-playbook-setup_packet_2026-08-03.md`, updated 2026-08-04. Crono needs
  no installation; the global playbook already applies. Its own hook deliberately was NOT changed.

<!-- superseded by the COMPLETE SESSION HANDOFF above; kept append-only -->
## CURRENT STATE, 2026-08-03 (late), THE NODE IS SYNCED AND THE READ IS OBSERVED

### THE CAVEAT THAT HAS BEEN IN EVERY PACKET FOR DAYS IS RETIRED

The mainnet node finished its reindex AND caught up. Height 2,515,929, progress 1.000000,
ChainLocked, answering RPC. `oracle/diff_snapshot.js` was run against it end to end and built a real
v3 snapshot in 1.3 seconds: 2,972 masternodes in the list, 2,069 valid, ordered by proRegTxHash,
`chainlocked: true`, block hash matching the ChainLock.

EVERY FIELD ASSUMPTION IS NOW OBSERVED RATHER THAN INFERRED, against live mainnet:

- `proRegTxHash` is a 64-lowercase-hex string, all 2,972 of them, no duplicates.
- `votingAddress` is a string on every entry.
- `isValid` is a real boolean on every entry (2,069 true), not a string.
- `getbestchainlock` returns `blockhash`, `height`, `known_block: true`, exactly the shape assumed.
- The response also carries `merkleRootMNList`, `cbTx`, and `cbTxMerkleTree`, which is the material
  the on-chain commitment check needs, so that work is now unblocked too.

So the strict boundary checks added over the last rounds (typed fields, lowercase hex, boolean
isValid, duplicate refusal) accept real mainnet data rather than being guesses that might have
refused everything. Update TODO.md and any future packet: the shape is no longer UNOBSERVED.

WHAT IS STILL TRUE: this remains a TRUSTED-NODE read until the `merkleRootMNList` check exists. One
server answered every query. Observing the shape does not make it chain-authenticated.

### Dash Core v23.1.8 is out (announced 2026-08-04 in the Dash Discord)

A patch on the 23.1.x series, described as important bugfixes and recommended for all users. The
running container is `dashpay/dashd:latest` pulled before that, so it is 23.1.7. Nothing here needs
it urgently, but the upgrade path for a dashmate deployment is the documented
`dashmate stop --safe`, `update`, `start`, `status`. Do NOT casually restart the reindexed node
container to pick it up: that datadir took two failed attempts and about a day to get synced, and
the value here is the synced state, not the patch version.

## CURRENT STATE, 2026-08-04 (late). Direct node mode is in, CI green, nothing pending

`main` at `6184bcb`, pushed. Suite 493 with the full install, 414 passing and 79 skipped without the
optional packages. All three CI jobs green. Clean tree. Everything below is superseded.

### START HERE

Nothing is half-done. Read the punch list, pick item 1.

### DIRECT NODE MODE IS WIRED, which was the top punch-list item

`MNO_DML_SOURCE=node` makes the gateway read the masternode list from its own Dash Core node, gated
on ChainLock, instead of fetching a published snapshot and authenticating it against pinned oracle
keys. For a self-hosting operator that removes the publisher, the signing keys, the quorum, and the
snapshot transport, every one of which was something to compromise.

Everything downstream is deliberately identical, the same `validateSnapshot`, root recompute, and
coexistence window. Only the origin differs. The unsigned-oracle boot refusal is now SCOPED to the
snapshot source, because in node mode there is no publisher and demanding a pinned key would be
demanding a signature on data nobody published. `/v1/health` reports `dmlSource` so an operator can
see which trust model is running. The node caller lives in `oracle/node_client.js`, shared with the
oracle CLI, which also gained `--read block` for publishing v3 snapshots.

STILL A TRUSTED-NODE READ, and every comment says so: one server answers the ChainLock query, the
block hash, AND the list, so it can return matching hashes over an arbitrary set. It becomes
chain-authenticated only with the `merkleRootMNList` commitment check, and `protx diff` already
carries the material for it.

### TWO GLOBAL PLAYBOOK RULES WERE EARNED HERE, both worth knowing before you write code

- **Rule 6, search for a defect's SHAPE after fixing it.** One clock-reading defect appeared in FOUR
  places, each time after being fixed elsewhere, twice in one session, once with a comment already in
  the file explaining the trap. Every instance cost an external review round. Grep would have found
  all four in one pass. On its first real use here it found `/v1/health` not reporting the DML
  source.
- **Rule 5a, a gate that observes the system can match itself.** See the next section, it cost about
  an hour.

### THE PRE-COMMIT GATE BLOCKED A COMMIT THAT WAS FINE, twice, and the second reason is worth reading

The stray-process check used `pgrep -f core/gateway.js`, which matches ANY process whose argument
list contains that string, including the shell running the commit whenever the commit message
mentions the path. It was firing on the text of its own commit message.

The first fix was a five second grace period, since `proc.kill()` returns before the child is gone.
Necessary but insufficient. The real fix filters on the EXECUTABLE being node, which a shell quoting
a path is not.

A CORRECTION THAT MATTERS MORE THAN THE BUG. Commit `6184bcb`'s message explains the invisibility by
saying `ps` truncates long argument lists. THAT IS WRONG. Verified afterwards, prompted by being
asked whether verifying first was prudent: `ps` displayed 4,052 characters without trouble. The real
cause was the instrumentation itself, whose debug line ended `| grep -v grep`, and the matching
process had "grep" in its own command, so the filter deleted the evidence. Six matching lines became
one. The fix is right; the published reason for one of its symptoms is not. Do not carry that
explanation forward.

### PUNCH LIST, in the order recommended

1. **Make `core/gateway.js` importable.** It starts an HTTP server on import, so nothing in it can be
   unit-tested. This is the ROOT CAUSE behind the weak tests this session: it forced a source-text
   grep as a tripwire (since replaced by a store-level invariant), and it is why rate-limit
   atomicity had to be proven at the unit level rather than through the path that uses it. Splitting
   boot from handlers would do more for correctness than another review round.
2. **The retained-leaves bound.** The root window can hold up to sixteen full leaf arrays during a
   changeover. Legitimate data, so normalization does not touch it; it needs a real bound.
3. **Then a review round**, covering direct node mode and item 1 together. Not before: the last
   several rounds found their material in the newest fixes, so a round is worth most when
   significant new code exists.
4. **The audit.** Still none. Also note `circom-ecdsa` is unaudited demonstration code by its own
   README, a deployment blocker for any mode shipping a key-bearing Circom proof.

### Known open, recorded rather than fixed

- A close error after a successful durable write can duplicate a registration.
- A challenge can be minted for a season that ended during materialization.
- Registration readiness ignores the anchor age.
- The Platform marker is local while the state it protects is shared. Deliberate, constrained, and
  documented in `CLAUDE.md` under its own section.
- The `merkleRootMNList` commitment check, which is what would make the node read chain-authenticated.

## CURRENT STATE, 2026-08-04. Everything reviewed to date is folded, CI is green, nothing is pending

`main` at `99445e7`, pushed. Suite 488 with the full install, 409 passing and 79 skipped without the
optional packages. All three CI jobs green (`checks`, `full`, `circuits`). Clean tree. Everything
below this section is superseded.

### START HERE

Nothing is half-done and nothing is waiting on a reviewer. Five review rounds, a paired-capability
experiment, and a follow-up assessment are all folded. Pick up from the punch list below.

### What changed on 2026-08-03 and 04, briefly

- **The members tree stopped stalling the gateway.** It rebuilt all 65,536 leaves on every append,
  about 9 seconds per root and 20 for a first-context commit, all blocking the event loop. It now
  keeps its root with a frontier, and a rebuild from durable records is one carry-stack pass costing
  N minus popcount(N) plus depth. Measured: 4,096 members went from 9.1s to 0.61s, and recovery is
  never worse than before at any size.
- **CI HAD BEEN RED SINCE 2026-07-30** and nobody looked, including me, across about fifteen pushes.
  `discord.js` is an optional dependency, CI installs without it, and four test files imported it at
  the top level so they failed to LOAD rather than skip. Invisible locally by construction. Fixed,
  and a new `full` job now installs everything so the Discord adapter has CI coverage for the first
  time. `CLAUDE.md` now names the one command to run after a push.
- **The documentation was lying about the code.** `CLAUDE.md` called account binding and
  context-scoped roots the headline OPEN blockers long after both landed, named the wrong default
  nullifier store, and described the members tree as not yet incremental one commit after it became
  incremental. That is worse than silence: it would have caused an agent to undo correct work.
- **Rate limits are charged atomically**, the registration commit observes both clock periods and
  refuses a regressed clock, the account identifier is bounded in bytes, and the Platform schedule
  marker is race-safe and bound to its contract id.
- **The Platform single-gateway constraint is now explicit** rather than implied. See its own
  section in `CLAUDE.md`.

### The one pattern worth carrying forward

Across this whole stretch, most of what each review round found was in the PREVIOUS round's fixes,
not in the code those fixes were about. That held for six consecutive rounds. Two concrete examples
from these two days: the post-proof clock guard read a flag that only updates when the clock is
actively sampled, so the check added to catch a regression could not see one; and the torn-tail
recovery fixed one process lifetime while breaking every later one. The same "read one clock fact
instead of all of them" defect appeared in FOUR separate places, each time after fixing it
elsewhere.

The practical instruction: after fixing a defect, grep for its shape before moving on. That single
habit would have prevented more of this session's rework than any other change.

### The other lesson, about tests

Four tests written during this stretch were caught VACUOUS, three by mutation and one by a reviewer.
The cause was always the same: the mutations an author picks revert their own fix, which the test is
guaranteed to catch because it was written while looking at that fix. The mutations that find things
attack the OBSERVATION: delete a whole branch whose value is performance rather than correctness,
satisfy the assertion by another route, rename the field the assertion reaches into. This is now in
the global playbook under rule 2.

### PUNCH LIST, in the order recommended

1. **Wire direct node mode.** BOTH ITS BLOCKERS CLOSED ON 2026-08-03 and it is still unwired:
   `oracle/oracle.js` imports `buildSnapshot`, the old current-tip read, while
   `buildDiffSnapshot` (block-bound, ChainLock-gated) sits tested and unused. The response shape is
   now OBSERVED against live mainnet (2,972 entries at height 2,515,929, every field checked) and
   `MNO_CLI_MAX_BUFFER` is settled by measurement (1.74 MiB against a 64 MiB default). This removes
   pinned-oracle-key trust entirely for the common self-hosting deployment, which is a real security
   gain rather than polish. The v2-to-v3 root change is already handled by the coexistence window.
2. **Make `core/gateway.js` importable.** It starts an HTTP server on import, so nothing in it can be
   unit-tested. That is the ROOT CAUSE behind several findings and behind every weak test this
   session: it forced a source-text grep as a tripwire (since replaced by a store-level invariant)
   and it is why the rate-limit atomicity had to be tested at the unit level instead of through the
   path that actually uses it. Splitting boot from handlers would do more for correctness than
   another review round.
3. **The retained-leaves bound.** The root window can hold up to sixteen full leaf arrays during a
   changeover. That is legitimate data, so normalization does not touch it; it needs a real bound.
4. **Then a review round**, covering items 1 and 2 together. Not before: the last several rounds
   found their material in the newest fixes, so a round is worth most when significant new code
   exists, and items 1 and 2 are that code.
5. **The audit.** Still none. Nothing of value should be gated before it. Note also that
   `circom-ecdsa` is unaudited demonstration code by its own README, which is a deployment blocker
   for any mode shipping a key-bearing Circom proof, independent of everything above.

### Known open, recorded rather than fixed

- A close error after a successful durable write can duplicate a registration.
- A challenge can be minted for a season that ended during materialization.
- Registration readiness ignores the anchor age.
- The Platform marker is local while the state it protects is shared. Deliberate, constrained, and
  documented in `CLAUDE.md`.

## CURRENT STATE, 2026-08-03, whole-gateway round is IN, folding is PAUSED on purpose

`main` at `ff2b663`, 422 tests green, clean tree. Read this section first.

### PICK UP EXACTLY HERE

1. **ALL FOUR REVIEWS ARE IN and cross-checked.** The adjudication is
   `REVIEW_ADJUDICATION_dash-mno-verify_gateway_round3_2026-08-03.md`, committed, and it carries the
   fold order. Read it before the individual findings files. Verdicts were three BLOCK and one
   APPROVE-WITH-FIXES. One reported blocker was REFUTED by direct test, and one finding that no
   earlier round or repository-access reviewer caught was REPRODUCED here in one command.
2. **Fold items 1 through 4 are DONE.** `da56e1d`: the torn-tail boot failure, the season commit
   into a dead season, and verification crossing the period it was checked in. `e313aa2`: the
   signature work bound, `MNO_MODE` validation, and the context allowlist. Suite 441.

   **NEW OPERATOR SETTING, and a deployment must set it.** `MNO_REGISTER_CONTEXTS` is the
   comma-separated list of context hashes this gateway accepts registrations for. Unset means open,
   which warns loudly at boot in two-tier mode. It is the bound on how many context trees one valid
   masternode holder can allocate.

   `60036fd`: the registration anchor policy. Suite 452.

   **SECOND NEW OPERATOR SETTING.** `MNO_REGISTER_ROOT_MAX_AGE` defaults to 900 seconds and bounds
   how old the DML root a registration anchors to may be, separately from the membership window.
   A deployment whose provers are slower than that will see registrations refused as
   `stale-or-unknown-root` and should raise it. Setting 0 disables the rule and restores the old
   behaviour, with a loud boot warning.

   `45ebc02`: the rate-limit keying, the `/v1/dml` limiter, the Platform schedule binding, and
   capability-specific health readiness. Suite 459.

   **THE WHOLE-GATEWAY ROUND'S FOLD IS NOW COMPLETE except the two architectural items**, which were
   always going to be separate work: the members-tree full rebuild (about 20 seconds of blocked
   event loop for one ordinary first registration) and the retained-leaves bound (up to sixteen full
   leaf arrays during a changeover, legitimate data that normalization does not touch).

   **THIRD AND FOURTH NEW OPERATOR SETTINGS.** `MNO_RATE_CHALLENGE_ACCOUNT` (10) and
   `MNO_RATE_VERIFY_ACCOUNT` (20) are per-account-per-window limits, and `MNO_RATE_DML` (60) bounds
   the public leaf-set endpoint. Also **PLATFORM MODE NOW REFUSES TO START** without
   `MNO_PLATFORM_ASSUME_SCHEDULE=1`, because the contract cannot carry a schedule marker and a
   changed schedule would otherwise be reinterpreted in silence.

   **ROUND 4 IS IN AND FOLDED** (`ebc0e0c`). Four reviewers, three BLOCK and one
   APPROVE-WITH-FIXES, reviewing the previous fold. Findings are in
   `REVIEW_FINDINGS_dash-mno-verify_gateway_round4_2026-08-02.md` (repo-access reviewer) and
   `~/Downloads/REVIEW_FINDINGS_dash-mno-verify_gateway_round4_2026-08-03.md` (packet reviewer).

   The headline is uncomfortable and worth carrying: MOST OF WHAT ROUND 4 FOUND WAS IN THE ROUND-3
   FIXES, not in the code those fixes were about. Sixth consecutive round with that shape. Two
   examples. The post-proof clock guard added in round 3 read a flag that only updates when the
   clock is actively sampled, and single-tier verifies sampled nothing, so the check added to catch
   a clock regression could not see one. And the torn-tail recovery fixed one process lifetime and
   broke every later one, because the discarded bytes stayed in the file and the next append
   concatenated onto them.

   A BLOCKER FROM ROUND 3 WAS SKIPPED BY THE ROUND-3 FOLD and re-reported: clock marks went
   ephemeral based on the nullifier store while two-tier keeps a durable registration file. Folding
   from a list lost it. It is fixed now (`ebc0e0c`), but the lesson is that a fold needs a
   checklist checked off against the findings, not a narrative.

   **STILL OPEN from round 4**, recorded rather than folded: a close error after a successful
   durable write can duplicate a registration; a challenge can be minted for a season that ended
   during materialization; registration readiness ignores the anchor age; and the gateway remains
   one uninjectable module (which is why several fixes needed structural tripwires instead of unit
   tests, and is the root cause behind more than one finding).

   **FIVE NEW OR CHANGED OPERATOR SETTINGS SO FAR.** `MNO_REGISTER_CONTEXTS` (two-tier now REFUSES
   to boot without it, or `MNO_ALLOW_ANY_REGISTER_CONTEXTS=1`), `MNO_REGISTER_ROOT_MAX_AGE` (900s),
   `MNO_RATE_CHALLENGE_ACCOUNT` (10), `MNO_RATE_VERIFY_ACCOUNT` (20), `MNO_RATE_DML` (60), and
   `MNO_PLATFORM_ASSUME_SCHEDULE` which must now NAME the schedule (e.g. `e604800s7776000`) rather
   than being `1`.

   **NEXT: another full round.** Everything since `a3cc0ed` has had only focused screens, which are
   a screen and not a round, and this project's record is five consecutive rounds finding the newest
   fixes to be the highest-risk surface, now six. Build packets from `ebc0e0c` or later. Given that
   round 4 found most of its material in round 3's fixes, expect the same again and frame the packet
   that way.
3. **The fold itself has had no independent round.** Two focused artifact checks screened it, which
   is not a round. Build fresh packets from the current commit once the contained items are folded,
   and remember this project's own record: five consecutive rounds found the newest fixes to be the
   highest-risk surface, and this fold was no exception (three of its seven external findings were
   defects in the fix rather than in the original code).
3. **A decision is already taken** on the context-admission finding: a CONFIGURED ALLOWLIST. Hilawe
   chose it on 2026-08-03. Do not re-open it, implement it, rejecting an unknown context BEFORE the
   proof verify.
4. **Two findings are architectural and get their own change with their own review**, not a fold:
   the members-tree full rebuild (measured at about 20 seconds of blocked event loop for one
   ordinary first registration) and the retained-leaves bound (up to sixteen full leaf arrays during
   a changeover, which is legitimate data that normalization does not touch).

### THE ONE THING TO KNOW ABOUT THE ROUND

A torn last line in the registration file permanently refuses boot. Two families found it, neither
the repository-access reviewer nor any of the twelve previous rounds did, and it reproduces in one
command: truncate the last line of `registrations.jsonl` and `FileBackend.#load` throws an unhandled
`SyntaxError`. A crash or power loss during the append window produces exactly that file. Fix it
first.

Also worth carrying: a reported fresh-boot blocker in the SQLite nullifier store was REFUTED by
direct test. `DatabaseSync` creates the file before the `chmod` runs, and a fresh path constructs
cleanly at mode 600. Do not "fix" it.

### What the whole-gateway round found

Verdict BLOCK, nine findings, most reproduced with measurements rather than reasoned. It read the
two-tier path, which no previous round had covered at all, and it found a regression in the
PREVIOUS round's own fix, which is the fifth consecutive round where the newest fixes were the
highest-risk surface.

FOLDED ALREADY (`ff2b663`): the window retained the parsed snapshot object as it arrived, so a host
with no signing key could pad a legitimately signed snapshot and have the gateway hold it at every
height (157 MB measured from eight records). Records now hold a normalized, field-by-field copy.

STILL OPEN, in the order recommended for folding:

- **B1, blocker. Two-tier memory mode drops the durable clock guard while keeping durable
  registrations.** `MNO_STORE=memory` gives TimeGuard a null path, but two-tier still constructs the
  file-backed registration store and reloads historical seasons. A gateway can finish season N,
  restart after a backward clock step into N-1, and rebuild N-1's members tree without noticing.
  Members whose season ended can prove again, which breaks the stated season rule.
- **M1, major. A registration can commit after its season has ended.** The handler samples the
  season before the proof verify, and `commit()` compares only against cached state without
  re-sampling the clock. Reproduced: a commit returned ok and wrote a season-zero record while the
  external season was one.
- **M3, major. The signature precheck permits attacker-chosen work.** `sigs` has no count bound and
  the verifier ignores each entry's own key label, so it scans and verifies the whole array per
  trusted key. 10,000 invalid checks measured at 1.28 s, and a 16 MB body carries far more. This
  partly reverses the point of checking the quorum before the tree rebuild.
- **M4, major. Authenticated adapter traffic shares one rate-limit bucket.** Every adapter makes the
  request itself, so the gateway sees one client for all users behind it, and one visitor can deny
  challenges to everyone else behind that adapter.
- **M5, major. Unbounded context trees.** DECIDED: implement a configured allowlist of context
  hashes, rejecting an unknown context BEFORE the proof verify.
- **M6, major. Platform nullifiers are not bound to the epoch schedule.** Both local durable stores
  refuse to open under a changed schedule; the Platform backend silently reinterprets.
- **m1, minor.** Health reports ready in single-tier mode with no DML root, hiding an oracle outage.
- **A1, major (architecture).** Every members-root update rebuilds a full depth-16 tree on the event
  loop. Measured: about 9 s per root, 19.6 s for a first-context commit, 32.7 MiB retained. One
  ordinary first registration blocks every HTTP handler for roughly 20 seconds. The fix is an
  incremental Merkle frontier, which is a real rewrite and should be its own change.
- **A2, minor.** The registration store retains and rescans every historical season.

### Two ideas from the round worth keeping

- `/v1/dml` lookup BY ROOT, which would close the documented challenge-to-refresh race without
  re-challenging, using state the gateway already holds.
- A generated state-machine test over clock, commit, rollover, refresh, and restart interleavings.
  The round's own blocker came from wall time advancing with no explicit call, which is exactly the
  shape example-based tests keep missing.

### One caveat on the round's own evidence

The reviewer could not run the 70 loopback tests (its sandbox forbids binding 127.0.0.1) and
treated them as unexecuted rather than failing. They pass here. Its focused probes are what carry
its measured claims, not the suite.

## CURRENT STATE, 2026-08-02 (night, after the fresh full round)

`main` at `cbbb1cd`, 420 tests green, clean tree. A FRESH FULL four-reviewer round ran on the
chain-anchor surface and every finding is folded. Read this section, then `docs/PRECOMMIT_ADOPTION.md`.
Everything below is superseded.

### What the round found, and what it means

Four reviewers, two BLOCK and two APPROVE-WITH-FIXES. The round was worth running: it found a
blocker that four prior focused passes had missed, and the finding TWO families reached
independently was the same one.

- **The blocker.** The served snapshot and the root window were separate authorities aged by
  separate rules. A record could expire leaving the window populated and the served snapshot null,
  so a challenge was minted against a root whose leaves the gateway would not serve, and the
  same-height coexistence guard, being conditional on that pointer, was skipped entirely. Fixed by
  CONSTRUCTION: the snapshot now rides in the window record, so the two cannot be separately aged.
- **The wedge.** `mayCoexist` demanded the leaf orders DIFFER, which read as tighter and was looser
  in effect, refusing an identical republish so the older root aged out while still being published.
  The check is now same block and same leaf multiset, whatever the order.
- **Three families agreed on two more**: block hashes must be one canonical lowercase schema
  everywhere (an uppercase v2 and a lowercase v3 for the same block read as different blocks and
  refused the changeover), and the signed message must be self-framing (a reviewer supplied a
  concrete collision where a newline moved a field boundary).
- **The twin-hunt paid.** `oracle/snapshot.js`, the LIVE builder, filtered on status before
  validating anything, so a malformed response silently shortened the signed member set. The round
  was framed to hunt twins of the folded fixes and this was one, in the wired path.

### Two things the round changed about the discipline itself

- **Rule 2 caught its first author-side defects here**, both in my own tests: a mutation that did
  NOT fail its test (revealing the test claimed coverage of a half-defect that is closed by
  construction) and a test asserting a state the code cannot reach. Nine trial rows in, that is the
  first time an author-side rule caught something before the external checker.
- **Fixtures were proving the builder against input Core cannot emit.** The legacy oracle test keys
  were "bbbb-1" and friends. They are now real outpoints in the same relative order, so every golden
  constant is untouched.

### Known residuals, stated not implied

- NOT COVERED by tests: overlapping refreshes completing in reverse order, and oversized-body
  cancellation. Each needs a seam the gateway does not expose.
- BREAKING: a deployment publishing uppercase block hashes must republish and re-sign.
- A prover that fetches leaves after a changeover can still receive a different snapshot than its
  challenge named, and must re-challenge. Lookup by root is the fix and is not built.

## CURRENT STATE, 2026-08-02 (late evening)

`main` at `c59efde` plus this handoff commit, ahead of `origin/main` (`e0f128c`), NOT yet pushed.
386 tests were green at `e0f128c`, no test files changed since, and the full suite passed inside the
new pre-commit gate when `c59efde` landed, which is the only way that commit could land with the hook
installed. Everything below is superseded.

### START HERE, in this order

1. **Read `~/.claude/playbooks/pre-commit-self-verification.md` before writing anything**, then this
   repository's instantiation of it, `docs/PRECOMMIT_ADOPTION.md` (scope, oracles, invariant classes,
   gates, trial log). The playbook was added today and it is aimed squarely at how this project has
   been failing. Applying it in one session changed two fixes for the better and exposed a hole in a
   test I had just written. The rules, and what each caught here, are in "The playbook, and what it
   is worth" below. In a fresh checkout, run `git config core.hooksPath tools/hooks` once, or the
   test gate does not run at all.
2. **The two chain-anchor blockers are closed** (`4b45a2c`, see "Open findings"). The remaining
   majors from that round are the next fold.
3. **The end-to-end refresh-path test does not exist** and three commits say so. See "Claims that are
   deliberately narrower than they look".

### Where the project is

Anonymous zero-knowledge proof of masternode control gating a private community. Working prototype,
validated on real mainnet data, NOT audited. Do not gate anything of value.

### What happened this session

**The chain anchor got its answer.** The Dash Core lead confirmed `merkleRootMNList` in the coinbase
special transaction is the canonical, consensus-enforced commitment, and that it commits `keyIDVoting`,
which is the exact field this project's leaf is built from. So the design needs no rework to be
anchorable. Full detail and his four foot-guns are in `TODO.md`. One of them, that `isValid` is part of
the commitment so a PoSe-banned node is IN the list, is already handled by the oracle's `ENABLED`
filter.

**Direct node mode was started, on `protx diff`.** `oracle/diff_snapshot.js` is a block-bound,
ChainLock-gated read. NOT wired in. It reads the ChainLock first so a node cannot pick a block to suit
its answer, and refuses unless the diff's own `blockHash` matches.

**A review of that work returned six blockers and twelve majors.** Four blockers are folded. The
review is the most valuable this project has had and its findings are worth reading before touching
any of it.

### What the late-evening session added, 2026-08-02

The playbook is now INSTANTIATED here, not just referenced. Three things landed in `c59efde` plus
this handoff commit:

- `docs/PRECOMMIT_ADOPTION.md`, the adoption note, written from an external draft and then vetted
  claim by claim against this repository before placement. Both quoted git-log specimens are
  verbatim real, the test command matches `package.json`, and the no-hook finding was confirmed.
  One material correction was made: the recommended gate scope was widened from the draft's four
  directories to include `adapters/` and `oracle/`, because rounds 9 through 12 were all adapter
  findings and both open blockers are in the oracle, so the draft would have left the most
  defect-dense code ungated.
- `tools/hooks/pre-commit`, the first gate that BLOCKS. It runs `npm test` when staged files touch
  gated paths, refuses instead of hanging when another suite is active, and fails closed on a
  failed staged-diff read. Its failing path was watched refusing a deliberately broken test (pass
  380, fail 1, HEAD unchanged) before the adopting commit went through it.
- The trial log has its first row. A focused external artifact check (a different model family)
  returned FIX-FIRST twice on the gate itself and all findings were folded before landing. No
  author-side rule caught a defect before the checker did, the sixth consecutive data point for
  that pattern, which is exactly the question the re-trial protocol says this repository exists to
  answer.

### The correction that matters most

I documented a security guarantee that was FALSE, and a reviewer caught it the same day. It said
role-level denies were the supported, safe way to exclude somebody from a gated channel.
`GuildChannel.memberPermissions` applies the member overwrite's ALLOW last, after every role deny, so
the bot's own grant outranks the exclusion. Combined with member-level denies being unprotectable,
THERE IS NO DISCORD-NATIVE EXCLUSION that survives this bot's grant. Retracted in `CLAUDE.md`, the
README, this file, and the code comments. Do not restore it. `TODO.md` holds the only design that can
work.

### Open findings, chain-anchor review

**Both blockers are CLOSED in `4b45a2c` (2026-08-02, late).** `chainlocked` is now required, not
just signed: `snapshotMessage` refuses to form without it (so an unlocked v3 can be neither signed
nor verified, with signed bytes unchanged for valid snapshots) and `validateSnapshot` demands the
claim plus a 64-lowercase-hex `blockHash` in signed and unsigned mode alike. The RPC boundary in
`oracle/diff_snapshot.js` refuses missing and mistyped security fields (`known_block` must be
boolean true, `diff.blockHash` must be a string before comparison, entry fields typed over the
whole list before the validity filter, duplicates refused). Thirteen new tests, each watched
failing against the prior code, including a signed unlocked v3 whose old-encoding signature the
prior code verified and adopted. The comparator-totality major closed with the same change.

Still open from that round: most of the remaining majors, including `current()` not actually being
the last adopted snapshot, and tests that prove isolated mechanics while naming end-to-end
guarantees. A new known minor from the fold's own review: a primitive non-object `mnList` entry
fails closed on the presence check but with a raw TypeError rather than a named refusal.

### Claims that are deliberately narrower than they look

Three commits say what they do NOT prove, and a future session should not read past that.

- RESOLVED in `7b3ac96`: the end-to-end refresh-path test now exists. Two valid snapshots (a v2 and
  a v3 over the same height, block, and leaf multiset) drive the real gateway's refresh path, and
  window membership is observed through the verify endpoint without a proof (a canonical-signal
  probe with a wrong epoch distinguishes the root check's outcome). The negative twin, a
  different-set v3, synchronizes on the gateway reporting its rejection. The original narrow claim
  is kept below as the record of what was missing.
  - Superseded: the coexistence tests drive `RootWindows`, not the gateway refresh path. The rule is
    proved correct; that the refresh path reaches it is NOT proved. The reviewer asked for two valid
    snapshots driven end to end and that test does not exist.
- `oracle/diff_snapshot.js`'s block-bound check closes the A to B to A residual **against an honest
  node only**. One server answers the ChainLock query, `known_block`, `diff.blockHash`, and `mnList`,
  so a dishonest one can return matching hashes with an arbitrary list. It is a trusted-node read, not
  a chain-authenticated one, and pinned signer trust is still load-bearing until the
  `merkleRootMNList` check exists.
- The `protx diff` field names are UNOBSERVED. They come from DIP4 and are corroborated by the Core
  lead, but nobody has seen the JSON. `getbestchainlock`'s shape IS observed from mainnet and matches.

### The playbook, and what it is worth

`~/.claude/playbooks/pre-commit-self-verification.md`, four rules, all four earned their place today.

1. **Enumerate invariants before committing a fix.** This changed two fixes. Allowing two roots at one
   height looked like a one-line relaxation until the invariant list showed the old blanket rejection
   was the only thing guaranteeing a source cannot present two different LISTS at a height. That is
   why `mayCoexist` checks the block and the leaf multiset instead of just letting the pair through.
   And keying the window on height alone silently guaranteed one record per height, which I had
   destroyed two commits earlier without noticing, and which a reviewer reproduced at 1,002 records.
2. **Mutation-check every test as it is written.** Recorded as a table in each commit message. It
   found that admitting v1 to the dual-root set fails NOTHING, because v1 is caught by the shaRoot
   check before the version enumeration is reached, so that invariant has no covering test and cannot
   have one until a version exists that carries a root and should not be trusted.
3. **Claims come from outputs, not intent.** The highest-value rule and the one I broke twice today. I
   told Hilawe "the node is syncing" when it had exited an hour earlier, and I wrote "385 tests pass"
   in commit `2b4e132` when the actual number was 386, from a stale reading. Re-derive anything
   time-varying at the moment of writing.
4. **Make design invariants executable.** `RootWindows.adopt` now throws on an unknown leaf ordering.
   The gateway deriving a safe key is a property of ONE caller; the store's bound depends on the key
   space, so the store enforces it. The reproduction that produced a thousand records now produces a
   thousand refusals.

Use the focused external artifact check (a different model family) at
`/tmp/precommit_check_dash-mno-verify.md` for changes whose
reasoning is not mechanical. I skipped it for the contained ones and said so, which the playbook
allows and asks to be stated.

### The node, and how to restart it

A wallet-free copy of the mainnet datadir is at `~/dashcore-node-datadir`, 50 GB. The ORIGINAL at
`~/Library/Application Support/DashCore` holds two wallets and must never be mounted. It was last
written by v23.0.2 in December and the container image is v23.1.7, which would upgrade it
irreversibly.

The copy needs `-reindex-chainstate` because its evolution database is inconsistent, which is the
datadir's condition and not the copy's. Two gotchas already paid for:

- `-reindex-chainstate` is incompatible with the datadir's transaction index. Pass `-txindex=0`.
- **The colima VM is too small for this reindex as configured, and lowering the cache did not fix
  it.** The VM has 5.77 GB. `-dbcache=4096` was OOM-killed at 19%. `-dbcache=1024 -par=2` sat at
  1.35 GB early and was ALSO OOM-killed, again at 19.5%, height 1,047,206, after about 75 minutes
  (`OOMKilled: true`, exit 137). Both deaths land at the same place, which is where the evolution
  database rebuild becomes memory-hungry rather than anything about the cache setting.

  An earlier version of this file said `-dbcache=1024` "survives", written from a reading taken two
  minutes after start and before the expensive phase. It does not. That is rule 3 of the pre-commit
  playbook failing inside the handoff that introduced the playbook, which is worth leaving on the
  record rather than quietly editing away.

  The fix to try first is a bigger VM, not a smaller cache: `colima stop && colima start --memory 12
  --cpu 4`. Confirm the host has the headroom before doing it. If that still dies at the same height,
  the evodb rebuild needs more than this machine will give a VM and the answer is a different route to
  a synced node entirely.

  **THE RESTART IS PARKED ON A CROSS-PROJECT DECISION, checked 2026-08-02 late evening.** Two facts,
  both measured this session, block just running the command:

  - The colima VM is shared, and `colima stop` ends every container in it. Live right now: the full
    dashmate local network (about 22 containers, up 11 days), `tegara-fork-live` (up 3 weeks),
    `shoal-l1` (up 3 weeks), and `inspiring_lewin` (up 2 weeks), all belonging to other projects.
    Whether those can be bounced, and when, is not this project's call.
  - `docker stats` shows the other containers holding about 3.2 GB of the VM's 5.772 GB, so dashd
    was effectively reindexing inside roughly 2.5 GB. That is consistent with both deaths at the
    same height and strengthens the bigger-VM diagnosis. The host has 16 GB total, so a 12 GB VM is
    at the host's edge, and keeping dashmate stopped during the reindex is the way to make the new
    headroom real rather than nominal.

  The recommended sequence, once the owner of the other work says the window is open: stop the
  dashmate group cleanly (`dashmate group stop`), note that `tegara-fork-live` and `shoal-l1` will
  be stopped by the VM restart, `colima stop && colima start --memory 12 --cpu 4`, remove the dead
  container (`docker rm dash-mno-node`), rerun the `docker run` recipe below, and only restart the
  dashmate group after the reindex passes height 1,047,206 or finishes. If it dies at the same
  height again with the whole 12 GB, take the different route to a synced node.

  **EXECUTED 2026-08-02, about 21:08 local, on Hilawe's go-ahead.** The dashmate group stopped
  cleanly, the VM came back at 11.65 GiB and 4 CPUs, and the reindex relaunched with the recipe
  below. One minute in it was running at height 16,593 holding 1.36 GiB. Two consequences the next
  session must know:

  - NOTHING auto-restarted after the VM bounce. `tegara-fork-live`, `shoal-l1`, and
    `inspiring_lewin` are STOPPED until someone starts them, and the dashmate group stays stopped
    (`dashmate group start`) until the reindex clears the death height.
  - The outcome at height 1,047,206 was not yet known when this was written. Check with
    `docker inspect -f '{{.State.Status}} {{.State.OOMKilled}}' dash-mno-node` and
    `docker logs --tail 3 dash-mno-node` before believing anything about the node.

```
docker run -d --name dash-mno-node \
  -v "$HOME/dashcore-node-datadir":/home/dash/.dashcore -p 127.0.0.1:9998:9998 \
  dashpay/dashd:latest dashd -printtoconsole -disablewallet -reindex-chainstate -txindex=0 \
  -server -rpcuser=probe -rpcpassword=probe -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 \
  -dbcache=1024 -par=2
```

After the reindex it still has about 121,000 blocks to catch up. `rpc.digitalcash.dev` answers
`getblockcount` and `getbestchainlock` but REFUSES `protx diff`, so a public endpoint cannot settle
the shape question.

### Gotchas that cost real time

- **Never run two `npm test` suites at once.** They contend for the same loopback port,
  `gateway_http` waits rather than failing, and `--test-timeout=0` means nothing cuts it off. Two
  orphaned runs had to be terminated by hand.
- **A scripted edit whose replacement string has the wrong indentation matches nothing and reports no
  error**, and if the script asserts before its write call the file is not touched at all. This bit
  four times. Grep for the change after every scripted edit.
- A `python3` heredoc with no `open(...).write(...)` silently changes nothing.

### Punch list

1. The named chain-anchor majors are closed: comparator totality (`4b45a2c`), `current()` adoption
   order, the end-to-end refresh-path test, and the primitive-entry diagnostic (all `7b3ac96`).
   The round's full twelve-major list was never committed and lives only in the prior session, so
   any un-itemized remainder needs that session's record or a fresh review round to recover.
4. The record-format design covering NF2, NF3, and the exclusion gap. All three share one root cause:
   a grant record holds ONE deadline and ONE target set and these need per-target state. Each has
   already had one patch fail in a new place. Change the format once.
5. The node reindex CLEARED THE DEATH HEIGHT. It passed 1,047,206 holding 2.8 GiB and was
   confirmed 100,000 blocks past it at 3.5 GiB, so the VM was the variable, as diagnosed. The
   dashmate group, `tegara-fork-live`, and `shoal-l1` are restarted and running beside it.
   `inspiring_lewin` NO LONGER EXISTS: it was evidently created with --rm, so the VM stop removed
   it (its image survives). Flag that to whichever project owned it. The reindex continues, then
   about 121,000 blocks of catch-up, after which direct node mode can confirm the protx diff
   response shape.
6. Wire direct node mode, once the node can confirm the response shape.
7. The `merkleRootMNList` check, an increment from there.
8. The parser decision, whether to add a dependency so the permission module boundary is enforced
   rather than tripwired.
9. Decide what to do about external model names in committed review records. The authorship rule
   says committed artifacts describe reviewers generically, and this file's CURRENT section now
   does, but the append-only historical sections (three mentions) and one committed round-10
   findings file still carry product names. Rewriting history conflicts with the append-only rule,
   so this is a deliberate decision, not a cleanup to do in passing.
10. An audit. Still none.

## CURRENT STATE, 2026-08-01 (evening, session paused mid-cycle)

`main` at `5d08856`, pushed, 354 tests green. Working tree clean apart from two untracked reviewer
findings files. Round 12 is FOLDED but NOT CONFIRMED, and that is the single most important fact here.

### Pick up exactly here

1. **Run a focused confirmation on the round 12 fold** (`git diff 51b22c7..5d08856`). Do not skip it
   and do not start anything else first. Every fold this week has introduced something, and two of the
   last three introduced blockers that only a confirmation caught. The base rate is two in three.
2. Then the parser decision, Pasta's answer, the exclusion feature, and the punch list below.

### What round 12 found and what was done

Four reviewers, all rejecting. Six blockers, four of them mine from the preceding two days. All folded
in five commits, one defect each, every fix verified by reverting it and watching a test fail.

- `51b22c7` keep-on-uncertain-failure is now opt-in (`repairs`), because it was silently stranding
  Matrix and Telegram members who have no repair pass. The exclusion gap was recorded in `TODO.md`.
- `0da3c2c` a failed orphan revoke restores the prior record. The covering row carries the NEW
  deadline, so leaving it extended a retired channel's life and the sweep never retried.
- `ec4ff42` an unlabelled legacy row belongs to the ledger's BOUND scope, not the current guild.
  Resolving it the other way let cleanup in one guild delete another's record.
- `23f2f4b` Discord grants carry and compare `contextHash`, which Matrix and Telegram always did. A
  record with no context authorizes nothing, because unknown authority is not local authority.
- `5d08856` preview and apply share one predicate, and the comment claiming they already did is fixed.

### The retraction that matters most

I documented a security guarantee and it was FALSE. It said role-level denies were the supported, safe
way to exclude somebody. `GuildChannel.memberPermissions` applies the member overwrite's ALLOW last,
after every role deny, so the bot's own grant outranks the exclusion. Combined with member-level denies
being unprotectable, THERE IS NO DISCORD-NATIVE EXCLUSION that survives this bot's grant. Retracted in
`CLAUDE.md`, the README, this file, and the code comments. Do not restore it. See `TODO.md` for the
only design that can work.

### Two gotchas that cost real time today

- **Do not run two `npm test` suites at once.** They contend for the same loopback port, `gateway_http`
  waits rather than failing, and `--test-timeout=0` means nothing ever cuts it off. Two orphaned runs
  had to be terminated by hand today, and one of them looked like a hung test rather than my own
  overlap.
- **A scripted edit whose replacement string has the wrong indentation matches nothing and reports no
  error**, and if the script asserts before its write call, the file is not touched at all. This bit
  three times today. Grep for the change after every scripted edit.

## CURRENT STATE, 2026-08-01

`main` at `b4b4da1`, pushed, 338 tests green (`npm test`, about two and a half minutes). Node 22.13 or
newer. Read this section, then `TODO.md`. Everything below is superseded.

### THE PERMISSION GUARANTEE, NARROWED ON PURPOSE. Read before touching the adapter.

The round 11 confirmation is in and it is the first thing to read. `main` is at `56876d2` and three of
its findings are NOT RESOLVED, deliberately left for a fresh start.

**discord.js `edit()` is a read-modify-write against the cache, inside the library.**
`PermissionOverwriteManager.edit()` looks up the existing overwrite in the CACHE and passes it to
`PermissionOverwrites.resolveOverwriteOptions`, which rebuilds both bitfields and sends them whole.
Verified in the installed 14.26.4 source.

So the central claim of the current design, that naming only allowed bits means a deny is never
written or cleared, is FALSE AT THE WIRE LEVEL. The deny bitfield is always transmitted, rebuilt from
whatever the cache held. A denial added since the cache was populated is wiped by any edit on that
overwrite, whichever bits are named. All three attempts at this rule share that defect.

The project's documented residual is therefore narrower than the truth. It is not only that the CHECK
reads a cached view. Every WRITE rewrites the whole overwrite from a cached view.

**THE ADAPTER CANNOT ENFORCE AN EXCLUSION AT ALL. Two facts combine, both verified in the installed
`discord.js` 14.26.4 source.**

- A member-level deny is not protectable. `edit()` rebuilds both bitfields from its cache and sends
  them whole, so a deny the cache has not seen is destroyed by any change the bot makes to that entry.
- A role-level deny does not exclude anybody the bot grants to. `GuildChannel.memberPermissions`
  applies the member overwrite's ALLOW last, after every role deny and role allow, so the bot's grant
  outranks the exclusion. The role entry survives untouched and has no effect.

I claimed for several hours, in this file, the README, and CLAUDE.md, that role-level denies were the
supported safe mechanism. That was WRONG, and a reviewer caught it the same day. The mistake was
confusing "the bot does not edit the role entry" with "the role entry still has effect". All three
documents are corrected. Do not restore that claim.

A real exclusion has to be OWNED BY THE BOT and checked as part of admission, before it grants, rather
than expressed in Discord permissions and hoped to survive. That does not exist yet, and building it
is the open design decision. Until then the honest statement is that an operator cannot keep a
specific person out of a gated channel while this bot is granting access to it.

Both mutations do refresh the channel immediately before deciding and writing, which shrinks the
member-level window to milliseconds. That is worth keeping and is not an exclusion mechanism.

The other two NOT RESOLVED items are `allowForeignScope`, which bypasses the binding without requiring
the target rows to belong to the configured guild (reproduced: it retired a guild A role row while
operating in guild B, combined with `--confirm-target-gone`), and the partial-refusal message, which
still says "some of your access was applied" when the error records possible mutation rather than
actual application.

Two regressions this fold introduced were fixed before stopping: the refusal path rereading a revision
after its await and deleting a replacement row, and the covering default breaking Matrix and Telegram.
Both are in `56876d2`, both reproduced by the confirmation, and neither existed the previous morning.

### Where the project is

Unchanged in substance. Anonymous zero-knowledge proof of masternode control gating a private
community. Working prototype, validated on real mainnet data, NOT audited. Do not gate anything of
value. Everything since 2026-07-29 is the Discord adapter, the shared grant ledger, and the
decommission command.

### READ THIS BEFORE FOLDING ANOTHER REVIEW ROUND

**Two of the three folds in this stretch introduced blockers of their own, and the reviewers found
them within hours.**

- The round 10 fold closed twelve findings and introduced three blockers plus a major. A focused
  confirmation caught all four.
- The fix for the mixed-denial case introduced a blocker that two model families found independently,
  and the executing reviewer found the SAME fix broken in the opposite direction at the same time.
- The round 11 fold has not yet been confirmed. Assume it is the same until a round says otherwise.

The pattern is not carelessness about any one fix. It is that a fix written immediately after reading
a finding tends to solve the case in front of it and break the neighbouring one. The countermeasures
that demonstrably worked:

1. **One defect per commit**, each with a test that fails against the code it replaces. Verified by
   actually reverting the fix and watching the test fail, not by assuming.
2. **Fix the twin in the same commit.** Every time a twin existed and was left, the next round found it.
3. **A focused confirmation after every fold.** The one run here found three blockers a fresh round
   would have taken longer to reach.
4. **State what is NOT pinned.** Several fixes have properties no test in this suite can reach, and
   saying so in the commit is the only thing that stops them reading as verified.

### The permission model, settled at the third attempt

`clearManagedAllows` computes its patch from the bits CURRENTLY ALLOWED and sets only those to null.
Do not replace it without reading why the other two designs failed:

- Nulling all three bits cleared an administrator's DENY as well as the allow, so removal lifted an
  exclusion and a role-level allow let the excluded member back in. Removal granted.
- Reading the overwrite and writing back a merged version is read-modify-write against a cache on a
  surface other people edit, so a denial the cache had not seen was destroyed by the code protecting it.
- Refusing to touch an overwrite carrying any denial left the allowed bits in place permanently and
  jammed the sweep every interval. Judging "nothing remains" from explicit allows also missed access
  INHERITED from a role, so the opposite case deleted the row while the member could still see the
  channel.

A deny bit is never in the allowed set, so it is never written and never cleared. There is now no
refusal on the clear path at all: refuse a GRANT over a denial, never refuse a CLEAR.

**Inherited role access is out of scope, not solved.** Resolving effective permissions needs the
privileged member intent this adapter dropped with role mode. The bot owns the member overwrite slot
and clears what it put there.

### Invariants that cost a blocker each to learn

- **The ledger row must always be a superset of what could be live.** A renewal commits a COVERING
  record naming both new and orphaned targets BEFORE revoking anything. Revoking first meant a failed
  write left the old access gone, the new never applied, and the row naming only the old target, with
  the epoch's proof already spent.
- **Every guard needs an exit that correct operation reaches.** Four instances so far. The inverse
  also bites: an exit must not accept weaker evidence than the guard demanded, which is how
  `--confirm-target-gone` plus one Discord 500 nearly retired a live role.
- **Repair is the only operation that grants from a stored record rather than a fresh proof.** It runs
  inside `admitIfLive` for serialization and checks guild, expiry, and configured channels itself.
- **Role mode is REMOVED and must not come back.** A Discord role is on the profile card, so it
  disclosed who holds a masternode. Role targets survive only in `discord:decommission`.

### Review framing, still the highest-leverage thing

The 2026-07-30 section's list holds. What round 11 added:

- **Name the defect shape in its costumes and ask for each explicitly.** Round 11 got hits on all
  three: twins, correct-arguments-that-miss-the-path, and guards with no exit.
- **Tell reviewers the fixes are the highest-risk surface**, because for two rounds running they were.
- **Say which files are NOT in the packet.** A reviewer once concluded a file was missing when it was
  present, said so in writing, and reviewed on that premise, missing a blocker inside it.
- **Declare non-findings.** Removed features and deliberately narrowed test claims, so effort goes
  elsewhere.
- The executing reviewer remains the load-bearing one. Every reproduction came from it.

### Gotchas new this stretch

- A `python3` edit script with no `open(...).write(...)` silently changes nothing. This happened twice
  and both times the surrounding edits landed, so the file looked edited. Re-grep after every scripted
  edit.
- A replacement string with the wrong indentation matches nothing and `str.replace(..., 1)` reports no
  error. A "revert and check the test fails" step that silently reverts nothing proves nothing.
- `ledger.get()` returns the record, not `{record, rev}`, and a missing row is `null`.
- `entries()` exists because `all()` drops the account id. An optional-call `entries?.()` would have
  made the whole repair pass a silent no-op.
- The test fixtures in `discord_access.test.js` and `discord_decommission.test.js` take channels
  differently. One nests under `channels`, the other does not.

### Punch list, in order

1. **Fold the rest of round 12.** Five blockers remain open, listed below. Two decisions were taken:
   keep-on-uncertain-failure is now opt-in (`repairs`), and the exclusion gap is recorded in `TODO.md`
   rather than built.
2. **The exclusion mechanism**, when it is wanted. A bot-owned admission check is the only design that
   can work. See `TODO.md`.
3. **Round 12's open blockers**: the covering record extends orphaned access to the new deadline,
   foreign-scope cleanup resolves a legacy row against the current guild instead of the bound scope,
   Discord grants are not bound to their proof context while Matrix and Telegram compare `contextHash`,
   and decommission preview diverges from apply on fully-denied members.
2. **The parser decision.** `test/discord_permissions.test.js` is an honest tripwire, not a proof: the
   cache hands back a mutable object, so `cache.get(id).edit(...)` passes. Closing it needs a parser
   dependency, which is a decision rather than a test tweak.
3. **Pasta was asked** whether `merkleRootMNList` in the coinbase is the right anchor for checking a
   masternode-list snapshot against the chain. His answer decides whether the pinned-key trust can be
   dropped entirely.
4. **A periodic re-check of the current target**, not only at startup.
5. **Confirm the `dash-cli` read buffer against a real node.**
6. **Direct node mode** and **the durable Platform claim**. Neither started, and they gate real use.
7. **An audit.** Still none.

### Naming note

"Oracle" reads as a trusted third party and the thing it names is a snapshot publisher: it applies a
deterministic function to public chain data and anyone can recompute it. The word is load-bearing
internally (`oracle/`, `MNO_ORACLE_PUBKEYS`, `MNO_ORACLE_QUORUM`) so renaming is a real change, not a
tidy-up. Avoid the word in anything external.

### BREAKING ON UPGRADE: existing Discord grants lose their access once

Grants written before `23f2f4b` carry no `contextHash`. They cannot say which context they were proved
in, so they authorize nothing, and the first startup after upgrading takes that access back. Those
members must verify again, and one on a Platform-backed nullifier store cannot do that until the next
epoch.

That is the correct decision, because assuming a context is exactly the "unknown means ours" mistake
the guild binding cost two blockers for. What was wrong was doing it silently. Startup now names the
count and says it is a one-time upgrade effect before the pass runs.

Plan the upgrade for an epoch boundary if the timing matters. If a deployment ever needs the rows kept
instead, the shape is an explicit operator assertion that transactionally stamps a named legacy
context, in the same style as `DISCORD_LEDGER_ADOPT_GUILD_ID`. It does not exist and should not be
inferred.

### Breaking changes for any existing deployment

Everything in the 2026-07-30 list, plus:

- `DISCORD_RESET_CLOCK=1` now exists and is the documented escape from an inflated clock floor.
- Decommission takes the ledger lock BEFORE logging in, reads the same legacy JSON the bot does, and
  can open a ledger bound to another guild for cleanup without changing the binding.
- `--confirm-target-gone` is refused unless a ledger record names the target.

## CURRENT STATE, 2026-07-30

`main` at `7427a34`, pushed, 307 tests green (`npm test`, about two and a half minutes). Node 22.13 or
newer. Read this section, then `TODO.md`. The 2026-07-29 section below is superseded.

### Where the project is

Unchanged in substance. Anonymous zero-knowledge proof of masternode control, gating a private
community. Oracle reads the deterministic masternode list and publishes a Merkle root, a
platform-neutral gateway verifies proofs and issues short access grants, adapters apply them. Working
prototype, validated on real mainnet data, NOT audited. Do not gate anything of value.

Everything this session touched is the Discord adapter, the shared adapter grant ledger, and the
decommission command.

### ROLE MODE IS GONE, and this is a product decision, not a refactor

A verified member is added to the private channel with a per-user permission overwrite. That is the
only mode. A Discord role is visible on the member's profile card to everyone in the server, so
granting one announced who holds a masternode, which is the fact the whole construction exists to
keep private. It defeated the system by design rather than by defect, so hardening it further was the
wrong answer. `DISCORD_GRANT_MODE=role` and `DISCORD_MNO_ROLE_ID` refuse to start.

Role targets survive in exactly one place, deliberately. `npm run discord:decommission -- role:<id>`
still takes back access an earlier deployment granted, and the bot refuses to start while any role
grant remains in the ledger, printing the command for each. Removing a mode must not strand the
access it granted.

Do not reintroduce role mode. If someone asks for it, the answer is that the privacy property is the
product.

### Round 9 and what closed it

The ninth review round, four reviewers, four BLOCKs. Every finding is now closed.

- **`615f7fe`** One module owns every permission change. `adapters/discord/permissions.js` holds the
  only permission mutations in the project, each carrying its own denial check. The check had reached
  `revokeAccess` and missed the grant path, reconciliation, and all four role mutations, so a member
  an administrator had excluded could walk back in by running `/submit`. Also stopped the role branch
  calling `process.exit(1)`, which ran before the sweep timer was installed and so froze cleanup for
  everyone.
- **`f8579b6`** The ledger database is bound to one guild in durable metadata, not only per record.
  Per-record fields cannot cover records written before the field existed, and reading "unknown" as
  "ours" let a repointed bot delete the record of access still live elsewhere. An unbound ledger
  holding grants fails closed and needs `DISCORD_LEDGER_ADOPT_GUILD_ID` naming the guild explicitly.
- **`f6609de`** Decommission retires the rows it clears, and only what actually came back. A row is
  not history to the sweep, it is revocation work still owed, so a retired channel left in a record
  got its bits cleared again later, possibly stripping unrelated access. An empty bound ledger now
  rebinds, which is the exit the previous commit's guard was missing.
- **`7617c56`** Tests that prove the guards refuse and that nothing can bypass them.
- **`8504bd5`** Role mode removed.
- **`7427a34`** `grant()` judges the deadline against the clock floor like every other decision. It
  used the raw reading, so after a forward jump and a correction it applied access the ledger already
  considered expired, live until the next sweep and repeatable after each one.

### THE ONE DEFECT SHAPE THIS COMPONENT PRODUCES

Nine rounds, one shape, in three costumes. Read this before touching the adapter.

1. **A fix lands where the reviewer pointed and its twin survives nearby.** Eight rounds of this. The
   answer that finally worked was structural, not another careful fix: put the check and the mutation
   in one operation, in one module, and add a test asserting no other file can mutate at all. That
   test catches the next occurrence by itself, including in code nobody has written yet.
2. **A correct argument that never reaches the actual path.** The comment defending the raw clock was
   right about the gateway owning the deadline and right about the outage cost, and never mentioned
   the `apply()` call below it. "Every caller checks" was right about two callers. "The ledger is
   history" was right about what a human means by a ledger and wrong about what the sweep does with
   it. When a comment argues for something, check the paths it does NOT mention.
3. **A guard with no exit.** The guild binding refused a repoint and gave the operator no way to
   satisfy it, so correct operation could not complete. A refusal that protects something real can
   still be wrong. Every guard needs an exit that ordinary correct operation reaches.

### How to run reviews here, still the most transferable thing

Framing changes results more than the code does. The 2026-07-29 section has the full eight lessons and
they all still hold. The ones round 9 confirmed again:

- **Never frame a packet as "confirm these fixes".** Still true.
- **Ask whether an operation can do the OPPOSITE of its purpose.** Produced two of round 9's blockers.
- **Ask whether a comment claims more than the code does.** Produced the finding that anchored the
  whole round.
- **Make reviewers separate READ from INFERRED.** Round 9's packet reviewers used it honestly and it
  made their reviews far more useful. It is also how the role-mode decision got made: every role
  finding in every review was INFERRED, because nobody could execute those semantics.
- **The executing reviewer does the load-bearing work.** Again. Every correct finding came with a
  reproduction. One packet reviewer produced a wrong finding by missing a caveat eight lines from the
  claim it was disputing, and another reasoned away two real defects in writing.
- **Watch for identical reviews.** Round 9 produced two byte-identical pastes labelled as different
  models. That is one data point, not two, and it cost a re-run.

### Gotchas that cost real time

Everything in the 2026-07-29 list still applies. New this session:

- An `async` test fixture that tears down in a `finally` without awaiting the callback deletes its
  temp directory mid-test. One test failed correctly and another PASSED for the wrong reason. Await
  the callback.
- `get()` on the ledger returns the record, not a `{record, rev}` wrapper, and a missing row is
  `null`, not `undefined`.
- A structural test scanning for `roles.add(` matches a plain `Set` named `roles`. Match the receiver
  form.
- `roleId` in `core/gateway.js`, `common/`, and the provers is the PROTOCOL context id and has nothing
  to do with a Discord role. A search and replace over role tokens would break the context hash the
  nullifier is scoped to. Audit before editing.

### Punch list, in order

1. **A fresh full round on `7427a34`.** The shape changed substantially, so this reviews something new
   rather than re-reading folded fixes.
2. **A periodic re-check of the current target**, not only at startup. Cheap now that role mode is gone.
3. **Confirm the `dash-cli` read buffer against a real node.** `MNO_CLI_MAX_BUFFER` (64 MB) was
   reasoned from the 1 MB default and never observed failing.
4. **The three smaller items**: prevention rather than recovery for an implausible forward clock jump,
   a model-based crash harness that interrupts at every write boundary, and what mixed `hashVersion`
   gateways in one cluster should do.
5. **Direct node mode** and **the durable privacy-preserving Platform claim**. Neither started, and
   these two are what gate real use.
6. **An audit.** Still none.

### Breaking changes for any existing deployment

Everything in the 2026-07-29 list, plus:

- Role mode is removed. `DISCORD_GRANT_MODE=role` and `DISCORD_MNO_ROLE_ID` refuse to start, and the
  bot refuses to start while a role grant remains in the ledger.
- The bot no longer needs the SERVER MEMBERS privileged intent.
- A ledger holding grants but no guild binding refuses to start until adopted with
  `DISCORD_LEDGER_ADOPT_GUILD_ID`.
- Stop the bot before running decommission with `--apply`, since it now writes to the ledger.
- After a forward clock jump and correction, new grants are refused until real time passes the mark.

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
