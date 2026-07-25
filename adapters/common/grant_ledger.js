import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
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
    this.apply = apply;
    this.revoke = revoke;
    this.now = now;
    this.log = log;
    this.writeFileFn = writeFileFn; // injectable so the persist-failure path is testable
    this.map = this.#load();
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
    const map = new Map();
    for (const [userId, r] of Object.entries(obj)) {
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
    const tmp = `${this.file}.tmp`;
    await this.writeFileFn(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2));
    await rename(tmp, this.file); // atomic replace, so a crash mid-write cannot corrupt the ledger
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
    const due = [...this.map].filter(([, r]) => this.now() >= r.expiresAt).map(([u]) => u);
    const revoked = [];
    for (const userId of due) {
      await this.#run(async () => {
        const live = this.map.get(userId);
        if (!live || this.now() < live.expiresAt) return; // re-verified meanwhile, leave it alone
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

  has(userId) {
    return this.map.has(userId);
  }
  // The live record, or null. Adapters that admit a member at a later moment than the grant (Telegram
  // approves a join request that arrives after verification) consult this to decide.
  get(userId) {
    return this.map.get(userId) ?? null;
  }
  // Whether a grant exists and has not lapsed.
  live(userId) {
    const r = this.map.get(userId);
    return Boolean(r) && this.now() < r.expiresAt;
  }
  size() {
    return this.map.size;
  }
}
