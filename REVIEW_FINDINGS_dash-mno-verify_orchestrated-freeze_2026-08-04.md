# Independent review findings, REVIEW_FINDINGS_dash-mno-verify_orchestrated-freeze_2026-08-04

Produced by an independent adversarial pass from a different model family, run against a
frozen candidate from a clean checkout. Machine paths and reviewer product names are
removed; file references are repo-relative. The full unedited transcript is retained
outside the repository.

## 1. Scope inspected

I reviewed frozen commit `8d71fe0d81d8cb7628ff4efa2a5c980856285c66`, with a clean working tree, against range `3a6aadf~1..b57873f`.

The primary scope covered the nine named implementation and test files. I also traced the requested invariants through these dependencies:

- [verifier.js](core/verifier.js)
- [season.js](core/season.js)
- [registration_store.js](core/registration_store.js)
- [diff_snapshot.js](oracle/diff_snapshot.js)
- [Independent Security Review Playbook](docs/INDEPENDENT_SECURITY_REVIEW_PLAYBOOK.md)

No files or Git state were changed.

## 2. Assumptions

- The playbook is normative, as requested.
- A signed deterministic masternode list (DML) snapshot is allowed to trust its pinned signer. Direct-node mode must meet the playbook’s stronger commitment-verification condition.
- Platform mode remains experimental, but its atomicity was reviewed because it is explicitly in scope.
- The adapter bearer secret is present in production. The unauthenticated override does not provide authoritative account identity.
- Availability failures that consume an epoch or seasonal claim are security-relevant because they violate playbook invariant 12.

## 3. Commands and evidence

Repository evidence included:

- `git rev-parse HEAD` returned the requested SHA.
- `git status --short` returned clean.
- `git diff --check 3a6aadf~1..b57873f` reported no whitespace errors.
- Node.js was `v26.0.0`.
- `package-lock.json` SHA-256 was `e58ec6a506e5a2b3fc22e7c268d2d9138d14d7afc2eece6d743bfa2f2339d164`.

Runnable focused suites passed:

- Root-window, Platform-store, and verifier selection produced 40 of 40 passing.
- Verifier idempotency, registration engines, and season rollover produced 45 of 45 passing.

Three adversarial reproductions succeeded:

```json
{"rootFromLiveChallengeStillRecent":false,"retainedHeights":[2],"verifyResult":{"ok":false,"reason":"stale-or-unknown-root"}}
```

```json
{"firstResponse":"transport timeout after consensus accepted the document","platformNowContainsSpend":true,"retryResult":{"ok":false,"reason":"already-used"}}
```

```json
{"accepted":true,"height":2100000,"leafCount":1,"root":"15291321489191351478429747305713147150887406586258949400677125501477281259688"}
```

The third result used an arbitrary list plus invalid `cbTx` and `cbTxMerkleTree` values. The snapshot builder accepted it because those commitment materials are not examined.

## 4. Findings

### F1 Major, direct-node mode violates the playbook’s chain-authentication requirement

The playbook permits direct-node mode only after `merkleRootMNList` is verified. The gateway instead starts this mode while explicitly acknowledging that the node may return an arbitrary self-consistent list.

Relevant locations include [gateway.js line 505](core/gateway.js:505) and [diff_snapshot.js line 22](oracle/diff_snapshot.js:22).

A compromised, malicious, or materially buggy configured node can return matching ChainLock and block hashes with an attacker-selected masternode list. The gateway builds and accepts the resulting root. This can authorize a non-masternode.

Minimal reproduction used `buildDiffSnapshot()` with:

- A syntactically valid fake ChainLock
- An arbitrary `mnList`
- `cbTx: "not-a-coinbase"`
- `cbTxMerkleTree: "not-a-proof"`

The builder returned a snapshot.

Remediation should either implement header, coinbase inclusion, `merkleRootMNList`, and simplified-list commitment verification, or refuse direct-node mode in the reviewed production profile.

### F2 Major, an uncertain Platform broadcast permanently consumes a claim without granting

The Platform backend reports success only after `broadcast()` returns. Consensus may accept the document before the client sees a timeout or connection failure. In that case, the request fails while the nullifier remains spent.

The retry cannot recover because [platform_store.js line 26](core/platform_store.js:26) deliberately stores no account binding. The verifier therefore returns `already-used`.

The reproduction simulated `broadcast()` committing and then throwing. The first call failed, `has()` returned true, and the same account’s fresh proof was refused.

This violates the playbook guarantee that a failed request cannot consume a durable claim.

Remediation requires an atomically stored privacy-safe account or operation commitment. An uncertain broadcast must query and compare that commitment before deciding whether the request won. Until the contract supports this, Platform nullifier mode should remain outside the supported profile.

### F3 Major, a successful registration write followed by a close or sync error can duplicate the registration

This is inherited code outside the named delta, but it directly violates a requested invariant and is already admitted in [HANDOFF.md line 159](docs/HANDOFF.md:159).

In [registration_store.js line 402](core/registration_store.js:402), the record is written and synchronized before `#remember()` updates the in-memory unique index. If `sync()` or `close()` reports an error after the complete line reached the file:

1. The gateway returns failure.
2. The in-memory store does not know the record exists.
3. A retry writes the same registration again.
4. Restart loads both complete lines without rejecting the duplicate.
5. The rebuilt members tree includes the commitment twice and changes root relative to the pre-restart tree.

The read-only sandbox prevented filesystem fault injection, but the failure sequence follows directly from the durable-write ordering and the repository records it as known open.

The backend needs recovery after an uncertain write. It should reread the durable key before allowing a retry, and loading must reject or deterministically collapse duplicate registration keys.

