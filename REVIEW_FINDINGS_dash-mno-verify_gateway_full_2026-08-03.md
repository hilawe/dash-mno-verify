# Gateway full-round adversarial review

This is a fresh full review of the requested gateway surface at commit `2c73d1f`. I read
`CLAUDE.md`, `docs/DESIGN.md`, and `docs/DEPLOY.md` first. I then read every scoped implementation
file and its tests. I inspected only the adapter call sites needed to test the gateway's client-address
assumption.

The evidence labels below distinguish direct code facts from operational conclusions.

- `READ` means the behavior follows directly from the cited code.
- `CONFIRMED` means I also reproduced the state transition or measured the cost with a focused probe.
- `INFERRED` means the consequence depends on deployment behavior stated in the finding.

## Lens 1 correctness, edge cases, and security

### B1 Two-tier memory mode drops the durable clock guard while keeping durable registrations

- Lens: 1, correctness and security
- Severity: blocker
- Location: `core/gateway.js:73`, `core/gateway.js:126`, `core/gateway.js:527`,
  `core/gateway.js:531`, `core/gateway.js:547`, `core/registration_store.js:186`,
  `core/registration_store.js:311`
- Evidence: READ. `MNO_STORE=memory` always gives `TimeGuard` a null path. In two-tier mode the gateway
  still constructs `FileBackend`, reloads its historical season records, and rebuilds the season named
  by the unpersisted clock. The Platform guard does not exclude the memory combination.
- Concrete cost: A two-tier gateway can finish season N, restart after a backward clock step into
  season N-1, and rebuild N-1's members tree without detecting the regression. Members whose season
  ended can prove again. This violates the stated rule that a past-season root stops verifying. The
  explicit ephemeral-nullifier opt-in does not disclose or authorize revival of durable registrations.
- Fix: Persist `MNO_TIME_MARKS_PATH` whenever two-tier mode uses `FileBackend`, regardless of the
  nullifier backend. If a fully ephemeral two-tier mode is wanted, wire `MemoryRegistrationBackend`
  behind a separate explicit option and make both stores and the clock guard ephemeral together. Add
  a restart test that seeds a prior-season registration and a higher durable season mark, then starts
  with `MNO_STORE=memory` and a lower clock and requires a refusal.

### M1 A registration can commit after its season has ended

- Lens: 1, correctness
- Severity: major
- Location: `core/gateway.js:770`, `core/gateway.js:771`, `core/gateway.js:772`,
  `core/gateway.js:788`, `core/gateway.js:557`, `core/season.js:124`, `core/season.js:127`
- Evidence: READ and CONFIRMED. The handler samples the season before proof verification. `commit()`
  later compares that value only with `SeasonMembers.current`, which is cached state. It does not
  sample the clock. The background rollover runs only once per minute. A focused small-depth probe
  advanced the external season after `ensure(0)` and before `commit(0, ...)`. The commit returned
  `ok: true` and wrote the season-zero record while the external season was one.
- Concrete cost: A proof started near a boundary can receive a successful registration response and
  persist an already-expired record. The member has paid the heavy proving cost and may mark the local
  secret accepted, but the next request rolls the tree forward and makes that membership unusable.
- Fix: Sample the guarded season again inside the serialized commit, immediately before the durable
  append. If it differs, roll the cache forward and return `season-rolled-retry` without writing. Test
  the boundary by holding the injected proof verifier, advancing a fake clock, and then releasing it.

### M2 Unsigned snapshot fields are retained throughout the root window

- Lens: 1, safety and resource exhaustion
- Severity: major
- Location: `core/gateway.js:246`, `core/gateway.js:353`, `core/gateway.js:483`,
  `core/gateway.js:494`, `core/stores.js:107`, `core/stores.js:123`, `core/stores.js:131`
- Evidence: READ and CONFIRMED. Snapshot validation does not reject unknown properties. The signature
  message ignores them. After verification, the gateway stores the original parsed object as
  `snapshot: o`, and `RootWindows` retains it at every height. A serving host can append a large
  `padding` property to a legitimately signed snapshot without invalidating its signature. A direct
  store probe with eight 15 MB padding strings retained 114.4 MiB of padding and raised resident memory
  by about 157.7 MiB. The network loader permits up to 16 MB per response, and coexistence can retain
  two records per height.
- Concrete cost: A host that possesses no signing key can turn each valid snapshot into persistent
  window memory. At the default eight-height window this is roughly 128 MB of attacker-chosen payload,
  or roughly twice that while both orders coexist, before object overhead and normal gateway state.
- Fix: After schema and signature checks, construct a new normalized snapshot containing only the
  fields `/v1/dml` needs. Copy the validated leaves and discard signatures and every unknown property
  before adoption. Reject unknown top-level fields as defense in depth.

### M3 The signature precheck permits attacker-chosen synchronous verification work

- Lens: 1, safety and denial of service
- Severity: major
- Location: `core/gateway.js:246`, `core/gateway.js:363`, `core/gateway.js:364`,
  `core/gateway.js:366`, `core/gateway.js:367`, `core/stores.js:239`
