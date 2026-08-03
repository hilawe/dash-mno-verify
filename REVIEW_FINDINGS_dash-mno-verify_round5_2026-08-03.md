# Adversarial review of round 5 fixes

Reviewed commit `993bc07`.

This review used only the supplied packet. I did not inspect the repository or run the tests. Line
numbers below refer to the individual files as presented in the packet. The packet omits the
circuits, proving code, adapters, and compiled public-signal metadata. Claims about what a proof
cryptographically binds are therefore identified as INFERRED.

## Findings

### F1 The packet cannot establish that B1 and B2 are closed

- Lens: architecture
- Severity: blocker
- Location: `CLAUDE.md:100`, `common/index.js:37`, `core/gateway.js:880`, `core/gateway.js:944`

READ. `CLAUDE.md`, which the review instructions name as the specification, still declares account
binding (B1) and context-scoped members roots (B2) open. It says both require changes to the committed
proving and verification keys and owner sign-off. The implementation comments instead describe both
findings as fixed. `common/index.js` says the account change is JavaScript-only and needs no circuit
change. The gateway now derives the signal hash from `(nonce, account)`, selects a members root store
by context, and compares the submitted public signals with those expected values.

INFERRED. If the committed circuits already bind the opaque `signalHash`, `root`, and `contextHash`
public inputs exactly as the verifier comments say, the JavaScript changes may be sufficient. The
packet does not include the circuits, `public.json`, verification-key provenance, or the owner
decision that the specification says is required. The opposite possibility is material. If the
committed artifacts do not enforce those inputs as assumed, the gateway can still grant a relayed
proof to the wrong account or accept membership across communities while its comments claim the
blockers are closed.

The concrete cost is that the release posture is internally contradictory on the two headline authorization
boundaries. An operator cannot tell from this packet whether the prototype still has two declared
blockers or whether the specification is stale. Treating the comments as proof of closure could put
an account-binding or cross-community grant defect into service.

The specific fix is to reconcile the specification and the artifact evidence before representing either
finding as closed. If the existing circuits already bind the three opaque public inputs, record that
decision in `CLAUDE.md`, include the compiled public-signal layout and artifact hashes in the evidence
map, and record owner sign-off. If they do not, keep B1 and B2 open until the circuit changes and
re-setup are complete.

To confirm this, compare the committed circuit declarations and compiled `public.json` files with
`SIGNAL_INDEX` and `REG_SIGNAL_INDEX`, verify the loaded verification keys were produced from those
circuits, and run negative proofs that hold the proof fixed while changing only the authenticated
account or the community context. Confirm the owner-approved artifact lineage. Until then, the proof
binding is an inference from verifier-side signal handling.

### F2 The two-tier post-proof guard reads the regression flag before sampling the season

- Lens: correctness
- Severity: major
- Location: `core/gateway.js:990`

READ. `stillCurrent()` calls `timeGuard.epoch()`, reads `timeGuard.regressed`, and only then calls
`timeGuard.season()` inside the two-tier branch. `TimeGuard.regressed` changes only when `epoch()` or
`season()` observes a lower period. The refresh path can advance the durable season mark through
`timeGuard.season()` at `core/gateway.js:561` without rolling `SeasonMembers`, because the rollover
uses a separate timer.

INFERRED. A clock can move forward across a season boundary, be observed by a refresh, and then move
back while a verification is in progress. If that correction does not also cross an epoch boundary,
the epoch sample leaves `regressed` false. The later season sample detects the rollback, but the code
does not read the flag again. When the observed season equals the challenge's old season and the
members cache has not yet rolled, the season comparison and root-store identity comparison both pass.
That request can grant once even though the sticky clock guard has just detected a regression. Later
requests refuse.

The concrete cost is that a past-season members tree can authorize a grant during the exact rollback window the
durable clock marks were added to close. The condition is narrow, but it violates a security
invariant rather than only degrading availability.

The specific fix is to sample every period that matters before reading the sticky flag. Capture the live epoch
and, in two-tier mode, the live season first. Then check `timeGuard.regressed`, followed by the epoch,
season, root-store identity, and root eligibility comparisons. Do not place any new observation after
the final regression check.

To confirm this, inject a controllable clock and drive a two-tier verification whose proof callback
does the following in order.

1. Advance across a season boundary without crossing an epoch boundary.
2. Let the refresh-side season observation raise the high-water mark without rolling the members
   cache.
3. Move the clock back to the challenge season before `stillCurrent()` runs.

The result must be `clock-regressed`, no nullifier may be written, and deleting the season sample or
moving it below the flag read must fail the test.

### F3 A complete JSON record without its final newline survives the torn-tail repair

- Lens: correctness
- Severity: major
- Location: `core/registration_store.js:250`

READ. The loader treats a missing final newline as recoverable only when `JSON.parse()` throws. If the
last append wrote the complete JSON object but stopped before writing `\n`, parsing succeeds. The code
remembers that record, sets no truncation offset, and leaves the file without a delimiter. The next
append opens the file in append mode and writes the next JSON object immediately after the first one.

