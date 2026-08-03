# Gateway round 4 adversarial review

This is a fresh full review of the requested gateway surface at commit `997e231`. I read
`CLAUDE.md`, `docs/DESIGN.md`, and `docs/DEPLOY.md` first, then reviewed the implementation and tests
under `core/`, `common/`, and `oracle/`. I inspected the eight fold commits from `da56e1d` through
`45ebc02` separately so the newest guards and refusal paths received extra scrutiny.

The evidence labels distinguish direct code facts from consequences that need an operational
assumption.

- `READ` means the behavior follows directly from the cited code.
- `CONFIRMED` means a focused probe reproduced the state transition.
- `INFERRED` means the consequence depends on an assumption stated in the finding.

The circuits, provers, and adapters were outside scope. Statements about what a proof asserts are
therefore inferred from the public-signal handling in `core/verifier.js`. Any operational consequence
that depends on adapter topology is marked as an assumption.

## Lens 1 correctness, edge cases, and security

### B1 Two-tier memory mode still revives durable registrations after a clock rollback

- Lens: 1, correctness and security
- Severity: blocker
- Location: `core/gateway.js:73`, `core/gateway.js:74`, `core/gateway.js:653`,
  `core/gateway.js:654`, `core/time_guard.js:25`, `core/time_guard.js:41`
- Evidence: READ. `MNO_STORE=memory` always gives `TimeGuard` a null path. Two-tier mode still opens a
  file-backed registration store and rebuilds season trees from it. The memory-store opt-in only makes
  the per-epoch nullifier set ephemeral. It does not make the registration file ephemeral.
- Concrete cost: A two-tier gateway can finish season N, restart after the host clock moves back into
  season N-1, and rebuild N-1 registrations without seeing the previous high-water mark. Memberships
  that had expired become usable again. This directly violates the rule in `CLAUDE.md` that a past
  season root stops verifying.
- Specific fix: Persist `MNO_TIME_MARKS_PATH` whenever the registration backend is durable, independent
  of the nullifier backend. If a fully ephemeral two-tier mode is needed, pair the in-memory nullifier
  store with `MemoryRegistrationBackend` behind a separate explicit development option. Add a restart
  test with a past-season registration, a higher durable mark, and `MNO_STORE=memory`.

### B2 The context allowlist is optional, so the resource bound is off by default

- Lens: 1, safety and denial of service
- Severity: blocker
- Location: `core/config.js:163`, `core/config.js:169`, `core/gateway.js:688`,
  `core/gateway.js:695`, `core/gateway.js:965`
- Evidence: READ and INFERRED. An unset `MNO_REGISTER_CONTEXTS` becomes an empty array. The
  registration guard runs only when that array is non-empty, while startup merely warns and continues.
  The ability to derive registrations in distinct contexts is inferred from the verifier's public
  context signal and the design stated in the packet because the circuit was outside scope.
- Concrete cost: The original unbounded-context defect remains reachable under the ordinary two-tier
  configuration. One valid masternode holder can register an unlimited sequence of caller-chosen
  contexts, creating a durable record and cached members tree for each one. The per-source limit slows
  the attack but does not bound total state. Combined with the documented full tree rebuild, a valid
  holder can keep the event loop unavailable.
- Specific fix: Refuse two-tier startup unless `MNO_REGISTER_CONTEXTS` contains at least one canonical
  field element. If open registration is useful for demonstrations, require an explicit
  `MNO_ALLOW_OPEN_REGISTRATION=1` option, matching the existing unauthenticated-oracle, unauthenticated-
  gateway, and ephemeral-store controls. Validate every configured value with `isCanonicalField` at
  boot.

### M1 Torn-tail recovery poisons the next append

- Lens: 1, correctness and data integrity
- Severity: major
- Location: `core/registration_store.js:240`, `core/registration_store.js:250`,
  `core/registration_store.js:255`, `core/registration_store.js:262`,
  `core/registration_store.js:347`, `core/registration_store.js:350`
- Evidence: READ and CONFIRMED. The loader stops at a torn last line but never truncates the damaged
  bytes. The next append opens the same file in append mode and writes the new object directly after
  the partial object. A focused probe loaded a header, one good record, and a torn tail, then appended
  a valid record. The append returned `{ duplicate: false, index: 1 }`. Reopening refused because the
  concatenated third line was invalid JavaScript Object Notation (JSON).
