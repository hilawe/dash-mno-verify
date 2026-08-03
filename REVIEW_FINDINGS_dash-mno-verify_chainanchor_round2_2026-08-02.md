# Chain-anchor adversarial review round 2

This review covers the chain-anchor packet for commit `df3b534`. I read only the source included in
the packet. I did not inspect the repository or treat omitted modules as evidence. Deterministic
masternode list (DML) behavior is assessed from the included gateway, stores, oracle builders,
signature code, and tests.

## Findings

### B1 An expired `latestDml` pointer disables live window guards

- Lens: correctness
- Severity: blocker
- Location: `core/gateway.js:351`, `core/gateway.js:394`, `core/gateway.js:404`,
  `core/gateway.js:429`, `core/gateway.js:613`, `core/gateway.js:758`,
  `core/stores.js:155`, `core/stores.js:173`

What I read is that the root window and `latestDml` are separate authorities. `dropOlderThan()`
removes records by their own timestamps. `enforceDmlFreshness()` then clears `latestDml` only when
that particular snapshot expires. Snapshot validation accepts any finite timestamp inside the age
and future-skew bounds. It does not require adopted timestamps to be monotonic. Both the height
regression refusal and the same-height coexistence refusal are conditional on `latestDml` being
non-null. `RootWindows.adopt()` does not enforce coexistence itself.

A sequence made entirely from snapshots that pass the included validation reaches the hole.

1. Adopt a version 2 snapshot at height H with timestamp T2.
2. Adopt a version 3 snapshot at the same height, block, and leaf set with an older but still-fresh
   timestamp T1. The coexistence check accepts it, and `latestDml` now points to this older record.
3. Let T1 cross the cutoff while T2 remains fresh. The version 3 record and `latestDml` are removed,
   but the version 2 record remains accepted in `dmlRoots`.
4. Present a fresh version 3 snapshot at H with a different block or leaf set. Because `latestDml`
   is null, the gateway skips `mayCoexist()` and adopts it beside the surviving version 2 record.

The concrete cost is that roots over inconsistent member sets can coexist and both pass the root
window. A member present in only one set can continue to prove, which is the exact outcome the
leaf-set commitment guard says it prevents. The split also causes an immediate serving error before
the fourth step. `/v1/challenge` mints against `dmlRoots.current()`, while `/v1/dml` returns null and
no leaves from the cleared `latestDml`. A lower-height snapshot can likewise bypass the rollback
check while a higher root remains in the window.

The fix should make one store authoritative for adoption, freshness, current snapshot data, and
conflict checks. Check height against the maximum retained height and check same-height candidates
against every retained record, regardless of a separate publication pointer. Keep the validated
leaves and version metadata with each window record, or keep an inseparable snapshot map keyed by the
same record key. Pruning must select the surviving current snapshot atomically. Rejecting timestamp
regression would reduce the reachable states, but it should not replace store-level enforcement.

Confirm this with a gateway test using three signed, internally consistent snapshots and staggered
timestamps as above. After the second snapshot expires, assert that the first snapshot still has a
usable `/v1/dml` response. Then submit a different-set version 3 snapshot at H and assert that it is
rejected and never becomes recent. Add a lower-height variant and assert that the retained maximum
height remains the adoption floor.

### M1 A fresh republish of the older order is treated as a conflict

- Lens: correctness
- Severity: major
- Location: `core/gateway.js:404`, `core/stores.js:155`

What I read is that a same-height candidate whose root differs from `latestDml.root` always calls
`mayCoexist()`. That method requires the candidate order to differ from every record already at the
height. After version 2 and version 3 coexist, a fresh republish of the exact version 2 root is checked
against both records. Its match with the stored version 2 order makes `every()` return false, so the
gateway rejects the republish and does not renew its timestamp.

The concrete cost is that the older-order root ages out even while the oracle is still publishing it.
Cached version 2 provers lose the transition window that the code says they retain until the oracle
stops publishing version 2. Once the old record is pruned, a later refresh can re-add it, so the
accepted set can disappear and reappear based on the age boundary and refresh timing.

The fix should distinguish replacement from coexistence. An exact same-order, same-root, same-block,
same-set republish should replace and refresh that record. A same-order candidate that changes any of
those values should refuse. Only records under the other order should take part in the coexistence
comparison.

Confirm this through the real refresh path with version 2, then version 3, then the same version 2
snapshot carrying a fresh timestamp. Assert that the version 2 record timestamp advances, both roots
remain recent, and the last adopted record becomes current without increasing the number of records
at the height.

### M2 The live legacy oracle still filters before validating its response

- Lens: correctness
- Severity: major
- Location: `oracle/snapshot.js:43`, `oracle/snapshot.js:63`

What I read is that the version 2 builder calls `Object.entries(list)` without first requiring the
remote procedure call (RPC) result to be a plain object keyed by collateral outpoint. It then filters
on `m.status === "ENABLED"` before validating any entry fields. An array is accepted and ordered by
its numeric indexes. A primitive entry or an entry with a missing or mistyped status is silently
dropped. A null entry reaches a raw property-access error. Only an entry that survives the filter has
its voting address checked indirectly by `votingAddressToLeaf()`.

This is the live twin of the boundary failures that the version 3 builder now refuses before its
validity filter. The concrete cost is a signed, self-consistent version 2 snapshot with a silently
shortened member set or an ordering that did not come from collateral outpoints. The gateway cannot
recover the omitted entries by recomputing the supplied root. The bad version 2 set can also make a
correct version 3 snapshot at the same height fail the leaf-set coexistence check, delaying the
chainlocked changeover.