### F4 Moderate, the new leaves bound can evict a root used by an unexpired challenge

[stores.js line 229](core/stores.js:229) evicts old heights solely from retained-leaf totals. It has no knowledge of challenges minted against those roots.

The reproduction minted the equivalent of a live challenge against root 11, adopted another height that triggered the bound, and then called the real policy verifier. The proof was refused with `stale-or-unknown-root` although the challenge’s epoch and lifetime still held.

The hard memory bound itself is finite. Validation limits each record to 65,536 canonical leaves and there are at most two known orderings per height. The defect is loss of proof validity, not unbounded growth.

Fix this by reference-counting roots used by pending challenges and preventing their eviction until expiry. The retention design must still cap pinned roots or refuse new challenges before exceeding its bound.

### F5 Minor, Platform close is claimed and tested as repeat-safe but is not idempotent

[platform_store.js line 107](core/platform_store.js:107) calls `client.disconnect()` on every close. It has no closed guard.

A fake client that throws when disconnected twice produced:

```json
{"disconnectCalls":2,"secondClose":"already disconnected"}
```

The changed test passes only because its fake client permits repeated disconnects. Add a store-level closed guard and make the test’s fake reject a second underlying disconnect.

### F6 Low, the recorded changed-test count is incorrect

The handoff claims 25 module-refactor tests, consisting of 21 gateway tests, three SQLite tests, and one Platform test. The actual diff contains:

- 21 gateway tests
- 2 SQLite tests
- 1 Platform test

That is 24 tests. The later retained-leaves commit adds ten, bringing the reviewed delta’s changed or added total to 34.

## Changed-test observation audit

### Gateway module tests

| Test | Judgment |
|---|---|
| Importing boots nothing | Direct |
| `close()` releases boot handles | Direct |
| Failed boot releases SQLite | Direct |
| Durable-store close is idempotent | Direct |
| Two-tier refresh cannot adopt after close | Direct with an injected await |
| Racing closes share one teardown | Direct |
| Closed gateway refuses listen | Direct |
| Close waits for disconnected handler | Direct with an injected await |
| Close racing bind | Proxy, because `listen()` is artificially delayed |
| Config import validates nothing | Direct |
| Every interval is tracked | Direct interception |
| One release failure does not stop later releases | Direct |
| Close waits for in-flight refresh | Direct |
| Port collision rejects | Direct |
| HTTP exception comes from supplied config | Direct for the refusal path |
| Boot refusals are function behavior | Direct |
| Node mode boots without an oracle key | Direct for boot policy, but it does not observe a chain-authenticated root |
| Every limiter is swept | Direct, with reliance on Node’s private `_onTimeout` field |
| Account refusal does not charge shared bucket | Direct endpoint observation |
| Shared refusal does not charge account bucket | Direct endpoint observation |
| Challenge and verify accounts are bound | Direct for mismatch rejection and nonce consumption, but a proxy for proof-to-account binding because it uses a fake malformed proof and never proves that the public signal hashes the account |

The last test would still pass if account were removed from `signalHash()`. An unchanged HTTP test separately checks that equation, but the changed test’s title is broader than its observation.

### Retained-leaves tests

| Test | Judgment |
|---|---|
| Default is silent for the stated mainnet size | Proxy for current mainnet and byte memory, because 2,972 is hard-coded and only leaf count is measured |
| Height window and disabled bound behavior | Direct store and configuration behavior |
| Oldest records are dropped | Direct |
| Oversized newest record is retained | Direct, and it demonstrates the configured cap can be exceeded |
| Root and leaves leave together | Direct |
| Whole-height eviction keeps ordering pairs together | Direct for the store, proxy for gateway admission because it bypasses `mayCoexist()` |
| One adoption can require several evictions | Direct |
| Exact bound is inclusive | Direct |
| Larger replacement rechecks bound | Direct |
| Wide configured window is shortened | Direct store and configuration behavior, but does not test gateway wiring |

### SQLite tests

| Test | Judgment |
|---|---|
| Repeated close is harmless | Direct |
| Refusing constructor closes its opened database | Direct, including an operation against the captured closed handle |

Neither new SQLite test exercises separate database connections, lock contention, power-loss recovery, or partial failure. Existing sequential calls on one synchronous connection are a proxy for cross-process concurrency.

### Platform test

| Test | Judgment |
|---|---|
| Close disconnects the Platform client | Proxy for the live Software Development Kit client and false evidence for idempotence, because the fake accepts unlimited disconnect calls |

No changed Platform test covers concurrent live broadcasts, unique-index error classification, commit-then-timeout behavior, or read-after-failure reconciliation.

## 5. Blocked or omitted checks

- `npm ci` was not run because the checkout and temporary filesystem are read-only.
- `npm test` was attempted. It was invalidated by widespread `EPERM` failures from `mkdtemp`, not by candidate assertions.
- The filesystem-backed gateway, SQLite, and registration tests could not be reproduced in this sandbox.
- Live Dash Platform behavior was not tested. It requires a funded identity and network access.
- Live Dash Core commitment verification could not be tested because the implementation is absent.
- The recorded continuous integration result for `3a6aadf` was not independently queried from GitHub.
- Circuit soundness and adapter behavior were outside this delta review.

## 6. Verdict

**REVISE**

Account binding, context-scoped members roots, expected public-value checks, synchronous challenge consumption, SQLite’s atomic unique insert, and season commit serialization are sound in the inspected paths.

Approval is withheld because direct-node mode violates the playbook’s production condition, Platform can irrecoverably consume a nullifier after an uncertain response, and registration partial failure can duplicate durable state.

## 7. Canary

`MNO-B57873F-PACKET-2026-08-04-VERIFIED`