- Concrete cost: The fix converts a recoverable boot into a delayed permanent outage. The gateway
  reports the next registration as committed, then the next restart refuses the entire two-tier path
  until an operator edits the file. The new registration is mixed into the damaged line, so automated
  recovery cannot safely identify it as an independent record.
- Specific fix: When a torn tail is accepted, truncate the file to the byte offset immediately before
  that line, flush the truncated file, and only then finish loading. Test the whole sequence of load,
  append, close, reopen, and rebuild. Do not stop at asserting that the first load succeeded.

### M2 The post-proof clock guard does not sample the epoch before granting

- Lens: 1, correctness and security
- Severity: major
- Location: `core/gateway.js:899`, `core/gateway.js:900`, `core/gateway.js:901`,
  `core/gateway.js:905`, `core/time_guard.js:124`, `core/time_guard.js:140`
- Evidence: READ and CONFIRMED. `stillCurrent` reads the sticky `timeGuard.regressed` flag before it
  calls any method that observes the epoch. In single-tier mode it never calls `timeGuard.epoch()` at
  all. The raw upper-bound check detects a forward rollover, not a backward step. A focused probe
  marked epoch 10, moved the clock to epoch 9, and ran the callback logic. It returned null. Calling
  `timeGuard.epoch()` immediately afterwards recorded the regression and changed the same callback's
  answer to `clock-regressed`.
- Concrete cost: A clock correction during proof verification can pass the new guard, spend the
  nullifier under the future epoch, and return a grant even though the gateway's stated rule is to
  refuse all state-bearing work after a regression. The next request detects the rollback, but the
  first grant has already escaped.
- Specific fix: Call `timeGuard.epoch()` first inside every `stillCurrent` invocation, then check
  `timeGuard.regressed`. In two-tier mode sample both epoch and season before inspecting either result.
  Add an injected-clock test that moves backward during `verifyProof`, rather than seeding a regression
  before gateway startup.

### M3 A season can still end inside the durable append and receive a successful registration

- Lens: 1, correctness
- Severity: major
- Location: `core/season.js:140`, `core/season.js:151`, `core/season.js:155`,
  `core/season.js:171`, `core/gateway.js:997`, `core/gateway.js:1004`,
  `core/gateway.js:1007`
- Evidence: READ and CONFIRMED. `SeasonMembers.commit` checks `seasonNow()` immediately before
  `await appendDurable()`, but it never checks again after that await. The root-age check has the same
  placement inside the durable writer. A focused probe changed the live season after the store append
  completed but before the durable writer resolved. `commit` returned `ok: true`, added the member to
  the old tree, and left a season-zero durable record while the authoritative season was one.
- Concrete cost: A slow file open, write, or flush at a boundary can still return success for a
  membership that the next rollover makes unusable. The member has paid the heavy proving cost and may
  promote its pending secret as accepted. The same interval lets an anchor cross its maximum age while
  the durable write is in flight.
- Specific fix: Define and enforce the acceptance point explicitly. At minimum, re-sample season and
  root eligibility after the durable append and before mutating the tree or returning success. A late
  record is harmless if the response says retry and the old-season tree is not published, but this
  should be represented as a named committed-but-expired result. A complete design can use a short
  registration ticket with a fixed expiry, as described under Opportunities.

### M4 A successful durable write followed by a close error can duplicate a registration

- Lens: 1, error-path correctness and data integrity
- Severity: major
- Location: `core/registration_store.js:300`, `core/registration_store.js:325`,
  `core/registration_store.js:347`, `core/registration_store.js:350`,
  `core/registration_store.js:352`, `core/registration_store.js:354`
- Evidence: READ. The record is written and flushed before `close()`. If `close()` rejects after the
  flush, control leaves through the `finally` block before `#remember(record)` runs. The file contains
  the record, while the in-memory `seen` set does not. A retry can append the same unique key again,
  and `#load` does not reject duplicate keys when the process restarts.
- Concrete cost: After a write-uncertainty error, the current process can report failure and then
  record the retry at the same in-memory index. A restart loads both lines into the members bucket,
  changes its root, consumes capacity twice, and leaves duplicate stored indices. This is the exact
  error path where an append-only file needs idempotent recovery.
- Specific fix: Treat the write result as uncertain after any error that follows `appendFile`. Before
  retrying, reconcile the tail from disk by unique key. Also reject duplicate unique keys and non-dense
  indices during load. The simpler alternative is to move registrations to the existing Node SQLite
  stack and use a unique constraint and transaction.
