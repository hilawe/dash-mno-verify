# Session handoff

The session-to-session log for this project. The CURRENT STATE section at the top is the one that
counts and supersedes everything below it. Historical sections are append-only and never rewritten,
only marked superseded. Read this first when picking the project back up, then `TODO.md` for the full
prioritized punch list.

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