INFERRED. The resulting line has the form `}{...}\n`. The following process refuses it as malformed
because it now ends in a newline and is no longer a torn-tail candidate. The first recovery lifetime
therefore appears healthy, while the next successful registration recreates the permanent boot
failure that this fix was meant to remove. The record may also be reconstructed as committed even
though the interrupted writer never completed its append and sync sequence.

The concrete cost is that an ordinary crash at the one-byte boundary before the newline can make a later
registration poison all subsequent two-tier boots until an operator edits the durable registration
file.

The specific fix is to handle every non-empty final line in a file that lacks a trailing newline, not only an
unparseable one. Under the stated correct-writer model, either truncate that final line to the last
complete newline or validate it and durably append the missing newline before any writer runs. The
first option preserves the rule that an append not completed and synced was never committed. Keep the
byte-offset calculation and perform the repair before populating durable in-memory state from that
line.

To confirm this, seed a schedule header and one complete registration record with no final newline.
Open the backend, append another valid record, close it, and reopen it. The reopened store must contain
the intended records and must not reject the concatenated line. Repeat the case with a header that is
complete but lacks its newline. The existing torn-tail test covers only invalid JSON and will not catch
this boundary.

### F4 The Platform schedule marker is neither atomic nor durable

- Lens: architecture
- Severity: major
- Location: `core/gateway.js:248`

READ. When no marker exists, the gateway creates the directory and calls `writeFile()` directly on
`MNO_PLATFORM_SCHEDULE_PATH`. It does not use exclusive creation, a temporary file, `fsync`, an atomic
rename, or a directory sync. It writes the marker before the Platform connection succeeds. The clock
mark code elsewhere in the same packet explains why a rename without flushes is insufficient for
security state. The Platform test at `test/gateway_http.test.js:1664` does not set a temporary marker
path. Its asserted boot writes the default `data/platform_schedule.json`, then intentionally fails on
missing Platform configuration.

INFERRED. A crash or power loss can leave the marker missing or truncated. A missing marker lets a
later schedule assertion become the new first assertion, defeating the local pin. A truncated marker
refuses every later boot on JSON parsing. Two simultaneous first boots can both read `ENOENT`, write
different schedules, and proceed, with the last write deciding what the file later says. The included
test can also create or alter deployment-shaped state in the repository instead of remaining isolated
under its temporary directory.

The concrete cost is that the new guard can either fail open on a later schedule change or fail closed
permanently after an interrupted first assertion. Concurrent starts can use differently numbered
epochs against the same Platform records. Running the test suite can seed the default marker and make
a later local deployment refuse for state created by a test.

The specific fix is to move marker handling into a small store with atomic, durable, concurrency-safe creation.
Create a same-directory temporary file with mode `0600`, flush it, atomically publish it, flush the
directory, and resolve concurrent creation by rereading and comparing the winner. Do not silently
overwrite an existing marker. Give every integration test its own
`MNO_PLATFORM_SCHEDULE_PATH` under the test's temporary directory and verify that cleanup removes it.

To confirm this, test restart after creation, a different schedule on the second start, injected
failure after each write step, and two concurrent first writers with different schedules. Exactly one
schedule may win, and neither process may enter Platform mode under the losing schedule. After the
integration test, assert that no marker exists under the repository's default `data` path.

### F5 The signature-cap boot guard rejects valid quorum configurations

- Lens: correctness
- Severity: major
- Location: `core/config.js:293`

READ. Snapshots are accepted once `oracleQuorum` distinct trusted signatures verify. A snapshot is
refused only when its `sigs` array exceeds `MAX_SNAPSHOT_SIGS`, which is 64. The new boot guard instead
rejects whenever the number of pinned public keys exceeds 64, even when the configured quorum is much
smaller.

INFERRED. A deployment may legitimately pin 65 or more eligible signers and require, for example, 3
of them. A valid snapshot needs only 3 signature entries, so the 64-entry response cap does not make
that quorum unreachable. The boot check nevertheless refuses ordinary correct operation. The comment
that a snapshot needs one signature per trusted key contradicts the verifier, which needs only the
quorum.

The concrete cost is that expanding the eligible signer pool past 64 causes a full gateway outage even though
every accepted snapshot remains below the work cap and can satisfy the configured quorum.

The specific fix is to validate `oracleQuorum <= MAX_SNAPSHOT_SIGS`, not
`oraclePubkeys.length <= MAX_SNAPSHOT_SIGS`. Keep the existing check that quorum does not exceed the
number of trusted keys. If iteration over a very large trusted-key set also needs a bound, give that
separate resource limit its own setting and error message rather than deriving it from the snapshot
signature count.

To confirm this, configure 65 distinct trusted keys, quorum 3, and a snapshot signed by any 3 of them.
The gateway must boot and adopt it. A configuration with quorum 65 and a 64-signature cap must refuse.
No included test exercises either boundary.