- Confirmation note: This path needs a fault-injection seam around file-handle close to reproduce
  deterministically. The ordering in the cited code is sufficient to establish the inconsistent state,
  but I did not simulate an operating-system close failure in this sandbox.

### M5 The Platform schedule assertion does not identify the asserted schedule

- Lens: 1, configuration and state safety
- Severity: major
- Location: `core/config.js:91`, `core/config.js:93`, `core/gateway.js:43`,
  `core/gateway.js:197`, `core/gateway.js:204`
- Evidence: READ. `MNO_PLATFORM_ASSUME_SCHEDULE` is parsed as a Boolean. Once it is set to `1`, the
  guard accepts every computed `SCHEDULE`. Nothing ties the assertion to the epoch and season lengths
  that were active when the operator made it.
- Concrete cost: An operator can leave the assertion in an environment file, later change
  `MNO_EPOCH_SECONDS` or `MNO_SEASON_SECONDS`, and silently reinterpret the same Platform documents
  under different period numbers. The refusal text itself identifies the two consequences. A spent
  tag can reopen, or an old immutable tag can deny a legitimate claim.
- Specific fix: Require the environment value to equal the computed schedule identifier, such as
  `MNO_PLATFORM_ASSUME_SCHEDULE=e604800s7776000`, instead of accepting a Boolean. Record that assertion
  durably per Platform network and contract identifier so a later local configuration change refuses
  before connecting. Test a changed epoch length with the old exact assertion still present.

### M6 Account-level refusals still drain the shared adapter bucket

- Lens: 1, availability and load shedding
- Severity: major
- Location: `core/gateway.js:793`, `core/gateway.js:794`, `core/gateway.js:805`,
  `core/gateway.js:848`, `core/gateway.js:849`, `core/gateway.js:854`,
  `test/gateway_http.test.js:1545`, `test/gateway_http.test.js:1552`
- Evidence: READ and INFERRED. Both account-bearing routes charge the source limiter before the body
  is read and before the account limiter runs. A request rejected by the smaller account bucket has
  already consumed the shared source bucket. The fairness test sets the shared limit to 1000, removing
  the interaction that can defeat the feature. Shared adapter addresses are stated in the packet but
  were not independently verified because adapters were outside scope.
- Concrete cost: With the defaults, one account can make 60 challenge requests. Its first 10 use its
  own allowance and the next 50 receive account-level 429 responses, but all 60 consume the shared
  challenge bucket. Every other account behind that source is then denied. The same pattern drains the
  120-request verification bucket after one account's first 20 attempts. The new per-account limit can
  therefore do the opposite of its stated purpose.
- Specific fix: Authenticate and parse the body, charge the account bucket first, and charge the
  shared source bucket only when the account bucket accepts. Keep both verification checks before
  `challenges.take()`. Change the test to use a small shared maximum, keep sending requests after one
  account is limited, and prove another account still has shared allowance.
- Assumption: The availability consequence requires several accounts to share one `clientKey`. The
  packet states that shipped adapters have that topology, but adapters were out of scope. The ordering
  defect is reachable under any deployment where that condition holds.

### m1 A challenge can be minted for a season that ended during materialization

- Lens: 1, boundary correctness
- Severity: minor
- Location: `core/gateway.js:813`, `core/gateway.js:814`, `core/gateway.js:815`,
  `core/gateway.js:827`, `core/season.js:113`, `core/season.js:118`, `core/season.js:119`
- Evidence: READ. The challenge handler samples the season, then awaits `ensureContext`, which can read
  records and build a full members tree. It never samples the season again before storing and returning
  the challenge. The verification path later rejects the stale season, so this does not grant access.
- Concrete cost: A correct request near a season boundary can receive an unusable challenge and spend
  several seconds producing a proof that the gateway is guaranteed to reject. This is the read-side
  twin of the commit boundary bug.
- Specific fix: After `ensureContext` returns, re-sample the guarded season. If it changed, repeat the
  ensure against the new season before reading the root and minting the nonce. Apply the same pattern
  to `/v1/members`, which can otherwise serve a just-expired season after a slow materialization.

### m2 Registration readiness ignores the registration anchor age

- Lens: 1, correctness and observability
- Severity: minor
- Location: `core/gateway.js:1050`, `core/gateway.js:1063`, `core/gateway.js:1066`,
  `core/stores.js:160`, `core/stores.js:171`
