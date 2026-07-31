# Discord access review round 9

## Scope and evidence

This review uses only the source packet for commit `f482028`. I did not execute the code or inspect
the repository. A finding marked READ follows directly from the supplied source and domain facts. A
finding marked INFERRED depends on the stated runtime assumption.

## Findings

### 1. Reconciliation can clear a newly visible denial and grant access

- Lens: 1, correctness
- Location: `adapters/discord/bot.js:491`
- Severity: blocker
- Evidence: INFERRED
- Assumption: Discord can deliver a permission-overwrite update after `usableTargets` takes its
  snapshot and before the reconciliation loop reaches that member. The later
  `permissionOverwrites.cache` iteration can therefore contain the new denial.

Channel startup checks for denials at `adapters/discord/bot.js:394`, but reconciliation later clears
each unauthorized member overwrite at line 491 without calling `refuseIfDenied`. A concrete sequence
breaks the stated invariant.

1. `usableTargets` observes no denial and marks the channel usable.
2. An administrator adds a member-level `ViewChannel` denial.
3. The cache receives that change before reconciliation visits the member.
4. The reconciliation loop sees the member overwrite, decides there is no live grant, and writes
   `ViewChannel: null`.
5. A role-level allow becomes effective, so an operation intended to revoke access grants it.

This is not the accepted stale-cache residual. The denial can be present in the cache used by the
mutation, and this path still does not inspect it. The adjacent ordinary revocation path does make
the immediate check at lines 212 through 213.

The grant path has the same missing guard at `adapters/discord/bot.js:141`. If a denial appears after
startup, setting the managed bits to `true` fights the overwrite despite the claim that the bot
refuses a conflict it can see.

The fix is to make one channel mutation helper perform the denial check and the edit together, then
use it from grant, expiry revocation, reconciliation, and decommission. Reconciliation must keep the
record or channel quarantined when the helper refuses. The documented cache race remains, but no
caller should knowingly mutate a cached denial.

### 2. Role mutations are protected by a startup snapshot only

- Lens: 1, correctness
- Location: `adapters/discord/bot.js:134`
- Severity: blocker
- Evidence: INFERRED
- Assumption: A role overwrite can change while the bot or decommission command is running. The
  supplied domain facts establish that adding a role carrying a denial can remove permission and
  removing it can restore permission.

`usableTargets` scans role denials once at `adapters/discord/bot.js:361-365`. None of the bot's three
role mutation paths repeats that check.

- Grant adds the role at `adapters/discord/bot.js:134`.
- Expiry revocation removes it at `adapters/discord/bot.js:223`.
- Startup reconciliation removes it at `adapters/discord/bot.js:476`.

The decommission command has the same shape. It checks once at
`scripts/discord_decommission.mjs:133-140`, then removes the role from an arbitrary number of members
at line 165. A denial added after preflight makes subsequent removals grant the denied permission.

The concrete costs go in both directions. A verified member can lose a permission when the grant
adds a newly denying role. An expired or unauthorized member can gain a permission when revocation
removes that role. The startup comment correctly describes the inversion, but the protection does
not cover the operations whose safety depends on it.

The fix is to route every role add and remove through one guarded helper that refreshes and checks
the role's channel overwrites immediately before the mutation. A failed check must close admissions
for that target and leave ledger records in place for retry. The project should state the remaining
cache race for role mode as plainly as it does for channel mode. If that residual is unacceptable,
remove role mode because Discord supplies no compare-and-set operation for this permission surface.

### 3. The role denial guard exits before any cleanup can run

- Lens: 1, correctness
- Location: `adapters/discord/bot.js:373`
- Severity: blocker
- Evidence: READ

When the role denial scan finds an offender, `usableTargets` calls `process.exit(1)`. The call occurs
inside reconciliation, before the ready handler reaches the startup sweep or installs its interval.
Expired role grants therefore keep their gated access indefinitely while a supervisor repeatedly
restarts the same process. Stale channel records left by an earlier mode also receive no cleanup.