- Evidence: READ and CONFIRMED. `sigs` has no count bound. For every trusted key, the gateway scans the
  entire array and synchronously verifies each candidate until one passes. The signed entries already
  carry a key label, but the verifier ignores it. On this host 10,000 invalid Ed25519 checks took about
  1.28 seconds. A response under the 16 MB body cap can carry far more, and the work multiplies by the
  number of pinned keys.
- Concrete cost: A compromised snapshot host that cannot forge a quorum can still block the Node.js
  event loop during boot and every refresh. This reverses the purpose of checking the quorum before
  the expensive tree rebuild.
- Fix: Validate an exact signature-entry schema, index entries by their canonical `key`, reject
  duplicates, and verify at most one signature for each trusted key. Bound the array by the number of
  configured keys before any cryptographic check.

### M4 Authenticated adapter traffic shares one rate-limit bucket

- Lens: 1, availability and load shedding
- Severity: major
- Location: `core/gateway.js:84`, `core/gateway.js:114`, `core/gateway.js:647`,
  `core/gateway.js:648`, `core/gateway.js:693`, `adapters/discord/bot.js:527`,
  `adapters/telegram/bot.js:95`, `adapters/matrix/bot.js:64`, `adapters/web/server.js:131`
- Evidence: READ. Challenge and verify apply the limiter before reading the account and key it only by
  the socket or proxy address. Every shipped adapter makes the request itself and sends no originating
  client address. The gateway therefore sees the bot or web adapter as the client for every user.
- Concrete cost: One web visitor can issue 60 start requests quickly and deny challenges to every
  other visitor behind that adapter for the rest of the window. The same coupling exists for proof
  submissions. Co-located adapters can also block one another because they share a source address.
- Fix: After authentication and bounded body parsing, key the account-bearing limits by the normalized
  account and context, with the adapter source as an additional namespace. Keep a separate global
  limiter and the verification semaphore for aggregate protection. Do not forward or trust a user
  supplied Internet Protocol address from the bot.

### M5 A valid member can allocate unbounded context trees

- Lens: 1, safety and resource exhaustion
- Severity: major
- Location: `core/gateway.js:759`, `core/gateway.js:766`, `core/gateway.js:769`,
  `core/gateway.js:788`, `core/season.js:39`, `core/season.js:79`, `core/season.js:86`,
  `core/season.js:141`
- Evidence: READ and CONFIRMED. Registration is public and accepts any platform, community, and role
  tuple. The proof binds the caller-selected context but does not show that the gateway serves it.
  Each successful new context creates a permanent entry in the current season's `ctx` map. The full
  tree cost is measured separately under Lens 2.
- Concrete cost: A masternode holder can precompute valid registrations for arbitrary contexts and
  grow memory, durable newline-delimited JavaScript Object Notation (JSON) storage, and commit work
  without bound. The once-per-context
  nullifier does not help because the attacker chooses a fresh context each time. The per-address rate
  limit slows the attack but does not bound its total state.
- Fix: Admit only configured context hashes, or require a short-lived accountless context ticket signed
  by an authenticated adapter. Put an explicit bound on active context caches and reject a new context
  before proof verification when the bound is reached.

### M6 Platform nullifiers are not bound to the epoch schedule

- Lens: 1, domain-state correctness
- Severity: major
- Location: `core/gateway.js:43`, `core/gateway.js:156`, `core/gateway.js:164`,
  `core/gateway.js:193`, `core/platform_store.js:19`, `core/platform_store.js:23`,
  `core/platform_store.js:38`, `common/index.js:63`
- Evidence: READ. The gateway computes `SCHEDULE` and passes it to SQLite and the registration file.
  `DocumentNullifierStore` receives no schedule and stores only epoch, context hash, and nullifier.
- Concrete cost: Changing `MNO_EPOCH_SECONDS` lets the same voting key produce a claim in the new
  epoch numbering while an old-schedule account grant can still be live, so two accounts can overlap.
  If the new epoch number collides with one used under the old schedule, an immutable Platform record
  instead denies the legitimate claim for the whole new epoch. Both local durable stores fail at open
  rather than reinterpret their data, but Platform mode silently does so.
- Fix: Pass the schedule identity into the Platform backend and require a durable contract marker that
  exactly matches before any read or write. If the deployed contract cannot represent that marker,
  refuse Platform mode until the contract is migrated. Add a backend contract test that reopens shared
  state under a different schedule and requires a hard failure.

### m1 Health reports ready when single-tier verification has no root

- Lens: 1, correctness and observability
- Severity: minor
- Location: `core/gateway.js:827`, `core/gateway.js:830`, `core/gateway.js:831`,
  `core/gateway.js:839`, `core/gateway.js:841`
- Evidence: READ. The comment defines `ok` as readiness, but the value depends only on clock regression.
  In single-tier mode it remains true when `dmlRoot` is null and every challenge returns 503.
- Concrete cost: A readiness probe can keep routing users to an instance that cannot issue or verify
  memberships, hiding an oracle outage behind a healthy status.