- Evidence: READ. `canRegister` requires any current deterministic masternode list (DML) root, while
  registration requires that root to satisfy `MNO_REGISTER_ROOT_MAX_AGE`. With the defaults, a root
  between 901 and 1800 seconds old remains current for membership but every registration is refused.
- Concrete cost: Health reports registration ready for up to 15 minutes while no root is eligible for
  registration. An operator can miss a stalled oracle, and members can generate expensive proofs that
  the gateway rejects immediately.
- Specific fix: Compute `canRegister` with
  `dmlRoots.isEligibleWithin(dmlRoot, config.registerRootMaxAgeSeconds, nowSec())`. Report the age or
  the refusal reason so an operator can distinguish no root from a registration-stale root.

### m3 The fixed signature cap can make a configured quorum impossible

- Lens: 1, configuration correctness
- Severity: minor
- Location: `core/config.js:9`, `core/config.js:21`, `core/config.js:275`,
  `core/gateway.js:411`, `core/gateway.js:435`, `core/gateway.js:436`
- Evidence: READ. Configuration accepts any number of distinct trusted keys and validates only that
  quorum does not exceed that count. Runtime rejects every snapshot with more than 64 signatures. A
  deployment configured with 65 keys and a quorum of 65 therefore boots successfully but can never
  adopt a root.
- Concrete cost: A syntactically valid configuration produces a permanent oracle outage with no boot
  error. The guard has no success path for that configuration.
- Specific fix: Validate at boot that both trusted-key count and quorum are within the supported cap,
  or derive the response cap from an explicitly bounded configured-key count. Add a 65-key config test
  that requires a startup refusal.

## Lens 2 architecture, design, efficiency, and right-sizing

### A1 Gateway boot, policy, refresh, and transport remain one uninjectable module

- Lens: 2, architecture and testability
- Severity: major
- Location: `core/gateway.js:39`, `core/gateway.js:73`, `core/gateway.js:275`,
  `core/gateway.js:511`, `core/gateway.js:768`, `core/gateway.js:1093`,
  `test/gateway_http.test.js:43`, `test/gateway_http.test.js:53`
- Evidence: READ. Importing `gateway.js` performs configuration validation, opens durable stores, loads
  keys, refreshes the oracle, creates timers, and binds a socket. The clock, refresh source, policy
  callbacks, and route handler cannot be instantiated independently. Gateway tests therefore spawn a
  child process and require a real loopback port.
- Concrete cost: The fold's most important races sit inside closures that tests cannot drive with an
  injected clock or delayed store. The full integration group is also all-or-nothing in environments
  that cannot bind a socket. This shape contributed directly to the missing during-proof clock test,
  the missing append-boundary test, and the vacuous signature-cap assertion below.
- Specific fix: Keep the command entry point small and extract a `createGateway` service that accepts
  config, clock, stores, proof verifier, and oracle loader, then returns the request handler and refresh
  operation. This is one boundary, not a new layer per concern. The existing child-process tests can
  remain as smoke tests while race and refusal tests call the service directly.

### A2 The signature-cap test passes when the cap is removed

- Lens: 2, test quality and maintainability
- Severity: minor
- Location: `test/gateway_http.test.js:1370`, `test/gateway_http.test.js:1377`,
  `test/gateway_http.test.js:1385`, `test/gateway_http.test.js:1400`,
  `test/gateway_http.test.js:1405`, `test/gateway_http.test.js:1421`
- Evidence: READ. The over-cap snapshot contains no valid trusted signature, so it is rejected for
  unmet quorum whether or not the length cap exists. The test comments acknowledge that removing the
  cap does not fail the test. The later valid-signature case is deliberately under the cap and tests
  indexing, not the cap.
- Concrete cost: The explicit defense-in-depth bound can disappear without any test failure. The same
  test title then continues to claim the over-cap behavior is covered.
- Specific fix: Put one valid trusted signature among more than 64 distinct entries. With the cap, the
  gateway must refuse. Without it, indexed verification finds the trusted entry and adopts the
  snapshot, so the mutation becomes observable without a timing assertion. A pure exported signature
  policy would make this cheaper than starting a child process.

### A3 Snapshot normalization has two tests that cannot observe its removal

- Lens: 2, test quality and regression resistance
- Severity: minor
- Location: `core/gateway.js:491`, `core/gateway.js:616`,
  `test/gateway_http.test.js:1343`, `test/gateway_http.test.js:1363`,
  `test/root_windows.test.js:289`, `test/root_windows.test.js:298`
