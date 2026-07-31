# Adversarial Code Review Round 9

## Scope and method

This review covers the Discord adapter and shared grant ledger at code commit `f482028`, with the
documentation-only commit `34f9805` at `HEAD`. I read `AGENTS.md`, `docs/DESIGN.md`, and
`docs/DEPLOY.md` first. I then read every scoped file in full, reconstructed the denial handling
removed by `6c1ecba`, inspected the relevant `discord.js` 14.26.4 source installed in this checkout,
ran the focused and full test suites, and drove the ledger and permission decisions with concrete
inputs.

The focused Discord test file passed all 25 tests. The shared ledger and reconciliation tests passed
all 33 tests. The full suite ran 285 tests, with 232 passes and the expected 53 sandbox failures. All
53 failures were loopback `listen EPERM` failures, so none is evidence against this component.

The reproductions used temporary directories and removed them when finished. No tracked file was
changed.

## Lens 1 findings

### 1. Most permission mutations bypass the denial checks

- Lens: 1, correctness and security
- Severity: blocker
- Evidence: READ
- Sites: `adapters/discord/bot.js:130-146`, `adapters/discord/bot.js:219-225`,
  `adapters/discord/bot.js:461-492`, `scripts/discord_decommission.mjs:131-165`,
  `scripts/discord_decommission.mjs:199-223`

The denial detectors are correct as pure predicates, but most callers do not run them immediately
before mutating Discord. The channel grant at line 141 never checks the existing member overwrite.
The reconciliation clear at line 491 relies on a channel-wide startup snapshot. The decommission
clear at line 223 relies on one preflight before the holder loop. Role additions and removals at bot
lines 134, 223, and 476, plus decommission line 165, rely only on an earlier guild-wide role scan.

I reproduced both directions with the documented Discord overwrite rules. Starting from a member
overwrite that denies `ViewChannel`, the exact `ACCESS` patch used at bot line 141 removes the denial
and adds all three allows. Starting from the same denial after a clean preflight, the exact
`ACCESS_CLEARED` patch used at reconciliation and decommission removes the denial. In the first case
a grant overrides an administrator's exclusion. In the second case a removal lets a role-level allow
through and grants access.

The role paths have the same inversion if the role gains a deny after startup. Adding the role can
remove the denied permission, while removing the role can restore it. This part rests on the Discord
permission semantics supplied for the review. I did not execute it against a live Discord server.

The accepted cache race does not excuse these sites. The project accepts that an immediate check can
miss a denial absent from the cache. These paths do not perform the immediate check at all, even when
the cached state has changed and would expose the conflict.

The comments overstate the implementation. `adapters/discord/bot.js:117-121` says every caller checks
immediately before using `ACCESS_CLEARED`. `adapters/discord/README.md:43-47` makes the same claim for
every individual removal. Neither claim is true.

#### Specific fix

- Put the check and mutation in one shared operation for each action, such as
  `grantMemberOverwrite`, `clearMemberOverwrite`, `addMonotonicRole`, and `removeMonotonicRole`.
- Run the closest possible denial check inside that operation on every invocation.
- Keep the documented cache race as a residual limitation, but do not add mutation sites that bypass
  even the cached check.
- Change the first-grant compensation contract as described in finding 6, so a known no-mutation
  refusal is not followed by a broad revoke.
- Add wiring tests that invoke each operation and assert both the Discord patch and the final
  effective permission state.

### 2. Legacy grants are not bound to a guild and can be forgotten after a repoint

- Lens: 1, correctness and durable revocation
- Severity: blocker
- Evidence: READ, with one stated Discord server assumption
- Sites: `adapters/discord/grant_ledger.js:19-23`,
  `adapters/discord/grant_ledger.js:201-211`, `adapters/common/grant_ledger.js:593-632`,
  `adapters/discord/bot.js:180-186`, `adapters/discord/bot.js:219-225`,
  `test/discord_grant_ledger.test.js:184-207`, `test/discord_grant_ledger.test.js:569-576`

