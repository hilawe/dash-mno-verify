# Discord access review round 10

## Review basis

This review uses only the source embedded in
`codexapp_dash-mno-verify_discord_round10_2026-07-30.md`. I did not inspect the repository or execute
the code. Claims about JavaScript control flow are marked READ. Claims that depend on Discord request
ordering or platform state are marked INFERRED, with the assumption stated.

## Executive assessment

The permission mutations in the supplied source are centralized in `permissions.js`, and the three
current raw mutations each run the relevant denial check. Role granting is gone from the bot, the bot
no longer requests the privileged member intent, and the decommission command requests it only for a
role target. Those parts of the simplification are sound in the code shown.

The component is still not safe to approve. The decommission command does not acquire the ledger lock
until after it changes Discord, so its claimed exclusion of a live bot does not cover the operation it
is meant to protect. Its retry path can also become a permanent trap after Discord cleanup succeeds.
Separate gaps let a verified member lose the only usable grant attempt for an epoch, let the
`DenialConflict` distinction disappear before it reaches compensation, and let a legacy import bypass
the scope-adoption guard in one composition the tests do not cover.

## Lens 1 findings

### F1 The decommission lock is acquired after the operation it is meant to exclude

- Lens: 1
- Location: `scripts/discord_decommission.mjs:59-61`, `scripts/discord_decommission.mjs:188`,
  `scripts/discord_decommission.mjs:254`, `scripts/discord_decommission.mjs:281-296`
- Severity: blocker
- Basis: INFERRED
- Assumption: Discord accepts independent permission requests from the bot and the decommission
  process in arrival order. The supplied domain facts say there is no compare-and-set, so no platform
  primitive serializes those requests.
- Concrete cost: The documentation says the single-writer lock enforces that the bot is stopped, but
  the command first removes roles or clears overwrites and only then constructs `GrantLedger`. A live
  bot can therefore grant the same member after the command clears them. The later ledger open fails
  because the bot holds the lock, but by then the external mutations and their race have already
  happened. The command can report that Discord access was taken back even though the bot's later
  request restored it. The lock correctly protects the ledger transaction but never protects the
  Discord operation.
- Specific fix: In apply mode, open the ledger and hold its exclusive lock before logging in or
  making any Discord mutation. Keep that same ledger open through the platform pass and retirement,
  then close it in one outer `finally`. Preview mode should continue without opening the ledger. Add a
  process-level test in which a holder owns the database before the command starts and assert that no
  Discord mutation stub is called.

### F2 A successful cleanup can leave a ledger record that no supported retry will retire

- Lens: 1
- Location: `scripts/discord_decommission.mjs:163-168`,
  `scripts/discord_decommission.mjs:281-330`, `adapters/discord/bot.js:410-419`
- Severity: blocker
- Basis: READ
- Concrete cost: Ledger retirement runs only when `removed.length` is nonzero. The error path at
  lines 324-327 says to fix the ledger problem and run the command again, but a successful first role
  removal means the second run finds zero holders. It then skips the ledger entirely. The same trap is
  reachable without a failure. When a denied role is refused, the command explicitly permits the
  operator to remove it by hand. A rerun again finds zero holders and skips retirement. The role rows
  remain, so the bot continues to refuse startup and the bound ledger can never empty or rebind. The
  statement that both halves are safe to repeat is false.
- Specific fix: Every apply run that completed an authoritative scan must open the ledger and run
  `retireAll`, even when zero live holders or overwrites were found. The failure and skipped sets
  already express what must remain tracked. Zero observed holders with a complete member fetch is
  positive evidence that all matching role rows may be retired. Add tests for a second run after a
  ledger-open failure and for the documented manual-removal path.

### F3 Deleted targets have no supported retirement path

- Lens: 1
- Location: `scripts/discord_decommission.mjs:147-153`,
  `scripts/discord_decommission.mjs:212-222`, `adapters/common/grant_ledger.js:287-312`
- Severity: major
- Basis: READ
- Concrete cost: A deleted role is converted to a generic "does not exist" refusal. A deleted channel
  is marked skipped and failed, so `retireTargetTransform` intentionally retains it for every member.
  Repeating the command cannot change either result because the target cannot come back. Yet a deleted
  target holds no live access, and the retained rows can keep the scope guard closed forever. The
  channel message even acknowledges that deletion means there is nothing to clear but provides no way
  to record that completion.
