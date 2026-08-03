# Gateway round 5 adversarial review

This review covers the repository at commit `993bc07`. The tip commit is documentation-only, so the
implementation packet described in the charter is the 850-line fold at `ebc0e0c`, compared with
`45ebc02`. I read `CLAUDE.md`, `docs/DESIGN.md`, and `docs/DEPLOY.md` first. I then reviewed the
scoped production code and tests under `core/`, `common/`, and `oracle/`, with extra attention on the
nine fold fixes and their sibling paths.

The evidence labels separate direct code facts from consequences that need an operational
assumption.

- `READ` means the behavior follows directly from the cited code.
- `CONFIRMED` means a focused probe reproduced the state transition.
- `INFERRED` means the consequence depends on an assumption stated in the finding.

The adapters, provers, and circuits were outside scope. Any claim about what a proof asserts is
inferred only from the public-signal handling in `core/verifier.js`. I did not re-report the known
open items listed in the charter.

## Lens 1 correctness, edge cases, and security

### Registration still misses an epoch rollback during proof verification

- Lens: correctness and security
- Severity: major
- Location: `core/gateway.js:842`, `core/gateway.js:847`, `core/gateway.js:1059`,
  `core/gateway.js:1088`, `core/gateway.js:1095`, `core/season.js:151`,
  `core/season.js:155`, `core/stores.js:185`
- Evidence: READ and CONFIRMED. The request-entry guard samples both epoch and season. After the
  registration proof, the commit path samples only `timeGuard.season()`. A focused `TimeGuard` probe
  marked epoch 25 and season 2, moved the clock from 2500 to 2450 with 100-second epochs and a
  1000-second season, and called only `season()`. It returned season 2 and left `regressed` false.
  Calling `epoch()` immediately afterwards detected the rollback from epoch 25 to 24.
- Concrete cost: A clock step backward across an epoch boundary, but not a season boundary, during
  the expensive registration proof is invisible to the final commit guard. The backward wall clock
  also makes the root-age calculation smaller, and `isEligibleWithin` clamps a future-looking root to
  age zero. A root that should have aged out can therefore pass the final check and gain a durable
  season registration even though the gateway states that every state-bearing endpoint refuses after
  a clock regression.
- Specific fix: Inside the serialized callback immediately before `registrationStore.append`, sample
  both `timeGuard.epoch()` and `timeGuard.season()`, then read `timeGuard.regressed`. Return a named
  refusal that `SeasonMembers.commit` maps to `clock-regression`. Add a test that marks both periods,
  moves backward across only the epoch boundary during `verifyProof`, and asserts that no durable
  append occurs.
- Confirmation note: No circuit behavior is assumed. The defect is in the gateway clock policy and
  the placement of its durable-write guard.

### A complete JavaScript Object Notation record without its newline still poisons the next append

- Lens: correctness and data integrity
- Severity: major
- Location: `core/registration_store.js:246`, `core/registration_store.js:250`,
  `core/registration_store.js:252`, `core/registration_store.js:269`,
  `core/registration_store.js:292`, `core/registration_store.js:362`,
  `test/registration_store.test.js:271`
- Evidence: READ and CONFIRMED. Truncation is scheduled only inside the JavaScript Object Notation
  (JSON) `JSON.parse` error branch. A crash can leave all JSON bytes but omit the final newline. That
  last line parses, is remembered as a
  registration, and is not truncated. A focused probe seeded a header and one complete registration
  without the newline, reopened the backend, and appended another record. The append returned
  `{ duplicate: false, index: 1 }`. The file then contained `}{` between the records, and a fresh
  backend refused line 2 as invalid JSON.
- Concrete cost: The recovery still turns one interrupted append into a delayed permanent boot
  outage. The first process treats an append that may never have completed as committed, the next
  append reports success while creating a malformed combined line, and every later boot refuses until
  an operator repairs the file.
- Specific fix: Treat every nonempty final line without a newline as an incomplete append, whether or
  not it parses. Truncate to the byte after the last complete newline before parsing or remembering
  that tail. Extend the test through load, append, close, reopen, and rebuild for both malformed and
  parseable unterminated tails. The existing test stops after the first recovered load and cannot
  catch either delayed failure.

### Sequential rate-limit checks still charge a request that is refused

- Lens: correctness and availability
- Severity: major
- Location: `core/gateway.js:875`, `core/gateway.js:879`, `core/gateway.js:934`,
  `core/gateway.js:938`, `core/stores.js:350`, `core/stores.js:361`,
  `test/gateway_http.test.js:1545`
