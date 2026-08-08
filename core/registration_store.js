// Durable, season-scoped registration records for the two-tier flow.
//
// The atomic unit is one registration record:
//   { season, contextHash, regNullifier, commitment, index }
// deduped by a unique key on (season, contextHash, regNullifier). Appending a record is the
// single durable write that both spends the registration nullifier (one voting key registers
// once per season and context) and records the member commitment. The members tree is a cache
// rebuilt from these records, so a crash between the spend and the tree update cannot strand a
// member: on restart the record is present and the member is back in the tree.
//
// Two backends behind one interface:
//   FileBackend    append-only JSON lines, durable on a single gateway, needs no funded identity.
//   MemoryBackend  in-process, for tests and ephemeral single-gateway use.
// A Dash Platform backend that shares records across gateways follows the same interface and is
// wired in platform_store.js once the file path is proven; see docs/PLATFORM.md.
//
// Leaf order: forSeasonContext returns one (season, contextHash) bucket's records in insertion
// order, which is the order the members tree for that context is built over and the order
// /v1/members exposes, so a prover's leaf index (the position of its commitment in that list)
// matches the gateway's root. Records and their leaf index are scoped to (season, contextHash), so
// a registration for one community never appears in another community's tree (review finding B2).
// A FileBackend is a single writer, so insertion order is total and stable across restarts. A
// multi-gateway Platform backend must impose its own deterministic total order (for example sorted
// by regNullifier) so every gateway rebuilds the identical tree.
import { open, readFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

// The statement a (season, contextHash) is registered under. The registration nullifier is derived
// differently per statement (docs/ZKVM_INTEGRATION.md, "Two statements"): the derive statement keys
// it on the private key, the custody statement cannot, so the two produce different nullifiers for
// the same node. Mixing them in one (season, contextHash) would let one node register twice, so a
// bucket is bound to a single statement, declared by its first registration and enforced on every
// later one. The engine (which proof system produced it) is recorded alongside for observability, and
// PLONK only supports derive.
export const ENGINE_STATEMENTS = Object.freeze({
  plonk: Object.freeze(["derive"]),
  zkvm: Object.freeze(["derive", "custody"]),
});
export function isValidEngineStatement(engine, statement) {
  // Object.hasOwn, not `ENGINE_STATEMENTS[engine]`, so an inherited property name like "constructor",
  // "toString", or "__proto__" returns false instead of reading a function and throwing on .includes.
  if (typeof engine !== "string" || typeof statement !== "string") return false;
  if (!Object.hasOwn(ENGINE_STATEMENTS, engine)) return false;
  return ENGINE_STATEMENTS[engine].includes(statement);
}
// Backward compatibility: a record written before this field existed is a PLONK derive registration,
// the only kind that existed then.
const DEFAULT_ENGINE = "plonk";
const DEFAULT_STATEMENT = "derive";

// The backend contract:
//   has({season, contextHash, regNullifier})    -> Promise<boolean>
//   append({season, contextHash, regNullifier, commitment})
//                                                -> Promise<{ duplicate, index }>
//   forSeasonContext(season, contextHash)        -> Promise<record[]>  (insertion order)
// where `duplicate` is true when the unique key rejected the insert, and `index` is the leaf
// position assigned within the (season, contextHash) bucket.
export class RegistrationStore {
  constructor(backend) {
    this.backend = backend;
  }
  async ready() {
    if (this.backend.ready) await this.backend.ready();
  }
  has(season, contextHash, regNullifier) {
    return this.backend.has({
      season: Number(season),
      contextHash: String(contextHash),
      regNullifier: String(regNullifier),
    });
  }
  append({ season, contextHash, regNullifier, commitment, engine, statement }) {
    // Fail closed on a missing declaration: a NEW write must state engine and statement explicitly, so
    // a caller that drops them cannot silently write a legacy plonk/derive record and mislabel a
    // custody registration (the DEFAULT_* values are for READING old records, not writing new ones).
    // isValidEngineStatement also rejects an impossible pair (for example PLONK custody). The
    // per-bucket consistency check is the backend's, inside the serialized append.
    if (!isValidEngineStatement(engine, statement)) {
      return Promise.resolve({ invalid: true, engine: String(engine), statement: String(statement) });
    }
    return this.backend.append({
      season: Number(season),
      contextHash: String(contextHash),
      regNullifier: String(regNullifier),
      commitment: String(commitment),
      engine: String(engine),
      statement: String(statement),
    });
  }
  forSeasonContext(season, contextHash) {
    return this.backend.forSeasonContext(Number(season), String(contextHash));
  }
  // The (engine, statement) a (season, contextHash) is declared under, or null if it has no
  // registration yet. The first record's declaration, so it is stable for the bucket's life.
  declarationFor(season, contextHash) {
    return this.backend.declarationFor(Number(season), String(contextHash));
  }
  // Whether any context in this season is declared under `engine`. The gateway uses this to make the
  // dual-root downgrade rule consider durable declarations, not just configured intent: a deployment
  // with a current-season zkVM registration must keep requiring v2 snapshots even if the config flag
  // is later unset (docs/ZKVM_INTEGRATION.md, the downgrade rule).
  seasonHasEngine(season, engine) {
    return this.backend.seasonHasEngine(Number(season), String(engine));
  }
}

// The declaration a bucket is bound to: the first record's (engine, statement), defaulting a legacy
// record with neither field to PLONK derive.
function declarationOfRecord(record) {
  return { engine: record.engine ?? DEFAULT_ENGINE, statement: record.statement ?? DEFAULT_STATEMENT };
}
// Two loaded records for one key are the same registration when they agree on what the registration
// IS. The stored `index` is deliberately NOT part of that: it is a position this process assigned, not
// something the registration means, and a retry after a reload can legitimately compute a different
// one when another registration took the position in between. Comparing it turned an honest
// interrupted write into a file the gateway refuses to start on, which is the opposite of what the
// duplicate handling exists for, and a reviewer reproduced exactly that sequence. The fields compared
// are the ones that decide whether admitting both would admit the same member twice.
// What a loaded record must be, returned as a reason rather than a boolean so the refusal can say
// which field is wrong. Every one of these is a field the members tree or the declaration logic reads,
// so a record failing any of them is one that would fail later and further from the cause.
function registrationRecordProblem(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return "not an object";
  if (!Number.isInteger(rec.season) || rec.season < 0) return `season ${JSON.stringify(rec.season)} is not a non-negative integer`;
  for (const f of ["contextHash", "regNullifier", "commitment"]) {
    if (typeof rec[f] !== "string" || rec[f].length === 0) return `${f} is not a non-empty string`;
  }
  if (!Number.isInteger(rec.index) || rec.index < 0) return `index ${JSON.stringify(rec.index)} is not a non-negative integer`;
  // The engine and statement bind the bucket, and an invalid pair would make every later registration
  // for that bucket refuse with a statement mismatch against a declaration nothing could satisfy.
  //
  // ABSENT IS LEGAL AND INVALID IS NOT. A record written before these fields existed carries neither,
  // and declarationOfRecord reads that as the plonk/derive default, which is a supported format rather
  // than corruption. What is not supported is a pair that is present and impossible, which is the case
  // this refuses. A first version demanded the fields outright and would have refused every legacy
  // file at boot, which is a guard with no exit for state the format promises to keep reading.
  const hasEngine = rec.engine !== undefined || rec.statement !== undefined;
  if (hasEngine && !isValidEngineStatement(rec.engine, rec.statement)) {
    return `engine/statement ${JSON.stringify(rec.engine)}/${JSON.stringify(rec.statement)} is not a valid pair`;
  }
  return null;
}

function sameRegistrationRecord(a, b) {
  return (
    String(a.season) === String(b.season) &&
    String(a.contextHash) === String(b.contextHash) &&
    String(a.regNullifier) === String(b.regNullifier) &&
    String(a.commitment) === String(b.commitment) &&
    String(a.engine ?? "") === String(b.engine ?? "") &&
    String(a.statement ?? "") === String(b.statement ?? "")
  );
}

function sameDeclaration(a, b) {
  return a.engine === b.engine && a.statement === b.statement;
}

// The unique key spends one registration nullifier per (season, contextHash). The bucket key is
// that same scope minus the nullifier, and groups the records whose commitments form one context's
// members tree.
function keyOf(d) {
  return `${d.season}:${d.contextHash}:${d.regNullifier}`;
}
function bucketOf(d) {
  return `${d.season}:${d.contextHash}`;
}

// In-memory backend that enforces the same unique key and per-(season, context) indexing, for tests
// and ephemeral single-gateway use. Not durable: a restart loses every record.
export class MemoryRegistrationBackend {
  constructor() {
    this.seen = new Set();
    this.byBucket = new Map(); // "season:contextHash" -> records[] in insertion order
  }
  async has(d) {
    return this.seen.has(keyOf(d));
  }
  async append(d) {
    const k = keyOf(d);
    if (this.seen.has(k)) return { duplicate: true };
    const b = bucketOf(d);
    const recs = this.byBucket.get(b) ?? [];
    // A bucket is bound to one (engine, statement): the first record declares it, a later record
    // with a different declaration is a conflict and is rejected without being written.
    const want = declarationOfRecord(d);
    if (recs.length > 0) {
      const declared = declarationOfRecord(recs[0]);
      if (!sameDeclaration(declared, want)) return { conflict: true, declared };
    }
    const index = recs.length;
    const record = {
      season: d.season,
      contextHash: d.contextHash,
      regNullifier: d.regNullifier,
      commitment: d.commitment,
      engine: d.engine,
      statement: d.statement,
      index,
    };
    this.seen.add(k);
    recs.push(record);
    this.byBucket.set(b, recs);
    return { duplicate: false, index };
  }
  async forSeasonContext(season, contextHash) {
    return [...(this.byBucket.get(`${season}:${contextHash}`) ?? [])];
  }
  async declarationFor(season, contextHash) {
    const recs = this.byBucket.get(`${season}:${contextHash}`);
    return recs && recs.length > 0 ? declarationOfRecord(recs[0]) : null;
  }
  async seasonHasEngine(season, engine) {
    return bucketsHaveEngine(this.byBucket, season, engine);
  }
}

// True if any (season, *) bucket's declaration uses `engine`. Scans the season's buckets, reading
// each bucket's declaration from its first record.
function bucketsHaveEngine(byBucket, season, engine) {
  const prefix = `${season}:`;
  for (const [bucket, recs] of byBucket) {
    if (!bucket.startsWith(prefix)) continue;
    if (recs.length > 0 && declarationOfRecord(recs[0]).engine === engine) return true;
  }
  return false;
}

// Durable append-only backend. One JSON record per line. The in-memory index is rebuilt from
// the file on load, so the tree survives a restart and every member keeps their leaf position.
export class FileBackend {
  // Set when a reload failed and the in-memory view is known to be behind the file. Private, because
  // nothing outside should be able to clear it without doing the reconciliation it stands for.
  #stale = false;

  // The in-flight reconciliation, shared by every caller that finds the store stale. Null when none
  // is running. See #reconcile() for why sharing one is what makes the flag mean anything.
  #reconciling = null;

  // `open` is injectable for ONE reason: the uncertain write, where the bytes reach the file and the
  // sync or close still reports an error, cannot be produced from outside this class. It is the exact
  // sequence F3 describes, so a test that cannot create it can only assert the fix by reading it. The
  // default is the real thing and no production path passes anything else, the same shape the
  // verifier's injectable proof check already uses.
  constructor(path, schedule = null, assumeSchedule = false, { open: openFile = open, readFile: readFileImpl = readFile } = {}) {
    this.path = path;
    this.schedule = schedule;
    this.assumeSchedule = assumeSchedule;
    // Injected alongside `open` for the same reason: the recovery paths here are defined by what
    // happens when the filesystem fails, and a test cannot drive that without standing in for it.
    this._readFile = readFileImpl;
    this.openFile = openFile;
    this.seen = new Set();
    this.byBucket = new Map(); // "season:contextHash" -> records[] in insertion order
    this._loading = null; // memoized load, so concurrent first-callers share one read
    this._tail = Promise.resolve(); // append mutex, see append()
    this.#stale = false; // set when a reload failed, so the next operation reconciles first
  }

  // Load the file once. Memoizing the in-flight promise keeps two concurrent first-callers from
  // both reading the file and double-populating the in-memory index.
  ready() {
    if (!this._loading) {
      // A FAILED LOAD IS NOT MEMOIZED. Holding the rejected promise wedged the store for the rest of
      // the process: ready() only rebuilds when `_loading` is falsy and a rejected promise is truthy,
      // so a transient read error meant every later call threw that same stale error forever, even
      // once the file was readable again. Two reviewers reached this independently from the reload
      // path; the same defect lives here, one level up, which is why it is fixed here.
      const attempt = this.#load();
      this._loading = attempt;
      attempt.catch(() => {
        if (this._loading === attempt) this._loading = null;
      });
    }
    return this._loading;
  }

  // Rebuild the in-memory index from the file. Used after an uncertain write, so a retry decides
  // against what is actually on disk rather than against what this process believes.
  //
  // THE INDEX IS NOT CLEARED UNTIL THE READ SUCCEEDS. The first version emptied `seen` and `byBucket`
  // and then memoized `#load()`, so a read that failed left the store with NO index and a rejected
  // `_loading`. `ready()` only rebuilds when `_loading` is falsy and a rejected promise is truthy, so
  // every later call threw that same error for the rest of the process lifetime, against an empty
  // index. Two reviewers reproduced it independently. A reload that fails must leave the store
  // exactly as usable as it was.
  //
  // RECONCILIATION IS SINGLE-FLIGHT, and that is the whole of this method now. The version this
  // replaces did the rollback by hand: it emptied the shared maps, remembered a `prior` pair to put
  // back, and restored them if the read failed. That is correct for one caller at a time and this
  // store never had one. A fresh full review showed what two concurrent callers did to it. Both
  // found the store behind the file, both reloaded, and each captured its own `prior` from whatever
  // the other had just installed. The reload that FAILED restored a snapshot taken before the one
  // that SUCCEEDED had finished, and `#ready()` then cleared the stale flag because its own reload
  // had returned. The store was left holding the old maps with nothing marking them old, so it
  // answered from them for the rest of the process. `seasonHasEngine` reported no zkVM registration
  // while the record was durably on disk, which is the downgrade signal reading backwards, and it is
  // the exact defect the stale flag was added to close, arriving through concurrency instead.
  //
  // Sharing one attempt removes the class rather than the interleaving. There is no `prior` to
  // restore because `#load()` now builds into its own maps and installs them only on success, and
  // there is no last-one-wins because there is only one. The flag and the maps are settled together
  // by the same outcome.
  #reconcile() {
    if (!this.#reconciling) {
      const attempt = this.#load().then(
        () => {
          this.#stale = false;
        },
        (err) => {
          // THE STORE IS KNOWN TO BE BEHIND THE FILE. `#load()` left the previous maps in place, so
          // it stays as usable as it was, and the flag is what stops that view being taken for
          // current: the uncertain record may already be in the file, so a later append deciding
          // against this view assigns an index the rebuilt tree will not agree with, and the live
          // members order diverges from the order a restart produces.
          this.#stale = true;
          throw err;
        },
      );
      this.#reconciling = attempt;
      // Clear the slot either way, so a failure is retried by the next caller rather than memoized.
      // Guarded on identity so a slower failure cannot clear a newer attempt's slot.
      const release = () => {
        if (this.#reconciling === attempt) this.#reconciling = null;
      };
      attempt.then(release, release);
    }
    return this.#reconciling;
  }

  // BUILDS INTO ITS OWN MAPS AND INSTALLS THEM ONLY ON SUCCESS. This used to populate `this.seen`
  // and `this.byBucket` as it read, which made a partly-built index observable and made a failure
  // something the caller had to undo by hand. Two costs, both real. A reload that failed needed a
  // rollback, and rollback across concurrent reloads is what F1 was. And interleaved reloads
  // remembered the same file record into the same shared maps more than once, so the duplicate
  // collapse below fired on in-memory state and warned an operator that their file held duplicate
  // records when it held one of each. Building locally means a failed load changes nothing at all.
  async #load() {
    await mkdir(dirname(this.path), { recursive: true });
    const seen = new Set();
    const byBucket = new Map();
    let duplicatesCollapsed = 0;
    let raw = "";
    try {
      raw = await this._readFile(this.path, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    // The first line may be a schedule header. Season numbers are derived from the configured season
    // length, so records written under a different length are not comparable: a duration change can
    // make today's season number equal an old one and rebuild those registrations, reviving members
    // who never re-proved. Refuse rather than reinterpret.
    // A TORN FINAL LINE IS TOLERATED, ANY OTHER MALFORMED LINE IS NOT.
    //
    // THE ASSUMPTION THIS RESTS ON, STATED because it is doing the work: a CORRECT WRITER crashing
    // is the model. This file is append-only, each record is one line written by one append, and a
    // caller is told a registration succeeded only after the fsync that completes that line. Under
    // that model an interruption can truncate only the last line, and the truncated record was
    // never reported as committed, so discarding it loses nothing a member was promised.
    //
    // What this canNOT distinguish, and does not claim to: a previously complete, committed record
    // that was later truncated by something else (a filesystem fault, an editor, a partial copy)
    // presents identically and would also be discarded. That is a real loss of a promised
    // registration. The trade is deliberate, because the alternative refused every boot after an
    // ordinary crash, but it is a trade rather than a free recovery, and the discard is logged and
    // flagged rather than silent so an operator can see it happened.
    //
    // Every other position is different. A malformed line in the MIDDLE means the file was edited,
    // corrupted, or written by something else, and silently skipping it would drop a member who WAS
    // promised their registration, quietly shrinking the tree. That still refuses.
    //
    // Before this, one truncated line refused the boot outright, so a transient crash became a
    // durable outage of the whole two-tier path until an operator hand-edited the file. Two
    // reviewers found it independently and it reproduces by truncating the last line.
    let seenHeader = false;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const t = line.trim();
      if (!t) continue;
      // The last non-empty line, and only when the file does not end in a newline, which is exactly
      // the shape an interrupted append leaves. Computed as "no later line has content" rather than
      // "is the final split element", so trailing whitespace after a torn record does not turn a
      // recoverable tail into a refused boot.
      const isTornCandidate = !raw.endsWith("\n") && lines.slice(i + 1).every((l) => l.trim() === "");
      let rec;
      try {
        rec = JSON.parse(t);
      } catch (err) {
        if (isTornCandidate) {
          console.error(
            `[registration-store] discarding a torn final line in ${this.path} (${err.message}). An ` +
              `append was interrupted before it completed, so that registration was never reported ` +
              `as committed and the member can register again.`,
          );
          this.tornTailDiscarded = true;
          // AND REPAIR THE FILE, not just this read. Ignoring the bytes fixed one process lifetime
          // and broke every later one: the next append opens the same file in append mode and writes
          // its record straight after the torn fragment, producing a single malformed line that now
          // ENDS IN A NEWLINE, so it is no longer a torn tail and the boot after that refuses
          // permanently. Truncating to the last complete newline is what makes the recovery durable.
          // Byte offset, not string length, because a multi-byte character anywhere earlier in the
          // file would otherwise put the cut in the wrong place.
          this._truncateTo = Buffer.byteLength(lines.slice(0, i).join("\n"), "utf8") + (i > 0 ? 1 : 0);
          break;
        }
        throw new Error(
          `${this.path} line ${i + 1} is not valid JSON (${err.message}). A malformed line anywhere ` +
            `but the end is not an interrupted append, so it is not discarded: doing so would drop a ` +
            `registration that WAS reported committed. Repair the file rather than starting without it.`,
        );
      }
      if (rec && rec.type === "schedule") {
        seenHeader = true;
        if (this.schedule != null && String(rec.schedule) !== String(this.schedule)) {
          throw new Error(
            `${this.path} was written under epoch/season schedule ${rec.schedule}, but this gateway ` +
              `runs ${this.schedule}. Changing the epoch or season length renumbers every period, so the ` +
              `stored registrations are not comparable. Point MNO_REG_PATH at a new file to start the ` +
              `new schedule cleanly, which forces members to re-register.`,
          );
        }
        continue;
      }
      // A DUPLICATE KEY IN THE FILE, which the write path can produce when a sync or close reports an
      // error after the record's bytes landed: the caller sees failure, the in-memory index never
      // learned the record, and a retry appends it again. Taking both would put the same commitment
      // in the members tree twice and change the root relative to the tree before the restart, which
      // is the harm. The write path below now rereads after an uncertain write so this should not
      // arise, and this stays as the safety net for a file written by an older build.
      //
      // IDENTICAL RECORDS COLLAPSE, DIFFERING ONES REFUSE. Keeping the first occurrence is
      // deterministic and reproduces the same tree on every load, which is the property that matters.
      // Two records sharing a key but disagreeing on what they say is corruption this cannot resolve,
      // and picking one would be inventing an answer.
      if (rec && seen.has(keyOf(rec))) {
        const first = (byBucket.get(bucketOf(rec)) ?? []).find((r) => keyOf(r) === keyOf(rec));
        if (!first || !sameRegistrationRecord(first, rec)) {
          throw new Error(
            `${this.path} line ${i + 1} repeats registration key ${keyOf(rec)} with different content. ` +
              `Two records for one key cannot both be right and this cannot choose between them. ` +
              `Repair the file.`,
          );
        }
        duplicatesCollapsed += 1;
        continue;
      }
      // THE RECORD'S SHAPE IS CHECKED BEFORE IT ENTERS THE INDEX. Parsing as JSON says only that the
      // bytes were syntactically valid, and a folder-access review pointed out what that lets in:
      // syntactically valid corruption reaching the member cache, a bucket bound to an impossible
      // engine and statement, or a tree materialization failing later instead of the file being
      // refused at startup. The whole point of loading is to rebuild a durable index, so a record it
      // cannot vouch for should stop the boot, where an operator can act on it.
      const bad = registrationRecordProblem(rec);
      if (bad) {
        throw new Error(
          `${this.path} line ${i + 1} is not a usable registration record (${bad}). Refusing at load ` +
            `rather than admitting it to the members tree, where it would surface later as something ` +
            `else entirely.`,
        );
      }
      this.#remember(rec, seen, byBucket);
    }
    if (duplicatesCollapsed > 0) {
      console.warn(
        `[registration] ${this.path} contained ${duplicatesCollapsed} duplicate registration ` +
          `record(s), identical to ones already loaded. Kept the first of each, so the members tree ` +
          `rebuilds the same way every time. This is the signature of an interrupted write from an ` +
          `older build; the file is usable and worth repairing.`,
      );
    }
    // REPAIR THE FILE SO IT ENDS ON A RECORD BOUNDARY, whatever shape the interruption left. There
    // are two, and the first version of this only handled one.
    //
    //   (a) The last line does not parse. The append died mid-record. Truncate it away; that
    //       registration was never reported committed, because success is returned only after fsync.
    //   (b) The last line PARSES but has no trailing newline. The append wrote every byte of the
    //       record and died before the newline. This one is not an error at all on read, so the
    //       first version scheduled no repair, and the next append then wrote its record straight
    //       onto the end of that line, producing `}{` in the middle of a line and a file that
    //       refuses every boot from then on. A reviewer reproduced exactly that.
    //
    // Case (b) keeps the record rather than discarding it: it is complete and self-consistent, and
    // the only thing missing is a delimiter this process can supply. Terminating it is the repair.
    // ready() is awaited by every writer, so neither shape survives into the next write.
    const { truncate, appendFile } = await import("node:fs/promises");
    if (this._truncateTo != null) {
      await truncate(this.path, this._truncateTo);
      this._truncateTo = null;
    } else if (raw.length > 0 && !raw.endsWith("\n")) {
      console.error(
        `[registration-store] ${this.path} ended mid-line with a COMPLETE record. An append wrote the ` +
          `whole record and stopped before its newline, so the record is kept and the line is ` +
          `terminated. Without this the next append would concatenate onto it and the boot after ` +
          `that would refuse.`,
      );
      await appendFile(this.path, "\n");
      this.tornTailTerminated = true;
    }
    // A store that predates the header cannot be checked retroactively: stamping it ASSERTS that its
    // existing records were written under the current schedule, which nobody verified. An empty store
    // is safe to stamp; one with records is not, so it needs the operator to say so.
    if (!seenHeader && this.schedule != null && seen.size > 0 && !this.assumeSchedule) {
      throw new Error(
        `${this.path} has registration records but no schedule header, so it predates this check and ` +
          `its records cannot be attributed to a schedule. If you know they were written under ` +
          `${this.schedule}, set MNO_ASSUME_SCHEDULE=1 once to stamp it; otherwise point MNO_REG_PATH ` +
          `at a new file, which forces members to re-register.`,
      );
    }
    if (!seenHeader && this.schedule != null) {
      // THROUGH A HANDLE, FLUSHED, AND THE DIRECTORY FLUSHED TOO. appendFile() creates the file and
      // returns without either. This line CREATES the registration log on a fresh deployment, so a
      // crash here could leave a file whose directory entry never became durable, and the next boot
      // would find no file at all and stamp a fresh header. Any record acknowledged in between would
      // be gone with it, which breaks the stated guarantee that a reported registration survives a
      // crash. Records appended later already flush themselves; it was only the creation that did
      // not.
      const fh = await open(this.path, "a");
      try {
        await fh.writeFile(JSON.stringify({ type: "schedule", schedule: this.schedule }) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
      const dirHandle = await open(dirname(this.path), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
    // INSTALLED LAST, after every step that can throw. Until this line the store is still serving
    // whatever it had, which is what makes a failed load a no-op rather than something to undo.
    this.seen = seen;
    this.byBucket = byBucket;
  }

  #remember(record, seen = this.seen, byBucket = this.byBucket) {
    seen.add(keyOf(record));
    const b = bucketOf(record);
    const recs = byBucket.get(b) ?? [];
    recs.push(record);
    byBucket.set(b, recs);
  }

  async has(d) {
    await this.#ready();
    return this.seen.has(keyOf(d));
  }

  // Appends are serialized through a promise chain so the unique-key check, the index
  // assignment, and the durable write form one critical section. Node runs one task at a time,
  // so chaining on _tail is enough; the swallow keeps a failed append from wedging later ones.
  append(d) {
    const result = this._tail.then(() => this.#appendOne(d));
    this._tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // EVERY PUBLIC ENTRY POINT GOES THROUGH THIS, not just the append.
  //
  // The first version of the stale flag was checked only by #appendOne, and a reviewer showed what
  // that leaves: after a successful retry barrier made a record durable and only the recovery READ
  // failed, has(), forSeasonContext(), declarationFor() and seasonHasEngine() all answered from the
  // old maps. seasonHasEngine is the one that stings, because it is the zkVM downgrade signal, so the
  // store could report no zkVM registration while the file durably held one.
  //
  // FAILING CLOSED IS THE POINT. If reconciliation cannot succeed, answering from a view known to be
  // behind the file is worse than refusing, because every caller here is making a decision that
  // assumes the answer describes durable state.
  async #ready() {
    await this.ready();
    if (!this.#stale) return;
    // Throws if it cannot reconcile, which is the fail-closed path. The flag is cleared inside the
    // shared attempt rather than here: clearing it on the strength of "my reload returned" is what
    // let a caller mark a view fresh that a concurrent failure had already replaced with an old one.
    await this.#reconcile();
  }

  async #appendOne(d) {
    await this.#ready();
    const k = keyOf(d);
    if (this.seen.has(k)) return { duplicate: true };
    const recs = this.byBucket.get(bucketOf(d)) ?? [];
    // The bucket's declaration is enforced inside this serialized section, so two concurrent first
    // registrations cannot set conflicting declarations: the second sees the first's record.
    const want = declarationOfRecord(d);
    if (recs.length > 0) {
      const declared = declarationOfRecord(recs[0]);
      if (!sameDeclaration(declared, want)) return { conflict: true, declared };
    }
    const index = recs.length;
    const record = {
      season: d.season,
      contextHash: d.contextHash,
      regNullifier: d.regNullifier,
      commitment: d.commitment,
      engine: d.engine,
      statement: d.statement,
      index,
    };
    // AN UNCERTAIN WRITE IS RESOLVED BEFORE THE CALLER CAN RETRY. The bytes can reach the file and the
    // sync or the close can still report an error, in which case the caller is told the registration
    // failed while the record is durable. The in-memory index would not know it, so the retry appended
    // the same registration a second time, and a later restart loaded both and put one commitment into
    // the members tree twice, changing the root. Rereading here is what makes the retry see the truth:
    // if the record landed, the reload learns it and the retry answers duplicate, which the
    // registration path already treats as success for the member.
    //
    // The original error is still what the caller sees. The write really was uncertain, and reporting
    // success because the reread happened to find the record would be answering a different question
    // than the one asked.
    try {
      const fh = await this.openFile(this.path, "a");
      try {
        await fh.appendFile(JSON.stringify(record) + "\n");
        await fh.sync(); // the record is on disk before we report success
      } finally {
        await fh.close();
      }
    } catch (err) {
      // AN UNCERTAIN WRITE IS RESOLVED BY RETRYING THE DURABILITY BARRIER, not by looking to see
      // whether the bytes are visible.
      //
      // The previous version rereads the file and reported success when it found the record. A
      // reviewer showed why that is wrong at the root: readFile() can see dirty page-cache data that
      // has never reached stable storage, and a FAILED sync() is precisely the case where visibility
      // and durability differ. So the reread proved the bytes existed somewhere, told the member they
      // were registered, and a crash could then lose the registration nullifier and the member
      // commitment after the fact. That is worse than the duplicate it was written to prevent,
      // because the atomic commit point silently stopped being one.
      //
      // What CAN establish durability is another barrier. Reopening the file and syncing it flushes
      // whatever is pending for that file, so a sync that now succeeds means the record is on stable
      // storage whatever happened to the first attempt. Only then is the write a commit, and the
      // reread is used solely to learn the index the record actually carries.
      let landed = null;
      try {
        const fh = await this.openFile(this.path, "r+");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        // The barrier held. Now find the record, and REQUIRE IT TO BE OURS. Searching by key alone
        // accepted a record another writer had put there under the same key, and reported that
        // writer's commitment as this caller's successful write while the live tree got this
        // caller's. The file backend is documented single-writer and nothing enforces it, so the
        // comparison is what makes the claim true rather than merely likely.
        await this.#reconcile();
        const found = (this.byBucket.get(bucketOf(d)) ?? []).find((r) => keyOf(r) === k) ?? null;
        if (found && sameRegistrationRecord(found, record)) landed = found;
        else if (found) {
          // Someone else's record holds this key. This write did not win, and saying so is the only
          // honest answer: the caller must not append its own commitment to the live tree.
          return { duplicate: true };
        }
      } catch {
        // The barrier did not hold, or the reread failed. Either way the write is genuinely uncertain
        // and the original error is what the caller needs to see.
      }
      if (landed) return { duplicate: false, index: landed.index };
      throw err;
    }
    this.#remember(record);
    return { duplicate: false, index };
  }

  async forSeasonContext(season, contextHash) {
    await this.#ready();
    return [...(this.byBucket.get(`${season}:${contextHash}`) ?? [])];
  }

  async declarationFor(season, contextHash) {
    await this.#ready();
    const recs = this.byBucket.get(`${season}:${contextHash}`);
    return recs && recs.length > 0 ? declarationOfRecord(recs[0]) : null;
  }

  async seasonHasEngine(season, engine) {
    await this.#ready();
    return bucketsHaveEngine(this.byBucket, season, engine);
  }
}
