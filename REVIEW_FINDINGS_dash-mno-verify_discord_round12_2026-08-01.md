# Discord access review round 12

## Review basis

I reviewed `9dbf92d..2ebc75f` and the complete committed state of every file named in the
round packet. I treated all nine commits in that range as the highest-risk surface. I also inspected
the installed `discord.js` 14.26.4 implementation of channel fetches, overwrite edits, and effective
permission resolution.

READ means the result follows from repository control flow, installed dependency source, or an
executable local reproduction. INFERRED means the concrete cost depends on external request timing.
Each finding involving `discord.js`, `node:sqlite`, or runtime ordering states its assumption.

The tracked worktree was clean when the review began. While the full test run was in progress,
another process edited and then committed documentation as `66fa98e`, advancing `HEAD`. I did not
make, alter, stage, commit, or push those changes. This report remains anchored to the requested
`2ebc75f` snapshot. Commit `66fa98e` retracts the false role-level guarantee in the main documentation,
which addresses that part of F1 and F10, but it changes no runtime code and does not fix F1. The
pre-existing untracked round 11 report was also left untouched.

## Executive assessment

The current adapter is not safe to approve. The stated role-level exclusion does not exclude a
member after the bot grants them. Discord applies a member overwrite after role overwrites, so the
bot's member allow outranks the role deny. The role entry survives, but it has no effect on the member
the bot just admitted.

Three recent fixes introduce separate blockers. The covering ledger record extends orphaned access
to the new grant's later deadline when revocation fails. The foreign-scope decommission guard still
retires legacy rows with no per-record guild identifier even though the database binding proves they
belong to the other guild. The channel refresh added before clears mutates the same overwrite map
that startup reconciliation is iterating, which can make that loop repeat forever before the expiry
sweep is installed.

The repair and deadline paths also remain unsound. Repair can declare a stale cached overwrite
healthy without ever reaching the new refresh. A grant can cross its expiry while platform work is in
flight and still be applied. Matrix does not perform the startup reconciliation that the shared
ledger's crash analysis relies on, because its persistent marker skips the pass on ordinary restarts.

## Lens 1 findings

### F1 The supported role-level exclusion is overridden by the bot's grant

- Lens: 1
- Location: `adapters/discord/permissions.js:130-134`, `adapters/discord/permissions.js:153-157`,
  `AGENTS.md:54-58`, `adapters/discord/README.md:96-108`
- Severity: blocker
- Basis: READ
- Assumption: The installed `discord.js` 14.26.4 `GuildChannel.memberPermissions` method matches the
  deployed runtime. It removes aggregated role denies at `GuildChannel.js:233`, then adds the member
  overwrite's allows at `GuildChannel.js:236`.
- Concrete cost: An operator assigns an exclusion role that denies `ViewChannel`. The verified member
  runs `/submit`, and `grantMemberOverwrite` writes a member-level `ViewChannel: true`. Effective
  permission resolution removes the role denial and then restores `ViewChannel` from the member
  overwrite. The member enters despite the documented exclusion. Repair repeats the same grant from
  a stored record. The member-level alternative is also unsupported because `edit()` can rewrite a
  deny from stale cache state. The adapter therefore has no working individual exclusion.
- Reproduction: Applying the installed resolver's order to a permission set produced
  `afterRoleDeny: false` and `afterMemberAllow: true`. The source order is explicit in
  `node_modules/discord.js/src/structures/GuildChannel.js:230-236`.
- Specific fix: Make exclusion a bot-owned admission policy checked before every fresh grant and every
  stored-record repair. If a Discord role is used as the operator interface, fetch the member's role
  membership and refuse before writing the member allow. Store or derive the exclusion in a way the
  bot can check without relying on Discord overwrite precedence. Take back existing managed allows
  when an exclusion becomes active. Keep admissions closed until this path exists, and remove every
  claim that a role deny enforces the exclusion by itself.

### F2 A covering record extends orphaned access to the new deadline

- Lens: 1
- Location: `adapters/discord/grant_ledger.js:64-75`,
  `adapters/common/grant_ledger.js:625-661`, `adapters/common/grant_ledger.js:731-770`
- Severity: blocker
- Basis: READ
- Assumption: `node:sqlite` commits each synchronous `#put` before the following awaited platform
  call. The reproduction used the repository's actual `DatabaseSync` ledger.
