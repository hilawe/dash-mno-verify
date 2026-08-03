# Discord access review round 11

## Review basis

I reviewed `7427a34..9dbf92d` and the complete current state of every file named in the
round packet. I treated the eight fold commits as the highest-risk surface. I also traced the shared
ledger paths that those commits call, even where the relevant code predates the diff.

READ means the result follows from repository control flow or an executable reproduction. INFERRED
means the cost depends on Discord permission resolution or request ordering. Each inferred finding
states that assumption. I inspected the installed discord.js permission resolver, but I did not use a
live Discord server.

The worktree was clean at the start. I did not modify a tracked file.

## Executive assessment

The current fold is not safe to approve. The highest-impact defect is in the helper added to decide
whether a refused clear leaves access behind. It checks only explicit member allows. Discord also
inherits allows from roles and the server-wide role, so a member can keep `ViewChannel` while the
helper reports that nothing remains. The sweep then deletes the only ledger row for live access.

The refusal paths disagree in the opposite direction too. Decommission retains a row even when a
member-level `ViewChannel` denial means the member has no channel access. Repeating the documented
command repeats the refusal and never releases the ledger binding. The new confirmed-gone exit also
accepts weaker evidence than the guard demanded. A typo absent from both Discord and the ledger exits
successfully while the actual outstanding target remains.

A separate shared-ledger bug appears during target migration. The old platform target is revoked
before the replacement record is written. A failed write or process death leaves the old record on
disk after the access it describes has already been removed.

## Lens 1 findings

### F1 Inherited visibility is mistaken for no access

- Lens: 1
- Location: `adapters/discord/permissions.js:48-59`, `adapters/discord/access.js:150-166`,
  `adapters/discord/bot.js:388-407`, `adapters/discord/bot.js:433-436`,
  `adapters/common/grant_ledger.js:667-684`
- Severity: blocker
- Basis: INFERRED
- Assumption: discord.js applies base and role permissions, then removes the member overwrite's deny
  bits and adds its allow bits. A permission left unset in the member overwrite therefore remains
  inherited. This is the order implemented by the installed discord.js `memberPermissions` method.
- Concrete cost: `retainedManagedAllows` looks only at the member overwrite's explicit allow bitfield.
  A member overwrite that denies `SendMessages`, allows nothing explicitly, and inherits
  `ViewChannel` from a role returns an empty array. `revokeAccess` treats that as successful cleanup.
  The sweep then deletes the row although the member can still see the private channel. The same twin
  exists in reconciliation if the denial appears after `usableTargets` scans but before the clear.
  The pass logs that nothing remains, opens admissions, and leaves untracked visibility in place.
- Reproduction: I seeded an expired real SQLite ledger row, supplied an overwrite denying only
  `SendMessages`, and ran the real `GrantLedger.sweep` through `revokeAccess`. The sweep returned
  `['u1']`, made zero Discord edits, and deleted the row. The log said that nothing remained allowed.
- Specific fix: Base the decision on effective `ViewChannel`, not explicit member allows. If resolving
  effective permissions is unavailable on this path, treat a refusal as complete only when the member
  overwrite itself denies `ViewChannel` and does not also allow it. Use one shared outcome predicate in
  the sweep, startup reconciliation, and decommission paths. Add cases with inherited `ViewChannel`
  and member denies on each other managed bit.

### F2 Decommission cannot retire a member who is already fully denied

- Lens: 1
- Location: `adapters/discord/decommission.js:164-209`,
  `adapters/discord/decommission.js:243-289`, `adapters/discord/grant_ledger.js:134-155`,
  `test/discord_decommission.test.js:120-135`
- Severity: major
- Basis: INFERRED
- Assumption: a member overwrite denying `ViewChannel` prevents the member from seeing the gated
  channel, regardless of inherited role allows.
