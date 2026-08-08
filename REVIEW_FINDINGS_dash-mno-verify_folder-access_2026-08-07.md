# Folder-access adversarial review of dash-mno-verify

## Scope and verdict

This review covers the repository at commit `e1099f8`, including the X11 reference harness and the fixes committed during the review window. I inspected the implementation, tests, fixtures, and current Git diff from `8d71fe0`. I did not modify the repository.

The earlier X11 evidence blocker is resolved in substance. The repository now contains a buildable Dash Core reference harness, a deterministic vector generator, and a seeded differential runner. The current implementation still has four major correctness or resource-boundary defects. Two were reproduced directly against the current commit.

REQUEST-CHANGES

## Blockers

None.

## Majors

### M1. A failed recovery read leaves every public store view behind durable state

- Location: `core/registration_store.js` lines 258 through 278, 471 through 473, and 584 through 597
- Impact: `has()`, `forSeasonContext()`, `declarationFor()`, and `seasonHasEngine()` can answer from a view known to be stale after the retry durability barrier succeeded. The zero-knowledge virtual machine (zkVM) downgrade signal can therefore return false even though the file durably contains a zkVM registration.
- Cause: `#reload()` sets `#stale = true` when reconciliation fails. Only `#appendOne()` checks that flag. Every read method calls `ready()`, which returns the old resolved promise restored by `#reload()`, then reads the old maps without reconciliation or refusal.

I reproduced the exact uncertain-write sequence. The first sync failed after the complete record was written. The recovery path reopened the file and successfully synced it, which made the record durable. I then made only the recovery read fail. The append reported the original error, while the file contained the zkVM record. The same backend returned all of the following.

- `has(...)` returned false.
- `seasonHasEngine(..., "zkvm")` returned false.
- `forSeasonContext(...)` returned an empty array.

This contradicts the comment that the next operation reconciles and breaks the stated rule that the downgrade decision considers durable declarations. A shared `#reconcileIfStale()` guard should run before every public read and append. If reconciliation still fails, the operation must fail closed instead of answering from the old maps.

The current test named `a reload that fails leaves the store as usable as it was` does not exercise this path. It fails the first `ready()` call on a new backend. A regression test needs a successful initial load, an uncertain append, a successful retry sync, a failed recovery read, and then each public read method.

### M2. The JSON-RPC path has no response-size bound

- Location: `oracle/node_client.js` lines 28 through 64
- Impact: A buggy or malicious configured node can make the gateway buffer and parse an arbitrarily large response. This can exhaust memory or block the event loop before the deterministic masternode list (DML) checks run.
- Cause: `maxBuffer` is applied only to `execFileSync()` in the `dash-cli` path. The fetch path calls `res.json()`, which buffers the whole response. The exported 64 MiB default and the comments describe a shared bound that the JSON-RPC path does not have.

I passed `maxBuffer: 1` with a fake JSON-RPC response containing 1,024 bytes. `makeNodeCall()` returned the entire value. No test imports `makeNodeCall()` or checks the remote path's byte limit.

The response body must be read as a stream under the same byte cap used by the command-line path, then parsed. The abort should occur as soon as the received byte count crosses the limit. `buildDiffSnapshot()` should also cap `mnList` before validation and commitment work, and `partialMerkleTree()` should reject `nHashes` above the number of nodes the declared tree can contain before allocating the array.

### M3. `RootWindows.adopt()` does not enforce the root-to-snapshot invariant it claims

- Location: `core/stores.js` lines 144 through 195
- Impact: A caller can store one advertised root beside another snapshot's leaves. The gateway can then mint a challenge for a root whose served snapshot cannot build a proof for it.
- Cause: The method rejects extra keys in `snapshot`, but it accepts `height`, `root`, `shaRoot`, `ts`, and `blockHash` as separate arguments. It never compares those values with the normalized snapshot and never recomputes the roots from `snapshot.leaves`.

I passed a normalized snapshot whose root was `snapshot-root` and supplied `root: "advertised-root"` to `adopt()`. The store accepted it and returned a current record containing both different values. The production gateway currently supplies matching fields, so this is not reachable through the present call site. It still disproves the store-level invariant that the tests and comments say protects every route in.

Make the normalized snapshot the single source of retained fields, or compare every duplicated field and require the recomputed roots before storing it. Add a test that crosses two otherwise valid normalized snapshots.

### M4. The durable registration loader accepts parsed JSON without validating a record

- Location: `core/registration_store.js` lines 317 through 390 and 463 through 469
- Impact: Syntactically valid corruption can enter the member cache, bind a bucket to an impossible engine and statement, or cause a later tree materialization to fail instead of refusing the file at startup.
- Cause: Every parsed non-schedule value is passed to `#remember()`. The loader does not validate the required fields, canonical scalar forms, declaration pair, or record type.

I loaded a record with an object-valued commitment, engine `bogus`, statement `bogus`, and index 999. `ready()` succeeded and `forSeasonContext()` returned it unchanged. The comments distinguish a recoverable torn tail from corruption in the middle, but the refusal applies only to invalid JSON syntax.

Normalize and validate each loaded record before duplicate handling. Legacy records may receive the documented PLONK derive defaults. The in-memory index should be derived from bucket order rather than trusted from the file, since the implementation already treats stored index differences as recoverable metadata.

## Minors

### N1. The partial merkle parser accepts noncanonical CompactSize encodings

- Location: `oracle/dml_commitment.js` lines 230 through 243
- Impact: The test and comments claim one accepted encoding for a commitment, but the same tree is accepted under more than one byte representation.
- Reproduction: I replaced the fixture's one-byte hash count with the equivalent `0xfd` plus 16-bit encoding. `partialMerkleTree()` accepted it and produced the same root.

