# Gateway fold adversarial review round 4

This review covers commit `997e231` using only the source and tests embedded in
`codexapp_dash-mno-verify_gateway_round4_2026-08-03.md`. No repository source was read or executed.
Claims about circuit behavior and adapter topology are identified as inferences.

## Findings

### F1 Rejected account requests still exhaust the shared adapter bucket

- Lens: correctness
- Severity: major
- Location: `core/gateway.js:795`, `core/gateway.js:806`, `core/gateway.js:850`, `core/gateway.js:855`, `test/gateway_http.test.js:1553`
- Read: Both account-bearing routes charge the source-keyed limiter before reading and charging the
  account-keyed limiter. A request that the account limiter rejects therefore still increments the
  shared source bucket. The fairness test sets `MNO_RATE_CHALLENGE` to 1000, so it removes the shared
  bucket interaction that can defeat the fix.
- Inferred: The packet says the shipped adapters send all users from one source address, but the
  adapters are outside this packet and that topology was not independently verified. The defect is
  reachable whenever two accounts share one `clientKey`, regardless of which adapter creates that
  condition.
- Concrete cost: With the defaults, one account can send 60 challenge requests. Its first 10 use its
  own allowance and the next 50 receive account-level 429 responses, but all 60 consume the shared
  challenge bucket. Every other account behind that adapter then receives 429. The same pattern lets
  one account consume the 120-request shared verify bucket after its own 20-request allowance ends.
  The per-account limiter therefore does not provide the fairness its comments and test claim.
- Specific fix: Authenticate and parse the body, charge the account bucket, and charge the shared
  adapter bucket only when the account bucket accepts the request. If a source-level ingress shield
  is still needed for malformed bodies, keep it as a separate limiter whose denial behavior is not
  described as per-account fairness. Apply the same ordering to challenge and verify, while keeping
  every verify limiter before `challenges.take()`.
- How to confirm: Set the shared challenge maximum to 4 and the account maximum to 2. Send four or
  more requests for `noisy`, then request a challenge for `quiet` from the same socket address. The
  current code rejects `quiet` at the shared limiter. The corrected code lets `quiet` use the
  remaining shared allowance. Repeat the same test for verify and assert that a limited request does
  not consume its nonce.

### F2 Torn-tail recovery leaves the torn bytes in the append path

- Lens: correctness
- Severity: major
- Location: `core/registration_store.js:251`, `core/registration_store.js:256`, `core/registration_store.js:262`, `core/registration_store.js:348`, `test/registration_store.test.js:272`
- Read: The loader stops parsing when it finds a malformed final line and marks
  `tornTailDiscarded`, but it never truncates the file to the last complete newline. The next durable
  append opens that same file in append mode and writes the new JavaScript Object Notation (JSON)
  record directly after the torn
  fragment. The existing test checks only the first recovered read. It never appends a record and
  reopens the store.
- Inferred: No circuit or adapter assumption is needed. This follows from the file bytes and append
  semantics in the included source.
- Concrete cost: An ordinary interrupted append can be ignored for one process lifetime. The first
  later registration concatenates a valid record to the torn fragment and flushes the malformed
  combined line. On the next restart the file ends in a newline, so the line is no longer a torn-tail
  candidate and boot refuses permanently until an operator repairs the log. If the torn line occurs
  while a schedule header is being written, the header-stamping path can create the same malformed
  concatenation during recovery itself.
- Specific fix: When the final line is accepted as torn, truncate the file to the byte offset after
  the last complete newline and flush that repair before `ready()` resolves or any schedule header is
  appended. Preserve the current loud refusal for every malformed non-tail line. Compute the offset
  in bytes, not JavaScript string units.
- How to confirm: Seed a schedule header, one complete record, and a torn final fragment. Open the
  backend, append a new valid registration, close it, and open a fresh backend on the same path. The
  current code refuses the second open. The fixed code loads both complete registrations and has no
  malformed line.

### F3 Registration preconditions can expire inside the durable append

- Lens: architecture
- Severity: major
- Location: `core/gateway.js:1005`, `core/gateway.js:1008`, `core/season.js:153`, `core/season.js:156`, `core/registration_store.js:348`, `core/registration_store.js:350`
- Read: `SeasonMembers.commit()` re-reads the season and then awaits `appendDurable()`. The gateway's
  callback re-checks deterministic masternode list (DML) root eligibility and then returns
  `registrationStore.append()`. The file backend subsequently awaits file opening, append, and sync.
  Neither the season nor the anchor is checked after file opening or after the durable write.
- Inferred: A slow file open or sync can let the event loop process a root refresh, or let wall time
  cross an anchor-age or season boundary. This is ordinary asynchronous timing, not a claim about an
  omitted module.
- Concrete cost: If the root becomes ineligible while the file is being opened, the record is still
  written, mirrored into the members tree, and returned as successful. That stale anchor can buy the
  remainder of the season, which is the exact outcome the new anchor checks are meant to prevent. If
  the season rolls during the write, the caller receives success for an already expired registration
  and pays the heavy proving cost again after the next rollover.
- Specific fix: Move the authoritative guard into a guarded backend append. Complete all preparatory
  awaits, including opening the file and resolving duplicate and declaration checks, then run a
  synchronous guard immediately before starting the append. Define and document whether eligibility
  is decided at write initiation or durable completion. If completion must be authoritative, the log
  needs a reversible or tombstoned admission record. At minimum, re-read the season after sync and
  refuse success without appending to the stale cache when the season changed.