- Concrete cost: Decommission treats every `DenialConflict` as a failed pair. It keeps the row and
  reports that the member still holds access even when `ViewChannel` is denied and there is nothing to
  remove. A second run reaches the same branch. The ledger never empties, so it cannot rebind to a new
  guild. The operator's only exit is to remove the denial or the overwrite by hand before rerunning.
  Removing the denial can itself restore inherited access during the recovery window.
- Reproduction: I ran `runDecommission` twice against a real in-memory ledger and a member overwrite
  denying all three managed bits. Both runs returned `['c1/u1']` as failed, made zero edits, and left
  the row present.
- Specific fix: Use the same effective-access outcome as F1. A refusal that proves `ViewChannel` is
  denied is completed cleanup and may retire that pair. A refusal that leaves `ViewChannel` effective
  must retain the row and name the remaining access. Add a two-run test that drives `retireAll`, not
  only `revokeAccess`.

### F3 Target migration revokes the old access before the replacement is durable

- Lens: 1
- Location: `adapters/common/grant_ledger.js:586-605`
- Severity: major
- Basis: READ
- Concrete cost: A renewal that changes target calls `revoke` for the orphaned old target and only
  then calls `#put` for the replacement. If `#put` fails, or the process dies between those operations,
  the durable row still names the old target after that access was removed. The new target was never
  applied. The comment at lines 589-590 claims the prior access stays fully tracked and live, but the
  successful revoke immediately above makes the second half false. In Discord, repair deliberately
  ignores old channels no longer in the current configuration, so the member can remain verified,
  recorded, and locked out after spending the epoch proof.
- Reproduction: I granted `old`, made the next ledger write throw `disk full`, and renewed to `new`.
  The event sequence was `apply:old`, `revoke:old`. The call rejected, the durable row still named
  `old`, and neither target had effective access.
- Specific fix: Make migration a durable state machine. Before any external mutation, persist a state
  that covers every target that could remain live during the transition. Apply the new target, revoke
  the orphan, then narrow to the final record. A platform-specific wrapper that can represent both
  channel and role targets may be needed for old role rows. Add crash and write-failure tests at every
  boundary.

### F4 The confirmed-gone exit accepts a target the ledger has never named

- Lens: 1
- Location: `scripts/discord_decommission.mjs:68-73`,
  `adapters/discord/decommission.js:134-155`, `adapters/discord/decommission.js:243-257`,
  `scripts/discord_decommission.mjs:180-215`
- Severity: major
- Basis: READ
- Concrete cost: `--confirm-target-gone` turns an authoritative not-found into success without first
  checking that the locked ledger names that target. A mistyped target is also absent, so the command
  retires zero rows, reports zero failures, prints that it took access back, and exits zero. The real
  outstanding row and its access survive. This is the inverse guard defect requested in the packet.
  The new exit accepts weaker evidence than the original guard was protecting.
- Reproduction: I put a live row for `channel:actual` in the ledger and ran `runDecommission` for a
  missing `channel:typo` with `confirmGone: true`. It returned no failures, kept the actual row, and
  ended with `took access back from 0 member(s) on channel:typo`.
- Specific fix: Under the ledger lock, require every identifier accepted through `--confirm-target-gone` to be
  named by at least one current row. Refuse a target absent from both Discord and the ledger. If an
  operator needs to acknowledge untracked historical access, give that a separate, more explicit
  operation that cannot look like ledger retirement.

### F5 Repair mutates a channel that startup declared quarantined

- Lens: 1
- Location: `adapters/discord/bot.js:166-188`, `adapters/discord/bot.js:283-335`,
  `adapters/discord/bot.js:587-614`, `adapters/discord/access.js:21-26`,
  `adapters/discord/access.js:199-233`
- Severity: major
- Basis: READ
- Concrete cost: `usableTargets` removes a channel containing any member denial, reports that the
  channel is quarantined, keeps admissions closed, and says the channel is left alone. The ready
  handler still runs `sweepAndNotify`, which always calls `repairLiveGrants`. `repairAccess` filters
  against every configured channel rather than the usable channels, so it can grant a different member
  from a live record on the quarantined channel. The repaired member did prove for that record and the
  per-user denial guard still runs, which limits the damage. The mutation still bypasses the channel
  quarantine and contradicts the operator-facing refusal.
