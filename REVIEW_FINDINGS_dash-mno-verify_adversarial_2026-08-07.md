# Adversarial Review Findings

Scope was `git diff 8d71fe0..HEAD`, excluding `output/`, `CLAUDE.md`, `TODO.md`, and `docs/`.

REQUEST-CHANGES

## Blockers

### B1. A reread cannot turn a failed sync into a durable commit

- Location: `core/registration_store.js` lines 510 through 539 and `test/registration_store.test.js` lines 364 through 402
- Impact: The gateway can acknowledge a registration whose atomic commit point was never made durable. A crash can then lose the registration nullifier and member commitment after the member was told registration succeeded.
- Cause: The recovery path treats visibility through `readFile()` as proof of durability. Filesystem reads can see dirty page-cache data that has never reached stable storage. A failed `sync()` is exactly the case in which visibility and durability differ.
- Reproduction: The committed test replaces `fh.sync()` with a function that throws without calling the real sync. The appended bytes remain readable, `#reload()` finds them, and `append()` returns `{ duplicate: false, index: 0 }`. The test therefore proves page-cache visibility while its name and assertions claim durability.
- Required property: Success after an uncertain write needs a successful durability barrier. A reread may identify the record, but it cannot replace that barrier.

This breaks the store's stated contract that the record is the durable atomic commit point. It also means the test passes for a reason other than the one its name states.

## Majors

### M1. A failed recovery reread lets live and restart member order diverge

- Location: `core/registration_store.js` lines 253 through 268 and 530 through 539
- Impact: The live members root can use one insertion order while the same file rebuilds a different root after restart. Proofs made against the live order stop working, and the durable index returned to callers no longer describes the rebuilt tree.
- Cause: When `#reload()` fails, it restores the old resolved `_loading` promise and the pre-write maps. Later appends therefore proceed without retrying reconciliation, even though the uncertain record may already be in the file.
- Reproduction: I let registration K reach the file, made its `sync()` throw, and made the recovery read fail once. Registration M then returned index 0 and K's retry returned index 1. The live order was `M@0, K@1`. The file contained `K@0, M@0, K@1`, and a restart collapsed the duplicate into `K@0, M@0`. The member order reversed across restart.
- Test gap: The test named `a reload that fails leaves the store as usable as it was` does not exercise `#reload()`. It fails the initial `ready()` read on a new backend, so it cannot catch this sequence.

The same non-transactional loading also leaves partial records in memory after a parse failure. If a later retry reads a repaired or replaced file, records absent from that second file can remain in `byBucket` and `seen`.

### M2. Uncertain-write recovery accepts another writer's conflicting record as this write

- Location: `core/registration_store.js` lines 530 through 539
- Impact: The store reports the submitted commitment as successfully written while its durable view contains a different commitment. `SeasonMembers.commit()` then appends the submitted commitment to the live tree, and a restart rebuilds from the other one.
- Cause: Recovery searches only by `(season, contextHash, regNullifier)`. It does not compare the found record with the attempted record using `sameRegistrationRecord()`.
- Reproduction: I made the attempted append fail before writing and made the recovery read return a competing record with the same key and commitment `OTHER_MEMBER`. The call returned `{ duplicate: false, index: 0 }` for `OUR_MEMBER`, while `forSeasonContext()` contained only `OTHER_MEMBER`.

The file backend is described as single-writer, but that condition is not enforced with a lock. A second process or second `FileBackend` pointed at the same path can reach this case. Even under a single-writer deployment, recovery should not claim that a record is the attempted write without comparing its content.

## Minors

### N1. Header hex accepts an ignored trailing nibble

- Location: `common/x11/index.js` lines 63 through 72, `oracle/proof_of_work.js` lines 60 through 75, and the header boundary in `oracle/diff_snapshot.js`
- Impact: A malformed 161-character header string is accepted as the same 80 bytes as its 160-character prefix. This does not bypass the hash or proof-of-work checks, but it contradicts the exact-header boundary and gives one header more than one accepted transport encoding.
- Reproduction: For a committed mainnet header, both `blockHashFromHeader(header + "f")` and `meetsProofOfWork(header + "f")` returned the same answers as the canonical header. Node's hex decoder silently drops the final half-byte.
- Test gap: The wrong-length test adds or removes whole bytes only, so it stays green when an odd trailing nibble is accepted.

### N2. `NullifierStore.prune()` can erase everything for a non-finite cutoff

- Location: `core/stores.js` lines 611 through 621 and `test/nullifier_store_contract.test.js` lines 57 through 64
- Impact: `prune(Infinity)` deletes every finite-epoch claim, contrary to the comment and test claim that an unusable cutoff removes nothing. The production caller currently supplies a validated finite value, so this is a contract and test defect rather than a reachable gateway bypass.
- Reproduction: Two stored claims followed by `prune(Infinity)` returned `{ removed: 2 }` and left the store empty.
- Test gap: The bad-input table omits both infinities. It includes `null`, but `Number(null)` is zero, so that case passes through ordinary numeric coercion rather than proving rejection of an unusable cutoff.

## Areas that held up

The X11 port matched all committed per-round vectors and all eleven end-to-end mainnet block cases. I also interleaved repeated calls over 0, 64, 80, and 300-byte inputs, mutated every returned buffer, and confirmed that every round remained repeatable and left caller-owned inputs unchanged. The round implementations allocate call-local state where it matters. The module-level scratch arrays in SHAvite and SIMD are overwritten synchronously before use and do not leak state between ordinary calls.

The direct-node trust comments identify the two underlying trust gaps accurately. The code does not verify a ChainLock signature, and it checks the header's chosen target only against mainnet's easiest allowed target rather than the difficulty required at that height. A malicious configured node can therefore mine a self-consistent synthetic header, coinbase, and list at the proof-of-work limit, or replay a real noncanonical block. Those outcomes are consequences of the two recorded decisions, not an additional bypass in the five implemented checks.

The deterministic masternode list commitment, coinbase position check, partial Merkle tree consumption rules, X11 naming, proof-of-work numeric comparison, and coinbase-height comparison formed a closed internal chain in the reviewed path. I found no way to alter a voting key or validity flag while reusing a real committed header without a hash preimage or collision.

## Verification

- Focused suite: 153 tests passed across X11, diff snapshots, deterministic masternode list commitments, registration storage, root windows, nullifier storage, and Platform storage.
- Additional checks: interleaved X11 state and input-mutation probe passed. Both registration failures and both minor input cases were reproduced directly.
- Full suite: The broad `npm test` run could not complete in this sandbox because every test that called `listen()` failed with `EPERM`. Non-network tests continued to pass. These were environment permission failures rather than assertion failures.
