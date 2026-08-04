# dash-mno-verify full-access paired review

Commit `8a18318`

## Scope and method

This is the source-only arm of the paired experiment. I reviewed only the files included in
`codexapp_dash-mno-verify_fullaccess-paired_2026-08-03.md`. I did not inspect the repository
checkout, run tests, execute the gateway, or measure memory and timing. No finding below depends on
the omitted circuits, adapters, or prover. Exact heap costs and filesystem failure reproduction need
execution, which this arm could not do.

The known open items named in the packet are not repeated.

## Findings

### Finding 1 [READ] The seeded recovery path retains the full Merkle tree

- Lens: resource lifetime and recovery behavior
- Location: `core/members_tree.js:191`
- Severity: major
- Concrete cost: `#seedFromFullBuild()` calls `levels()`, which assigns every padded level to
  `this._levels`, then extracts the frontier and root without clearing that cache. At depth 16 this
  keeps 65,536 leaves and 65,535 internal nodes alive after recovery. The branch starts at 4,096
  commitments. Each materialized large context can therefore retain 131,071 field-element objects
  and the containing arrays for its whole lifetime, even though the gateway never asks for sibling
  paths. This contradicts the stated design that full levels exist only for callers that need paths.
  The exact heap cost needs execution, but the retained object count follows directly from the code.
- Specific fix: after copying the needed frontier entries and root, set `this._levels = null`. Add a
  small-depth test that materializes through the full-build branch, then counts a fresh
  `capacity - 1` hashes when `pathFor()` is first requested. That test proves the recovery-only level
  arrays were released without relying on a private cache value.

### Finding 2 [READ] The Platform schedule marker rename is not durable

- Lens: durable security metadata
- Location: `core/gateway.js:271`
- Severity: major
- Concrete cost: the marker's temporary file is flushed before `rename()`, but the containing
  directory is never flushed after the rename. Under ordinary Unix durability rules, atomic rename
  does not make the directory entry durable across power loss. The marker can therefore disappear
  after a boot that recorded schedule A. If an operator later changes the period lengths and updates
  `MNO_PLATFORM_ASSUME_SCHEDULE` to schedule B, the missing marker is treated as first use and B is
  recorded over Platform documents created under A. Old nullifier documents are then interpreted
  under new epoch numbering, which can reopen a spent claim or deny a valid one. `TimeGuard` already
  contains the required post-rename directory-flush pattern, but this marker does not use it.
- Specific fix: flush the parent directory after the rename and fail startup if that flush is not
  available for a deployment that depends on this local assertion. Use a unique temporary filename
  or exclusive creation as well, so two gateway processes cannot share and rename the same `.tmp`
  file. Add a filesystem-operation test that asserts the order is temporary-file write, file flush,
  rename, then directory flush.

### Finding 3 [READ] A newly created registration file can lose acknowledged records

- Lens: registration durability
- Location: `core/registration_store.js:332`, `core/registration_store.js:383`
- Severity: major
- Concrete cost: initialization creates the schedule header with `appendFile()` and no flush. A
  later registration flushes the file contents, but neither path flushes the parent directory after
  creating the file. A host power loss can therefore remove the directory entry after a registration
  was reported successful. On restart, `ENOENT` is treated as a new empty store. The member
  disappears from the rebuilt tree, and the seasonal registration spend disappears with it. This
  breaks the stated property that an acknowledged durable registration survives restart.
- Specific fix: initialize the file through an opened handle, flush it, close it, and flush the
  parent directory before declaring the backend ready. If the directory was newly created, make its
  creation durable too. Keep the existing per-record file flush for later appends. Add a fault-point
  test around first-file creation and document that process-crash coverage is distinct from host
  power-loss durability.

### Finding 4 [READ] A post-write refusal permanently locks a Platform claimant out

- Lens: atomic claim outcome and retry behavior
- Location: `core/verifier.js:149`
- Severity: major
- Concrete cost: after `nullifiers.add()` records the spend, `periodStillCurrent()` can reject because
  the deterministic masternode list (DML) root aged out or was evicted during the Platform round
  trip. The caller receives no grant, but the spend remains. The included contract test states that
  the Platform backend does not persist the claiming account and never permits an idempotent
  re-grant. A new proof in the same epoch therefore reaches `has()`, cannot establish same-account
  ownership, and returns `already-used`. One legitimate member is denied for the rest of the epoch
  after a timing condition the member cannot control. The comment that the account can spend the
  same tag next time is true for local stores and false for Platform.
- Specific fix: do not enable the Platform claim path until its atomic record carries a
  privacy-preserving account owner that every gateway can compare for idempotent retry. One option is
  a keyed account commitment shared by the gateways rather than a public account identifier. If the
  document format cannot change, define root eligibility at write initiation for this backend and do
  not turn a completed unique insert into an ungrantable refusal solely because the root moved during
  that insert. Add a test that combines the existing Platform no-regrant behavior with a root change
  during `add()`.

### Finding 5 [READ] A live clock regression still makes `/v1/members` return 400

- Lens: diagnostic behavior and test validity
- Location: `core/gateway.js:1166`
- Severity: minor
- Concrete cost: the handler checks `timeGuard.regressed` before calling `timeGuard.season()`. The
  flag changes only when an observation runs. If the clock steps backward after startup, the first
  check is false. `season()` then records the regression inside `ensureContext()`, and the monotonic
  season guard throws. The outer handler converts that host-clock failure to Hypertext Transfer
  Protocol (HTTP) 400, still blaming the caller instead of returning the intended 503 diagnostic.
  The included test seeds a future mark before startup. Startup observes it and sets the flag before
  the request, so the test covers only an already-known regression and misses the live transition.
- Specific fix: observe both epoch and season before reading the sticky flag, return 503 when either
  observation detects regression, and pass the already-observed season to `ensureContext()`. Extend
  the test so the guard is healthy at startup and the clock moves backward immediately before the
  request.

### Finding 6 [READ] Re-signing does not deduplicate alternate key spellings

- Lens: signature-set canonicalization
- Location: `common/oracle_sig.js:162`
- Severity: minor
- Concrete cost: `addSignature()` promises one entry per key, but it removes an old entry only when
  the raw label string equals the canonical base64 label it generates. An existing base64url,
  unpadded, or otherwise accepted spelling of the same 32-byte key survives. The helper appends a
  second label for the same decoded key. The gateway canonicalizes labels and rejects two signatures
  for one key, so an ordinary re-sign operation can make the entire snapshot unusable.
- Specific fix: decode each existing label with `publicKeyFromRaw()`, canonicalize it with
  `rawPublicB64()`, and remove entries whose decoded key matches the signer. Add a unit test that
  starts with the signer's key in base64url form, calls `addSignature()`, and asserts that exactly one
  canonical entry remains and the gateway-side duplicate rule accepts it.

## Opportunities

- Add a migration test where a version 2 tip snapshot is followed by a version 3 best-ChainLock
  snapshot one block lower. The current height-regression rule rejects the latter. A test would force
  an explicit decision about whether a short ChainLock lag should wait, coexist under a checked leaf
  set, or require an operator-controlled cutover.
- Refresh `CLAUDE.md`. It still describes `members_tree.js` as non-incremental, omits the SQLite store
  from the store choices, and names B1 and B2 as open even though this packet presents their folded
  fixes. These are documentation discrepancies, not findings against the reviewed runtime paths.
- Remove the duplicate `platformSchedulePath` property in `core/config.js` and correct the nearby
  proxy comment that says first forwarded hop while the implementation and tests use the last hop.

APPROVE-WITH-FIXES
