import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// The targets in `a` that `b` does not already cover. Used two ways: the new targets a renewal adds
// (extraTargets(record, prev)), and the prior targets a renewal orphans (extraTargets(prev, record)),
// so each can be granted or revoked precisely. Returns null when there is nothing. A mode switch
// (channel to role or back) carries nothing over, so the whole of `a` is extra.
export function extraTargets(a, b) {
  if (a.mode === "channel") {
    const covered = b && b.mode === "channel" ? (b.channels ?? []) : [];
    const channels = (a.channels ?? []).filter((c) => !covered.includes(c));
    return channels.length ? { mode: "channel", channels } : null;
  }
  const coveredRole = b && b.mode === "role" ? b.roleId : null;
  return a.roleId && a.roleId !== coveredRole ? { mode: "role", roleId: a.roleId } : null;
}

// A grant record is valid when it has a finite expiry and the target its mode needs: a non-empty list
// of channel ids for channel mode, a non-empty role id for role mode. Shared by load and grant, so a
// malformed gateway response cannot be written and then never expire (now >= NaN is always false) only
// to break startup on the next load.
export function isValidRecord(r) {
  if (!r || !Number.isFinite(r.expiresAt)) return false;
  const okChannel = r.mode === "channel" && Array.isArray(r.channels) && r.channels.length > 0 && r.channels.every((c) => typeof c === "string" && c.length > 0);
  const okRole = r.mode === "role" && typeof r.roleId === "string" && r.roleId.length > 0;
  return okChannel || okRole;
}

// A persisted ledger of the access the bot has granted, so the expiry sweep is correct across a
// restart (a granted role or channel overwrite outlives the process) and does not race a fresh
// re-verification. The Discord mutations are injected as `apply` and `revoke`, so the ledger logic is
// unit-testable without Discord. A record is { expiresAt, mode, channels, roleId }.
//
// Two properties the inline version did not have:
//   - Persist before applying. A crash between the two then leaves a record with no access, which the
//     sweep harmlessly clears, never access with no record, which would be permanent and untracked.
//   - Serialize every operation globally (see #run). grant and sweep run one at a time, so a member
//     who re-verifies while the sweep is in flight keeps their fresh access instead of having the stale
//     revoke land on top of it, and no operation's whole-map save persists another operation's
//     not-yet-committed record.
export class GrantLedger {
  #serial = Promise.resolve();

  constructor({ file, apply, revoke, now = () => Math.floor(Date.now() / 1000), log = () => {}, writeFileFn = writeFile } = {}) {
    this.file = file;
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
      if (!isValidRecord(r)) {
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
    if (!isValidRecord(record)) throw new Error(`refusing to grant a malformed record for ${userId}`);
    return this.#run(async () => {
      const prev = this.map.get(userId);
      // If a renewal changes the target, revoke the parts of the prior grant the new one does not carry
      // forward, before applying the new grant, so old access (including a different mode or role id) is
      // never left live and untracked. If that revoke fails, abort the renewal. prev is unchanged, so its
      // access stays fully tracked and live.
      const orphaned = prev ? extraTargets(prev, record) : null;
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
  size() {
    return this.map.size;
  }
}