- Concrete cost: A member has access to `old` until time 200 and renews onto `new` until time 999.
  The covering write stores `channels: [new, old]` with `expiresAt: 999`. If revoking `old` fails, the
  method throws and leaves that covering row. The due query sees nothing at time 200, so it does not
  retry the failed revocation. Access to the retired channel now survives until 999 even though the
  new proof did not authorize that target. This is an access extension caused by the safety fix.
- Reproduction: The actual Discord ledger retained
  `{ expiresAt: 999, channels: ['new', 'old'] }` after the orphan revoke threw. At time 201, `sweep()`
  returned an empty list and made no second revoke attempt.
- Specific fix: Represent transition obligations per target, including each target's own expiry and
  desired state. A flat channel array with one deadline cannot cover this state safely. At minimum,
  persist the orphan with its original expiry and a pending-revoke marker, persist the new target with
  its new expiry, retry pending revokes independently of grant expiry, and narrow the record only after
  the platform result is durable. Add failure and process-death tests after the covering write, during
  revoke, and before the final write.

### F3 Foreign-scope cleanup still retires legacy rows from the bound guild

- Lens: 1
- Location: `adapters/common/grant_ledger.js:302-319`,
  `adapters/discord/decommission.js:33-58`, `adapters/discord/grant_ledger.js:147-175`,
  `scripts/discord_decommission.mjs:143-160`
- Severity: blocker
- Basis: READ
- Assumption: A row without `record.guildId` belongs to the database scope recorded in SQLite, as the
  binding comments at `adapters/common/grant_ledger.js:123-131` and
  `adapters/discord/grant_ledger.js:262-272` state. The reproduction used a real temporary SQLite
  database and confirmed that `allowForeignScope` did not change its binding.
- Concrete cost: A database bound to guild A contains a legacy row with no `guildId`. The cleanup
  command opens it while configured for guild B through `allowForeignScope`. `ours()` treats the
  missing field as guild B evidence, and `retireTargetTransform` rejects only an explicit foreign
  field. With `--confirm-target-gone`, guild B's not-found response therefore deletes guild A's row.
  Access in guild A remains live and unreachable, with its only record gone.
- Reproduction: I created a ledger bound to `guild-A`, granted a legacy
  `{ mode: 'channel', channels: ['gone-channel'] }` record, reopened it for `guild-B` with the cleanup
  escape, and ran the real confirmed-gone decommission. The binding remained `guild-A`, the command
  returned no failures, and the row count changed from one to zero.
- Specific fix: Pass the ledger's bound scope into decommission and use it as the provenance for every
  row lacking `guildId`. When the configured guild differs from the binding, accept only rows that
  explicitly name the configured guild. Apply the same predicate to `namedInLedger` and the retirement
  transform. Add legacy channel and role cases to the foreign-guild test.

### F4 Refreshing during live cache iteration can hang startup cleanup

- Lens: 1
- Location: `adapters/discord/bot.js:414-433`, `adapters/discord/permissions.js:139-176`
- Severity: blocker
- Basis: READ
- Assumption: The installed `discord.js` 14.26.4 channel fetch path matches production. A forced
  `BaseChannel.fetch(true)` requests the channel, then `GuildChannel._patch` clears and repopulates
  `permissionOverwrites.cache` at `GuildChannel.js:81-85`. Standard JavaScript `Map` iterators can
  visit entries inserted after iteration begins.
- Concrete cost: `reconcileGuild` iterates `ch.permissionOverwrites.cache` directly. Every
  unauthorized member calls `clearManagedAllows`, which forces a channel refresh and repopulates that
  same map. The iterator then sees the reinserted members again. Even after the first clear leaves no
  managed allows, the next call refreshes before returning `[]`, so the map is repopulated again. The
  ready handler never reaches the initial sweep or installs its timer. Interactions stay closed, and
  already expired access for other members remains live.
- Reproduction: A one-entry map using the same clear-and-repopulate behavior visited the same entry
  six times before a test cap stopped it. Without the cap, the focused reproduction did not terminate.
  No other production caller iterates a live overwrite map across the new refresh. Decommission takes
  an array snapshot first.
- Specific fix: Snapshot the reconciliation candidates before the first awaited mutation, for example
  with `[...ch.permissionOverwrites.cache.entries()]`. Treat the snapshot only as a work list because
  each mutation already refreshes before deciding. Add a test whose `fetch()` clears and repopulates
  the original map, then assert each original member is processed at most once and the pass completes.

### F5 Repair trusts a stale complete cache entry and never reaches refresh