- Reproduction: I supplied a configured channel with a `ViewChannel` denial on `excluded`, then called
  the real repair for clean member `u1`. It sent the grant edit and returned `['c1']`.
- Specific fix: Make the usable target set the authority for repair. Pass the set returned by
  `usableTargets` into the repair pass, or maintain a mutable eligible set that is emptied whenever
  startup keeps interactions closed. Add a composition test that runs target classification followed
  by the scheduled repair.

### F6 A mixed grant refusal is reported as a temporary platform failure

- Lens: 1
- Location: `adapters/discord/access.js:50-86`, `adapters/discord/bot.js:551-579`,
  `test/discord_access.test.js:82-97`
- Severity: minor
- Basis: READ
- Concrete cost: When one channel grants and another refuses on a denial, `applyAccess` sets
  `mutated = true`. That is correct for ledger retention, but it erases the permanent-refusal dimension.
  The interaction handler takes the generic branch and promises automatic application within a few
  minutes. Repair will refuse the denied channel on every pass until an administrator changes it. The
  member receives partial access and no instruction that administrator action is required.
- Reproduction: The real ledger composition granted `c1`, refused `c2`, kept the row, and threw an
  error with `mutated === true` whose message still contained `DENYING ViewChannel`. That value selects
  the temporary-failure response.
- Specific fix: Replace the Boolean with a per-target outcome that separately records successful or
  uncertain mutation and permanent refusal. Keep the row when any target may be live, but tell the
  member which outcome needs an administrator and which outcome will retry automatically.

### F7 Permanent repair lookup failures are silently retried forever

- Lens: 1
- Location: `adapters/discord/access.js:211-217`, `adapters/discord/bot.js:181-188`
- Severity: minor
- Basis: READ
- Concrete cost: Repair deliberately ignores gone and foreign channels. It also swallows every other
  fetch error without logging it. A missing-permission error is not a short blip, but the pass reports
  no failure and repeats the same lookup every sweep. The member was promised automatic repair and the
  operator gets no continuing signal that intervention is required.
- Specific fix: Log retryable and permanent non-absence errors with the member and channel, with rate
  limiting if needed. Return a structured repair result so the scheduled pass can report unresolved
  records without turning one member into a global failure.

## Lens 2 findings

### F8 Ten test names still outrun their assertions

- Lens: 2
- Location: `test/discord_access.test.js:252-283`,
  `test/discord_grant_ledger.test.js:156-170`, `test/discord_grant_ledger.test.js:356-379`,
  `test/adapter_grant_expiry.test.js:220-241`, `test/adapter_grant_expiry.test.js:359-380`,
  `test/adapter_grant_expiry.test.js:559-577`, `test/adapter_grant_expiry.test.js:635-657`,
  `test/adapter_grant_expiry.test.js:936-950`, `test/adapter_grant_expiry.test.js:991-1013`
- Severity: major
- Basis: READ
- Concrete cost: These tests can stay green when the property named in the test is false. Several are
  on the exact fold paths they were written to protect.

The assertion gaps are as follows.

- `a MIXED denial keeps the record` calls `revokeAccess` directly and never creates or checks a ledger
  record.
- `a TOTAL denial is still skipped, so the sweep does not wedge` never runs a sweep or checks row
  deletion.
- `a failed same-target renewal keeps the new grant and strands nothing` checks the new expiry and lack
  of revoke calls, but never checks repair or resulting platform access.
- `a persist failure grants nothing and writes nothing` covers only a first grant. It does not cover
  the renewal path that already revoked an orphan, which is F3.
- `the clock mark is durable even when no grant changes` advances past the record's deadline and calls
  `sweep`, which deletes the grant. The stated no-change condition never occurs.