- Specific fix: Add an explicit confirmation path for an absent target, such as
  `--confirm-target-gone`, that is valid only in apply mode, only when the target is named by the
  ledger, and only after the command has distinguished an authoritative not-found from transient
  failures. Preview should show exactly which rows would be retired. Do not collapse every role fetch
  error to `null`.

### F4 The denial refusal is erased before the ledger decides whether to compensate

- Lens: 1
- Location: `adapters/discord/permissions.js:29-46`,
  `adapters/discord/bot.js:137-146`, `adapters/common/grant_ledger.js:600-608`,
  `test/discord_permissions.test.js:150-160`
- Severity: major
- Basis: INFERRED
- Assumption: A first grant can encounter existing access on one configured channel and a denial on
  another. The supplied source itself recognizes untracked access after process death, and Discord
  permits per-member overwrites with mixed state.
- Concrete cost: `DenialConflict.mutated = false` exists specifically to prevent compensation after a
  refusal, but `applyAccess` catches that object and throws a new plain `Error`. The shared ledger does
  not inspect `mutated` in any case. With two channels, the first can already hold access while the
  second refuses because of a denial. The aggregate error triggers a whole-record compensating revoke,
  which clears the first channel. A verification request that was refused on the second channel has
  now taken existing access away on the first. The test proves only that the error object can be
  recognized at the wrapper boundary. It never drives the error through `applyAccess` and
  `GrantLedger.grant`.
- Specific fix: Make `applyAccess` return or throw an aggregate outcome that records whether any
  mutation succeeded or became uncertain. Preserve `mutated = false` only when every attempted
  operation was a precondition refusal and no write was sent. Teach `GrantLedger.grant` to avoid
  compensation and conditionally remove its just-written row in that exact case. Add an end-to-end
  test with two channels that asserts both the Discord calls and final ledger row.

### F5 A transient first apply failure consumes the proof but has no repair path

- Lens: 1
- Location: `adapters/discord/bot.js:557-590`,
  `adapters/common/grant_ledger.js:594-608`, `adapters/discord/bot.js:280-283`,
  `adapters/discord/bot.js:458-467`
- Severity: major
- Basis: READ
- Concrete cost: The gateway verifies the proof before `ledger.grant` runs. A first Discord apply
  failure leaves the new live ledger row in place and returns an error. The member is told to run
  `/verify` again, but the project rules make the challenge one-time and the voting-key nullifier
  single-use for the epoch. A new proof from the same voting key cannot provide a second membership in
  that epoch. Restart does not repair the grant either. Reconciliation only visits existing
  overwrites, and `authorizedNow` treats the live row as authority to leave one alone. Nothing creates
  the missing overwrite from the live record. The member can remain verified, recorded, and locked out
  until expiry.
- Specific fix: Add a per-member repair operation that reapplies the target of a live matching row
  without asking the gateway to consume another proof. Run it after a failed apply with bounded retry,
  and run it during startup reconciliation for live records whose managed allows are absent. Keep the
  denial checks attached to every repair mutation. The user-facing retry should invoke this repair
  path rather than request a new proof.

### F6 Empty-scope rebinding can occur before a pending legacy import is judged

- Lens: 1
- Location: `adapters/common/grant_ledger.js:249-258`,
  `adapters/common/grant_ledger.js:287-303`
- Severity: major
- Basis: READ
- Concrete cost: `#refuseForeignScope` automatically rebinds an empty database before
  `#importLegacy` runs. If an empty database is bound to guild A, a legacy file is present and not
  marked imported, and the adapter starts for guild B, the database is rebound to B at line 298. The
  legacy rows are then imported. `#bindScope` sees an existing B binding and never requires the
  operator to assert where those rows came from. This contradicts the stated rule that imported rows
  of unknown origin reach the same fail-closed adoption path. Foreign legacy rows can become trapped
  under the wrong binding, and the normal decommission and rebind instructions may no longer be
  usable.
- Specific fix: Treat a pending legacy import as part of the row set when deciding whether an old
  binding is empty. Do not change the scope until import eligibility and origin have been judged.
  One simple order is to validate the import without renaming it, perform the binding or adoption
  decision against the combined state, then commit the import and rename only after that decision
  succeeds. Add a test combining an empty bound database, a different requested scope, and a
  previously unseen legacy file.

## Lens 2 findings