- Lens: 1
- Location: `adapters/discord/access.js:197-239`, `adapters/discord/permissions.js:139-157`,
  `adapters/discord/bot.js:168-190`
- Severity: major
- Basis: READ
- Assumption: `guild.channels.fetch(chId)` uses its default `force: false` behavior in the installed
  library and may return an existing cached channel. This is the implementation at
  `GuildChannelManager.js:392-402`.
- Concrete cost: If the cache says a live member already allows all three managed bits while Discord
  has lost or partially removed that overwrite, line 229 returns before `grantMemberOverwrite` can
  perform the forced refresh. Every repair pass repeats the cached no-op. The member's proof and live
  row remain valid, but the promised automatic repair never occurs. A restart or unrelated cache
  update is required.
- Reproduction: I supplied a cached complete overwrite whose `fetch()` returned a fresh channel with
  no overwrite. `repairAccess` returned `[]`, called `fetch()` zero times, and made zero edits.
- Specific fix: Refresh before the completeness decision and use the returned object for both the
  read and any write. Export a small refresh-and-read operation from `permissions.js`, or make the
  repair helper own the full check-and-grant operation so callers cannot short-circuit before the
  refresh. Test stale-complete and fresh-missing state in one fixture.

### F6 Grant and repair can apply access after their deadline

- Lens: 1
- Location: `adapters/common/grant_ledger.js:581-624`,
  `adapters/common/grant_ledger.js:643-679`, `adapters/discord/access.js:197-239`
- Severity: major
- Basis: INFERRED
- Assumption: The wall clock can cross `record.expiresAt` while an orphan revoke, channel fetch,
  refresh, retry delay, or platform request is awaited. Platform calls can take nonzero time and can
  succeed at or after the deadline.
- Concrete cost: `grant()` checks time once before migration, persistence, and `apply`. `repairAccess`
  checks once before fetching any channels. A record live by one second passes, then access can be
  applied after it is already expired. The row remains present but `live()` immediately reports false.
  The access stays on the platform until the next sweep, up to 300 seconds for Discord and 60 seconds
  for Matrix. Multiple Discord channels and retry delays widen the reachable window.
- Reproduction: With the injected clock at 100 and an expiry of 101, I advanced the clock to 101 in
  the real ledger's `apply` callback. `grant()` resolved, the callback recorded application at 101,
  and `live()` returned false immediately afterwards.
- Specific fix: Recheck the durable clock immediately before each external grant and again after the
  platform call returns. If the deadline passed, revoke before resolving and keep the record until
  cleanup succeeds. For multi-target adapters, enforce the check at the per-target mutation boundary,
  not only in the shared wrapper. Add exact-boundary tests around migration, retry delays, and repair.

### F7 Matrix skips the startup reconciliation used in the crash argument

- Lens: 1
- Location: `adapters/common/grant_ledger.js:59-67`, `adapters/matrix/bot.js:191-245`,
  `adapters/common/reconcile.js:20-32`
- Severity: major
- Basis: INFERRED
- Assumption: A Matrix invite request can be accepted by the homeserver while the sending process
  loses its response, and request effect or visibility can race a replacement process's cleanup. This
  is the delayed external-side-effect ordering assumed by the shared ledger comment itself.
- Concrete cost: The shared ledger says Matrix mitigates the process-death residual by reconciling
  platform state at startup. Matrix returns immediately from `reconcileRoom` whenever its persistent
  historical marker matches the room. Ordinary restarts therefore do not inspect membership. If the
  replacement sweeps and deletes the expired row before the old invite becomes visible, the later
  invitation is permanent and untracked. The marker proves only that an upgrade baseline was cleaned
  once. It says nothing about side effects from later process deaths.
- Specific fix: Run the membership comparison on every Matrix startup, as Discord intends to do. Keep
  the marker only as evidence that the historical upgrade boundary was handled, or remove it once an
  unconditional current-state pass replaces that role. Add a restart ordering test with an expired
  row and an invite that becomes visible after the first cleanup observation.

## Lens 2 findings

### F8 Five test names outrun their assertions, and three more assert the wrong layer

- Lens: 2
- Location: `test/discord_permissions.test.js:100-123`,
  `test/discord_permissions.test.js:298-326`, `test/discord_access.test.js:192-205`,
  `test/discord_access.test.js:208-214`, `test/discord_access.test.js:256-275`,
  `test/discord_decommission.test.js:128-148`, `test/discord_decommission.test.js:243-269`,
  `test/discord_grant_ledger.test.js:156-170`, `test/discord_grant_ledger.test.js:688-715`
