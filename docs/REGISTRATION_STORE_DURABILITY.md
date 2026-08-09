# FileBackend durability and reconciliation, the specification

Written 2026-08-09 under the pre-commit playbook's rule 7. `core/registration_store.js` `FileBackend`
crossed rule 7's mechanical trigger this session: its reconciliation and durability state machine was
repaired six times across three review passes (`4a5e691`, `07a300e`, `4565515`, `e26f3a5`, `f39e9f4`,
`687a026`), and four of those repairs introduced the next round's finding. That is the signature of a
unit whose contract was never written down, so eleven awaits and two private flags each carried their
own copy of the intended behaviour and the copies drifted. This is that contract. The code is checked
against it, and the divergences are landed as one change rather than one finding per round.

## What it establishes

Every public read (`has`, `forSeasonContext`, `declarationFor`, `seasonHasEngine`) answers from an
in-memory index that reflects the DURABLE contents of the append-only file, or it refuses. "Durable"
means forced to stable storage by a barrier that returned success, not merely visible to a reread.

## What it does not establish (the trust boundary)

- Nothing about a second writer to the same file. The backend is documented single-writer, and a
  multi-gateway deployment uses the Platform backend, which imposes its own total order.
- That a record found under this caller's key is this caller's. When the file already holds a
  different record at the key, the append reports `duplicate` rather than claiming the other writer's
  commitment.
- That data survives a fault the storage layer accepted and then lost. Once a barrier returns
  success the record is treated as durable, which is the strongest claim a userspace writer can make.

## Inputs, and which side owes each

- The file at `this.path`. Owed by prior appends of THIS backend. Read through `this._readFile`.
- `openFile` and `_readFile`. The filesystem, injectable only so a test can drive the failure paths
  that define this unit. Production passes nothing and gets the real thing.
- The record `d` passed to `append()`. Owed by the caller (`RegistrationStore`), already normalized
  to `{season:Number, contextHash, regNullifier, commitment, engine, statement}` strings.
- The private reconciliation state: `#stale`, `#unbarriered`, the `#reconciling` memo, and the
  `#dirEnsured` flag. Owed entirely by this unit and never touched from outside.

## Behaviour for every way each input can be absent, malformed, or incoherent

This is the section rule 7 says is longest and is the one that was never written, so the drift lived
here. Each row is either enforced with a named site or is a divergence this change closes.

File-shaped inputs, resolved by `#load()`:

- File absent (`ENOENT`): an empty record set, not an error.
- Torn final line that fails to parse, no trailing newline: discarded and the file truncated to the
  last record boundary. Interruption matrix row 4.
- A malformed line anywhere but the end: refuse the load. Silently skipping it would drop a member
  who WAS promised a registration.
- A schedule header naming a different schedule: refuse.
- A record whose fields are wrong (a `contextHash`, `regNullifier`, or `commitment` that is not a
  CANONICAL BN254 field element, a negative index, an impossible engine/statement pair): refuse at
  load, by `registrationRecordProblem`, so the failure lands at boot where an operator can act. Two
  DIVERGENCES were folded here. The last-occurrence-wins collapse used to replace a stored record
  WITHOUT re-validating the replacement, so a corrupt duplicate bypassed the check; validation now
  runs ahead of the duplicate branch (finding 4, store-review round). And the check used to require
  only a non-empty string, so a `commitment` of "not-a-field" passed and threw only later at tree
  materialization; it now uses `isCanonicalField` (F4, sixth-round review), which the verifier applies
  on the write path, so the store re-applies the same check on the read path because a file can be
  corrupted or hand-edited independently of the verifier, and the loader is the last guard before a
  request path hits the bad value. Canonical also refuses the aliasing spellings ("01" for "1") that
  would let a corrupted file spend one nullifier twice under two string-distinct keys.