- Evidence: READ. Moving the shared limiter after the account limiter fixes one ordering, but the two
  updates are still not atomic. `RateLimiter.allow` increments its bucket before returning. If the
  account bucket accepts and the shared bucket then rejects, the request consumes account allowance
  even though no challenge or verification was served. The new fairness test exercises only the
  opposite order, where the account bucket rejects first and the shared bucket must stay untouched.
- Concrete cost: The shared and account fixed windows start independently. A user who retries near
  the end of a saturated shared window can consume the whole account allowance on shared-bucket 429
  responses. When the shared window resets, that user remains denied until the later account window
  resets. The same defect exists on challenge and verify. The verify nonce survives, but its holder
  can still be locked out by attempts that performed no verification.
- Specific fix: Add a synchronous composite operation that inspects and refreshes both buckets, then
  increments both only when both can accept. Both maps live in one process, so this needs no lock or
  abstraction beyond a small `allowAll` method. Add tests for both refusal orders with deliberately
  offset window starts, including a verify assertion that the nonce and both allowances survive a
  shared-bucket refusal.
- Assumption: The availability cost requires several accounts to share one `clientKey`, which is the
  topology described by the packet. The non-atomic update is reachable for any callers that share a
  source key.

### Account strings can still turn bounded request counts into unbounded retained bytes

- Lens: safety and denial of service
- Severity: minor
- Location: `core/config.js:148`, `core/gateway.js:865`, `core/gateway.js:870`,
  `core/gateway.js:875`, `core/gateway.js:899`, `core/stores.js:348`,
  `core/stores.js:461`
- Evidence: READ and INFERRED. The body cap permits almost 2 megabytes (MB), while `account` has no byte-length
  bound. The full string becomes an account-limiter key and is also retained in every accepted
  challenge for the 600-second default lifetime. Sweeping every limiter limits time and key count, but
  it does not limit bytes per key or bytes per pending challenge.
- Concrete cost: With the default shared challenge limit, one source can retain about 60 nearly 2 MB
  account strings per minute. Across the 10-minute challenge lifetime that is roughly 1.2 gigabytes (GB) of
  account text, before map and JSON overhead, despite all count limits working as configured.
- Specific fix: Convert the account once, reject it before any limiter or challenge write when its
  Unicode Transformation Format, 8-bit (UTF-8) byte length exceeds a small documented bound, and use
  that validated string everywhere. Check
  the real identifier limits of the supported platforms before choosing the bound. Add a test with an
  oversized account and assert that no limiter key and no challenge are retained.
- Assumption: Production exploitation requires a buggy or compromised authenticated adapter. In the
  explicit unauthenticated mode, any caller can supply the string. The retained-byte amplification in
  the gateway is directly visible from the cited code.

### The local Platform schedule marker is neither atomic nor durable

- Lens: correctness and shared-state safety
- Severity: major
- Location: `core/gateway.js:243`, `core/gateway.js:248`, `core/gateway.js:262`,
  `core/gateway.js:264`, `core/time_guard.js:90`, `core/time_guard.js:99`
- Evidence: READ. The first Platform assertion is recorded with a direct `writeFile`. There is no
  exclusive creation, temporary-file rename, file flush, or directory flush. The repository's own
  `TimeGuard` explains and implements the rename and flush discipline because a marker that is lost
  after a power failure cannot protect a later boot. Exclusive creation is the extra step this
  first-writer-wins marker needs for concurrent starts.
- Concrete cost: Two first-start processes can both read `ENOENT`, write different schedules, and
  continue, with the last write winning locally. A power loss can also lose the marker after the
  process proceeded. A later operator who changes the schedule and its exact environment assertion
  can then connect to old Platform state without the local refusal this fix claims to provide.
- Specific fix: Create the marker with exclusive create semantics, flush it, and flush its parent
  directory. On `EEXIST`, read and compare instead of overwriting. Scope the marker to the Platform
  network and contract identifier so independent shared states do not collide. Only an on-chain marker
  can coordinate different hosts, so keep the existing limitation explicit.
- Confirmation note: The cross-host limitation is already admitted by the code and is not this
  finding. This finding concerns the promised local first-assertion record.

### Ephemeral SQLite still selects durable clock marks

- Lens: correctness and configuration
- Severity: minor
- Location: `core/gateway.js:83`, `core/gateway.js:85`, `core/gateway.js:280`,
  `core/gateway.js:294`, `core/config.js:233`, `core/config.js:239`
