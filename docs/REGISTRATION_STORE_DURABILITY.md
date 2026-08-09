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
- The private reconciliation state: `#stale`, `#unbarriered`, the `#reconciling` memo, and the mark
  generation counter. Owed entirely by this unit and never touched from outside.

## Behaviour for every way each input can be absent, malformed, or incoherent

This is the section rule 7 says is longest and is the one that was never written, so the drift lived
here. Each row is either enforced with a named site or is a divergence this change closes.

File-shaped inputs, resolved by `#load()`:

- File absent (`ENOENT`): an empty record set, not an error.
- Torn final line that fails to parse, no trailing newline: discarded and the file truncated to the
  last record boundary. Interruption matrix row 4.
- A complete final record with no trailing newline: kept, and the newline appended, so the next
  append does not concatenate onto it. Interruption matrix rows 4 and 5.
- A malformed line anywhere but the end: refuse the load. Silently skipping it would drop a member
  who WAS promised a registration.
- A schedule header naming a different schedule: refuse.
- A syntactically valid record whose fields are not usable (a `commitment` that is not a field
  element, a negative index, an impossible engine/statement pair): refuse at load, by
  `registrationRecordProblem`, so the failure lands at boot where an operator can act rather than
  later at tree materialization. DIVERGENCE (finding 4): the last-occurrence-wins collapse replaced a
  stored record WITHOUT re-validating the replacement, so a corrupt duplicate bypassed the check.
- A duplicate key whose record is identical to the one already loaded: collapse to one, keeping the
  LAST occurrence, because it carries the index the writer finally assigned.
- A duplicate key whose record differs on an identity field: refuse. Two records for one key cannot
  both be right and this cannot choose.
- Bucket leaf positions that are not a contiguous `0..n-1` set: sorted stably by index, ties keeping
  file order, NOT refused. The base revision legitimately produces a file holding two distinct
  records at index 0, and refusing it turned an upgrade into an outage (`687a026`).

The durability and reconciliation state:

- An append whose sync or close reports an error after bytes may have landed: BOTH flags set in the
  same synchronous step as the failure, inside the inner catch, so no await separates the write
  becoming uncertain from the store saying so.
- A reconciliation whose barrier fails: the reconciliation fails, both flags stay set, and every
  caller refuses (fail-closed). The next caller retries the barrier.
- A reconciliation that reads bytes no barrier forced to disk: refused, because `#barrierThenLoad`
  runs a barrier before the read whenever `#unbarriered` is set. A reread cannot turn visibility into
  durability.
- A newer uncertain write that marks the flags WHILE a reconciliation is loading: the reconciliation
  must not clear the flags, because its barrier and its read both predate that write. DIVERGENCE
  (finding 1): `#barrierThenLoad` cleared `#unbarriered` and `#reconcile` cleared `#stale` at
  DIFFERENT moments, so a write landing between them left `#unbarriered` set and `#stale` clear, a
  state a briefly-added assertion then made permanent. The fix is a generation counter bumped by
  every mark and captured at the start of a reconciliation, so the success continuation clears BOTH
  flags together and ONLY when nothing newer has been marked.

The torn-tail repair offset:

- A torn-tail repair whose `truncate()` fails: the offset must not survive the load. DIVERGENCE
  (finding 2): `_truncateTo` was instance state nulled only on a successful truncate, so a failed
  truncate left it armed and a later load over a file an operator had since repaired applied the
  stale offset and deleted a good record. The fix makes the offset a per-load local, computed and
  consumed within one `#load()` and never carried across loads.

## Output, and which fields a consumer may read

- `has()` returns a boolean, true only against a reconciled view.
- `append()` returns `{duplicate:false, index}` on a durable write, `{duplicate:true}` when the key
  is already spent, `{conflict:true, declared}` on a declaration mismatch, or throws when the write
  is genuinely uncertain. The caller treats `duplicate` as success for the member.
- `forSeasonContext()` returns the bucket's records in leaf order, which is the order the members
  tree is built over.
- `declarationFor()` returns the bucket's `{engine, statement}` or null.
- `seasonHasEngine()` returns a boolean, the zkVM downgrade signal, which must never read false for a
  season whose durable records include a zkVM registration.

Every one of these awaits `#ready()` first, which refuses unless both flags are clear or a
reconciliation establishes the view.

## Test coverage of the flag machinery, stated honestly

The finding-1 fix has two parts. The first, that both flags are set together by `#mark()` and cleared
together in the single continuation of `#reconcile`, is covered by the deterministic durability tests
(`a reread cannot turn a failed durability barrier into an apparent commit`, `an unbarriered write
cannot be laundered into a commit during the awaited close`, `no public view answers from the old maps
while an uncertain write is still recovering`). The second, the generation guard that declines to
clear when a newer mark landed DURING a reconcile, resists a deterministic local test: exercising it
needs a mark to land inside another reconcile's held load, and driving that through the filesystem
hooks was non-deterministic in two attempts, which is the fragile-timing-test shape the pre-commit
playbook warns against. The guard is kept because the specification requires it and because it is
fail-safe by construction, a wrong decision only declines to clear and costs one extra reconcile with
no wrong answer, and its specific race is handed to the different-family fresh-full review round rather
than pinned by a flaky local test. This is a rule-4 recorded reason, not an omission.