- `a renewal onto a different target revokes the old one before granting the new` records revoke and
  apply in separate arrays, so it cannot detect their cross-operation order. The Discord-specific twin
  correctly records one sequence.
- `the ledger is released when the process holding it exits, however it exits` exercises only
  `SIGKILL`.
- `a decision is never made on a clock reading that was not persisted` makes its only consequence
  assertion conditional on `reportedDead`. An implementation that always reports live takes the empty
  branch and passes.
- `a retirement that would leave an invalid record changes nothing at all` checks only row count. A
  rollback failure that changed record contents without changing the count would pass.
- `a pending legacy import counts as rows, so an empty foreign ledger is not rebound around it` checks
  the throw and source file, but never reopens the database to assert that its scope stayed on the old
  guild.

- Specific fix: Rename only claims that are intentionally narrow. For security and ordering claims,
  drive the real lifecycle and assert durable rows, effective mutation calls, and event order. Remove
  conditional assertions whose precondition is the behavior under test.

### F9 The decommission extraction reports every result twice

- Lens: 2
- Location: `adapters/discord/decommission.js:275-290`,
  `scripts/discord_decommission.mjs:196-211`
- Severity: minor
- Basis: READ
- Concrete cost: `runDecommission` prints the summary and final failure explanation. The command prints
  both again after the function returns. An apply run therefore produces duplicate completion and
  failure lines. On a ledger update failure, the inner message correctly says Discord access was taken
  back, while the repeated generic footer says the failed items still hold access.
- Specific fix: Give one layer ownership of presentation. Prefer returning a structured result from
  `runDecommission` and printing once in the command, while tests assert the result.

### F10 The README still documents removed behavior and a stronger boundary than exists

- Lens: 2
- Location: `adapters/discord/README.md:84-90`, `adapters/discord/README.md:183-185`,
  `adapters/discord/README.md:204-210`
- Severity: minor
- Basis: READ
- Concrete cost: The README says there is no way to add a permission mutation that skips the guarded
  module, while the deliberately scoped tripwire test documents two cache-object escapes. The setup
  still tells operators how to configure role mode, says the context defaults to a role identifier, and says
  submit grants by the configured mode. Role mode is removed and those instructions now conflict with
  startup behavior.
- Specific fix: Keep the tripwire's honest boundary in the README. Remove the remaining role-mode setup
  and flow text, while retaining only the decommission instructions for historical role grants.

## Required defect-shape audit

### Sibling guards and predicates

I checked the following sibling sites.

- Member denial mutations in `grantMemberOverwrite` and `clearMemberOverwrite`
- Callers in `applyAccess`, `revokeAccess`, `repairAccess`, `usableTargets`, reconciliation, and channel
  decommission
- Role denial checks in the decommission preflight and `removeRole`
- Gone and foreign results at channel lookup, overwrite edit, role lookup, and role removal
- First-grant, renewal, orphan migration, sweep, and `admitIfLive` branches in the shared ledger
- Scope mismatch, empty rebind, adoption, pending import, and retirement branches
- Clock refusal, reset, sweep, liveness, and admission branches
- Decommission lock acquisition, confirmed absence, failed-member sets, failed-pair sets, skipped-channel
  sets, and retirement

The raw mutation twin is closed in the current source. The only two overwrite edits and the only role
removal are in `permissions.js`. `isGone` is shared rather than copied, and `isNotOurs` remains a
separate predicate. I found no current mutation outside that module.

The surviving twins are F1 and F2. The inherited-access question was fixed for explicit allows in the
sweep and reconciliation, but not for inherited allows, and decommission still makes the opposite
all-refusals decision. F3 is the persistence twin. First-grant write failure is tested, while renewal
write failure after a successful orphan revoke is not.

### Comments that miss the active path

I found four load-bearing comments whose argument does not reach the path that matters.