- Evidence: READ. `durableStateExists` treats every store other than the literal `memory` value as
  durable. The SQLite branch separately recognizes `MNO_NULLIFIER_PATH=:memory:` as ephemeral and
  allows it behind `MNO_ALLOW_EPHEMERAL_NULLIFIERS=1`.
- Concrete cost: A single-tier gateway explicitly configured for in-memory SQLite still writes the
  default clock-mark file. A forward clock jump can then make later ephemeral development runs refuse
  across restarts, despite the configuration and comments saying no durable state exists to protect.
- Specific fix: Derive durability from the concrete backend. SQLite is durable only when its path is
  not `:memory:`, Platform is durable, memory is not, and two-tier registrations make the combined
  service durable regardless of the nullifier backend. Add positive and negative path-selection tests.

### The signature-cap boot check rejects quorums that are reachable

- Lens: correctness and configuration
- Severity: minor
- Location: `core/config.js:27`, `core/config.js:290`, `core/config.js:293`,
  `core/config.js:301`, `core/gateway.js:490`
- Evidence: READ and CONFIRMED. The runtime cap limits signatures carried by one snapshot, but the new
  boot check limits the number of trusted keys. A probe configured 65 distinct trusted keys with
  quorum 1 and was refused. One valid signature is sufficient for that quorum and is below the
  64-signature response cap, so the configuration has a valid acceptance path.
- Concrete cost: A deployment cannot keep a large trust roster with a small quorum, even though the
  verifier can accept such a snapshot and the response work remains capped. The refusal text assumes
  every trusted key must sign, which is not the quorum rule the code enforces.
- Specific fix: Refuse when `oracleQuorum > MAX_SNAPSHOT_SIGS`. If scanning trusted keys also needs a
  bound, define and document a separate `MAX_TRUSTED_ORACLE_KEYS` based on that work rather than using
  the response-signature cap. Test 65 trusted keys with quorum 1 and a one-signature snapshot, plus an
  unreachable quorum above the response cap.

## Lens 2 architecture, design, efficiency, and right-sizing

### The new persistence tests use deployment paths and do not test the persisted transition

- Lens: architecture and test safety
- Severity: major
- Location: `test/gateway_http.test.js:43`, `test/gateway_http.test.js:51`,
  `test/gateway_http.test.js:1664`, `test/gateway_http.test.js:1700`,
  `test/gateway_http.test.js:1730`, `test/gateway_http.test.js:1754`
- Evidence: READ. The gateway helper supplies no temporary registration, time-mark, or Platform
  schedule path. The new two-tier durability rule makes ordinary two-tier test children write
  `data/time_marks.json`, and the Platform assertion test writes `data/platform_schedule.json` before
  it fails later on missing credentials. The Platform test never boots again with a changed schedule,
  so removing the marker write leaves the test green. The clock test checks `/season/`, which also
  matches `seasonSeconds` and a null `season` field.
- Concrete cost: Running the test suite can alter a developer's ignored local deployment state. The
  tests can also pass when the first Platform assertion is not recorded and when no integer season
  high-water mark is present, so the two new durability claims are not regression-protected.
- Specific fix: Give every spawned gateway a test-owned temporary directory and explicitly set
  `MNO_REG_PATH`, `MNO_TIME_MARKS_PATH`, `MNO_NULLIFIER_PATH`, and
  `MNO_PLATFORM_SCHEDULE_PATH`. For Platform, boot once to record schedule A, then boot with schedule B
  and its matching assertion and require the recorded-marker refusal. For clock marks, parse the file,
  require integer epoch and season values, then perform the restart regression the production rule is
  meant to stop.

### The normalization source-text tripwire is an acceptable stopgap, but not an invariant

- Lens: architecture and testability
- Severity: minor
- Location: `core/gateway.js:653`, `core/stores.js:82`,
  `test/root_windows.test.js:376`, `test/root_windows.test.js:388`,
  `test/root_windows.test.js:391`
- Evidence: READ. The test proves that one source spelling contains
  `snapshot: normalizeSnapshot(` and does not contain one exact raw spelling. It does not observe the
  object retained by the live refresh path. A later assignment that replaces the stored snapshot with
  the raw object, or a second raw retention path, passes the regular-expression check. A safe refactor
  that preserves normalization under a different spelling fails it.
