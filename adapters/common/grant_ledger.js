import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

// A persisted ledger of the access an adapter has granted, shared by every adapter that hands out
// time-bounded access. Extracted from the Discord adapter, which was the only one with a complete
// grant lifecycle; Telegram and Matrix previously invited a member and never took the access back,
// so a grant outlived the epoch it was issued for.
//
// The two properties that make it correct, both inherited from the Discord original:
//   - Persist before applying. A crash between the two leaves a record with no access, which the
//     sweep harmlessly clears, never access with no record, which would be permanent and untracked.
//   - Serialize every operation (see #run), so a member who re-verifies while a sweep is in flight
//     keeps their fresh access instead of having the stale revoke land on top of it.
//
// A record is whatever the adapter needs, plus a finite `expiresAt`.

export class GrantLedger {
  #serial = Promise.resolve();
  #saveSeq = 0;
  #persistedMark = null;
  #persistedRegression = null;

  // `validate` decides whether a record is well formed, and `orphaned(prev, next)` returns the part
  // of a prior grant a renewal does not carry forward (so it can be revoked before the new grant is
  // applied). Both are injected because they are the only platform-specific parts: Discord has two
  // grant modes with different targets, while an adapter that simply admits and removes a user has
  // one shape and nothing to migrate.
  constructor({
    file,
    apply,
    revoke,
    validate = (r) => Boolean(r) && Number.isFinite(r.expiresAt),
    orphaned = () => null,
    now = () => Math.floor(Date.now() / 1000),
    log = () => {},
    writeFileFn = writeFile,
  } = {}) {
    this.file = file;
    this.validate = validate;
    this.orphaned = orphaned;
    // Adapters decide admission independently of the gateway, against gateway-issued absolute
    // deadlines. Their own clock was unguarded, so moving it back before a sweep made an expired
    // grant live again and admitted a member whose epoch had ended, even while the gateway itself
    // was refusing new proofs. The mark below is the adapter's own high-water clock.
    this.clockMark = null;
    this.clockRegressed = false;
    this.apply = apply;
    this.revoke = revoke;
    this.now = now;
    this.log = log;
    this.writeFileFn = writeFileFn; // injectable so the persist-failure path is testable
    this.map = this.#load();
    // Compare the loaded high-water against the clock immediately. live() is a read-only check now,
    // so without this a process that STARTS behind its own mark would report a sane clock until some
    // async path happened to observe one, and admit on the strength of it in the meantime. The flag
    // is persisted by the next write; detecting it at startup is what has to be immediate.
    this.#observeClock();
    this.#persistIfMoved();
  }