The channel sibling already explains the correct failure boundary at
`adapters/discord/bot.js:398-410`. It quarantines the bad channel, keeps interactions closed, and
allows cleanup elsewhere to continue. The role branch retains the exact process-wide failure that
the channel branch says was unsafe.

The fix is to return a non-ready, quarantined role result instead of exiting. The ready handler
should still start the sweep. Role records whose removal is unsafe must be retained and reported,
while unrelated channel records and safe work continue. This requires the per-mutation role guard
from finding 2 so the sweep can distinguish refusal from safe cleanup.

### 4. Decommissioned records can remove replacement access later

- Lens: 1, correctness
- Location: `scripts/discord_decommission.mjs:24`
- Severity: major
- Evidence: READ

The command deliberately never updates the ledger. The shared sweep later invokes the recorded
target's revoke operation at `adapters/common/grant_ledger.js:454`, then deletes the row only after
that later revocation succeeds.

A normal repoint produces a delayed second removal.

1. A live ledger row grants member U access to old channel C until tomorrow.
2. The operator runs decommission with `--apply`, which clears U's managed bits on C today.
3. C is repurposed, and the operator manually gives U access for a different reason.
4. Tomorrow the stale row becomes due.
5. The bot clears U's managed bits on C again and removes the replacement access.

The command's comment treats the ledger as history, but the sweep treats every row as current
revocation work. Those meanings cannot safely share one record after decommission succeeds.

The fix is to make decommission update target state after Discord removal. It should remove the
decommissioned target from each affected record, retain any targets that still need expiry cleanup,
and delete a row only when no tracked target remains. The platform changes and ledger changes need
an explicit recovery protocol because they cannot be one transaction. At minimum, the command should
write a durable `decommissioning` state before mutation and a `decommissioned` state after success so
ordinary sweeps never act on a retired target.

### 5. Legacy records silently lose the one-server protection

- Lens: 1, correctness
- Location: `adapters/discord/grant_ledger.js:204`
- Severity: blocker
- Evidence: INFERRED
- Assumption: Fetching a member who is absent from the currently configured guild returns an error
  classified by `isGone`, such as Discord's Unknown Member result. This is the behavior the supplied
  source itself relies on at `adapters/discord/bot.js:221`.

Records written before `guildId` existed are explicitly treated as "unknown, assume ours."
`foreignGuildRecords` ignores them at `adapters/discord/grant_ledger.js:207-211`, and the runtime
guard also runs only when `record.guildId` is truthy at `adapters/discord/bot.js:182`.

Consider a legacy role record created in guild A, followed by a repoint to guild B where the same
user is not a member. The foreign-guild gate passes. When the record expires, the member fetch in
guild B returns an `isGone` result, `revokeAccess` returns success, and the sweep deletes the row.
The role in guild A remains live and is now untracked. If the user belongs to both guilds, an Unknown
Role result can reach the same outcome because code 10011 is also in `isGone` at
`adapters/discord/grant_ledger.js:201-202`.

The test named "a record from another guild is detected" pins the unsafe exception at
`test/discord_grant_ledger.test.js:569-576`. It asserts that a record with no `guildId` is not foreign,
even though its origin is unknowable.

The fix is to fail closed on legacy records until their guild is bound explicitly. Migration should
require a one-time operator-supplied legacy guild identifier, persist it into every imported record
and database metadata, and refuse a later guild mismatch. "Unknown" cannot safely mean "current" for
the field that prevents unreachable access from being forgotten.

### 6. Predicate tests do not exercise the mutation policy they claim to protect

- Lens: 2, architecture and testability
- Location: `test/discord_grant_ledger.test.js:489`
- Severity: major
- Evidence: READ

The test named "a per-member denial on a gated channel is detected, so the bot can refuse rather than
fight it" calls only `memberDenialsOnGatedChannel`. It never calls grant, reconciliation, revocation,
or decommission, so it passes while finding 1 remains. The role test at
`test/discord_grant_ledger.test.js:531` likewise tests only `roleDenialsAcrossChannels`, so it passes
while all four role mutation sites in finding 2 remain unguarded.

Several other test names do assert their full claims. The same-member race test records operation
order, the persist-failure test records apply calls, the migration-failure test proves the
replacement was not applied, and the target parser tests the whole string. The gap is concentrated
at the boundary between pure detection and Discord mutation.