- Severity: major
- Basis: READ
- Concrete cost: These tests stay green while the named safety property is false. Several were added
  for the exact fold paths that remain broken.

The name gaps are as follows.

- `both mutations refresh the channel before deciding` invokes only `grantMemberOverwrite`. It never
  calls `clearManagedAllows`, whose refresh causes F4.
- `a renewal whose write fails still leaves a row naming the NEW targets` asserts the opposite. The
  expected row contains only `old` because the first covering write failed.
- `a foreign-guild row is never retired` supplies only a row with an explicit foreign `guildId`. It
  never supplies the legacy missing field that F3 deletes.
- `the repair is idempotent, so a healthy member costs no Discord write` defines health entirely from
  a cached overwrite and provides no fresh state. It passes for F5's stale-complete, actually-missing
  member.
- `the repair refuses to reapply over an administrator's exclusion` tests only a cached member-level
  deny. It does not test the documented role-level exclusion, which F1 shows is overridden.
- `a failed same-target renewal keeps the new grant and strands nothing` checks the stored expiry and
  lack of revoke calls. It never asserts resulting platform access or a repair path for the
  `strands nothing` claim.

Three other tests do not name the wire-level claim, but their assertion messages and surrounding
comments still say a deny is left exactly alone. They inspect only the patch passed to the fake
`edit()` in `discord_permissions.test.js:100-123`, `discord_access.test.js:256-275`, and
`discord_decommission.test.js:128-148`. The installed `edit()` rebuilds and transmits both bitfields,
so those tests cannot support the stated conclusion.

- Specific fix: Rename only deliberately narrow tests. For security claims, reproduce the installed
  library boundary or model its whole request body. Add the missing clear refresh, stale cache, legacy
  guild, effective role permission, transition expiry, and platform-result assertions.

### F9 The mutation tripwire omits production directories and raw REST writes

- Lens: 2
- Location: `test/discord_permissions.test.js:200-265`
- Severity: minor
- Basis: READ
- Concrete cost: The test honestly documents two cache-value escapes. It has two additional gaps. It
  scans only `adapters/discord` and scripts whose filename contains `discord_`, so a shared helper in
  `adapters/common` or another production directory is invisible. It also keys on the text
  `permissionOverwrites` or `.roles`, so a direct REST call to `Routes.channelPermission` passes. A
  future shared-ledger refactor can therefore add an unguarded permission mutation while the boundary
  tripwire stays green.
- Specific fix: Scan all production JavaScript and ECMAScript module files outside dependencies and
  tests, with an allowlist for the intended module. Add signatures for raw channel-permission routes
  and role membership endpoints. Keep the documented parser limitation because a text scan remains a
  tripwire, not a proof.

### F10 Load-bearing comments and operator messages still claim the old guarantee

- Lens: 2
- Location: `docs/HANDOFF.md:83-95`, `adapters/discord/access.js:121-125`,
  `adapters/discord/bot.js:316-328`, `adapters/discord/bot.js:398-406`,
  `adapters/discord/decommission.js:203-212`, `adapters/discord/README.md:88-112`,
  `adapters/discord/README.md:199-220`
- Severity: major
- Basis: READ
- Concrete cost: The top of the handoff correctly says `edit()` sends both cached bitfields, but the
  same current-state section later says a deny is never written or cleared. `access.js` still describes
  a clear-path refusal that no longer exists. Bot and decommission messages say a denied member is
  left exactly alone while mixed overwrites are deliberately edited. The README says every mutation
  carries the same denial check even though clear no longer checks or refuses, and its setup still
  instructs operators about removed role mode. These claims make the supported operating procedure
  impossible to infer correctly and give false confidence to the tests in F8.
- Specific fix: Give the permission model one short source of truth and link to it. State separately
  what is checked before grant, what clear deliberately changes, what the library transmits, and what
  exclusions are unsupported. Make warnings distinguish a fully denied member that receives no
  request from a mixed overwrite whose allows are cleared. Remove the remaining role-mode setup text.

## Lens 3 opportunities

### IDEA 1 Model access as per-target obligations

Replace the one-row, one-expiry record with a small set of target obligations. Each target can carry
its own scope, expiry, desired state, and pending operation. That representation removes the need for
Discord's temporary union record, gives Matrix and Telegram a real covering form, and makes retries
independent of the newest grant's deadline.