New grants carry `guildId`, but the validator does not require it and the legacy import preserves old
records without it. `foreignGuildRecords` deliberately treats a missing guild as local. A repointed
bot can therefore sweep a legacy role record against the new guild, treat Discord's `10011 Unknown
Role` response as already gone, delete the row, and leave the role live in the old guild with no
record tracking it.

I reproduced the ledger half with an actual migrated legacy record. The imported row had no
`guildId`, `foreignGuildRecords` returned an empty list, the bot's `isGone({ code: 10011 })` branch
made revocation succeed, and `sweep()` deleted the row while the modeled old-guild role remained
live.

The local `discord.js` 14.26.4 source confirms that `GuildMemberRoleManager.remove()` accepts a raw
role identifier and sends a delete request to the current guild. The remaining assumption is that
Discord returns `10011 Unknown Role` when that identifier belongs only to another guild. That is the
code the adapter already expects and classifies as gone. A live two-guild test would confirm the
server response, but it would not change the missing durable guild binding.

The tests pin the hole. The legacy migration test imports a record with no `guildId`. The test named
“a record from another guild is detected” explicitly asserts that a record with no guild is not
foreign. Its name therefore promises more than its assertions establish.

#### Specific fix

- Bind the database itself to one guild in durable metadata, instead of relying only on optional
  fields in individual records.
- Refuse to infer a guild for an existing ledger containing only unbound records. Require an explicit
  operator adoption step after the old guild and targets have been checked.
- Require a valid `guildId` on every new Discord record and preserve it in all derived orphan
  records.
- Add a migration test where an unbound legacy role is still live in the old guild and prove that a
  new-guild sweep cannot delete its row.

### 3. The documented decommission path cannot release the guild guard

- Lens: 1, correctness and operability
- Severity: blocker
- Evidence: READ
- Sites: `adapters/discord/bot.js:431-441`, `adapters/discord/bot.js:623-650`,
  `adapters/discord/bot.js:180-186`, `scripts/discord_decommission.mjs:24-25`,
  `adapters/discord/README.md:55-58`

The bot tells an operator with foreign-guild records to point back to the old guild and run
`discord:decommission`. The command deliberately never touches the ledger. After it successfully
removes the old Discord access, every old row still carries the old `guildId`. Starting the bot on
the new guild reaches the same foreign-record guard again. Its sweep cannot age those rows out,
because `revokeAccess` refuses every foreign record and the ledger keeps every failed revoke for
retry.

I reproduced the state transition with a real `GrantLedger`. A bound old-guild record was foreign
before decommission. A modeled successful decommission left it foreign because the command performs
no ledger operation. After expiry, `sweep()` returned no revoked members and the row survived. No
future sweep in the new guild can make progress.

This makes the stated recovery procedure ineffective and leaves interactions closed indefinitely.
The operator must edit or replace the database by hand, or run the full bot against the old guild
until every record expires. Neither requirement is documented by the guard that blocks startup.

#### Specific fix

- Give decommission a ledger retirement operation that runs only after Discord state has been
  inspected and the target is confirmed clear.
- Update each affected row transactionally. Remove the retired target from channel records, delete a
  row only when no target remains, and retain rows for every failed member or channel.
- For a whole-guild repoint, support archiving the old guild-bound database and initializing a new
  guild-bound database. Print that exact recovery command from the guard.
- Test the full old-guild decommission to new-guild startup sequence, including partial failures.

### 4. A clock regression can apply a grant that the same ledger considers expired

- Lens: 1, correctness and expiry enforcement
- Severity: major
- Evidence: READ
- Sites: `adapters/common/grant_ledger.js:383-429`,
  `adapters/common/grant_ledger.js:436-473`, `adapters/common/grant_ledger.js:510-513`

`grant()` compares `expiresAt` with `seen.wall`, while every expiry decision uses `seen.floor`. After
a forward clock jump raises the durable floor and the wall clock is corrected, a deadline can be in
the future relative to `wall` but in the past relative to `floor`. `grant()` persists the record and
applies platform access anyway.

I reproduced this with a floor of `10000`, a corrected wall clock of `1000`, and an expiry of `2000`.
After `grant()` returned, the platform access flag was true while `ledger.live("u")` was false. The
next sweep removed it, but that leaves access live for up to the sweep interval. A member can
re-verify after each sweep and repeat the grant while the inflated floor remains.

The comment at lines 389-397 claims this is not a hole because the sweep and admission path use the
floor. That omits the direct platform admission performed inside `grant()`. The test named “grant
refuses on the same clock sample it persisted” checks the single-sample property only when wall time
itself crosses the deadline. It does not cover `floor >= expiresAt > wall`.

#### Specific fix

- Refuse platform application whenever `seen.floor >= record.expiresAt`.
- Treat a corrected clock below an inflated floor as an operator-visible closed state for new grants.
  The existing explicit `resetClock` mechanism is the recovery path after the host clock is verified.
- Add a test that advances the mark, rolls back the wall clock, then asserts that a grant between the
  two values performs no `apply` call.

### 5. A role denial exits before any unrelated expiry cleanup can run

- Lens: 1, correctness and availability
- Severity: major
- Evidence: READ
- Sites: `adapters/discord/bot.js:345-374`, `adapters/discord/bot.js:623-650`

Channel conflicts were changed from process exit to quarantine so one bad channel would not stop
cleanup elsewhere. The sibling role branch still calls `process.exit(1)` from `usableTargets`.
Because this runs inside the `ready` handler before the startup sweep and interval are installed, one
deny overwrite on the configured role stops every unrelated expired channel or prior-role grant from
being revoked.

This can be indefinite when the deny is an intentional operator policy. It is the exact “guard causes
a larger failure” shape that the channel branch comments say was fixed.

#### Specific fix

- Return `ready: false` for a role conflict and continue installing the sweep timer.
- Guard each role removal immediately before mutation, keep conflicting role rows for retry, and allow
  expired records for other targets to proceed.
- Add a mixed-ledger test with one conflicted role record and one safe expired channel record. The
  role row should survive and the channel row should be revoked.

## Lens 2 finding

### 6. The safety predicates and side effects have no shared, testable boundary

- Lens: 2, architecture and testability
- Severity: major
- Evidence: READ
- Sites: `adapters/common/grant_ledger.js:421-429`,
  `adapters/discord/bot.js:130-228`, `adapters/discord/bot.js:431-492`,
  `scripts/discord_decommission.mjs:119-230`,
  `test/discord_grant_ledger.test.js:475-593`

The pure tests prove that `memberDenialsOnGatedChannel` and `roleDenialsAcrossChannels` recognize
chosen inputs. They do not prove that any mutation calls them. The actual mutations live in private
functions in `bot.js` and in a separate command handler, so the tests cannot exercise the wiring.
That split is why the latest fix reached `revokeAccess` but missed grant, reconciliation, and the
per-holder decommission paths.

The shared ledger also treats every first `apply` failure as an uncertain partial application and
calls `revoke` on the full record. It has no way to distinguish a precondition refusal that changed
nothing from a network failure that may have changed some targets. The deleted denial-refusal code
ran into exactly this interface problem. Its cleanup could remove pre-existing state, so the guard
was deleted instead of giving the ledger a precise outcome. The current result overrides the denial,
as finding 1 demonstrates.

#### Specific fix

- Move Discord permission operations into a module imported by both the bot and decommission command.
  Keep lookup, denial detection, mutation, and error classification in that boundary.
- Replace the binary success or throw contract with an outcome that records targets known applied,
  known untouched, and uncertain. Compensate only the applied or uncertain targets.
- Export the operations behind a small Discord client interface so tests can drive the real control
  flow without a live server.
- Keep `GrantLedger` responsible for durable ordering and expiry, while the Discord module owns the
  exact permission compensation plan.

## Required adversarial questions

### Twins

I checked the following sibling sites.

| Reasoning shape | Sites checked | Result |
|---|---|---|
| Member denial before clear | bot startup `394-413`, revoke `212-215`, reconciliation `487-492`, decommission `199-223` | Startup and revoke check. Reconciliation and each decommission mutation do not. |
| Member denial before grant | bot grant `130-146` | No check. |
| Role denial before add or remove | bot startup `357-374`, grant `132-135`, sweep removal `219-225`, reconciliation `461-476`, decommission `131-165` | Startup and decommission preflight check. Individual additions and removals do not. |
| Missing, foreign, and transient target errors | bot role `347-355`, bot channel `386-393`, revoke `203-216`, decommission role `124-130`, decommission channel `180-197` | Bot paths distinguish the cases. Decommission role fetch still collapses every error to “does not exist.” |
| Gone after lookup and after mutation | revoke `203-226`, reconciliation `450-458`, decommission `164-170` and `222-228` | The named mutation sites check `isGone`. Nothing else found here. |
| Every item attempted after one failure | grant `137-146`, revoke `199-218`, decommission `174-230` | All three loops continue and collect failures. Nothing found here. |
| Guild binding | new grant `606-612`, startup `431-441`, revoke `180-186`, legacy import `614-627`, retirement command `24-25` | New rows and ordinary revokes check. Legacy rows remain unbound and decommission cannot retire bound rows. |
| Destructive command parsing | decommission `40-95` | Preview is the default, contradictory flags fail, unknown flags fail, and exactly one target is required. Nothing found here. |

### Opposite outcomes

- Granting can remove permission in role mode if the role gains a deny after startup.
- Granting can override a member denial in channel mode.
- Revoking or decommissioning can grant permission by clearing a denial added after preflight.
- The role startup guard can stop unrelated revocations.
- The guild guard can make its documented recovery path permanently fail.
- Reporting-only stale-target code does not mutate. Preview branches do not call Discord mutations.
- `live()` is described as a read-only report, but it advances durable clock metadata. That mutation is
  intentional. The inconsistent use of its floor by `grant()` is finding 4.

### Removed guarantees

The deleted `clearManagedAllows` logic protected denials by clearing only bits observed as allowed.
The deleted `deniedManagedBits` grant check protected an administrator's exclusion from being
overridden by proof. Both depended on cached state and had race or compensation defects.

The replacement ownership rule can be valid only if every mutation enforces it and if a
precondition refusal is not followed by a broad compensating revoke. Neither condition holds. The
simplification removed the administrator-exclusion guarantee without establishing the enforcement
needed by its replacement.

### Comment claims

The following load-bearing claims are false or incomplete.

- “Every caller checks” at `adapters/discord/bot.js:117-121` is false for reconciliation.
- “Immediately before every individual removal” at `adapters/discord/README.md:43-47` is false for
  reconciliation and decommission.
- “One ledger serves one server” at `adapters/discord/README.md:55-58` is false for imported unbound
  rows, and its decommission recovery cannot retire bound rows.
- The cleanup-readiness claim at `adapters/discord/bot.js:629-633` is false for the role denial exit.
- The no-hole clock claim at `adapters/common/grant_ledger.js:392-397` omits the direct `apply` call.
- The best-effort stale-target warnings accurately state their limits. Nothing found there.
- The preview comments match the argument parsing and mutation branches. Nothing found there.

### Test assertions

I read every assertion used to support this review.

- The denial tests at `test/discord_grant_ledger.test.js:489-563` test only pure detectors. They do not
  invoke a bot or decommission mutation.
- The foreign-guild test at lines `569-582` asserts that an unbound record is not foreign, leaving the
  legacy case open.
- The legacy import test at lines `184-207` confirms that records without `guildId` are adopted.
- The failed-first-grant test at lines `113-123` asserts that a broad revoke is called. It does not
  model whether the failure changed anything or whether compensation reverses pre-existing state.
- The expiry tests cover wall-clock deadline rejection and durable samples. They do not cover a
  durable floor above both wall time and the proposed deadline.
- No scoped test imports `bot.js` or executes `discord_decommission.mjs`, so none asserts that preview
  stays non-mutating, that denial checks are wired to each mutation, or that decommission releases the
  guild guard.

## Lens 3 ideas

### IDEAS

- Add a small permission transition model to tests. Give each role and member overwrite real allow and
  deny bitfields, apply the exact patch emitted by the operation, and assert that grant is monotonic
  toward access while revoke is monotonic away from access.
- Store a guild identity and lifecycle state in ledger metadata. States such as active, decommissioning,
  and retired would make repoints explicit and let the command prove that an old ledger is safe to
  archive.
- Record per-target mutation outcomes for partial Discord operations. That would make retries and
  compensation precise without turning the ledger into a general workflow engine.

BLOCK
