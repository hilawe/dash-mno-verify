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
// It also allows per-member locking instead of one global queue. The global queue existed because a
// whole-map rewrite could otherwise persist another member's in-flight record. With a per-row store
// that cannot happen, so one member's slow platform call no longer blocks every other member's grant.
//
// WHAT THIS DOES NOT DO, STATED PLAINLY BECAUSE IT WAS TWICE CLAIMED THAT IT DID
//
// It does not make two processes on one ledger safe. The per-member chain is a promise chain in
// memory and binds only its own process; SQLite serializes individual statements, but a grant is a
// statement, then an await on a platform call, then another statement, and nothing holds a lock
// across that gap. Two processes could interleave a removal and a fresh grant and leave live access
// with no record.
//
// The answer is not to make two processes safe, it is to make two processes impossible. The database
// is opened in an exclusive locking mode: the kernel holds it for the life of the process and a second
// process is refused.
//
// What that claim rests on, since this comment has overstated things before. A holder process spawned
// for real, with the parent asserting the holder is still running before concluding anything, refused
// a second opener 90 times out of 90 under six-way concurrency. An independent reviewer separately
// confirmed refusal on a local filesystem both while the holder ran and while it was suspended. An
// earlier version of that test let its holder exit before the check, which produced an intermittent
// result that looked like the lock leaking and was actually the test lying; see the comment on it.
//
// THE LIMITS OF THAT, because this claim has been overstated twice and corrected twice.
//
//   Local storage only. SQLite's exclusion is the filesystem's, and SQLite's own documentation says
//   locking is unreliable on network filesystems. On an NFS mount two hosts can both believe they hold
//   the lock, which brings back the interleaving above and can corrupt the file. Nothing here can
//   detect that, so it is a deployment requirement, stated in the adapter READMEs.
//
//   Process life only. The lock dies with the process, which is what makes it safe, and it is also the
//   edge it cannot cover: a process that persisted a grant, sent the platform request, had it ACCEPTED,
//   and was then terminated before the effect landed releases the lock while that request is still in
//   flight. A replacement can start, find the grant expired, remove it, delete the row, and then the
//   dead process's request takes effect. Live access with no record. No local lock closes this, because
//   the holder is gone and the side effect is on someone else's server. The mitigation is reconciling
//   against real platform state at startup, which Matrix and Discord both do; Telegram cannot do the
//   general form, because its API exposes no member roster, so for Telegram this stays open.
//   Do not describe the non-interleaving property as holding across a process death.
//
//   Not absolute under a starved scheduler. The refusal is an OS advisory (fcntl) lock, and its
//   enforcement is only as reliable as the kernel under load. Reproduced on Linux under heavy CPU
//   contention, a second opener is admitted a few percent of the time even though the holder still
//   holds a full exclusive lock (confirmed by reading /proc/locks), and the harder openers hammer the
//   file the lower the refusal rate falls. No journal mode changes this: rollback leaks more than WAL,
//   and a forced BEGIN EXCLUSIVE does not help, because the miss is below SQLite, at the kernel's
//   advisory-lock enforcement. On a quiescent host, and on the local storage required above, an
//   established holder refuses every opener, so this is a property of an overloaded box rather than of
//   the ledger, but it is why the "refused every time" phrasing is scoped to a non-starved system and
//   why the test that checks it polls past the rare miss and retries a fresh holder instead of
//   asserting an immediate absolute (test/adapter_grant_expiry.test.js).
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// `rev` increments on every write to a row and is what makes the sweep's delete conditional. Without
// it the delete was unconditional and ran after the platform call, so a fresh grant written by ANOTHER
// process during that call was silently deleted by this one, leaving live access with no record.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS grants (
    user_id    TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    record     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,   -- the injected clock, recorded for operators; never read for a decision
    rev        INTEGER NOT NULL DEFAULT 1
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
    // A record that covers BOTH the new grant and the prior targets it orphans, or NULL when this
    // adapter's record shape cannot express one.
    //
    // The default is null on purpose, and it must stay null. An adapter whose record names exactly one
    // room or chat, as Matrix and Telegram do, has nowhere to put a second target, so there is no
    // covering record to write. Returning the new record instead would be a claim that it covers the
    // old target when it does not, and the ordering below would then write the new target BEFORE the
    // old one is revoked, leaving that access live with nothing naming it. That is worse than the
    // ordering it replaced, and it is what a default of `record` did to two adapters.
    covering = () => null,
    // Whether this adapter runs a pass that reapplies access from a live record.
    //
    // OFF by default, and that default is the whole point. Keeping a record after an uncertain apply
    // failure is only safe for an adapter that will later finish the job from it. Discord has such a
    // pass. Matrix and Telegram do not, and when this policy was introduced for Discord it silently
    // applied to them too: their member ended up with a live row, no access, no retry, and a spent
    // one-time proof, while being told to verify again. A shared default that is correct for exactly
    // one of three callers is a trap, so an adapter has to say it can repair before it gets the
    // behaviour that assumes repair.
    repairs = false,
    now = () => Math.floor(Date.now() / 1000),
    resetClock = false,
    log = () => {},
    importFrom = null,
    // The platform place this ledger's grants live in: a Discord guild, a Matrix room, a Telegram
    // chat. It is bound into the database itself on first use, not merely recorded on each record.
    //
    // Per-record fields alone could not carry this. A record written before the field existed reads as
    // "unknown", every safe answer to unknown was wrong, and treating unknown as "ours" let a repointed
    // adapter revoke a legacy record against the new place, receive a not-found the code already
    // classified as already-gone, and delete the row while the access stayed live and untracked in the
    // old one. Binding the DATABASE removes the question: every row in it belongs to the bound scope by
    // construction, whatever any individual record does or does not say.
    scope = null,
    // The operator asserting, by naming it, which scope an existing unbound ledger belongs to. Adoption
    // cannot be inferred, because the whole problem is that the origin of those rows is unknowable from
    // inside the process. It must equal `scope`, so a mistyped value refuses rather than adopting the
    // rows into the wrong place.
    adoptScope = null,
    // The cleanup tool's way past the scope refusal, and nothing else's.
    //
    // The refusal exists to stop a repointed ADAPTER sweeping rows for a place it cannot reach, which
    // would delete the only record of live access. It caught the decommission command too, and that
    // produced a deadlock: the startup guard told the operator to point at the old guild and
    // decommission there, and the ledger then refused to open for the old guild because the database
    // was bound to the new one. Neither guard could be satisfied, and a guard whose documented exit is
    // blocked by another guard is worse than no guard.
    //
    // Safe for this caller specifically, because decommission does not sweep. It acts on one target an
    // operator named, previews by default, and needs --apply to change anything. It is loud when used.
    allowForeignScope = false,
    putFn = null,
    // TEST SEAM. `exclusive: false` disables the single-writer lock, and exists only so tests can open
    // a second connection while a ledger is live. No adapter spreads operator configuration into these
    // options (each constructs a literal), and nothing must ever start: a config key reaching this
    // would silently restore the cross-process interleaving three rounds were spent closing.
    exclusive = true,
  } = {}) {
    this.file = file;
    this.validate = validate;
    this.orphaned = orphaned;
    this.covering = covering;
    this.repairs = Boolean(repairs);
    this.apply = apply;
    this.revoke = revoke;
    this.now = now;
    this.log = log;
    this.putFn = putFn; // injectable so the persist-failure path stays testable

    // Owner-only on the directory too. The database and its siblings are set to 0600 below, which a
    // direct check confirms covers the -wal and -shm files, but a restrictive directory costs nothing
    // and still holds if a chmod ever fails on an unusual filesystem.
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(file);
    // Everything below the open can throw: a chmod that fails, a malformed row, a migration that
    // refuses a bad record. The exclusive lock is taken by the first statement, so leaving the handle
    // open on the way out would mean the operator cannot open the database to fix the very thing the
    // error just told them to fix. Close it, then rethrow the original.
    try {
      this.#open({ file, exclusive, importFrom, resetClock, scope, adoptScope, allowForeignScope });
    } catch (e) {
      try {
        this.#db.close();
      } catch {
        // already closed, or never got far enough to matter
      }
      throw e;
    }
  }

  #open({ file, exclusive, importFrom, resetClock, scope, adoptScope, allowForeignScope }) {
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
    // ONE PROCESS AT A TIME, enforced by the operating system rather than by us.
    //
    // A grant or a removal is a statement, then an await on a platform call, then another statement.
    // SQLite serializes the statements but nothing holds a lock across that gap, and the per-member
    // chain that does hold it is a promise chain in memory, so it binds only its own process. Two
    // processes could therefore interleave a removal and a fresh grant for one member and leave live
    // access with no record.
    //
    // A previous attempt at this was a lease row with a staleness timeout. It did not work, for
    // reasons worth recording so nobody rebuilds it: the timeout has to be longer than the longest
    // quiet period or a live-but-idle bot loses its ledger (the default sweep intervals, 60s and 300s,
    // were already longer than the window), the old owner's next operation silently took the claim
    // back because refreshes were not conditioned on still owning it, a backward wall-clock step made
    // the age negative and read as stale, and nothing in any adapter released it on shutdown.
    //
    // An exclusive locking mode is the primitive that was wanted all along. The kernel holds it for
    // the life of the process and drops it when the process dies, however it dies, so there is no
    // staleness window to reason about, no heartbeat, no ownership fencing, and no signal handler to
    // forget. A second process is refused outright.
    if (exclusive && file !== ":memory:") this.#db.exec("PRAGMA locking_mode=EXCLUSIVE");
    this.#db.exec("PRAGMA journal_mode=WAL");
    // The caller is told a grant was recorded only once the write reached disk, which is the whole of
    // persist-before-apply. One flush per grant is nothing next to the platform call that follows it.
    this.#db.exec("PRAGMA synchronous=FULL");
    // Two adapter processes on one ledger should wait for each other rather than fail immediately.
    this.#db.exec("PRAGMA busy_timeout=5000");
    this.#db.exec(SCHEMA);
    // A database written before `rev` existed has no such column, and CREATE TABLE IF NOT EXISTS will
    // not add one. Add it in place rather than making the operator start over.
    if (!this.#db.prepare("PRAGMA table_info(grants)").all().some((c) => c.name === "rev")) {
      this.#db.exec("ALTER TABLE grants ADD COLUMN rev INTEGER NOT NULL DEFAULT 1");
    }

    this.#stmt = {
      get: this.#db.prepare("SELECT record, rev FROM grants WHERE user_id=?"),
      all: this.#db.prepare("SELECT user_id, record FROM grants"),
      due: this.#db.prepare("SELECT user_id FROM grants WHERE expires_at <= ? ORDER BY user_id"),
      put: this.#db.prepare(
        "INSERT INTO grants (user_id, expires_at, record, updated_at, rev) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at, record=excluded.record, " +
          "updated_at=excluded.updated_at, rev=excluded.rev",
      ),
      // A database-wide counter, never reset and never reused. Deriving the revision from the ROW
      // (starting at 1 on insert, incrementing on update) let a row be deleted and reinserted at the
      // same revision, so a stale sweep's conditional delete matched the fresh row anyway and deleted
      // it, which is the exact outcome the conditional delete exists to prevent. RETURNING makes the
      // bump and the read one statement.
      nextRev: this.#db.prepare(
        "INSERT INTO meta (k, v) VALUES ('revSeq', '1') " +
          "ON CONFLICT(k) DO UPDATE SET v = CAST(meta.v AS INTEGER) + 1 RETURNING CAST(v AS INTEGER) AS rev",
        // The row is seeded above every existing revision at open (see #seedRevSeq), so the literal 1
        // here is only ever reached on a database with no counter AND no rows.
      ),
      // Conditional on the revision the caller read. See the sweep for why.
      del: this.#db.prepare("DELETE FROM grants WHERE user_id=? AND rev=?"),
      // Unconditional, for the offline retirement only. Every online deletion goes through `del` and
      // its revision check, because a concurrent grant must not be deleted by a stale sweep. A
      // retirement runs with the exclusive lock held and no adapter running, so there is no concurrent
      // writer whose revision could matter.
      delAny: this.#db.prepare("DELETE FROM grants WHERE user_id=?"),
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

    this.#seedRevSeq();
    // A mismatch is checked BEFORE the import, because the import renames the source file once it
    // commits and an operator who pointed the adapter at the wrong place should not have their legacy
    // file moved as a side effect of the attempt.
    this.#refuseForeignScope(scope, importFrom, allowForeignScope);
    this.#importLegacy(importFrom);
    // Binding happens AFTER the import, so rows adopted from a legacy JSON file are judged by the same
    // rule as rows already in the database. A fresh ledger binds silently. A ledger that already holds
    // grants of unknown origin refuses until the operator names the scope.
    this.#bindScope(scope, adoptScope);
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

  // ---- scope binding -----------------------------------------------------------------------------

  // The scope this database is bound to, or null while it is still unbound.
  scope() {
    return this.#stmt.readMeta.get("scope")?.v ?? null;
  }

  // A database bound to somewhere else describes access this process cannot reach. Sweeping it would
  // revoke against the wrong place, get an already-gone answer, and delete the only record of live
  // access. Refuse, and say what to do about it.
  #refuseForeignScope(scope, importFrom, allowForeignScope = false) {
    const bound = this.scope();
    if (bound === null || scope === null || String(bound) === String(scope)) return;
    if (allowForeignScope) {
      this.log(
        `${this.file} is bound to ${bound} and this process is configured for ${scope}. Continuing ` +
          `anyway because this is the cleanup tool, which acts only on the target it was given. The ` +
          `binding is NOT changed.`,
      );
      return;
    }
    // An EMPTY bound ledger is rebound rather than refused, and that is the difference between a guard
    // and a trap. The refusal exists to stop live access being forgotten, so with no grants left there
    // is nothing to forget and nothing to protect. Refusing anyway made the documented recovery
    // impossible to complete: an operator who decommissioned the old place correctly still could not
    // start anywhere else, because the binding outlived the grants it was protecting and no sweep could
    // clear it. The guard has to have an exit that ordinary correct operation reaches.
    // Rows ALREADY here, plus rows a pending legacy import is about to add. Counting only the former
    // was a hole: an empty database bound to somewhere else was rebound here, the import then brought
    // in rows of unknown origin, and #bindScope saw a scope already set and never asked the operator
    // where those rows came from. The comment on #bindScope says imported rows meet the same rule as
    // rows already present, and that was true of every path except this one. The pending file is only
    // PEEKED at, never consumed, so a refusal below does not move the operator's file aside.
    const rows = this.#stmt.count.get().n + this.#pendingLegacyCount(importFrom);
    if (rows === 0) {
      this.#stmt.setMeta.run("scope", String(scope));
      this.log(
        `${this.file} was bound to ${bound} and holds no grants, so it has been rebound to ${scope}. ` +
          `Nothing was tracked against ${bound} any more.`,
      );
      return;
    }
    throw new Error(
      `refusing to start: ${this.file} is bound to ${bound} and still holds ${rows} grant(s), but this ` +
        `adapter is configured for ${scope}. Those grants name access that is live in ${bound} and ` +
        `unreachable from here, so sweeping them would delete the only record of it. Point the adapter ` +
        `back at ${bound}, take the access back there, and let the ledger empty. The ledger rebinds by ` +
        `itself once it holds nothing. Alternatively configure a different ledger file for ${scope} and ` +
        `keep this one until ${bound} is settled.`,
    );
  }

  // Rewrite every record through `transform`, in one transaction, for an offline retirement.
  //
  // A decommission takes access back on the platform and then has to say so here, because the ledger's
  // rows are not history: the sweep treats every row as revocation work that is still owed. Leaving a
  // retired target in a record meant the sweep would clear those permission bits AGAIN when the record
  // finally expired, long after the channel had been repurposed, removing access an operator had since
  // granted for an unrelated reason. And leaving whole rows behind meant a bound ledger never emptied,
  // so the scope guard above could never release.
  //
  // `transform(record, userId)` returns a replacement record, or null to drop the row, or the record
  // it was given to leave it alone. Returning a record that does not validate aborts the whole
  // retirement, because a partially rewritten ledger is worse than an untouched one.
  //
  // This is deliberately NOT on the per-member queue. It is an offline operation: the exclusive lock
  // means the adapter cannot be running against this file while it happens, which is the property that
  // makes a single transaction over every row safe.
  retireAll(transform) {
    const rows = this.#stmt.all.all();
    let changed = 0;
    let deleted = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const userId = row.user_id;
        const before = this.#parse(userId, row.record);
        const after = transform(before, userId);
        if (after === before) continue;
        if (after === null) {
          this.#stmt.delAny.run(userId);
          deleted += 1;
          continue;
        }
        if (!this.validate(after)) {
          throw new Error(
            `retirement would leave ${userId} with an invalid record (${JSON.stringify(after)}). ` +
              `Nothing was changed.`,
          );
        }
        this.#stmt.put.run(
          userId,
          Math.floor(after.expiresAt),
          JSON.stringify(after),
          this.now(),
          this.#stmt.nextRev.get().rev,
        );
        changed += 1;
      }
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
    return { changed, deleted, remaining: this.size() };
  }

  // Bind an unbound database, but only when it is safe to do so without asking.
  //
  // An EMPTY ledger has no history to get wrong, so it binds silently. A ledger that already holds
  // grants is the dangerous case: those rows may have been written against a different place, and
  // nothing inside this process can tell. Guessing "they must be ours" is exactly the assumption that
  // let a repoint delete live access. So it fails closed and makes the operator assert the answer.
  #bindScope(scope, adoptScope) {
    if (scope === null || this.scope() !== null) return;
    const rows = this.#stmt.count.get().n;
    if (rows === 0) {
      this.#stmt.setMeta.run("scope", String(scope));
      return;
    }
    if (adoptScope !== null && String(adoptScope) === String(scope)) {
      this.#stmt.setMeta.run("scope", String(scope));
      this.log(
        `adopted ${rows} existing grant(s) in ${this.file} as belonging to ${scope}, by explicit ` +
          `operator assertion. Nothing verified that claim, so if any of them were made elsewhere, ` +
          `that access is now tracked against the wrong place.`,
      );
      return;
    }
    throw new Error(
      `refusing to start: ${this.file} holds ${rows} grant(s) but is not bound to any scope, so ` +
        `nothing here can tell whether they were made in ${scope} or somewhere else. Treating them as ` +
        `local is what let a repointed adapter delete the record of access that was still live ` +
        `elsewhere. Confirm where these grants were made, then either start once asserting it, or ` +
        `move this file aside and let a fresh ledger bind to ${scope}.` +
        (adoptScope === null
          ? ""
          : ` The assertion given was ${adoptScope}, which is not ${scope}, so it was refused rather ` +
            `than adopting the grants into a scope the operator did not name.`),
    );
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
    return this.#rowWithRev(userId)?.record ?? null;
  }

  // The record together with the revision it was read at, so a caller that awaits a platform call and
  // then writes can tell whether the row is still the one it decided about.
  #rowWithRev(userId) {
    const row = this.#stmt.get.get(String(userId));
    if (row === undefined) return null;
    return { record: this.#parse(String(userId), row.record), rev: Number(row.rev) };
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

  // Returns the revision it allocated. A caller that may need to undo this write has to hold that
  // number ACROSS its platform call, because rereading it afterwards reads whatever is there then,
  // which may be a different row written by someone else.
  #put(userId, record) {
    let rev = null;
    const write = () => {
      rev = this.#stmt.nextRev.get().rev;
      return this.#stmt.put.run(
        String(userId),
        Number(record.expiresAt),
        JSON.stringify(record),
        this.now(), // the injected clock, so no wall-clock read exists outside #observeClock
        rev,
      );
    };
    if (this.putFn) this.putFn(write, userId, record);
    else write();
    return rev;
  }

  // ---- the guarded clock -------------------------------------------------------------------------

  // ONE sample per decision, and the decision uses exactly the sample that was persisted.
  //
  // The previous version sampled twice. #observeClock read the clock and wrote it down, then
  // #effective read the clock AGAIN, and every caller decided on that second value. Between the two
  // samples real time can cross an expiry boundary, so an adapter could refuse an admission on the
  // strength of a time it had never recorded, and a restart with a lower clock then found a floor one
  // tick short of what it had already acted on and let the expired grant back in. That is the same
  // "acted on state that was not durable" shape the whole SQLite move was supposed to end, surviving
  // in the one place where there were two observations rather than one.
  //
  // So this returns the sample. `wall` is the raw reading, for the one decision that legitimately
  // wants unfloored time (see grant). `floor` is that same reading raised to the durable high-water
  // mark, for every expiry decision. Nothing downstream may call the clock again.
  #observeClock() {
    const t = this.now();
    const mark = this.#mark();
    if (mark == null || t > mark) {
      this.#stmt.raiseMark.run(String(t));
      return { wall: t, floor: t };
    }
    if (t < mark && this.#regression() == null) {
      this.#stmt.setMeta.run("clockRegressed", JSON.stringify({ observed: t, mark, at: t }));
    }
    // The mark is the durable floor and it is at least t here, so this is the persisted value.
    // Expiry is judged against the wall clock floored at the highest value ever observed. This is the
    // resolution of two opposing review findings. Treating a regression as "revoke everything" meant a
    // routine one-second correction destroyed every member's access, and combined with a sticky flag
    // it bricked the adapter permanently. Ignoring a regression meant a rolled-back clock revived
    // grants that had already expired. Flooring at the mark does neither: time never moves backwards
    // for expiry purposes, so nothing revives and nothing is mass-revoked. A forward jump that is
    // later corrected leaves the mark high, which expires grants early, the conservative direction,
    // and `resetClock` is the way back from one.
    return { wall: t, floor: Math.max(t, mark) };
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
      // ONE sample, used by the check below. An earlier version observed here, threw the sample away,
      // and called the clock again for the check, so the refusal could rest on a reading that was
      // never persisted. A restart at a lower clock then found a floor one tick short of what this
      // process had already acted on and let the expired grant back in. The other three decision
      // sites were fixed for this and this one was missed.
      const seen = this.#observeClock();
      // Refuse a deadline that has already passed. Near an epoch boundary a slow queue or a slow
      // platform call could otherwise apply access that is expired the moment it is granted, and it
      // would then sit live until the next sweep, up to a full sweep interval later.
      //
      // THE FLOOR, not the raw reading, and this is the ONE decision site that used to differ.
      //
      // The argument for the raw clock was that the gateway owns this deadline and issued it against
      // ITS clock, while the floor exists to stop a rolled-back adapter clock reviving an EXISTING
      // grant, so flooring here would turn a forward clock glitch into an outage lasting as long as
      // the jump. It went on to say a grant accepted under a rolled-back clock was not a hole either,
      // because sweep and admitIfLive judge against the floor and remove it.
      //
      // That last part was the mistake, and it is the shape this component keeps producing: a correct
      // argument that never addresses the actual path. grant() does not only persist a record, it
      // calls apply() directly a few lines below. So with the floor above the deadline and the raw
      // clock below it, which is what a forward jump followed by a correction leaves behind, the
      // access was applied on the platform while live() already reported false. It then sat there
      // until the next sweep, up to a full sweep interval, and a member could repeat it after every
      // sweep for as long as the inflated floor stood.
      //
      // Flooring here does cost what the old comment said. After a forward jump, new grants are
      // refused until wall time catches up. That is the conservative direction, it is visible, it is
      // logged, and resetClock is the deliberate operator escape from it. Granting access the same
      // ledger considers expired is none of those things.
      if (seen.floor >= record.expiresAt) {
        throw new Error(
          seen.floor > seen.wall
            ? `refusing to grant ${userId} access expiring at ${record.expiresAt}: this ledger has ` +
              `already observed time ${seen.floor}, which is ahead of its current clock ${seen.wall}. ` +
              `Something moved the clock forward and it has since been corrected. New grants stay ` +
              `refused until the clock passes ${seen.floor}. If the host clock is now known good, ` +
              `start once with the clock reset to drop the floor.`
            : `refusing to grant ${userId} access that has already expired`,
        );
      }
      const prev = this.#row(userId);
      // A renewal that changes target revokes the parts of the prior grant the new one does not carry
      // forward, so old access is never left live and untracked.
      //
      // THE INVARIANT IS THAT THE ROW ALWAYS COVERS EVERYTHING THAT COULD BE LIVE. The order used to
      // be revoke, then write, and the comment claimed the prior row kept its access fully tracked and
      // live. The first half stayed true and the second did not: after a successful revoke the row
      // named a target that had just been taken away. If the write then failed, or the process died in
      // between, the member was left with the old access gone, the new access never applied, and a row
      // naming only the old target. Repair could not help them, because it deliberately ignores
      // channels outside the current configuration, so they stayed verified, recorded, and locked out
      // with the epoch's proof already spent.
      //
      // So a covering record is committed FIRST. It names the new targets and the orphaned ones
      // together, which over-claims and never under-claims. Then the orphan is revoked. Then the final
      // record replaces it. Every failure point in that sequence leaves a row that is a superset of
      // what is live, which is the safe direction, and every one leaves the NEW targets named, so the
      // repair pass can finish the job without spending another proof.
      const orphan = prev ? this.orphaned(prev, record) : null;
      if (orphan) {
        // Only when this adapter can actually express a record covering both. When it cannot, the
        // PRIOR row is left exactly where it is across the revoke, which still names the old target,
        // so the row remains a superset of what is live. That is the older ordering and it is correct
        // for them: what it costs is the repairability the covering record buys, not the invariant.
        const cover = this.covering(record, orphan);
        if (cover) {
          try {
            this.#put(userId, cover);
          } catch (e) {
            throw new Error(`could not persist grant: ${e.message}`);
          }
        }
        try {
          await this.revoke(userId, orphan);
        } catch (e) {
          // PUT THE PRIOR RECORD BACK before giving up, when a covering row was written.
          //
          // The covering row carries the NEW deadline, because that is the deadline of the grant it is
          // mostly about. Leaving it after a failed orphan revoke extended the orphaned target's life
          // to that deadline: the old access is still live, the row now says it expires later than it
          // was ever granted for, and the sweep does not fire at the original time, so nothing retries
          // the revoke. A fix for a renewal stranding access ended up extending it instead.
          //
          // Restoring `prev` is exactly right for this case. The renewal is abandoned, so the member
          // holds only what they held before, the row names it with its ORIGINAL deadline, and the
          // sweep takes it back on time. That is also what this path did before the covering record
          // existed, and the older behaviour was correct here.
          if (cover) {
            try {
              this.#put(userId, prev);
            } catch {
              // The covering row survives, which over-claims rather than under-claims and is the safe
              // direction. The migrate failure below is what the caller needs to hear.
            }
          }
          throw new Error(`could not migrate the prior grant: ${e.message}`);
        }
      }

      // The revision THIS call wrote, captured before the platform call below. The refusal path used
      // to reread it afterwards, which reads whatever row exists at that moment: a concurrent process
      // could have written a fresh grant in between, and the reread then deleted that row instead. A
      // successful grant vanished and its access became permanent and untracked, which is the exact
      // outcome the revision check exists to prevent, produced by the code added to enforce it.
      let writtenRev = null;
      try {
        writtenRev = this.#put(userId, record);
      } catch (e) {
        // A single statement either committed or it did not, so there is nothing to roll back. On a
        // renewal the covering row above survives, which still names the new targets, so the member is
        // repairable rather than stranded.
        throw new Error(`could not persist grant: ${e.message}`);
      }
      try {
        await this.apply(userId, record);
      } catch (e) {
        // The stored record covers every target that could be live now: a first grant's uncertain new
        // access, or on a renewal the prior carried-forward targets (still live) plus any partial new
        // ones, since the orphaned old targets were revoked above. On a renewal, leave it and let the
        // sweep cover it.
        if (prev) throw e;

        // A FIRST grant, and what happens next depends on whether anything reached the platform.
        //
        // `e.mutated === false` is the apply saying nothing was sent at all, which is what a pure
        // precondition refusal looks like. Compensating that used to clear the member's access anyway,
        // so declining to grant took access away, and that defect is why an earlier refusal was
        // deleted rather than repaired. The row goes too: nothing was applied, so a row promising
        // access would be a lie, and the member cannot be granted while the exclusion stands.
        if (e?.mutated === false) {
          // CONDITIONAL on the revision this call wrote, not unconditional. delAny exists for the
          // offline retirement, where no other writer can exist, and its own comment says every online
          // deletion goes through the revision check because a concurrent grant must not be deleted by
          // a stale caller. This is an online path and it was using delAny anyway.
          //
          // The exclusive lock normally makes that impossible. On a network filesystem it does not,
          // and that is the exact case the revision check was added for, so the one place that skipped
          // it was the place a second process could do harm.
          // Conditional on the revision captured BEFORE the apply. If anything replaced the row while
          // the platform call was in flight, the revision no longer matches and this deletes nothing,
          // which is the entire point.
          if (writtenRev !== null) this.#stmt.del.run(String(userId), writtenRev);
          throw e;
        }

        // Anything else is a transient or uncertain failure, and what happens next depends on whether
        // this adapter can finish the job later.
        //
        // WITHOUT a repair pass, keeping the record strands the member: nothing retries the platform
        // call, their proof is spent for the epoch, and the row proves an authorization it cannot
        // deliver. So compensate, and drop the row only if that compensation completes, since a row
        // surviving a successful compensation is a live grant with nothing behind it. A failed
        // compensation keeps the row so the sweep retries.
        if (!this.repairs) {
          try {
            await this.revoke(userId, record);
            if (writtenRev !== null) this.#stmt.del.run(String(userId), writtenRev);
          } catch {
            // Deliberately swallowed. The apply failure is what the caller needs, and the record
            // surviving is the correct outcome of a failed compensation.
          }
          throw e;
        }

        // WITH a repair pass, the record is KEPT with no compensating revoke.
        //
        // This is the opposite of what it did a few commits ago, and the reason is that a repair path
        // now exists. Without one, a kept record was a live grant with no access behind it and nothing
        // that would ever fix it, so revoking and dropping the row was the least-wrong option. With
        // reconciliation converging in both directions, the record is the authority that repairs the
        // access, so throwing it away destroys the only evidence the member earned it, and the proof
        // that earned it cannot be spent twice in an epoch.
        //
        // Compensating is now actively wrong as well. It clears the channels that DID succeed, which
        // is the sibling-stripping defect, and the repair would only put them back.
        this.log(
          `${userId} is recorded but their access did not fully apply (${e.message}). The record is ` +
            `kept and reconciliation will reapply it.`,
        );
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
    const due = this.#stmt.due.all(this.#observeClock().floor).map((r) => r.user_id);
    const revoked = [];
    for (const userId of due) {
      // The record is re-read and re-judged INSIDE the member's own lock. That, not the order things
      // were enqueued in, is what stops a stale revoke landing on access a concurrent re-verification
      // just granted. Taking one member's lock at a time is also what lets unrelated grants proceed
      // while a long sweep runs.
      await this.#run(userId, async () => {
        const seen = this.#rowWithRev(userId);
        if (!seen) return;
        // Observe again inside the lock, and judge on THAT sample. Time may have moved since the due
        // list was collected, and a decision must never rest on a reading that was not persisted.
        if (this.#observeClock().floor < seen.record.expiresAt) return; // re-verified meanwhile, leave it
        try {
          await this.revoke(userId, seen.record);
        } catch (e) {
          this.log(`revoke failed for ${userId}, keeping the grant to retry: ${e.message}`);
          return; // a real revoke failure must not drop the record, or live access goes untracked
        }
        // Delete only the row we judged. The member's lock covers the await above WITHIN this process,
        // but it is only a promise chain in memory, so a SECOND adapter process running against the
        // same database is not held by it at all. It can record a fresh grant while the removal above
        // is still in flight, and an unconditional delete then threw that fresh row away and left the
        // member holding live access with nothing to revoke it by. Matching on the revision means the
        // worst case is now the recoverable direction: the record survives, the member's access may
        // have been removed by this stale removal, and they get it back by re-verifying.
        if (this.#stmt.del.run(String(userId), seen.rev).changes === 0) {
          this.log(`sweep for ${userId} was overtaken by a fresh grant, keeping it and reporting nothing`);
          return; // not "revoked": the caller notifies on that, and this member is granted again
        }
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
      const t = this.#observeClock().floor; // the persisted sample, and the only one this decides on
      const record = this.#row(userId);
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
    const t = this.#observeClock().floor;
    const r = this.#row(userId);
    return Boolean(r) && t < r.expiresAt;
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

  // Every record. The Discord reconciliation reads these to learn which roles and channels this bot
  // has granted through before, which a pass over the current target alone cannot see.
  all() {
    return this.#stmt.all.all().map((row) => this.#parse(row.user_id, row.record));
  }

  // Every record WITH the account it belongs to. `all()` drops the id, which is fine for the callers
  // that only inspect record contents and useless for anything that has to act on a member. The repair
  // pass needs both, and reaching for `all()` there would have silently iterated records it could not
  // attribute.
  entries() {
    return this.#stmt.all.all().map((row) => [row.user_id, this.#parse(row.user_id, row.record)]);
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

  // Releasing the claim on a clean shutdown is what makes an ordinary restart immediate rather than
  // making the operator wait out the staleness window.
  close() {
    try {
    } catch {
      // A ledger that is already unusable is not worth failing a shutdown over.
    }
    this.#db.close();
  }

  // The revision counter must start ABOVE every revision already in the table, and must be an integer.
  //
  // It used to be created at 1 whenever its row was absent, which is exactly the state of a database
  // written by the previous version, where the revision was derived from the row and started at 1 on
  // every insert. So on upgrade the counter handed out 1 again, collided with the rows already holding
  // 1, and a stale conditional delete matched a fresh row. The counter is the backstop for a lost
  // exclusive lock, and it failed on precisely the databases that would need it.
  //
  // Malformed text did the same thing by a different route, because CAST turns it into zero. Fail
  // closed on that rather than silently restarting the sequence.
  #seedRevSeq() {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#stmt.readMeta.get("revSeq");
      const highest = Number(this.#db.prepare("SELECT IFNULL(MAX(rev), 0) AS m FROM grants").get().m);
      if (row === undefined) {
        this.#stmt.setMeta.run("revSeq", String(highest));
      } else {
        const stored = Number(row.v);
        if (!Number.isSafeInteger(stored) || stored < 0) {
          throw new Error(
            `grant ledger ${this.file} has a malformed revision counter (${JSON.stringify(row.v)}). ` +
              `Fix or remove it; a reset counter can let a stale delete remove a fresh grant.`,
          );
        }
        // Never move it down, and never leave it below a revision already issued.
        if (stored < highest) this.#stmt.setMeta.run("revSeq", String(highest));
      }
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- adopting the file this replaces -----------------------------------------------------------

  // Read a legacy JSON ledger into the database, once, on a fresh database. Everything lands in one
  // transaction, so an interrupted migration leaves the database untouched rather than half-adopted,
  // and the JSON is only renamed aside after that transaction commits. A malformed record fails the
  // migration for the same reason it fails a load: adopting it as empty would strand live access.
  // How many grants a pending legacy import would add, without importing or touching the file. Zero
  // when there is nothing to import, when the database already holds rows, or when this file has
  // already been adopted, which mirrors #importLegacy's own early exits so the two cannot disagree.
  #pendingLegacyCount(importFrom) {
    if (!importFrom || !existsSync(importFrom)) return 0;
    if (this.#stmt.count.get().n > 0 || this.#stmt.readMeta.get("importedFrom") !== undefined) return 0;
    try {
      const obj = JSON.parse(readFileSync(importFrom, "utf8"));
      const grants = (obj?.grants && typeof obj.grants === "object" ? obj.grants : obj) ?? {};
      return Object.keys(grants).length;
    } catch {
      // Malformed. #importLegacy raises the real error with the real message a moment later, and
      // guessing zero here would let a foreign rebind slip through on an unreadable file, so treat it
      // as "there is something there".
      return 1;
    }
  }

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
        this.#stmt.put.run(
          String(userId),
          Number(record.expiresAt),
          JSON.stringify(record),
          this.now(),
          this.#stmt.nextRev.get().rev,
        );
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
    //
    // A missing source here means another process migrated the same file and renamed it first. Both
    // transactions were serialized and idempotent, so the database is correct either way, and the only
    // question is whether this process refuses to start over a rename it did not need to do. It should
    // not. The exclusive lock normally prevents two processes reaching this at all, and on a filesystem
    // where that lock cannot be trusted it is exactly this path that would be reached twice, so treat a
    // missing source as done rather than as a failure.
    const kept = `${importFrom}.migrated`;
    try {
      renameSync(importFrom, kept);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.log(`${importFrom} was already migrated by another process; continuing`);
      return;
    }
    this.log(
      `migrated ${Object.keys(grants).length} grant(s) from ${importFrom} into ${this.file}; ` +
        `the old file is now ${kept}`,
    );
  }
}