- Fix: Make readiness capability-specific. At minimum, single-tier `ok` must require a current
  deterministic masternode list (DML) root. Prefer explicit `canChallenge`, `canVerify`, and
  `canRegister` booleans because two-tier mode
  can verify existing members while registration is unavailable.

## Lens 2 architecture, efficiency, and maintainability

### A1 Every members-root update rebuilds a full depth-16 tree on the event loop

- Lens: 2, architecture and efficiency
- Severity: major
- Location: `core/members_tree.js:78`, `core/members_tree.js:82`,
  `core/members_tree.js:84`, `core/members_tree.js:94`, `core/season.js:79`,
  `core/season.js:84`, `core/season.js:141`, `core/season.js:143`
- Evidence: READ and CONFIRMED. `levels()` pads to 65,536 leaves and computes 65,535 internal hashes
  after every append. A new context first builds an empty full tree in `_materializeFrom`, then
  invalidates it and builds another after append. On this host one root took about 9 seconds. A complete
  first-context commit took 19.6 seconds and retained about 32.7 MiB of heap for 131,071 cached nodes.
- Concrete cost: One ordinary first registration blocks every Hypertext Transfer Protocol (HTTP)
  handler for about 20 seconds on the measured host. Repeated valid registrations can keep the process
  unavailable. Latency stays proportional to fixed tree capacity rather than the number of changed
  leaves, and all context commits also share the season serialization queue.
- Fix: Keep an incremental Merkle frontier and update only the 16 nodes on the appended leaf's path.
  The gateway does not generate member paths, so it only needs commitments for `/v1/members`, the
  frontier for the next append, and recent roots for verification. Rebuild the frontier from durable
  commitments once on lazy load, then append in O(depth).

### A2 The registration store retains and rescans every historical season

- Lens: 2, right-sizing and maintainability
- Severity: minor
- Location: `core/registration_store.js:175`, `core/registration_store.js:178`,
  `core/registration_store.js:194`, `core/registration_store.js:218`,
  `core/registration_store.js:253`, `core/gateway.js:408`, `core/gateway.js:409`
- Evidence: READ. `FileBackend` loads every newline-delimited JSON record into `seen` and `byBucket` forever.
  `seasonHasEngine` linearly scans the full bucket map, and the refresh loop calls it every refresh in
  two-tier mode when the static Secure Hash Algorithm 256-bit (SHA-256) root flag is off.
- Concrete cost: Disk, boot memory, boot time, and refresh work grow with all registrations ever
  accepted, even though the monotonic clock forbids serving past seasons. A long-lived gateway pays
  repeatedly for state it cannot use.
- Fix: Maintain a per-season engine index and compact expired seasons after the durable high-water mark
  advances. SQLite is already a project dependency through Node.js and would simplify unique inserts,
  indexed current-season reads, pruning, and single-writer enforcement.

The policy-check order, authoritative nullifier insert, paired Poseidon and SHA-256 root window, and
registration record as durable commit point are otherwise sound in the reviewed paths. I found no
current consumer that mutates a retained snapshot or its leaves. The resource bug is that the raw
object is retained, not that an existing consumer changes it.

## Lens 3 opportunities

### IDEA Exact DML lookup by challenged root

- Idea: Let `/v1/dml` accept a retained Poseidon root and return the normalized snapshot stored in that
  exact `RootWindows` record. Use the root as an entity tag so clients and reverse proxies can cache the
  large response.
- Value: The gateway already retains the needed snapshots. This removes the documented challenge to
  DML refresh race, avoids needless re-challenges during changeover, and reduces repeated serialization
  and transfer of unchanged leaf arrays.
- Rough effort: Small to medium. Add a lookup method, validate the query as a canonical field element,
  return 404 or 410 once it leaves the window, and cover refresh-between-requests behavior.
- Assumption: A retained root identifies the ordered Poseidon tree. This is the same collision-resistance
  assumption the proof system already uses.

### IDEA Generated state-machine tests for clock and commit interleavings

- Idea: Build a small in-process gateway service with injected clock, proof verifier, and stores, then
  generate sequences of challenge, verify, register, rollover, refresh, failure, and restart events.
  Assert invariants after every event, including no commit under a sampled past season, no accepted root
  without matching leaves, and no durable spend without its paired record.
- Value: Existing tests cover named interleavings but missed the case where wall time advances without
  an explicit `ensure()` call. A state model tests the absence of bad sequences rather than only the
  examples already imagined.
- Rough effort: Medium. Most dependencies are already injectable below the HTTP module. The main work
  is extracting boot and handler state from the module-level server so tests do not need child processes
  or real sockets.
- Assumption: None beyond preserving the existing external HTTP contract.

## Test evidence

All non-network test files passed. The repository's full `npm test` command could not complete in this
sandbox because loopback binds are prohibited. The 70 gateway and loader tests that open
`127.0.0.1` failed with `listen EPERM`. I treated those as unexecuted due to the environment, not as
code failures. Focused probes confirmed the stale-season commit, the members-tree time and memory cost,
the signature-verification amplification, and the root-window retention cost.

BLOCK