  // Only a missing file means an empty ledger (first run). A corrupt, unreadable, or malformed file is
  // an error, not "nothing to revoke". Loading it as empty would silently strand every live grant, so
  // fail startup instead and let the operator fix or remove the file.
  #load() {
    let raw;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return new Map();
      throw e;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`grant ledger ${this.file} is not valid JSON (${e.message}). Fix or remove it.`);
    }
    // Newer files are { meta, grants }; older ones are a flat map of user id to record. Keeping the
    // metadata in its own object matters beyond tidiness: a flat file cannot distinguish a metadata
    // key from a platform user id that happens to share its name.
    let grants = obj;
    if (obj && typeof obj === "object" && obj.grants && typeof obj.grants === "object") {
      grants = obj.grants;
      const mark = Number(obj.meta?.clockMark);
      if (Number.isFinite(mark)) this.clockMark = mark;
      this.#persistedMark = this.clockMark;
      // Sticky across restarts, exactly as the gateway's guard is. Held only in memory, a temporary
      // glitch plus any failed revoke plus a restart would quietly re-admit expired members.
      if (obj.meta?.clockRegressed) this.clockRegressed = obj.meta.clockRegressed;
      this.#persistedRegression = this.clockRegressed;
    }
    const map = new Map();
    for (const [userId, r] of Object.entries(grants)) {
      // The mode-specific target must be present, or a sweep would delete the record without being able
      // to revoke the real Discord access.
      if (!this.validate(r)) {
        throw new Error(`grant ledger ${this.file} has a malformed record for ${userId}. Fix or remove it.`);
      }
      map.set(userId, r);
    }
    return map;
  }

  // Persist asynchronously so a write never blocks the event loop and the bot's Discord heartbeat. The
  // load stays synchronous, because it runs once at construction before the bot is live, where a brief
  // blocking read is harmless. Callers save only inside #run, so saves never overlap.
  async #save() {
    await mkdir(dirname(this.file), { recursive: true });
    // A per-save temporary name. A single shared ".tmp" meant two saves could interleave and the
    // second rename would find the file already consumed by the first.
    const tmp = `${this.file}.${process.pid}.${(this.#saveSeq += 1)}.tmp`;
    await this.writeFileFn(
      tmp,
      JSON.stringify(
        { meta: { clockMark: this.clockMark, clockRegressed: this.clockRegressed }, grants: Object.fromEntries(this.map) },
        null,
        2,
      ),
    );
    // Rename alone is atomic but not durable: the whole point of persist-before-apply is that a grant
    // recorded here survives the machine losing power right after access was applied. Without these
    // flushes the record could still be in the page cache, the machine could come back with the old
    // ledger, and the member's access would be live and untracked forever. Flush the file, then the
    // rename, then the directory entry that makes the rename visible.
    await this.#fsyncFile(tmp);
    await rename(tmp, this.file);
    await this.#fsyncDirBestEffort(dirname(this.file));
    this.#persistedMark = this.clockMark;
    this.#persistedRegression = this.clockRegressed;
  }

  // Flushing the FILE is part of the persist-before-apply guarantee, so a failure there fails the
  // grant rather than letting the caller apply access whose record may not survive a power loss.
  // Flushing the DIRECTORY is best effort: some filesystems do not support it, and refusing every
  // grant on that basis would be worse than the residual risk, which is stated rather than hidden.
  async #fsyncFile(target) {
    const fh = await open(target, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async #fsyncDirBestEffort(target) {
    let fh;
    try {
      fh = await open(target, "r");
      await fh.sync();
    } catch {
      // See above: not every filesystem can flush a directory handle.
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // Serialize every grant and sweep operation, so no two mutate-and-persist sequences interleave. This
  // is stricter than a per-user lock (grants for different users no longer run concurrently), and it is
  // what keeps a save honest: an operation's map mutation, persist, apply, and any rollback all complete
  // before the next begins, so one user's whole-map save can never persist another user's in-flight
  // record that later rolls back.
  //
  // The tradeoff is head-of-line blocking: one user's Discord apply or revoke holds the queue for every
  // other operation. That is acceptable here, because grants are human-paced, a Discord call is bounded
  // by the client's request timeout, and the worst case (a mass-expiry sweep or a Discord outage) is a
  // few seconds of delayed grants, not a stall. A finer design keeps per-user ordering around the
  // Discord calls and serializes only the mutate-and-persist section, but the correct answer at real
  // scale is a per-row store (SQLite), which removes the whole-map rewrite that forces this serialization
  // at all. That store is the tracked follow-up; the single queue is the right size for a reference bot.
  #run(fn) {
    this.#serial = this.#serial.then(fn, fn); // run fn once the previous op settles, either way
    return this.#serial;
  }

  // Migrate any orphaned prior targets, persist the record, then apply the Discord access. If
  // persistence fails, keep the prior record and grant nothing. If applying fails, keep a record that
  // covers any access that could be live, so the sweep can clean it up. Every failure throws, so the
  // caller can tell the member to retry.
  async grant(userId, record) {
    if (!this.validate(record)) throw new Error(`refusing to grant a malformed record for ${userId}`);
    return this.#run(async () => {
      // Issuing a grant is an observation of the clock, so the high-water mark advances here too.
      // The map mutation below persists it; a change with no mutation is written explicitly.
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
        this.#persistIfMoved(); // this path never reaches the map write, so persist the observation
        throw new Error(`refusing to grant ${userId} access that has already expired`);
      }
      const prev = this.map.get(userId);
      // If a renewal changes the target, revoke the parts of the prior grant the new one does not carry
      // forward, before applying the new grant, so old access (including a different mode or role id) is
      // never left live and untracked. If that revoke fails, abort the renewal. prev is unchanged, so its
      // access stays fully tracked and live.
      const orphaned = prev ? this.orphaned(prev, record) : null;
      if (orphaned) {
        try {
          await this.revoke(userId, orphaned);
        } catch (e) {
          throw new Error(`could not migrate the prior grant: ${e.message}`);
        }
      }

      this.map.set(userId, record);
      try {
        await this.#save();
      } catch (e) {
        if (prev) this.map.set(userId, prev);
        else this.map.delete(userId);
        throw new Error(`could not persist grant: ${e.message}`);
      }
      try {
        await this.apply(userId, record);
      } catch (e) {
        // record covers every target that could be live now: a first grant's uncertain new access, or on
        // a renewal the prior carried-forward targets (still live) plus any partial new ones, since the
        // orphaned old targets were revoked above. Keep record so the sweep covers it. On a first grant
        // there is no prior access, so also best-effort revoke the uncertain new access now.
        if (!prev) await this.revoke(userId, record).catch(() => {});
        try { await this.#save(); } catch (err) { this.log(`could not persist after a failed apply: ${err.message}`); }
        throw e;
      }
    });
  }

  // Revoke every grant whose epoch has lapsed. Returns the user ids actually revoked, so the caller can
  // notify them. The live record is re-checked inside the serialized operation, so a member who re-verified
  // during the sweep keeps their fresh access.
  async sweep() {
    // Three properties have to hold together here, and each one cost a round to learn.
    //   Judge against the floored clock, so a rolled-back wall clock neither hides work that is due
    //   nor manufactures work that is not. Revoking everything on any regression was an earlier cut,
    //   and it turned a one-second correction into a mass revocation.
    //   Observe INSIDE the queue. Mutating the mark synchronously here stole the advance from an
    //   admission already queued ahead of us, which then saw nothing to persist and admitted against
    //   a mark that existed only in memory.
    //   Stay synchronous up to enqueuing the revocations. Awaiting would yield the event loop and let
    //   a concurrent re-verification queue ahead of them, so a stale revoke could land on freshly
    //   granted access.
    this.#run(async () => {
      this.#observeClock();
      if (this.#clockStateDiffers()) await this.#save();
    }).catch((e) => this.log(`could not persist the clock mark: ${e.message}`));
    // A pure read for deciding what is due, so this stays synchronous and the revocations below are
    // enqueued before any concurrent re-verification can slip ahead of them.
    const t = this.#peekEffective();
    const due = [...this.map].filter(([, r]) => t >= r.expiresAt).map(([u]) => u);
    const revoked = [];
    for (const userId of due) {
      await this.#run(async () => {
        const live = this.map.get(userId);
        if (!live) return;
        if (this.#peekEffective() < live.expiresAt) return; // re-verified meanwhile, leave it alone
        try {
          await this.revoke(userId, live);
        } catch (e) {
          this.log(`revoke failed for ${userId}, keeping the grant to retry: ${e.message}`);
          return; // a real revoke failure must not drop the record, or live access goes untracked
        }
        this.map.delete(userId);
        try { await this.#save(); } catch (e) { this.log(`could not persist sweep: ${e.message}`); }
        revoked.push(userId);
      });
    }
    return revoked;
  }

  // The adapter's guarded clock. Time moving forward advances the mark; time moving backwards is
  // recorded and, from then on, every admission is refused. Refusing is the safe direction: a member
  // waiting for a corrected clock is an inconvenience, while admitting one whose epoch has ended is
  // the failure the whole grant lifecycle exists to prevent.
  // Update the clock state in memory and report whether anything changed, so the async callers can
  // persist it. Advancing the mark without persisting it was a real hole: a quiet interval could move
  // the mark forward in memory only, and after a restart the guard compared against an OLDER mark, so
  // a rollback to a time between the two went undetected and admitted members whose epoch had ended.
  #observeClock() {
    const t = this.now();
    if (this.clockMark == null || t > this.clockMark) {
      this.clockMark = t;
      return true;
    }
    if (t < this.clockMark && !this.clockRegressed) {
      this.clockRegressed = { observed: t, mark: this.clockMark, at: t };
      return true;
    }
    return false;
  }

  // Read-only view of the clock, for callers that are not in a position to persist. It deliberately
  // does NOT advance the mark: an observation that cannot be written down is one a restart would
  // forget, and a forgotten high-water is what lets a later rollback pass unnoticed.
  // The time every expiry decision is made against: the wall clock, floored at the highest value ever
  // observed. This is the resolution of two opposing review findings. Treating a regression as
  // "revoke everything" meant a routine one-second correction destroyed every member's access, and
  // combined with a sticky flag it bricked the adapter permanently. Ignoring a regression meant a
  // rolled-back clock revived grants that had already expired. Flooring at the mark does neither:
  // time never moves backwards for expiry purposes, so nothing revives and nothing is mass-revoked.
  // A forward jump that is later corrected leaves the mark high, which expires grants early, the
  // conservative direction.
  // The mark advances on every read, because a floor that only moved on writes went stale and a
  // rollback past it revived expired grants. Every observing path then calls #persistIfMoved, because
  // an advance is EVIDENCE: once a grant has been treated as expired under a high mark, losing that
  // mark to a crash is NOT the same as never having observed it, since the record is still there to
  // be revived under a lower floor. An earlier comment here claimed otherwise and was wrong.
  #effectiveNow() {
    this.#observeClock();
    return this.#peekEffective();
  }

  // The same floor WITHOUT observing. Used where the caller must not mutate shared state, so a
  // synchronous read cannot quietly advance the mark out from under a queued operation that was
  // about to persist it.
  // Write the mark down if it has moved away from what is on disk. Every path that OBSERVES the
  // clock must reach this, not just the ones that happen to mutate a grant: an advance that stayed in
  // memory and was then lost to a crash let a later correction fall back to a lower floor and revive
  // a grant that had already been treated as expired. Enqueued rather than awaited, because the
  // observing paths here are synchronous reports; the one path that ADMITS on the strength of the
  // floor awaits its save explicitly before deciding.
  #persistIfMoved() {
    if (!this.#clockStateDiffers()) return;
    this.#run(() => this.#save()).catch((e) => this.log(`could not persist the clock mark: ${e.message}`));
  }

  // A regression sets the flag WITHOUT moving the mark, so comparing marks alone would never write it
  // down and a restart would forget that it happened.
  #clockStateDiffers() {
    return this.clockMark !== this.#persistedMark || Boolean(this.clockRegressed) !== Boolean(this.#persistedRegression);
  }

  #peekEffective() {
    const t = this.now();
    return this.clockMark == null ? t : Math.max(t, this.clockMark);
  }

  // Decide admission and perform it INSIDE the serial queue, so a sweep cannot revoke and delete
  // between the liveness check and the platform call. Without this the two ran unsynchronized: a
  // handler could read a live grant, await the approval, and have the sweep delete the record while
  // that call was in flight, leaving a member admitted with no record and therefore never swept
  // again. If the grant expires while `admit` is running, the record still exists, so the next sweep
  // removes them, which is the property that makes this safe rather than merely narrower.
  //
  // `matches` optionally checks the record against the caller's current target, so a record written
  // for one chat or context cannot authorize admission to another.
  async admitIfLive(userId, admit, matches = () => true) {
    return this.#run(async () => {
      const record = this.map.get(userId);
      // Persist if the in-memory mark differs from what is on disk, rather than only when THIS call
      // advanced it. Another synchronous read may have advanced it already, and admitting on the
      // strength of an advance that was never written would leave a restart comparing against an
      // older floor, which is the rollback hole this guard exists to close.
      this.#observeClock();
      if (this.#clockStateDiffers()) await this.#save();
      const t = this.#peekEffective();
      if (!record || t >= record.expiresAt) return false;
      if (!matches(record)) return false;
      await admit(record);
      return true;
    });
  }

  has(userId) {
    return this.map.has(userId);
  }
  // The live record, or null. Adapters that admit a member at a later moment than the grant (Telegram
  // approves a join request that arrives after verification) consult this to decide.
  get(userId) {
    return this.map.get(userId) ?? null;
  }
  // Whether a grant exists and has not lapsed.
  // A read-only liveness check. Callers that admit on the strength of it must use admitIfLive, which
  // observes and persists the clock first; this one only reports.
  live(userId) {
    const r = this.map.get(userId);
    const t = this.#effectiveNow();
    this.#persistIfMoved();
    return Boolean(r) && t < r.expiresAt;
  }

  // Reported for the operator, not used to gate access: the effective clock already prevents a
  // regression from reviving a grant, so refusing service on top of that would only add an outage.
  get clockIsSane() {
    return !this.clockRegressed;
  }

  get clockStatus() {
    return { mark: this.clockMark, regression: this.clockRegressed || null };
  }
  size() {
    return this.map.size;
  }
}