The fix should validate the whole RPC response before filtering. Require a non-null, non-array object,
validate each collateral key, require every entry to be a non-null object, require a known string
status, and require the voting-address field and type expected from this response shape. Validate the
sampled height and block hash at the same boundary. Only then select enabled entries and build roots.

Confirm with the version 3 boundary cases repeated against `buildSnapshot()`. Cover an array response,
a primitive entry, missing status, stringly or otherwise mistyped status, missing voting address, and
a malformed collateral key. Each must produce a named refusal rather than an empty or shortened
snapshot.

### M3 The signed message is not self-framing

- Lens: architecture
- Severity: major
- Location: `common/oracle_sig.js:41`, `common/oracle_sig.js:68`,
  `common/oracle_sig.js:70`, `core/gateway.js:252`, `core/gateway.js:314`

What I read is that `snapshotMessage()` converts fields with `String()` and joins them with newlines.
The version 2 branch requires only that `shaRoot` be a string. It does not validate `root`, the
contents of `shaRoot`, or `ts`. Gateway validation later requires a canonical root and Secure Hash
Algorithm 256-bit (SHA-256) root, but it accepts any timestamp for which `Number(o.ts)` is finite and
inside the time bounds.

The encoding has concrete cross-field collisions. Let R and S be valid roots and N be a current
timestamp. These two version 2 objects produce identical signed bytes when every omitted field is the
same.

- Object A uses `root = R + "\n" + S`, `shaRoot = ""`, and `ts = N`.
- Object B uses `root = R`, `shaRoot = S`, and `ts = "\n" + N`.

`snapshotMessage()` accepts object A. Object B passes the included root, SHA-256 root, and timestamp
shape checks because `Number("\n" + N)` equals N. A signature over A therefore verifies over B. The
gateway recomputes B's roots from B's leaves and can adopt it.

The concrete cost is semantic field confusion at the oracle authentication boundary. A signature
over a malformed object can be reframed as a signature over a gateway-valid membership snapshot. I
infer exploitability through the standalone signer from the comment that it calls this signing API.
That signer is not included in the packet. If it independently applies the complete gateway schema
and recomputes both roots before signing, this path is blocked there. The common signing API itself
does not supply that guarantee.

The fix should use an unambiguous canonical encoding with explicit types and boundaries. A
length-prefixed binary form or a specified canonical JavaScript Object Notation (JSON) array is
sufficient. The signing function should also reject every noncanonical field before forming bytes,
including newline-bearing strings and non-integer timestamps. A message format change needs a new
signature domain and snapshot version so old signatures do not change meaning.

Confirm first with a unit test that constructs A and B, asserts their current messages are equal,
signs A, and verifies the signature against B. Then inspect the omitted standalone signer. If it signs
an externally supplied snapshot without full validation and root recomputation, treat this as directly
reachable. After the format change, assert that A is refused and that canonical field mutations still
break signatures.

### M4 Version 2 block hashes are coercible and noncanonical

- Lens: correctness
- Severity: major
- Location: `core/gateway.js:234`, `core/gateway.js:271`, `core/gateway.js:327`,
  `core/stores.js:155`

What I read is that `validateSnapshot()` enforces a lowercase, string block hash only for version 3.
For signed version 1 and version 2 snapshots, `oracleSignaturesOk()` applies a case-insensitive regular
expression to `String(o.blockHash)`. A singleton array containing a valid hash therefore passes and
has the same signed bytes as the string form. An uppercase version 2 hash also passes. Unsigned
version 1 and version 2 snapshots have no block-hash shape check in the included validator.

The uppercase form creates a transition failure without any hash collision. A signed version 2
snapshot using uppercase hexadecimal is adopted. A version 3 snapshot for the same block must use
lowercase hexadecimal. `mayCoexist()` compares the stored values as case-sensitive strings, so it
concludes that the blocks differ and rejects the version 3 snapshot. Both snapshots satisfy their
respective gateway schemas.

The concrete cost is that a representational difference can block the chainlocked rollout for the
freshness period. The singleton-array case also disproves the comment that the signed boundary has a
well-formed block hash, even though it does not by itself change the underlying hash value.

The fix should enforce one block-hash schema in `validateSnapshot()` for every version that carries
the field. Require a string of 64 lowercase hexadecimal characters before signature construction or
comparison. Store and compare only that canonical form, with no `String()` coercion.

Confirm with signed gateway tests for an uppercase version 2 hash and a singleton-array hash. Both
should refuse. Add a transition test using a canonical lowercase version 2 hash and the matching
version 3 hash to preserve the intended coexistence case.

## Probe assessment

The included gateway does not show the policy-check order inside `verifyMembership()`, so I cannot
read that the root check precedes the epoch check. I can read that the end-to-end test includes a
negative control with `BAD_ROOT`. If the epoch check moved ahead of the root check for every request,
that negative probe would return `wrong-epoch`, `windowHolds(BAD_ROOT)` would return true, and the test
would fail. That makes the technique self-checking against a wholesale order reversal. The actual
order still rests on the omitted verifier implementation, and an epoch rollover between challenge and
probe can produce `epoch-rolled-over` as a rare test failure rather than a false pass.

## Opportunities

- Return snapshot version, order, block hash, and chainlock status from `/v1/dml`, and consider a
  lookup by root so a client can fetch the exact leaves named by a challenge after a refresh.
- Serialize `refreshRoots()` or schedule the next refresh only after the current one completes. The
  included `setInterval()` can overlap asynchronous refreshes if a configured interval is shorter
  than a fetch and validation pass.
- Require safe integers for height, depth, and timestamp at both oracle and gateway boundaries. This
  avoids JavaScript number aliasing even though current Dash heights are far below the unsafe range.

BLOCK