The fix is not more predicate tests. Move the guarded add, remove, and overwrite operations behind
small functions with injected Discord calls. Tests should arrange a denial, invoke each operation,
assert rejection, and assert that the mutation spy was not called. Include a reconciliation test
where the denial appears between target discovery and member cleanup. Include a decommission test
where a role denial appears after initial preflight and before the second holder.

## Required adversarial questions

### Twins

I checked the following sibling sites.

- Channel writes appear in grant at `bot.js:141`, ordinary revocation at `bot.js:213`,
  reconciliation at `bot.js:491`, and decommission at `discord_decommission.mjs:223`. Only ordinary
  revocation checks the same member immediately. Decommission checks the channel once before its
  holder loop. Grant and reconciliation do not check.
- Role writes appear in grant at `bot.js:134`, ordinary revocation at `bot.js:223`,
  reconciliation at `bot.js:476`, and decommission at `discord_decommission.mjs:165`. None checks
  immediately. The bot and command each rely on an earlier target-wide snapshot.
- `isGone` is shared by the bot and decommission command. Channel fetch and mutation branches
  distinguish ordinary failure from absence, and the channel bot path separately handles
  `isNotOurs`. The role path has no equivalent provenance protection for legacy records.
- Per-target loops generally collect failures and continue. `applyAccess`, channel revocation,
  reconciliation's member clear helper, and both decommission holder loops do so. The role denial
  branch is the outlier because it exits the process.

### Opposite operations

Revoking can grant in channel reconciliation and in every role-removal path after a denial change.
Granting a role can remove permission after the same change. The role startup guard can cause a
larger failure by preventing every sweep from being installed. Decommission can remove access a
second time after the target has been repurposed.

Nothing found indicates that preview performs a Discord mutation. In preview mode the role and
channel loops only collect and report prospective holders. Reporting helpers such as `staleTargets`
do not mutate Discord. `ledger.live` does update the durable clock high-water mark, but that is an
explicit part of its time decision and not an untracked platform side effect.

### Removed guarantees

The ownership simplification removed read-modify-write preservation of member overwrites. That
choice can be sound only if every mutation refuses a visible conflict. Finding 1 shows that the
replacement guarantee did not reach grant or reconciliation. Role mode uses the same snapshot
shortcut without a stated ownership rule, which produces finding 2.

Separating decommission from startup removed unsafe automatic bulk deletion. That was a sound
simplification. Refusing to update the ledger at all removed the guarantee that a retired target
will not be acted on again, which produces finding 4.

### Comments and claims

The following load-bearing claims exceed the code.

- `bot.js:118-121` says every caller checks immediately before using `ACCESS_CLEARED`.
  Reconciliation at line 491 does not.
- `bot.js:406-410` says the bot will not fight a visible member denial. Grant at line 141 and
  reconciliation at line 491 can do so.
- The role comments say the configured role only ever adds permission. The code establishes that
  only at one startup snapshot.
- `discord_decommission.mjs:24-25` says retained ledger rows are history. The sweep treats them as
  pending future mutations.
- The one-server claim does not cover imported records with no `guildId`.

### Test assertions

The denial tests assert detector output, not refusal by any caller. The foreign-guild test explicitly
accepts unknown legacy provenance. Those names claim more end-to-end protection than their assertions
provide.

The serialization, persistence ordering, orphan migration ordering, malformed record, target parser,
and best-effort stale-target tests make the state or call-order assertions their names require.
Nothing further was found in those assertions.

## Ideas

### Periodic safe reconciliation

After the mutation guards are fixed, run reconciliation periodically as well as at startup. This
would narrow the documented window where a request accepted just before process death lands after
the replacement process has already reconciled. A slow cadence with bounded work is enough.

### Permission-change quarantine

Listen for channel overwrite and role configuration changes affecting managed targets. Close
admissions immediately and require a fresh target scan before the next grant. This does not create a
compare-and-set operation, but it reduces the time in which a startup snapshot can become stale and
gives operators a direct diagnostic.

BLOCK