- Records in one (season, contextHash) bucket that disagree on their engine/statement DECLARATION:
  refuse at load. Each record's declaration is individually valid, but a query reads only the bucket's
  first record, so a bucket mixing a PLONK and a zkVM registration would make `seasonHasEngine` report
  the wrong downgrade signal. The append path already refuses a second registration whose declaration
  differs from the bucket's first; the loader now enforces the same coherence, so a file that violates
  it (an older build, or hand-editing) is refused where an operator can act rather than answered
  wrongly.
- The last complete record with no trailing newline: kept AND its bytes barriered before it is
  trusted. Written by a process that died before its own newline, they may have no fsync behind them,
  and the load is about to treat the record as committed. The repair forces the existing bytes to
  disk (barrier one), adds the delimiter, and forces again (barrier two). The TWO barriers cover
  different things and fail differently. If barrier one fails, the record's own bytes are not durable,
  the load throws before installing the maps, the record is not trusted, and the next load retries the
  whole repair. If barrier two fails, the record's bytes are ALREADY durable (barrier one succeeded)
  and only the delimiter's durability is deferred: the load throws, but the next load sees a
  newline-terminated file, skips the repair, and trusts the record, which is safe because a crash that
  loses the un-synced newline returns the file to the unterminated state and the repair runs again. So
  "the repair is retried" holds for the record's durability; the delimiter's own barrier is
  best-effort, and it costs nothing because losing it is self-healing.
- A duplicate key whose record is identical to the one already loaded: collapse to one, keeping the
  LAST occurrence, because it carries the index the writer finally assigned.
- A duplicate key whose record differs on an identity field: refuse. Two records for one key cannot
  both be right and this cannot choose.
- Bucket leaf positions that repeat (a TIE, two records at the same index): accepted, sorted stably
  by index with ties keeping file order. The base revision legitimately produces a file holding two
  distinct records at index 0 (an uncertain-write retry), and refusing it turned an upgrade into an
  outage (`687a026`).
- Bucket leaf positions with a GAP whose max index EXCEEDS the bucket length: refused. A gap is
  something an append-only store cannot produce, and it is not harmless like a tie: the next append
  assigns `recs.length` and pushes to the end, so a bucket holding `A@0, B@5` serves `[A, B, C@2]`
  live but rebuilds `[A, C@2, B@5]` on restart, and the served members root stops matching the
  rebuilt one. The exact condition is `max index <= length`, not `< length`: when the max EQUALS the
  length, the appended index ties it and a stable sort keeps the appended record last, so the order
  holds. So the loader refuses `max index > length` (a later round measured that `< length` refused
  harmless files like `A@0, B@2`). Neither the writer nor the base-revision failure sequence produces
  equality, so this only widens which corrupt files load, never which are served wrong.

The durability and reconciliation state:

- An append whose sync or close reports an error after bytes may have landed: BOTH flags set in the
  same synchronous step as the failure, inside the inner catch, so no await separates the write
  becoming uncertain from the store saying so.
- A reconciliation whose barrier fails: the reconciliation fails, both flags stay set, and every
  caller refuses (fail-closed). The next caller retries the barrier.
- A reconciliation that reads bytes no barrier forced to disk: refused, because `#barrierThenLoad`
  runs a barrier before the read whenever `#unbarriered` is set. A reread cannot turn visibility into
  durability.
- The flags are cleared in ONE place, `#reconcile`'s success continuation, and set in one place,
  `#mark()`. DIVERGENCE (finding 1): they used to be cleared at DIFFERENT moments, `#barrierThenLoad`
  clearing `#unbarriered` and `#reconcile` clearing `#stale`, so a write landing between the two
  clears left one set and one clear, a state a briefly-added assertion then made permanent. One clear
  site, reached only when the barrier and the load both succeeded, removes the split.

  ASSUMPTION THIS RESTS ON, stated because it is load-bearing: appends are serialized on `#_tail`, so
  no genuinely newer append can mark the view during a reconciliation's load (a queued append must
  pass `#ready()` and join the in-flight reconciliation before it writes). A generation counter that
  declined to clear when a mark landed mid-load was written and then REMOVED, because a different-
  family round proved that state unreachable in this single-writer store and the guard shipped
  untested with a comment claiming it fixed a live bug. If appends ever stop being serialized on one
  writer (a multi-gateway Platform backend), that guard returns with a test that reaches it.

