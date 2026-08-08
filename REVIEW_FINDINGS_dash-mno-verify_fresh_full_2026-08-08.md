# Dash Masternode Verification Adversarial Review

- Date: 2026-08-08
- Reviewed revision: `66127dd735be4c84d4ed00fae3e5eb93d5020280`
- Review scope: current code and `git diff e5737b9..HEAD`. The untracked `output/` directory, all documentation, and the two committed findings reports were excluded. The review started from the implementation and did not use earlier findings as a checklist.

Verdict: REQUEST-CHANGES

## Findings

### F1 Major Concurrent reconciliation can permanently install stale registration state

- Locations: `core/registration_store.js` lines 283 to 304 and 538 to 543

`#ready()` starts a new `#reload()` whenever `#stale` is true, but reconciliation is not single-flight. Two public calls can therefore run reloads concurrently. Each reload replaces the shared `seen` and `byBucket` maps and saves a different prior pair. If one reload succeeds while the other fails, the failed reload can restore the old maps and the successful caller can then clear `#stale`. The result is an old in-memory index marked fresh.

This breaks both halves of the uncertain-write fix. A durable registration can disappear from `has()` and `seasonHasEngine()`, and later appends can assign indexes from a view that omits a record already on disk. The latter can make the live members tree differ from the tree rebuilt after restart. A zero-knowledge virtual machine (zkVM) registration can also disappear from the downgrade signal, allowing the refresh path to accept a snapshot without the Secure Hash Algorithm 256-bit (SHA-256) root that durable state requires.

The reproduction used an injected file handle and reader with this order.

1. The append writes its record, then its first sync reports an error.
2. The retry sync succeeds, so the record is durable.
3. The recovery read fails, setting `#stale`.
4. Two public reads start together. One reconciliation succeeds and one fails after both have replaced the shared maps.

The record was present in the file. One public call rejected, while the concurrent `seasonHasEngine(1, "zkvm")` returned `false`. A later call also returned `false` without another read, showing that the stale flag had been cleared over the restored old maps.

```json
{
  "first": { "status": "rejected", "reason": { "code": "EIO" } },
  "second": { "status": "fulfilled", "value": false },
  "afterRace": false,
  "diskHasRecord": true,
  "readCalls": 4
}
```

The correction must make reconciliation one operation shared by every caller, then install the rebuilt maps and freshness state as one outcome. A failed attempt must not be able to restore state over a successful concurrent attempt.

### F2 Major A repeated pinned root can evict the newest deterministic masternode list height

- Location: `core/stores.js` lines 258 to 286

`#pinnedHeights()` marks every height carrying a pinned root. A deterministic masternode list (DML) root normally repeats across heights when the list does not change, so one challenge can pin several historical copies. When a new root arrives and the leaf bound is exceeded, the eviction loop chooses the first unpinned height. If all historical heights share the pinned root, the only unpinned height is the one just adopted. The loop deletes the newest height and leaves the gateway serving history.

This contradicts the bound's stated rule that the latest height is never dropped. It can keep a newly joined masternode out and keep `/v1/dml` on an older snapshot until pins or age expiry clear. The shipped leaf cap does not bind at the current mainnet list size under the default eight-height window, but the bug is reachable whenever the configured cap binds or the retained snapshots become large enough.

The minimal reproduction follows.

```js
const pinned = new Set();
const w = new RootWindows(8, { maxLeaves: 250, pinnedRoots: () => pinned });
w.adopt(record({ height: 1, root: "same", leaves: 100 }));
w.adopt(record({ height: 2, root: "same", leaves: 100 }));
pinned.add("same");
w.adopt(record({ height: 3, root: "new", leaves: 100 }));
```

It produced this state.

```json
{ "retainedHeights": [1, 2], "currentRoot": "same", "newRootAccepted": false }
```

The correction must preserve the newest height before selecting an eviction target. A root pin needs enough retained state to verify that root, not every historical copy of the same root.

### F3 Moderate The new snapshot guard accepts a null versus non-null SHA-256 mismatch

- Location: `core/stores.js` lines 190 to 192

The new guard compares `shaRoot` only when both the record and its snapshot are non-null. It accepts either asymmetric case. A record can therefore advertise no SHA-256 root while its served snapshot carries one, or advertise a root that its served snapshot does not carry. That recreates the split the guard was added to prevent.

The minimal reproduction follows.

```js
const w = new RootWindows();
const sha = "a".repeat(64);
w.adopt({
  height: 1,
  root: "r",
  shaRoot: null,
  ts: 1,
  snapshot: normalizedSnapshot({ height: 1, root: "r", shaRoot: sha, leaves: [] }),
});
```

It produced this state.

```json
{
  "servedSnapshotShaRoot": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "acceptedByShaView": false
}
```