### IDEA 2 Test Discord permission behavior at the dependency boundary

Build a compact contract harness around the installed resolver and overwrite manager. It should cover
effective role and member precedence, full request-body reconstruction, forced fetch patching, and map
iteration. This does not require a live Discord server and would have caught F1 and F4 before the fold.

### IDEA 3 Separate immutable planning from platform mutation

For reconciliation and decommission, first create an immutable work list from one observed state.
Then execute each item through helpers that refresh and decide again. This keeps iteration stable while
retaining last-moment guards, and it makes preview, execution, and retirement outcomes easier to test
as one plan.

## Required defect-shape audit

### Costume 1 Sibling guards and predicates

I checked the following sibling sites.

- The two overwrite writes in `grantMemberOverwrite` and `clearManagedAllows`
- The historical role removal in `removeRole`
- Grant, revoke, repair, startup reconciliation, and decommission callers
- Member denial and role denial predicates
- Gone and foreign results at channel fetch, overwrite edit, role fetch, and role removal
- Explicit, missing, local, and foreign per-record guild identifiers against the database binding
- First grant, renewal, covering write, orphan revoke, final write, refusal delete, sweep, and admission
- Matrix and Telegram target migration with the default null covering record

I found three sibling failures. The refresh was added inside both mutation helpers but its live-map
caller was not updated, which is F4. The decommission guard covers explicit foreign rows and misses
the legacy missing-field twin, which is F3. The code checks that a role entry is not edited and never
checks whether the later member allow makes it ineffective, which is F1.

The raw current mutation boundary is otherwise intact at `2ebc75f`. The only overwrite writes are the
two calls in `permissions.js`. The only role membership mutation is the historical decommission
removal in that module. I found no current permission mutation elsewhere in the repository. Matrix
and Telegram retain their prior row while an orphan revoke is in flight because the default covering
function returns null. I found no new untracked-access regression in that ordering, although it still
costs repairability after a successful revoke followed by a failed replacement write.

### Costume 2 Correct arguments that do not reach the path

I found four instances.

- The argument that role entries are untouched never reaches effective permission resolution, F1.
- The refresh attached to grant never reaches repair's stale-complete short circuit, F5.
- The deadline check occurs before the awaited work that can cross the deadline, F6.
- The shared crash argument relies on Matrix startup reconciliation, but the persistent marker exits
  before the membership path on ordinary restarts, F7.

I also checked `isGone` versus `isNotOurs`, the refusal revision captured before `apply`, the clock
floor reset path, and the Discord member message's `applied` versus `mutated` split. I found no new
defect in those branches under the documented single-process, local-filesystem assumption.

### Costume 3 Guards and exits

I found three failures.

- The exclusion guard has no safe operator exit. Its documented role-level exit is overridden by the
  member grant, F1.
- The confirmed-gone exit accepts weaker guild evidence for legacy rows than the scope guard demanded,
  F3.
- A failed orphan revoke leaves a covering row whose later deadline prevents the promised retry at the
  old deadline, F2.

I checked the clock reset, empty-ledger rebind, explicit adoption, deleted channel and role exits,
transient role lookup refusal, startup reconciliation retry, and role-denial removal guidance. Those
exits are reachable in the committed control flow, subject to the documented temporary permission
window when an operator removes a deny from a historical role.

### Costume 4 Claims the code cannot keep

I found the role-level safety claim in F1, the startup reconciliation claim in F7, and the stale
comments and operator messages in F10. F8 lists the tests whose names or assertions still certify
stronger behavior than they exercise. I found no overclaim in the current revision-capture comments.
The conditional delete uses the revision captured before `apply`, and the two-writer focused test
exercises a replacement row rather than rereading it after the await.

## Validation

- `npm test` discovered 345 tests. It reported 292 passing and the expected 53 sandbox failures. Every
  failure was a loopback `listen EPERM` in `gateway_http.test.js` or `load_oracle.test.js`.
- The five review-focused files reported 112 passing and zero failing.
- Imports of `permissions.js`, `access.js`, `decommission.js`, the Discord and shared grant ledgers,
  and `reconcile.js` all succeeded.
- `git diff --check 9dbf92d..2ebc75f` passed.
- Focused executable reproductions confirmed F2 through F6. F1 follows directly from the installed
  resolver and a bitfield reproduction. F7 remains inferred from the runtime ordering stated above.

BLOCK