- How to confirm: Inject an `appendDurable` that observes an eligible root and current season, then
  changes both before resolving with an index. The current `SeasonMembers.commit()` returns `ok` and
  appends the commitment. Add a file-backend variant that pauses after `open()` and evicts the root
  before allowing `appendFile()`.

### F4 An empty context allowlist keeps the original unbounded registration path open

- Lens: architecture
- Severity: major
- Location: `core/config.js:170`, `core/gateway.js:689`, `core/gateway.js:966`
- Read: `MNO_REGISTER_CONTEXTS` defaults to an empty array. The registration guard runs only when the
  array is nonempty. A two-tier gateway with no list boots successfully and only emits a warning that
  any context may allocate durable state and a cached tree.
- Inferred: The ability of one masternode holder to produce distinct context-scoped registration
  nullifiers is inferred from the verifier interface and the packet's stated design because the
  circuit is not included. The unbounded admission branch itself is directly present in the gateway.
- Concrete cost: Upgrading a production deployment without adding the new environment setting leaves
  the prior resource-exhaustion defect intact. A valid holder can register fresh contexts indefinitely,
  growing the append-only file and forcing a full members-tree build for each context. The source
  describes that first build as about 20 seconds of blocked event-loop work, so the default path can
  be used for sustained denial of service.
- Specific fix: Refuse to boot in two-tier mode when the allowlist is empty. Preserve development use
  through a separate explicit unsafe flag such as `MNO_ALLOW_ANY_REGISTER_CONTEXTS=1`, matching the
  existing unauthenticated gateway and unsigned-oracle opt-ins. Validate every configured context as
  a canonical field element at boot.
- How to confirm: Boot two-tier mode with no `MNO_REGISTER_CONTEXTS`. The current process starts and
  reaches registration verification for arbitrary contexts. The corrected process must refuse. A
  second test should prove that a named unsafe opt-in reaches the old open behavior and that a
  nonempty allowlist admits only its members.

### F5 The Platform schedule assertion does not name a schedule

- Lens: architecture
- Severity: major
- Location: `core/config.js:94`, `core/gateway.js:198`, `core/gateway.js:205`, `test/gateway_http.test.js:1654`
- Read: `MNO_PLATFORM_ASSUME_SCHEDULE` is parsed as a persistent Boolean. Once it is `1`, the gateway
  accepts any computed `SCHEDULE`. The test proves only that absent fails and `1` passes the guard. It
  never changes the epoch or season length while retaining the assertion.
- Inferred: Deployment environment values commonly persist across configuration changes. The packet
  does not include a deployment system, so the likelihood of a stale flag is inferred. The missing
  comparison is direct from the source.
- Concrete cost: An operator can change `MNO_EPOCH_SECONDS` or `MNO_SEASON_SECONDS` while the old
  Boolean remains set. The gateway then reinterprets Platform documents under the new numbering,
  which its own refusal text says can reopen a spent tag or deny a legitimate claim. The flag does
  not substantiate the comment that the operator asserted one exact schedule.
- Specific fix: Require the environment value to equal the computed schedule identifier, for example
  `MNO_PLATFORM_ASSUME_SCHEDULE=e604800s7776000`, and refuse every other value. A local durable marker
  scoped to the Platform contract identifier would provide a second check, even though it cannot
  protect another gateway host by itself.
- How to confirm: Start with an assertion matching the default schedule. Change only
  `MNO_EPOCH_SECONDS` and keep the old assertion. The current guard passes. The corrected guard must
  fail and print both identifiers until the operator supplies the new exact value.

### F6 The normalization regression test cannot observe retained padding

- Lens: correctness
- Severity: minor
- Location: `test/gateway_http.test.js:1344`, `test/gateway_http.test.js:1364`, `test/root_windows.test.js:290`
- Read: The integration test checks the public `/v1/dml` response, whose handler explicitly constructs
  a five-field object. It would omit `padding` even if the window stored the entire hostile snapshot.
  The RootWindows unit test passes an already normalized object into `adopt()`, so it also succeeds if
  `normalizeSnapshot(o)` is replaced by `o` in the refresh path.
- Inferred: No external behavior is assumed. This is a mutation of the included call site against the
  included assertions.
- Concrete cost: The test suite can stay green if the previously measured 157 megabyte retained-padding
  regression returns. The test title claims coverage that neither assertion provides.
- Specific fix: Extract and export the pure snapshot-normalization function, then pass an object with
  a large unknown property to it and inspect the returned keys directly. Alternatively expose the
  refresh-to-window adoption function to a unit test and inspect `window.current().snapshot` rather
  than the public response.
- How to confirm: Mutate the refresh call from `snapshot: normalizeSnapshot(o)` to `snapshot: o`.
  Both current tests still pass. The replacement test must fail under that mutation.

## Opportunities

- Make oracle signature screening injectable at the verification-call boundary. A unit test can then
  count signature verification calls and distinguish the 64-entry cap and one-check-per-trusted-key
  behavior without a timing assertion. The current test accurately admits that it cannot detect
  removal of the cap.
- Sweep the DML and account-keyed rate limiters in the periodic maintenance timer. Their internal
  maximum keeps memory bounded, so this is cleanup rather than a finding, but inactive keys otherwise
  remain until a limiter fills and performs its own sweep.

BLOCK