Reject a 16-bit form below `0xfd`, a 32-bit form at or below `0xffff`, and a 64-bit form at or below `0xffffffff`. Add those mutations to the test named `one commitment has exactly one accepted encoding`.

### N2. Malformed IPv6 groups alias valid service bytes

- Location: `oracle/dml_commitment.js` lines 50 through 68
- Impact: The serializer accepts malformed remote procedure call data while its surrounding boundary claims malformed fields refuse.
- Reproduction: `serviceBytes("[1g::]:9999")` returned the same bytes as `serviceBytes("[1::]:9999")` because `parseInt()` accepted the valid prefix. Non-hex groups can also be coerced to zero, and values wider than 16 bits are masked.

Require each explicit group to match one through four hexadecimal digits, reject more than one `::`, and reject unsupported embedded IPv4 forms explicitly.

### N3. The X11 reference source is pinned by a mutable tag rather than its recorded commit

- Location: `tools/x11-reference/PIN`, `tools/x11-reference/Dockerfile`, and `tools/x11-reference/build.sh`
- Impact: A clean rebuild at a later date is not guaranteed to compile the same source recorded in the vectors if the upstream tag moves.
- Cause: `PIN` contains `v23.1.3`, and the container clones that tag. The vectors record commit `8f06d39897babc4c4d28598af9426f483e3c5596`, but the build does not require that commit.

Pin the commit identifier as the build input and retain the tag as descriptive metadata. At minimum, compare the cloned commit with an expected commit and fail the image build on a mismatch.

### N4. The direct-node startup warning contradicts the implemented trust model

- Location: `core/gateway.js` lines 531 through 537
- Impact: The operator-facing warning says the mode is a trusted-node read and then says it becomes chain-authenticated when the DML commitment check exists. That check now exists, but the ChainLock signature and height-specific difficulty are still not verified.

The warning should say that the commitment check proves internal agreement with the supplied header, while the configured node remains trusted to identify the ChainLocked chain block. This matches the more accurate comments in `oracle/diff_snapshot.js`.

## X11 evidence assessment with repository access

The evidence position is materially better than the inline packet described.

- The 110 per-round vectors can now be regenerated from Dash Core's own X11 sources at the configured upstream revision.
- The seeded differential runner compares every round across targeted padding boundaries and random inputs from 0 through 300 bytes.
- Eleven integrated cases cover linked mainnet headers from heights 1 through 2,516,624.
- The ordinary test suite checks every committed vector and all eleven integrated block identifiers.

The per-round cases establish agreement with the pinned reference on their fixed inputs. The differential runner extends that comparison across input lengths, but it is not part of `npm test` and must be run deliberately with a container. I could inspect it but could not rerun it because this review sandbox was denied access to the local Docker socket.

The real-block cases remain the only order-sensitive independent anchors. That is enough to pin the order once their header and expected identifier pairs are checked against a synced node or independent public chain source. An accidental wrong order has no practical chance of matching even one fixed 256-bit identifier.

The tests still overstate the word self-anchoring. A header that points to the public genesis identifier is not thereby authenticated as block 1. A fixture author can pair a fabricated header with an output produced by the same wrong implementation. The repository makes the cases externally checkable and records how to check them. The prose metadata test only proves that those instructions exist. It does not perform the external check.

The earlier statement that the reference was verified and the harness deleted would have been self-certification. That statement no longer describes this repository. The harness, generator, source recipe, seeds, and corpus strategy are now present and reviewable. Pinning the exact upstream commit would finish the reproducibility chain.

## Areas that held up

The X11 round implementations matched every committed reference vector and all eleven integrated block cases. The proof-of-work target conversion, endianness, and mainnet limit behaved correctly on the included real headers and hostile target cases.

The DML commitment path correctly binds the complete simplified masternode list to the coinbase payload, requires the supplied transaction at coinbase index zero, reproduces the header merkle root, names the header with X11, checks its declared work against mainnet's easiest consensus target, and compares the coinbase height with the reported ChainLock height. I found no way to alter a real committed voting key or validity flag while retaining the real header without a hash collision or preimage.

The configured-node residual is documented rather than hidden. The node can consistently replay an old real block or mine a synthetic header at the easiest permitted target because the gateway does not verify the ChainLock signature or expected difficulty at that height. Direct-node mode is therefore still a trusted-node mode. I treat that as an accepted architecture boundary for this review, not a newly discovered bypass.

The uncertain-write path now retries a durability barrier before reporting a recovered append as successful. The all-syncs-fail case correctly reports failure. Root pinning covers both pending challenges and in-flight verification, while the documented memory bound still wins when every retained height is pinned.

## Verification

- Focused security suite: 156 tests passed.
- Full suite: 594 tests passed, with no failures, skips, or cancellations.
- Repository checks: `git diff --check` passed.
- Direct probes: reproduced the stale durable-store view, missing JSON-RPC cap, root-to-snapshot mismatch, invalid registration record load, noncanonical CompactSize acceptance, and IPv6 alias.
- X11 reference container: not rerun because the sandbox could not access `/Users/hsemunegus/.colima/default/docker.sock`.

## Required actions

- Reconcile or refuse every registration-store operation while `#stale` is set.
- Apply the configured byte cap to streamed JSON-RPC responses and add structure-level count bounds.
- Make `RootWindows` derive retained scalar fields from one normalized snapshot.
- Validate and normalize durable registration records during load.
- Tighten CompactSize and IPv6 parsing.
- Pin the X11 reference by commit and correct the direct-node startup warning.

REQUEST-CHANGES