- Concrete cost: The test is useful for the exact mutation that escaped the prior suite, but it can
  produce both false confidence and false failures. That makes source formatting part of the behavior
  contract while the actual memory-retention invariant remains unenforced at its owner.
- Specific fix: Make `RootWindows.adopt` normalize any supplied snapshot before storing it, or extract
  the refresh-to-adopt operation into an importable function and assert
  `window.current().snapshot` after a hostile padded input. Then delete the source-text check.
- Engineering judgment: Given the known import-on-boot gateway shape, this tripwire is acceptable as a
  short-lived quarantine for one named regression. It is still a smell and should not be treated as
  equivalent to a behavioral test.

### Boot validation writes state before it decides whether configuration is valid

- Lens: architecture and simplicity
- Severity: minor
- Location: `core/gateway.js:686`, `core/gateway.js:691`, `core/gateway.js:709`,
  `core/gateway.js:730`, `core/gateway.js:745`, `core/gateway.js:243`,
  `core/gateway.js:264`
- Evidence: READ. Two-tier mode loads keys, opens and may stamp the registration file, and advances
  clock marks before it refuses an empty or noncanonical context allowlist. Platform mode writes the
  local schedule marker before it knows whether the Platform connection can be established.
- Concrete cost: A failed preflight is not read-only. Correcting the rejected configuration can then
  encounter schedule state created by the failed attempt, and a failed Platform credential check can
  pin a schedule even though no Platform state was reached. This makes the most expensive refusal path
  harder to reason about and is why the tests leak state into `data/`.
- Specific fix: Move all pure configuration checks, including mode, store combination, allowlist
  presence, allowlist canonicality, quorum reachability, and exact assertion syntax, into one
  preflight step before constructing `TimeGuard` or any store. Record backend metadata only after the
  backend identity and credentials have been validated, but before the first state write.

The normalization function itself is appropriately small, and the current limiter sweep includes all
seven limiters. The `ALL_LIMITERS` array remains a manual registry, so its comment that future
limiters join "by construction" overstates the guarantee, but no current limiter is missing and I do
not report that wording as a separate defect.

## Lens 3 opportunities

### IDEA Exhaustive append-prefix crash testing

- Idea: Serialize one registration record, then test every byte prefix of that append as the file
  tail. For each prefix, reopen the store, append a new registration, reopen again, and assert that the
  final state is either the old committed prefix set or the complete new set, never an unbootable log.
- Value: This is a small state-machine test borrowed from storage-engine crash testing. It would have
  caught the original torn-tail refusal, the previous delayed concatenation bug, and the parseable
  no-newline case in this round without needing one hand-written example per failure shape.
- Rough effort: Low. The record is a few hundred bytes, so a full prefix loop is cheap compared with
  the existing members-tree tests.
- Assumption: The single-writer file model remains the intended backend contract. That is stated in
  `core/registration_store.js`.

### IDEA Add a read-only gateway preflight command

- Idea: Provide a command that parses and validates gateway configuration, prints the computed
  schedule identifier and context hashes, checks key and path readability, and exits without opening
  stores or binding a port.
- Value: Operators can produce the exact `MNO_REGISTER_CONTEXTS` and
  `MNO_PLATFORM_ASSUME_SCHEDULE` values before first boot. Tests can exercise every new boot refusal
  without touching deployment state or needing a loopback listener. This also gives the deployment
  guide a correct two-tier setup path after the new mandatory allowlist.
- Rough effort: Low to medium. Most parsing already lives in `core/config.js`. The work is separating
  validation from gateway side effects and adding one thin command.
- Assumption: Context hashes are intended to be configured from the same platform, community, and
  role tuple accepted by `common/contextHash`. Confirm the operator-facing tuple for each adapter when
  documenting the command, because adapters were outside this review.

## Test evidence

`npm test` discovered 462 tests. The 377 tests that did not require a loopback listener passed. The
remaining 85 failed with the operation-not-permitted error `listen EPERM` on `127.0.0.1`, including
the gateway Hypertext Transfer Protocol (HTTP) group and two
loopback oracle-loader tests. Per the charter, those are unexecuted environment failures rather than
code failures.

Focused in-process probes reproduced all of the following states.

- A parseable registration record without its newline is accepted, the next append concatenates, and
  the next reopen refuses.
- A same-season epoch rollback stays invisible when only `TimeGuard.season()` is sampled.
- A 65-key trust roster with quorum 1 is rejected by the new boot check even though one signature is
  within the runtime cap.

BLOCK
