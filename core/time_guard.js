// Monotonic epoch and season, guarded against a backward clock.
//
// Why this exists. Epochs and seasons are computed straight from wall-clock time, and the security
// state hangs off them: the epoch scopes the spent-nullifier set, and the season scopes the members
// tree and the registrations behind it. Old registration records stay on disk after a season ends,
// so if the clock moves back across a season boundary the gateway rebuilds the previous season's
// members tree and revives credentials that should have expired. Back across an epoch boundary, the
// spent set for that epoch has already been pruned, so a nullifier can be spent a second time.
//
// A backward clock is not exotic: a corrected NTP step, a virtual machine restored from a snapshot,
// a hand-set clock, or a forward jump that is later corrected all produce it.
//
// The rule here is to never go backwards. The highest epoch and season ever observed are persisted,
// and if the computed value falls below the stored mark the gateway refuses to serve rather than
// silently rolling its state back. Refusing is the conservative direction: a stalled gateway is an
// operational problem, while a rolled-back one hands out memberships that were meant to have lapsed.
//
// The marks are keyed by the configured epoch and season lengths, because changing either renumbers
// every epoch and season and makes old marks meaningless rather than violated.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";

import { epochNow, seasonNow } from "../common/index.js";

export class TimeGuard {
  // `path` is where the marks live, or null to keep them in memory only (the ephemeral mode that
  // MNO_STORE=memory already opts into, which has no durability to protect in the first place).
  constructor({ path, epochSeconds, seasonSeconds, nowSec }) {
    this.path = path ?? null;
    this.epochSeconds = epochSeconds;
    this.seasonSeconds = seasonSeconds;
    this.nowSec = nowSec;
    this.marks = { epoch: null, season: null };
    // Set once a regression is seen. It is deliberately sticky: the clock going forward again does
    // not prove the state is sound, because the operator still needs to know it happened.
    this.regression = null;
    this.#load();
  }

  #load() {
    if (!this.path) return;
    let text;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      // Only "the file is not there" means a first run. A permission error or an unreadable file is
      // the guard's own security state being unavailable, and seeding fresh marks there would silently
      // disarm it: a gateway that had reached season 20 could restart into season 19 and rebuild that
      // season's registrations. Fail closed instead and let the operator decide.
      if (e.code === "ENOENT") return;
      throw new Error(`cannot read the clock marks at ${this.path} (${e.message}). Fix or remove it.`);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`clock marks at ${this.path} are not valid JSON (${e.message}). Fix or remove it.`);
    }
    if (raw === null || typeof raw !== "object") {
      throw new Error(`clock marks at ${this.path} are malformed. Fix or remove it.`);
    }
    // Marks from a different epoch or season length describe a different numbering, so they are not
    // comparable. Start fresh rather than report a regression that never happened.
    if (raw?.epochSeconds !== this.epochSeconds || raw?.seasonSeconds !== this.seasonSeconds) return;
    // Both marks must be well formed together. Accepting whichever one parsed would silently reset
    // the other side of the guard, so a file with a valid season and a corrupt epoch would leave the
    // epoch high-water at nothing and let an epoch rollback pass unnoticed.
    for (const kind of ["epoch", "season"]) {
      if (raw[kind] != null && !Number.isInteger(raw[kind])) {
        throw new Error(`clock marks at ${this.path} have a malformed ${kind}. Fix or remove it.`);
      }
    }
    if (Number.isInteger(raw.epoch)) this.marks.epoch = raw.epoch;
    if (Number.isInteger(raw.season)) this.marks.season = raw.season;
    // A regression outlives the process. It was sticky in memory only, so a clock that caught up and
    // a restart erased the evidence and the gateway silently resumed, which is precisely the case an
    // operator needs to be told about.
    if (raw.regression && typeof raw.regression === "object") this.regression = raw.regression;
  }

  #persist() {
    if (!this.path) return;
    const body = JSON.stringify({
      epochSeconds: this.epochSeconds,
      seasonSeconds: this.seasonSeconds,
      epoch: this.marks.epoch,
      season: this.marks.season,
      regression: this.regression,
    });
    // Write and rename, so a crash mid-write cannot leave a truncated file that reads as "no marks"
    // and silently drops the guard.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    // Rename is atomic but not durable. Without these flushes a power loss can lose the newest mark,
    // the process restarts against an OLDER high-water, and a rollback to a time between the two goes
    // undetected, which is the whole failure this guard exists to catch. The adapter ledger already
    // flushed for the same reason; this did not.
    this.#fsync(tmp, true);
    renameSync(tmp, this.path);
    this.#fsync(dirname(this.path), false); // best effort: not every filesystem flushes a directory
  }

  #fsync(target, required) {
    let fd;
    try {
      fd = openSync(target, "r");
      fsyncSync(fd);
    } catch (e) {
      if (required) throw new Error(`cannot flush the clock marks at ${target} (${e.message})`);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed or never opened
        }
      }
    }
  }

  // Compare a freshly computed period against its mark. Advancing updates the mark, standing still
  // is fine, and going backwards records a regression and keeps the mark where it was.
  #observe(kind, value) {
    const mark = this.marks[kind];
    if (mark == null || value > mark) {
      this.marks[kind] = value;
      this.#persist();
      return value;
    }
    if (value < mark) {
      if (this.regression == null) {
        this.regression = { kind, observed: value, mark, at: this.nowSec() };
        this.#persist(); // record it before serving anything, so a restart cannot clear it
      }
    }
    return value;
  }

  epoch() {
    return this.#observe("epoch", epochNow(this.epochSeconds, this.nowSec()));
  }

  season() {
    return this.#observe("season", seasonNow(this.seasonSeconds, this.nowSec()));
  }

  // True once a backward step has been seen. The gateway refuses the state-bearing endpoints while
  // this holds, because it can no longer vouch for the epoch scoping the spent set or the season
  // scoping the members tree.
  get regressed() {
    return this.regression != null;
  }

  // Operator-facing detail for the health endpoint and the refusal message.
  status() {
    return {
      epochMark: this.marks.epoch,
      seasonMark: this.marks.season,
      regression: this.regression,
    };
  }
}