The torn-tail repair offset:

- A torn-tail repair whose `truncate()` fails: the offset must not survive the load. DIVERGENCE
  (finding 2): `_truncateTo` was instance state nulled only on a successful truncate, so a failed
  truncate left it armed and a later load over a file an operator had since repaired applied the
  stale offset and deleted a good record. The fix makes the offset a per-load local, computed and
  consumed within one `#load()` and never carried across loads.

Directory durability:

- The file's DIRECTORY ENTRY must be on stable storage before the first record is acknowledged.
  `fsync` of the file forces its data blocks, not its directory entry, so a crash after an append
  returned success could leave the next process seeing no file at all. The gateway ALWAYS configures a
  schedule (`core/gateway.js`), so on every real deployment `#load` writes the schedule header, which
  creates the file, and then flushes the directory. That flush stands OUTSIDE the header-write block,
  gated on `#dirEnsured` (set only on success), so a load whose flush fails is retried by the next
  load rather than skipped once the header exists. A different-family round found both halves: the
  flush was previously inside the header block, so a failed flush was skipped on retry, and it did not
  exist at all for a null-schedule store. A null-schedule `FileBackend` (tests, and the peer of the
  in-memory backend) does not create a file in `#load` and carries no durable-directory contract, which
  is why the flush is confined to the schedule path and does not perturb the filesystem sequence the
  recovery tests drive. When the path spans SEVERAL new levels, the flush walks the whole chain from
  the file's directory up to the first pre-existing ancestor, because the entry naming each new
  directory lives in its parent. The new/pre-existing boundary is remembered stickily
  (`#createdDirBoundary`), since recursive mkdir reports what it created only on the creating load, and
  a retry after a partial flush failure would otherwise flush only the leaf, a later round's finding.

## Output, and which fields a consumer may read

- `has()` returns a boolean, true only against a reconciled view.
- `append()` returns `{duplicate:false, index}` on a durable write, `{duplicate:true}` when the key
  is already spent, `{conflict:true, declared}` on a declaration mismatch, `{invalid:true, ...}` when
  the engine/statement pair is impossible or a field element is not canonical, or throws when the
  write is genuinely uncertain. The caller treats `duplicate` as success for the member. Append
  validates the three field elements as canonical before writing, the same check the loader applies,
  so the store never persists a record it would refuse on the next load.
- `forSeasonContext()` returns the bucket's records in leaf order, which is the order the members
  tree is built over.
- `declarationFor()` returns the bucket's `{engine, statement}` or null.
- `seasonHasEngine()` returns a boolean, the zkVM downgrade signal, which must never read false for a
  season whose durable records include a zkVM registration.

Every one of these awaits `#ready()` first, which refuses unless both flags are clear or a
reconciliation establishes the view.

VISIBILITY IS BOUND TO DURABILITY on the append success path. The record is added to the index by
`#remember` the moment its `sync()` succeeds, INSIDE the write's try, before the `close()` is awaited.
A later round found that remembering it only after the close left a window where the record was durable
on disk but a concurrent read answered from the old maps and denied it, `seasonHasEngine` among them.
If the close then fails, the outer catch's reconciliation rebuilds the index from the file, so the
early `#remember` is not doubled and the durable write is still reported as success.

## Test coverage of the flag machinery

The finding-1 fix, that both flags are set together by `#mark()` and cleared together in the single
continuation of `#reconcile`, is covered by the deterministic durability tests: `a reread cannot turn
a failed durability barrier into an apparent commit`, `an unbarriered write cannot be laundered into a
commit during the awaited close`, and `no public view answers from the old maps while an uncertain
write is still recovering`. The generation guard that once sat on top of this is gone, so there is no
untested branch left here (an earlier draft of this document recorded the guard as an untested
rule-4 reason; it was removed in the same change that removed the guard).