The gateway's current call site passes both values from the same parsed snapshot, so this is a latent store-invariant failure rather than an externally reachable mismatch today.

The correction must compare the normalized values unconditionally, including null equality.

### F4 Moderate Loaded registration strings are not validated as field elements

- Location: `core/registration_store.js` lines 122 to 141

The new shape check requires `contextHash`, `regNullifier`, and `commitment` to be non-empty strings. All three are actually canonical BN254 field elements. A syntactically valid damaged record such as `commitment: "not-a-field"` passes `FileBackend.ready()`. The first materialization of that context later throws while converting the commitment to `BigInt`, moving the failure away from startup and back into the request path the loader change was intended to protect.

Reproduction wrote this record as one complete JavaScript Object Notation (JSON) line.

```json
{
  "season": 1,
  "contextHash": "not-a-field",
  "regNullifier": "also-not-a-field",
  "commitment": "not-a-field",
  "engine": "plonk",
  "statement": "derive",
  "index": 0
}
```

`FileBackend.ready()` succeeded. `MembersTree.fromCommitments()` over the loaded record then failed with `Cannot convert not-a-field to a BigInt`.

The correction must apply the same canonical-field predicate used by proof decoding and snapshot validation when records are loaded.

### F5 Low The stricter IPv6 parser still accepts structurally invalid addresses

- Location: `oracle/dml_commitment.js` lines 68 to 84

The new check validates the text inside each group, but it does not validate when zero compression is legal. An address without `::` may contain fewer than eight groups and the parser silently pads it. An address with `::` may already contain eight groups even though the abbreviation must replace at least one zero group.

Both malformed services are accepted.

```js
serviceBytes("[1:2:3:4:5:6:7]:9999");
serviceBytes("[1:2:3:4:5:6:7:8::]:9999");
```

This did not expose a mainnet outage. Dash Core emits canonical service strings, and the parser accepts the ordinary IPv4, compressed IPv6, and expanded IPv6 forms Core produces. The defect leaves the strict decoder claim incomplete and permits more than one malformed spelling to map to bytes.

The correction must require exactly eight groups when `::` is absent, and require `::` to replace at least one group when it is present.

### F6 Low The X11 reference image cache ignores the effective commit override

- Locations: `tools/x11-reference/build.sh` lines 7 to 14, `tools/x11-reference/fuzz.mjs` lines 24 to 31, and `tools/x11-reference/generate.mjs` lines 20 to 27

The image name includes the tag and a hash of committed input files, but not the effective `DASH_COMMIT` environment override. The Dockerfile describes an empty `DASH_COMMIT` as the escape used to inspect a moved tag. If the old image already exists, `build.sh` resolves the same image name, reports it as already built, and never checks what the tag now names. A non-empty alternate commit at the same tag has the same problem.

With an existing cached image, the reproducing command is shown below.

```sh
DASH_COMMIT= tools/x11-reference/build.sh
```

The script exits through the `image inspect` cache hit before invoking a build. `fuzz.mjs` and `generate.mjs` resolve that same cache key, so they continue using the prior reference unless the operator also knows to force a rebuild.

The correction must include the effective commit override in the image identity, including a distinct identity for the deliberate empty override.

## Real-world compatibility checks

No legitimate-data rejection was found in the new Hypertext Transfer Protocol (HTTP) response cap, canonical varint reader, IPv6 group character check, or shared 80-byte header decoder.

- Dash Core's `ReadCompactSize` rejects wider-than-shortest encodings, so the canonical varint rule matches the producer.
- The response cap handles a declared oversize body, an understated length, no length, chunked input, invalid JSON, and an ordinary response. The command-line path is unchanged and keeps the same 64 mebibyte cap.
- The shared header decoder accepts the 160-character hex form returned by `getblockheader` and every committed mainnet header case.
- The service parser accepts canonical IPv4 and IPv6 strings. F5 concerns malformed strings it still accepts, not real strings it refuses.

A live Dash node was not available in this environment. These checks used the current code, committed mainnet fixtures, and Dash Core's producer behavior. Dash Core's noncanonical CompactSize rejection is visible in [its serialization source](https://github.com/dashpay/dash/blob/v23.1.3/src/serialize.h), and its service formatting is in [the network address source](https://github.com/dashpay/dash/blob/v23.1.3/src/netaddress.cpp).

## Verification performed

- Targeted changed-area tests passed with 156 tests and no failures.
- Every test that does not open a listening socket passed with 487 tests and no failures.
- The full `npm test` command could not complete in this sandbox. Tests that call `listen()` failed with `EPERM` on loopback and wildcard addresses. The failures occurred before their assertions and are an environment restriction, not evidence about the code under review.
- The three main runtime findings were reproduced directly against revision `66127dd` with injected file-system interleavings and small deterministic root-window cases.
