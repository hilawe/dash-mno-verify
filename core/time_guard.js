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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
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
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return; // no marks yet, or unreadable; the first observation seeds them
    }
    // Marks from a different epoch or season length describe a different numbering, so they are not
    // comparable. Start fresh rather than report a regression that never happened.
    if (raw?.epochSeconds !== this.epochSeconds || raw?.seasonSeconds !== this.seasonSeconds) return;
    if (Number.isInteger(raw.epoch)) this.marks.epoch = raw.epoch;
    if (Number.isInteger(raw.season)) this.marks.season = raw.season;
  }

  #persist() {
    if (!this.path) return;
    const body = JSON.stringify({
      epochSeconds: this.epochSeconds,
      seasonSeconds: this.seasonSeconds,
      epoch: this.marks.epoch,
      season: this.marks.season,
    });
    // Write and rename, so a crash mid-write cannot leave a truncated file that reads as "no marks"
    // and silently drops the guard.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.path);
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
      this.regression ??= { kind, observed: value, mark, at: this.nowSec() };
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