- `retainedManagedAllows` argues that no explicit allow means no remaining access. It does not mention
  inherited role allows.
- The migration comment says a failed orphan revoke leaves the prior row unchanged and its access live.
  It does not cover a successful orphan revoke followed by a failed write.
- The quarantine message says the channel is left alone. It does not mention the scheduled repair that
  runs even when readiness is false.
- The interaction message says a kept row will repair automatically. It does not mention a mixed
  permanent denial carried inside an error with `mutated === true`.

I found no additional defect in the comments about lock ordering, the pending-import count, or the
role lookup distinction. The apply command takes the ledger lock before creating the Discord client.
The pending legacy file is counted before an empty foreign scope can rebind. A transient role lookup
error is no longer accepted as proof that the role is gone.

### Guard exits

F1 is a weak-evidence exit. The refusal is cleared on the absence of explicit allows even though
inherited access can remain. F4 is another weak-evidence exit. Confirmed absence succeeds without
evidence that the ledger ever named the target. F2 is the no-exit form. A fully denied member has no
access to remove, but decommission retains the row on every run.

The clock floor has both natural catch-up and `DISCORD_RESET_CLOCK=1`. The scope guard releases after
the ledger is genuinely empty. An unbound populated ledger can be adopted only by naming the current
scope. Removed role mode has a decommission path, subject to F2 and F4. The role confirmed-gone path
correctly distinguishes an authoritative absence from a transient lookup error.

## Refusal semantics across the three callers

The three cleanup callers do not currently agree on the evidence a refusal provides.

- Sweep revocation treats an empty explicit allow set as proof of no access. F1 shows that inherited
  visibility can survive.
- Startup reconciliation uses the same test if a denial appears between the channel scan and the
  member clear. It can log success and open admissions over untracked inherited visibility.
- Decommission treats every denial as remaining access. F2 shows that even a `ViewChannel` denial can
  keep the row forever.

The grant caller has a separate two-dimensional outcome. `mutated` answers whether anything may have
reached Discord. It does not answer whether a permanent refusal also occurred. F6 is the user-visible
result of collapsing those questions.

## Test and import results

The five focused files ran 98 tests, all passing. The full command discovered 331 tests. It reported
278 passing and 53 failing. Every failure was the documented sandbox artifact, `listen EPERM` on
`127.0.0.1`, across the gateway Hypertext Transfer Protocol (HTTP) and loopback oracle tests. There
were no skipped or cancelled tests and no non-loopback failure.

Direct imports of `permissions.js`, `access.js`, and `decommission.js` succeeded through the
reproduction harness. This checks the extracted modules at evaluation time rather than relying on
`node --check`.

## Ideas

- IDEA: Replace `Error.mutated` with a per-target outcome carrying `applied`, `refused`, `unknown`, and
  `effectiveAccessRemains`. Ledger retention, retry, and member messaging then consume the same facts
  without treating one Boolean as two decisions.
- IDEA: Model permission states as a small matrix over inherited `ViewChannel`, member allow bits,
  member deny bits, platform result, and lifecycle operation. Run each state through grant, sweep,
  reconciliation, repair, and decommission. The current hand-picked tests cover explicit mixed allows
  but miss inherited mixed state.
- IDEA: Give target migration a durable intermediate record and crash-inject after every database and
  platform boundary. This is a better fit than adding another compensation branch after an external
  side effect.
- IDEA: Extract startup target classification from `bot.js` and make it return the repair-eligible set.
  One composition test can then prove that a quarantined channel is neither reconciled nor repaired.

## Required actions

- Replace the explicit-allow refusal test with an effective `ViewChannel` decision shared by all three
  cleanup callers.
- Make target migration durable before its first external revoke.
- Require confirmed-gone targets to exist in the locked ledger.
- Stop repair from writing to quarantined channels.
- Add the lifecycle and ordering assertions listed in F8.
- Remove the duplicate command reporting and stale role-mode documentation.

BLOCK
