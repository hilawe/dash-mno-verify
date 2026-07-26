// A durable ledger of the access an adapter has granted, shared by every adapter that hands out
// time-bounded access. Telegram and Matrix once invited a member and never took the access back, so a
// grant outlived the epoch it was issued for; the lifecycle was extracted from the Discord adapter,
// which was the only one that had a complete one.
//
// The two properties that make it correct, both inherited from the Discord original:
//   - Persist before applying. A crash between the two leaves a record with no access, which the
//     sweep harmlessly clears, never access with no record, which would be permanent and untracked.
//   - No two operations on the SAME member interleave, so a member who re-verifies while a sweep is
//     in flight keeps their fresh access instead of having the stale revoke land on top of it.
//
// A record is whatever the adapter needs, plus a finite `expiresAt`.
//
// WHY SQLITE, AND WHY IT IS A CORRECTNESS CHANGE RATHER THAN A PERFORMANCE ONE
//
// This was a JSON file rewritten in full on every change, guarded by one global promise queue. Four
// review rounds looked at that arrangement and every one of them found defects in it, the last two
// finding their defects inside the previous round's fixes. The recurring shape was always the same:
// a piece of state was updated in memory, the write that would make it durable was ENQUEUED behind
// the operation doing the updating, and a decision reached the caller in between. The clock
// high-water mark alone was rewritten three times under that pattern.
//
// node:sqlite's DatabaseSync removes the shape rather than patching another instance of it. Reads and
// writes are synchronous and durable at the point of call, so "observed" and "persisted" are the same
// instant and there is no window to lose. Nothing here enqueues a save any more, because there is no
// save to enqueue. What remains asynchronous is exactly what genuinely is, the platform calls in
// `apply` and `revoke`.
//
// The other two things it buys, both of which were tracked follow-ups:
//   - Per-member locking instead of one global queue. The global queue existed because a whole-map
//     rewrite could otherwise persist another member's in-flight record. With a per-row store that
//     cannot happen, so one member's slow platform call no longer blocks every other member's grant.
//   - Cross-process safety. The old file locking assumed a single process per adapter, and two
//     instances would have interleaved whole-map writes and lost grants. SQLite arbitrates, the clock
//     floor is read back from the database on every observation rather than trusted from memory, and
//     the mark is raised with a MAX so a lagging process cannot pull another's floor back down.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS grants (
    user_id    TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    record     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grants_expires_at ON grants (expires_at);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class GrantLedger {
  #db;
  #chain = new Map(); // userId -> tail of that member's operation chain
  #stmt = {};

  // `validate` decides whether a record is well formed, and `orphaned(prev, next)` returns the part
  // of a prior grant a renewal does not carry forward (so it can be revoked before the new grant is
  // applied). Both are injected because they are the only platform-specific parts: Discord has two
  // grant modes with different targets, while an adapter that simply admits and removes a user has
  // one shape and nothing to migrate.
  //
  // `importFrom` is the legacy JSON ledger to adopt on first open. It is explicit rather than derived
  // from the database name, because silently reading a different file than the one configured is the
  // kind of thing an operator should not have to discover.
  constructor({
    file,
    apply,
    revoke,
    validate = (r) => Boolean(r) && Number.isFinite(r.expiresAt),
    orphaned = () => null,
    now = () => Math.floor(Date.now() / 1000),
    resetClock = false,
    log = () => {},
    importFrom = null,
    putFn = null,
  } = {}) {
    this.file = file;
    this.validate = validate;
    this.orphaned = orphaned;
    this.apply = apply;
    this.revoke = revoke;
    this.now = now;
    this.log = log;
    this.putFn = putFn; // injectable so the persist-failure path stays testable

    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    // Narrow the file BEFORE enabling write-ahead logging: SQLite creates the sibling -wal and -shm
    // files from the database file's own mode, so doing this afterwards leaves those two holding the
    // same rows at the default mode. The ledger pairs platform accounts with the access they hold,
    // which is not as sensitive as the gateway's nullifier store but is not public either.
    if (file !== ":memory:") {
      try {
        chmodSync(file, 0o600);
      } catch (e) {
        throw new Error(`refusing to start: cannot restrict ${file} to mode 0600 (${e.message})`);
      }
    }
    this.#db.exec("PRAGMA journal_mode=WAL");
    // The caller is told a grant was recorded only once the write reached disk, which is the whole of
    // persist-before-apply. One flush per grant is nothing next to the platform call that follows it.
    this.#db.exec("PRAGMA synchronous=FULL");
    // Two adapter processes on one ledger should wait for each other rather than fail immediately.
    this.#db.exec("PRAGMA busy_timeout=5000");
    this.#db.exec(SCHEMA);

    this.#stmt = {
      get: this.#db.prepare("SELECT record FROM grants WHERE user_id=?"),
      all: this.#db.prepare("SELECT user_id, record FROM grants"),
      due: this.#db.prepare("SELECT user_id FROM grants WHERE expires_at <= ? ORDER BY user_id"),
      put: this.#db.prepare(
        "INSERT INTO grants (user_id, expires_at, record, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at, record=excluded.record, updated_at=excluded.updated_at",
      ),
      del: this.#db.prepare("DELETE FROM grants WHERE user_id=?"),
      count: this.#db.prepare("SELECT COUNT(*) AS n FROM grants"),
      readMeta: this.#db.prepare("SELECT v FROM meta WHERE k=?"),
      // MAX, not a plain assignment. Another process may already have observed a later time, and a
      // lagging one must never pull the shared floor back down.
      raiseMark: this.#db.prepare(
        "INSERT INTO meta (k, v) VALUES ('clockMark', ?) " +
          "ON CONFLICT(k) DO UPDATE SET v = MAX(CAST(meta.v AS INTEGER), CAST(excluded.v AS INTEGER))",
      ),
      setMeta: this.#db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"),
      delMeta: this.#db.prepare("DELETE FROM meta WHERE k=?"),
    };

    this.#importLegacy(importFrom);
    this.#validateAll();

    // A large forward clock jump, once observed, floors every later decision above every real
    // deadline, so existing grants read as expired and admissions are refused until wall time catches
    // up. That is the conservative direction but it has no way back on its own, so the operator gets
    // one: start once with resetClock and the floor drops to the current clock. It is deliberately
    // explicit and logged, because using it while the clock is genuinely wrong reopens the rollback
    // hole the floor exists to close.
    if (resetClock) {
      this.log(`clock floor reset by request: was ${this.#mark()}, now ${this.now()}`);
      this.#stmt.delMeta.run("clockMark");
      this.#stmt.delMeta.run("clockRegressed");
    }
    // Compare the loaded high-water against the clock immediately, so a process that STARTS behind its
    // own mark records that before it can answer a single admission.
    this.#observeClock();
  }

  // ---- durable state, all synchronous ------------------------------------------------------------

  #mark() {
    const row = this.#stmt.readMeta.get("clockMark");
    if (row === undefined) return null;
    const n = Number(row.v);
    return Number.isFinite(n) ? n : null;
  }

  #regression() {
    const row = this.#stmt.readMeta.get("clockRegressed");
    if (row === undefined) return null;
    try {
      return JSON.parse(row.v);
    } catch {
      // A meta row we cannot parse is not a reason to forget that a regression happened.
      return { unparsed: row.v };
    }
  }

  #row(userId) {
    const row = this.#stmt.get.get(String(userId));
    if (row === undefined) return null;
    return this.#parse(String(userId), row.record);
  }

  #parse(userId, json) {
    let record;
    try {
      record = JSON.parse(json);
    } catch (e) {
      throw new Error(
        `grant ledger ${this.file} has an unreadable record for ${userId} (${e.message}). Fix or remove it.`,
      );
    }
    // The mode-specific target must be present, or a sweep would delete the record without being able
    // to revoke the real platform access.
    if (!this.validate(record)) {
      throw new Error(`grant ledger ${this.file} has a malformed record for ${userId}. Fix or remove it.`);
    }
    return record;
  }

  // A corrupt or malformed ledger is an error, not "nothing to revoke": loading it as empty would
  // silently strand every live grant, so fail startup and let the operator fix or remove it.
  #validateAll() {
    for (const row of this.#stmt.all.all()) this.#parse(row.user_id, row.record);
  }

  #put(userId, record) {
    const write = () =>
      this.#stmt.put.run(String(userId), Number(record.expiresAt), JSON.stringify(record), Date.now());
    return this.putFn ? this.putFn(write, userId, record) : write();
  }

  // ---- the guarded clock -------------------------------------------------------------------------

  // Time moving forward raises the mark; time moving backwards is recorded and stays recorded. Both
  // are written at the moment they are observed, so no part of this exists only in memory, which is
  // what every earlier version got wrong in a different way.
  #observeClock() {
    const t = this.now();
    const mark = this.#mark();
    if (mark == null || t > mark) {
      this.#stmt.raiseMark.run(String(t));
      return;
    }
    if (t < mark && this.#regression() == null) {
      this.#stmt.setMeta.run("clockRegressed", JSON.stringify({ observed: t, mark, at: t }));
    }
  }

  // The time every expiry decision is made against: the wall clock, floored at the highest value ever
  // observed. This is the resolution of two opposing review findings. Treating a regression as
  // "revoke everything" meant a routine one-second correction destroyed every member's access, and
  // combined with a sticky flag it bricked the adapter permanently. Ignoring a regression meant a
  // rolled-back clock revived grants that had already expired. Flooring at the mark does neither:
  // time never moves backwards for expiry purposes, so nothing revives and nothing is mass-revoked.
  // A forward jump that is later corrected leaves the mark high, which expires grants early, the
  // conservative direction, and `resetClock` is the way back from one.
  #effective() {
    const t = this.now();
    const mark = this.#mark();
    return mark == null ? t : Math.max(t, mark);
  }

  // ---- per-member serialization ------------------------------------------------------------------

  // One chain per member, so operations on the same member never interleave while unrelated members
  // proceed in parallel. The global queue this replaces made every grant wait behind every other
  // member's platform call, which was the head-of-line blocking the reviews kept flagging.
  #run(userId, fn) {
    const key = String(userId);
    const prev = this.#chain.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run once the previous op settles, either way
    const settled = run.then(
      () => {},
      () => {},
    );
    this.#chain.set(key, settled);
    // Drop the entry once this is the tail, so the map does not grow with every member ever seen.
    settled.then(() => {
      if (this.#chain.get(key) === settled) this.#chain.delete(key);
    });
    return run;
  }

  // ---- the lifecycle -----------------------------------------------------------------------------

  // Migrate any orphaned prior targets, persist the record, then apply the platform access. If
  // persistence fails, nothing was written and nothing is granted. If applying fails, the record
  // stays, so it covers any access that could be live and the sweep can clean it up. Every failure
  // throws, so the caller can tell the member to retry.
  async grant(userId, record) {
    if (!this.validate(record)) throw new Error(`refusing to grant a malformed record for ${userId}`);
    return this.#run(userId, async () => {
      // Issuing a grant is an observation of the clock, and it is durable before anything below acts
      // on it. The old version enqueued this write behind the very operation doing the observing, so
      // the refusal below could reach the caller while the advance was still only in memory.
      this.#observeClock();
      // Refuse a deadline that has already passed. Near an epoch boundary a slow queue or a slow
      // platform call could otherwise apply access that is expired the moment it is granted, and it
      // would then sit live until the next sweep, up to a full sweep interval later.
      // Deliberately the unfloored clock. The gateway owns this deadline and issued it against ITS
      // clock; the floor exists to stop a rolled-back adapter clock reviving an EXISTING grant. Using
      // the floor here would mean a forward clock glitch, once recorded, rejected every new grant
      // until wall time caught up to the inflated mark, which is an outage lasting as long as the
      // jump. A grant accepted under a rolled-back clock is not a hole either: sweep and admitIfLive
      // judge it against the floor and remove it.
      if (this.now() >= record.expiresAt) {
        throw new Error(`refusing to grant ${userId} access that has already expired`);
      }
      const prev = this.#row(userId);
      // If a renewal changes the target, revoke the parts of the prior grant the new one does not
      // carry forward, before applying the new grant, so old access (including a different mode, room
      // or role id) is never left live and untracked. If that revoke fails, abort the renewal. The
      // prior row is unchanged, so its access stays fully tracked and live.
      const orphan = prev ? this.orphaned(prev, record) : null;
      if (orphan) {
        try {
          await this.revoke(userId, orphan);
        } catch (e) {
          throw new Error(`could not migrate the prior grant: ${e.message}`);
        }
      }

      try {
        this.#put(userId, record);
      } catch (e) {
        // A single statement either committed or it did not, so there is nothing to roll back.
        throw new Error(`could not persist grant: ${e.message}`);
      }
      try {
        await this.apply(userId, record);
      } catch (e) {
        // The stored record covers every target that could be live now: a first grant's uncertain new
        // access, or on a renewal the prior carried-forward targets (still live) plus any partial new
        // ones, since the orphaned old targets were revoked above. Leave it so the sweep covers it. On
        // a first grant there is no prior access, so also best-effort revoke the uncertain new access.
        if (!prev) await this.revoke(userId, record).catch(() => {});
        throw e;
      }
    });
  }

  // Revoke every grant whose epoch has lapsed. Returns the user ids actually revoked, so the caller
  // can notify them.
  async sweep() {
    // Judge against the floored clock, so a rolled-back wall clock neither hides work that is due nor
    // manufactures work that is not. Revoking everything on any regression was an earlier cut, and it
    // turned a one-second correction into a mass revocation.
    this.#observeClock();
    const due = this.#stmt.due.all(this.#effective()).map((r) => r.user_id);
    const revoked = [];
    for (const userId of due) {
      // The record is re-read and re-judged INSIDE the member's own lock. That, not the order things
      // were enqueued in, is what stops a stale revoke landing on access a concurrent re-verification
      // just granted. Taking one member's lock at a time is also what lets unrelated grants proceed
      // while a long sweep runs.
      await this.#run(userId, async () => {
        const live = this.#row(userId);
        if (!live) return;
        if (this.#effective() < live.expiresAt) return; // re-verified meanwhile, leave it alone
        try {
          await this.revoke(userId, live);
        } catch (e) {
          this.log(`revoke failed for ${userId}, keeping the grant to retry: ${e.message}`);
          return; // a real revoke failure must not drop the record, or live access goes untracked
        }
        this.#stmt.del.run(String(userId));
        revoked.push(userId);
      });
    }
    return revoked;
  }

  // Decide admission and perform it inside the member's lock, so a sweep cannot revoke and delete
  // between the liveness check and the platform call. Without this the two ran unsynchronized: a
  // handler could read a live grant, await the approval, and have the sweep delete the record while
  // that call was in flight, leaving a member admitted with no record and therefore never swept
  // again. If the grant expires while `admit` is running, the record still exists, so the next sweep
  // removes them, which is the property that makes this safe rather than merely narrower.
  //
  // `matches` optionally checks the record against the caller's current target, so a record written
  // for one chat or room cannot authorize admission to another.
  async admitIfLive(userId, admit, matches = () => true) {
    return this.#run(userId, async () => {
      this.#observeClock(); // durable at the point of call, so admitting on it is safe
      const record = this.#row(userId);
      const t = this.#effective();
      if (!record || t >= record.expiresAt) return false;
      if (!matches(record)) return false;
      await admit(record);
      return true;
    });
  }

  // ---- reads -------------------------------------------------------------------------------------

  has(userId) {
    return this.#stmt.get.get(String(userId)) !== undefined;
  }

  // The live record, or null. Adapters that admit a member at a later moment than the grant (Telegram
  // approves a join request that arrives after verification) consult this to decide.
  get(userId) {
    return this.#row(userId);
  }

  // Whether a grant exists and has not lapsed. A read-only report: callers that ADMIT on the strength
  // of it must use admitIfLive, which does the same check inside the member's lock.
  live(userId) {
    this.#observeClock();
    const r = this.#row(userId);
    return Boolean(r) && this.#effective() < r.expiresAt;
  }

  // Whether any record matches. Used by the startup reconciliation gate, which must ask "does this
  // ledger cover the target now configured" rather than "does it hold anything at all": records for a
  // previous room or group say nothing about the members of the current one.
  some(predicate) {
    for (const row of this.#stmt.all.all()) {
      if (predicate(this.#parse(row.user_id, row.record), row.user_id)) return true;
    }
    return false;
  }

  size() {
    return this.#stmt.count.get().n;
  }

  // Reported for the operator, not used to gate access: the effective clock already prevents a
  // regression from reviving a grant, so refusing service on top of that would only add an outage.
  get clockIsSane() {
    return this.#regression() == null;
  }

  get clockStatus() {
    return { mark: this.#mark(), regression: this.#regression() };
  }

  close() {
    this.#db.close();
  }

  // ---- adopting the file this replaces -----------------------------------------------------------

  // Read a legacy JSON ledger into the database, once, on a fresh database. Everything lands in one
  // transaction, so an interrupted migration leaves the database untouched rather than half-adopted,
  // and the JSON is only renamed aside after that transaction commits. A malformed record fails the
  // migration for the same reason it fails a load: adopting it as empty would strand live access.
  #importLegacy(importFrom) {
    if (!importFrom || !existsSync(importFrom)) return;
    if (this.#stmt.count.get().n > 0 || this.#stmt.readMeta.get("importedFrom") !== undefined) return;

    let obj;
    try {
      obj = JSON.parse(readFileSync(importFrom, "utf8"));
    } catch (e) {
      throw new Error(`legacy grant ledger ${importFrom} is not valid JSON (${e.message}). Fix or remove it.`);
    }
    // Newer files are { meta, grants }; the oldest are a flat map of user id to record.
    const grants = (obj?.grants && typeof obj.grants === "object" ? obj.grants : obj) ?? {};
    const mark = Number(obj?.meta?.clockMark);
    const regressed = obj?.meta?.clockRegressed;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const [userId, record] of Object.entries(grants)) {
        if (!this.validate(record)) {
          throw new Error(
            `legacy grant ledger ${importFrom} has a malformed record for ${userId}. Fix or remove it, ` +
              `then start again to migrate.`,
          );
        }
        this.#stmt.put.run(String(userId), Number(record.expiresAt), JSON.stringify(record), Date.now());
      }
      if (Number.isFinite(mark)) this.#stmt.raiseMark.run(String(mark));
      if (regressed) this.#stmt.setMeta.run("clockRegressed", JSON.stringify(regressed));
      this.#stmt.setMeta.run("importedFrom", String(importFrom));
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
    // Only now, with the rows committed, move the old file aside. Leaving it would make the next start
    // try to import it again into a database that already holds it, and deleting it would throw away
    // the operator's only copy of the previous state.
    const kept = `${importFrom}.migrated`;
    renameSync(importFrom, kept);
    this.log(
      `migrated ${Object.keys(grants).length} grant(s) from ${importFrom} into ${this.file}; ` +
        `the old file is now ${kept}`,
    );
  }
}