- Evidence: READ. The integration test inspects `/v1/dml`, whose handler constructs a new five-field
  response and omits unknown fields regardless of what the window retained. The unit test passes an
  already normalized object directly to `RootWindows.adopt`. Replacing `snapshot: normalizeSnapshot(o)`
  with `snapshot: o` leaves both assertions green.
- Concrete cost: The previously measured retained-padding regression can return without a failing test,
  even though two test names appear to cover it.
- Specific fix: Move the pure normalization function into an importable module and test it directly
  with a signed-shape object containing large unknown fields. Better still, expose the refresh-to-window
  adoption operation and inspect `window.current().snapshot`, which tests the real call site.

### A4 New rate-limit maps are omitted from periodic sweeping

- Lens: 2, efficiency and robustness
- Severity: minor
- Location: `core/gateway.js:101`, `core/gateway.js:105`, `core/gateway.js:109`,
  `core/gateway.js:112`, `core/gateway.js:702`, `core/stores.js:318`,
  `core/stores.js:329`, `core/stores.js:339`
- Evidence: READ. The timer sweeps the source-keyed challenge, verify, register, and members limiters.
  It omits both new account limiters and the new DML limiter. `RateLimiter` eventually sweeps lazily
  when its 50,000-key cap is reached, so entry count is bounded, but expired keys and their full string
  contents remain until then.
- Concrete cost: The new account keys contain the complete caller-supplied account string. Because the
  request body permits roughly 2 megabytes and no account-length bound exists, a malformed or
  compromised adapter can make the limiter retain large expired keys across windows. Even with normal
  short platform identifiers, a long-lived gateway retains stale account and context combinations
  needlessly.
- Specific fix: Sweep `accountChallengeLimiter`, `accountVerifyLimiter`, and `dmlLimiter` in the timer.
  Enforce a small account identifier length before constructing a rate key or storing a challenge.
- Assumption: Production adapters normally send short canonical identifiers. The adapters were out of
  scope, so the large-key consequence assumes a buggy or compromised authenticated adapter. The
  omitted sweep itself is directly read from the code.

The root-window authority, signature label canonicalization, policy-check ordering, and explicit
handling of durable refusal shapes are otherwise sound in the reviewed paths. I did not report the
known full members-tree rebuild or the retained leaf-array bound, as requested.

## Lens 3 opportunities

### IDEA Replace the registration log with the SQLite pattern already used here

- Idea: Store registrations in Node SQLite with a unique key on season, context, and registration
  nullifier, plus an indexed bucket order and the schedule marker in metadata. Commit the record and
  assigned index in one transaction.
- Value: This removes the torn-tail parser, append and close uncertainty, manual in-memory duplicate
  index, and full historical scan. It uses a dependency and durability policy already present in
  `core/nullifier_sqlite.js`, so it reduces code and risk rather than introducing a new storage system.
- Rough effort: Medium. The backend interface can stay unchanged, and migration can import the existing
  JSON lines file only after validating unique keys, declarations, and dense indices.
- Assumption: The file backend remains a single-gateway store. That is the contract already stated in
  `core/registration_store.js`.

### IDEA Issue a short registration ticket before the heavy proof

- Idea: Add an accountless registration-start endpoint that returns the context, season, eligible DML
  root, and a short expiry in a gateway-authenticated ticket. The registration proof already exposes
  root, season, and context, so submission can require exact equality with the ticket without changing
  the circuit. The registration nullifier continues to prevent replayed membership.
- Value: This gives the long proof one explicit policy window and replaces three moving root-age checks
  with one stable contract. It also lets the gateway refuse work too close to a season boundary before
  the member spends minutes proving.
- Rough effort: Medium. It needs a bounded ticket store or a message authentication code, one endpoint,
  and boundary tests. No proving or verification key change appears necessary based on the public
  signals read in `core/verifier.js`.
- Assumption: The proof really binds the five public registration signals in the order read by the
  verifier. The circuits were out of scope, so confirm that against the compiled public-signal file
  before adopting this design.

## Test evidence

`npm test` ran all 459 tests. The 375 non-network tests passed. Eighty-four tests that require a
loopback listener failed with `listen EPERM` because this sandbox prohibits binding `127.0.0.1`.
Those are unexecuted environment failures, not code failures. Focused in-process probes reproduced
the torn-tail append corruption, the season change inside the durable writer, and the unsampled
backward epoch in the post-proof guard.

BLOCK