### F7 The structural mutation test is a tripwire, not the property in its name

- Lens: 2
- Location: `test/discord_permissions.test.js:165-217`
- Severity: major
- Basis: READ
- Concrete cost: The test scans only immediate children of two directories. A mutation in
  `adapters/discord/helpers/x.js` is invisible. Its expressions also miss an alias split across
  `const overwrites = ch.permissionOverwrites` and `overwrites.edit(...)`, bracket notation, and a line
  whose code follows an opening and closing block comment. The source comment admits one alias bypass
  but the assertion still claims that every permission change must pass through `permissions.js`.
  The current supplied source has no raw bypass. The three raw operations I found are
  `permissionOverwrites.edit` at `permissions.js:104` and `permissions.js:109`, and
  `member.roles.remove` at `permissions.js:114`. The defect is that the test can stay green after a
  future bypass is added, which is the exact recurrence it claims to prevent.
- Specific fix: Recursively enumerate the source tree and parse JavaScript syntax rather than matching
  individual lines. Either add enough alias tracking to enforce the boundary or narrow the test's
  claim and make an abstract syntax tree lint rule the enforced guard. Add explicit negative fixtures
  for a nested file, an alias, destructuring, bracket notation, and multiline formatting.

### F8 The original asynchronous fixture still tears down before its callback finishes

- Lens: 2
- Location: `test/adapter_grant_expiry.test.js:28-43`
- Severity: minor
- Basis: READ
- Concrete cost: `withLedger` returns the callback's promise from a synchronous function, so its
  `finally` removes the directory immediately after the callback reaches its first `await`. The tests
  then continue against a database whose path has already been removed, or fail differently by
  operating system. This is the same fixture defect that the later `scopeDir` comment says was fixed
  by awaiting its callback, but its sibling remains. The affected tests can pass against an unlinked
  open handle while failing to exercise the durable file they appear to use.
- Specific fix: Make `withLedger` asynchronous, use `return await fn(...)`, close the ledger in
  `finally`, and remove the directory only after close. Add one assertion inside the callback that the
  database path still exists after an `await`.

## Required defect-shape audit

### Twin checks

I checked the current grant, clear, reconciliation, sweep, role-removal, and decommission mutation
sites. No present raw mutation bypass was found outside `permissions.js`. `isGone` is shared by the bot
and decommission command, and `isNotOurs` remains separate. The surviving twin defects are in the
guarding infrastructure rather than a present fourth call site. F7 shows that the structural test
would not reliably catch such a site, and F8 shows the asynchronous fixture bug survived beside the
fixed `scopeDir` helper.

### Comments that do not reach the actual path

- The exclusive-lock argument does not reach the Discord calls because the lock is acquired later.
- The `DenialConflict` argument does not reach grant compensation because the type is erased.
- The "run verify again" recovery does not reach either nullifier reuse or a ledger-based reapply.
- The claim that binding happens after import does not cover the earlier automatic rebind.

### Guard exits

The per-member denial guard has a reachable exit when the conflicting overwrite is removed or the
exclusion is moved to a role. The role-denial guard has a safe mutation exit when the deny is removed.
The clock floor has both natural catch-up and an explicit reset. The foreign-scope and legacy-role
guards do not have reliable exits because F2 and F3 can leave completed or impossible platform work
permanently recorded as outstanding.

## Role-mode removal assessment

Deleting role grant mode itself did not remove a permission guarantee still needed by the bot. Channel
grant and clear operations retain their managed-bit denial guard, role adding is absent, and the
ordinary bot uses only the Guilds intent. The unsafe remainder is the retirement path for roles already
granted. F1 lets that command race the live bot, while F2 and F3 can strand the ledger after the role
has already been removed or deleted.

## Ideas

- IDEA: Model startup reconciliation as convergence in both directions. Remove unauthorized
  overwrites, and reapply live ledger grants whose managed allows are missing. This would make the
  persist-before-apply direction genuinely recoverable.
- IDEA: Give decommission runs a durable local operation identifier and a final state that distinguishes
  platform complete, ledger complete, and retry required. That would make an interrupted second phase
  observable without guessing from a fresh platform scan.
- IDEA: Treat `permissions.js` as a capability boundary in tooling. A syntax-aware lint check over all
  Discord source files is a better fit than a regular-expression test that claims proof of a structural
  property.

BLOCK
