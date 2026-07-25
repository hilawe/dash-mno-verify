import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TimeGuard } from "../core/time_guard.js";
import { SeasonMembers } from "../core/season.js";

// Epochs and seasons come straight from the clock, and the security state hangs off them: the epoch
// scopes the spent-nullifier set, the season scopes the members tree. A backward clock would rebuild
// a past season's tree from records still on disk and revive credentials that were meant to lapse.
// These pin the refusal.

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-time-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EPOCH = 100;
const SEASON = 1000;

// A guard whose clock the test drives directly.
function guardAt(path, clock) {
  return new TimeGuard({ path, epochSeconds: EPOCH, seasonSeconds: SEASON, nowSec: () => clock.t });
}

test("time moving forward is fine and advances the marks", () => {
  withDir((dir) => {
    const clock = { t: 10_000 };
    const g = guardAt(join(dir, "marks.json"), clock);
    assert.equal(g.epoch(), 100);
    clock.t = 20_000;
    assert.equal(g.epoch(), 200);
    assert.equal(g.regressed, false);
    assert.equal(g.status().epochMark, 200);
  });
});

test("time standing still inside a period is not a regression", () => {
  withDir((dir) => {
    const clock = { t: 10_000 };
    const g = guardAt(join(dir, "marks.json"), clock);
    g.epoch();
    clock.t = 10_050; // same epoch
    g.epoch();
    assert.equal(g.regressed, false);
  });
});

test("a backward step across an epoch boundary is caught", () => {
  withDir((dir) => {
    const clock = { t: 20_000 };
    const g = guardAt(join(dir, "marks.json"), clock);
    g.epoch();
    clock.t = 10_000; // the clock is corrected backwards
    g.epoch();
    assert.equal(g.regressed, true);
    assert.equal(g.regression.kind, "epoch");
    assert.equal(g.regression.observed, 100);
    assert.equal(g.regression.mark, 200);
  });
});

test("a backward season is caught, and the mark does not follow it down", () => {
  withDir((dir) => {
    const clock = { t: 20_000 };
    const g = guardAt(join(dir, "marks.json"), clock);
    assert.equal(g.season(), 20);
    clock.t = 5_000;
    g.season();
    assert.equal(g.regressed, true);
    assert.equal(g.status().seasonMark, 20, "the high-water mark must not be lowered");
  });
});

test("the marks survive a restart, so a reboot cannot clear the guard", () => {
  withDir((dir) => {
    const path = join(dir, "marks.json");
    const clock = { t: 20_000 };
    guardAt(path, clock).epoch();

    // A fresh process, with the clock now behind where the previous one had reached.
    clock.t = 10_000;
    const g2 = guardAt(path, clock);
    g2.epoch();
    assert.equal(g2.regressed, true, "a restart must not reset the high-water mark");
  });
});

test("regression is sticky once seen", () => {
  withDir((dir) => {
    const clock = { t: 20_000 };
    const g = guardAt(join(dir, "marks.json"), clock);
    g.epoch();
    clock.t = 10_000;
    g.epoch();
    clock.t = 30_000; // the clock recovers
    g.epoch();
    assert.equal(g.regressed, true, "recovery does not prove the state was untouched");
  });
});

test("marks written under a different period length are ignored, not treated as a regression", () => {
  withDir((dir) => {
    const path = join(dir, "marks.json");
    // Marks from a configuration with much shorter epochs carry much larger numbers.
    writeFileSync(path, JSON.stringify({ epochSeconds: 1, seasonSeconds: 1, epoch: 999_999, season: 999_999 }));
    const g = guardAt(path, { t: 20_000 });
    g.epoch();
    assert.equal(g.regressed, false, "renumbering is a config change, not a clock step");
  });
});

test("an unreadable marks file seeds fresh rather than failing to start", () => {
  withDir((dir) => {
    const path = join(dir, "marks.json");
    writeFileSync(path, "{ this is not json");
    const g = guardAt(path, { t: 20_000 });
    assert.equal(g.epoch(), 200);
    assert.equal(g.regressed, false);
  });
});

test("the marks file is written 0600 and is valid after each advance", () => {
  withDir((dir) => {
    const path = join(dir, "marks.json");
    const clock = { t: 20_000 };
    const g = guardAt(path, clock);
    g.epoch();
    g.season();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.epoch, 200);
    assert.equal(raw.season, 20);
    assert.equal(raw.epochSeconds, EPOCH);
  });
});

test("with no path the guard still works, it just does not persist", () => {
  const clock = { t: 20_000 };
  const g = new TimeGuard({ path: null, epochSeconds: EPOCH, seasonSeconds: SEASON, nowSec: () => clock.t });
  assert.equal(g.epoch(), 200);
  clock.t = 10_000;
  g.epoch();
  assert.equal(g.regressed, true, "the guard still holds within a process");
});

test("the members tree refuses to roll back to an earlier season", async () => {
  // Defense in depth behind the gateway's refusal: rebuilding a past season's trees would revive
  // registrations that should have lapsed.
  const sm = new SeasonMembers({
    store: { forSeasonContext: async () => [] },
    rootWindow: 4,
    emptyRoot: "0",
    nowSec: () => 1000,
    monotonic: true, // what the gateway sets; off by default so rebuilding a past season stays testable
  });
  await sm.ensure(20);
  await assert.rejects(sm.ensure(19), /refusing to roll the members tree back/);
  await sm.ensure(20); // the current season still works
  await sm.ensure(21); // and forward is fine
});