### F6 A shared-bucket refusal now consumes the account bucket

- Lens: correctness
- Severity: minor
- Location: `core/gateway.js:875`, `core/gateway.js:934`

READ. The challenge and verify handlers charge the per-account limiter first, then charge the shared
source limiter. This fixes the previous direction, where an account-level refusal consumed the shared
bucket. It creates the inverse behavior. A request accepted by the account limiter but refused by the
already-full shared limiter still consumes one account allowance. The fairness test at
`test/gateway_http.test.js:1545` covers only the old direction.

INFERRED. When the shared adapter bucket is exhausted, quiet users who retry can spend their own
allowances on requests that were never served. Their account windows start at their first retry and
can extend beyond the shared window's reset, leaving them rate-limited after aggregate capacity has
returned. The nonce is preserved on verify, but the user's ability to submit it is not.

The concrete cost is that aggregate congestion can turn into a per-user outage lasting up to another rate-limit
window. The fairness subdivision is therefore not transactional in either direction.

The specific fix is to make the hierarchical limit decision atomic. Add non-mutating availability checks plus
a commit step, a reservation with rollback, or one combined limiter that charges both keys only when
both have capacity. Preserve the rule that neither bucket is charged for a request refused by the
other.

To confirm this, exhaust the shared bucket with other accounts, send attempts for a fresh quiet
account, let only the shared window reset, and verify that the quiet account can proceed immediately.
Mutating either order to charge one bucket on the other's refusal must fail the test.

### F7 The post-proof clock test does not exercise the gateway clock hook

- Lens: architecture
- Severity: minor
- Location: `test/verifier_idempotent.test.js:152`

READ. The verifier tests inject a `stillCurrent` callback that directly returns a refusal once their
stubbed proof changes a Boolean. They establish that `verifyMembership()` calls the hook in the right
places. They do not execute the gateway callback at `core/gateway.js:990`, instantiate `TimeGuard`, or
sample either clock period. The HTTP tests cannot reach the callback because they use policy-invalid
signals and no real proof.

INFERRED. Removing `timeGuard.epoch()` from the gateway callback, moving the regression read above all
observations, or retaining the season-order defect in F2 leaves every included period test green. The
test suite therefore repeats the boundary problem described in the review preface. It tests the hook
contract while not testing the code that decides the hook's answer.

The concrete cost is that the exact regression fixed in item 2 can return without any included test failing, and
the two-tier sibling already does so.

The specific fix is to extract the gateway's period decision into an importable function that accepts the
guard, pending challenge, mode, season state, root store, and public signals. Unit-test real
`TimeGuard` observations through that function. Keep the verifier hook tests as separate coverage of
call placement.

To confirm this, mutation-check the tests by deleting each `epoch()` and `season()` observation and by
moving the sticky-flag read above them. Every mutation must fail for the corresponding mode.

## Test assessment

The structural source-text tripwire at `test/root_windows.test.js:376` is acceptable as an explicit
short-term regression alarm, because it targets a mutation that two behavioral-looking tests did not
observe and the comment states its limits. It is also an architecture smell. A test that imports
`gateway.js` starts a server, so source matching is compensating for a module boundary that prevents
behavioral testing.

The tripwire catches removal or obvious replacement of `snapshot: normalizeSnapshot(...)` at the
current call site. It does not prove that the matched code runs, that no second raw adoption path
exists, that the normalized result is not mutated later, or that `normalizeSnapshot()` is the value
retained in every branch. It can also pass on matching dead code or a matching comment and can fail on
an equivalent refactor. The direct unit test of `normalizeSnapshot()` helps with the function's shape,
but it does not close those call-path gaps.

The torn-tail test is non-vacuous for malformed JSON, but it omits the valid-JSON, missing-newline
boundary in F3. The signature tests do not exercise the relation between signer-pool size, quorum,
and the response cap in F5. The Platform test proves only that the named assertion passes the first
guard. It does not verify a durable restart refusal under a changed schedule, and it writes through
the default marker path.

## Opportunities

- Refactor gateway construction into an importable handler or application factory. Keep `listen()` in
  a thin executable entry point. This would replace the structural normalization tripwire and the
  missing period-hook coverage with behavioral tests.
- Replace the manually maintained `ALL_LIMITERS` array with a limiter factory or registry that adds
  every constructed limiter automatically. All current limiters are present, but the comment that a
  future limiter joins the sweep "by construction" is stronger than the code. A new declaration can
  still be omitted from the list.
- Validate and compile `MNO_REGISTER_CONTEXTS` into a `Set` before loading verification keys or opening
  the registration file. This makes the new boot refusal fail earlier and turns each hot-path
  allowlist lookup from a linear scan into a direct membership check.
- Remove the duplicate `platformSchedulePath` property in `core/config.js`. It is behaviorally
  harmless while both expressions are identical, but it makes later edits order-dependent.

BLOCK
