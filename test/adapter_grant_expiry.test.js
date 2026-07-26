import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrantLedger } from "../adapters/common/grant_ledger.js";

// The persisted high-water clock, read straight out of the ledger rather than through the instance
// that wrote it, so a test can tell "recorded in memory" from "actually on disk".
function storedMark(file) {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k='clockMark'").get();
    return row === undefined ? null : Number(row.v);
  } finally {
    db.close();
  }
}

// Telegram and Matrix used to hand out access and never take it back, so a member kept the room or
// the group long after the epoch they proved for. Both now record the grant and sweep it, using the
// ledger extracted from the Discord adapter. Telegram additionally decides admission from the ledger,
// because its invite link is public by nature and only the approval binds access to an account.

function withLedger(fn, { now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const applied = [];
  const revoked = [];
  const clock = { t: 1000 };
  const ledger = new GrantLedger({
    file: join(dir, "grants.json"),
    apply: async (id, r) => applied.push([id, r]),
    revoke: async (id) => revoked.push(id),
    now: now ?? (() => clock.t),
  });
  try {
    return fn({ ledger, applied, revoked, clock, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a grant is recorded and applied, then swept once the epoch lapses", async () => {
  await withLedger(async ({ ledger, applied, revoked, clock }) => {
    await ledger.grant("u1", { expiresAt: 2000 });
    assert.deepEqual(applied[0][0], "u1");
    assert.equal(ledger.has("u1"), true);

    clock.t = 1999;
    assert.deepEqual(await ledger.sweep(), [], "not due yet");

    clock.t = 2000;
    assert.deepEqual(await ledger.sweep(), ["u1"], "due at expiry");
    assert.deepEqual(revoked, ["u1"]);
    assert.equal(ledger.has("u1"), false, "the record is cleared once access is taken back");
  });
});

test("live() is what admission should be decided on", async () => {
  await withLedger(async ({ ledger, clock }) => {
    assert.equal(ledger.live("u1"), false, "an unknown account has no access");
    await ledger.grant("u1", { expiresAt: 2000 });
    assert.equal(ledger.live("u1"), true);
    clock.t = 2000;
    assert.equal(ledger.live("u1"), false, "a lapsed grant does not admit, even before the sweep runs");
    assert.equal(ledger.has("u1"), true, "the record is still there until swept, but it is not live");
  });
});

test("a forwarded link admits nobody: only the granted account is live", async () => {
  // The Telegram failure this closes. The proof binds to one account, so a second account following
  // the same link must not be admitted.
  await withLedger(async ({ ledger }) => {
    await ledger.grant("prover", { expiresAt: 2000 });
    assert.equal(ledger.live("prover"), true);
    assert.equal(ledger.live("someone-else"), false, "a forwarded link grants the forwardee nothing");
  });
});

test("a grant survives a restart, so the sweep still knows to revoke it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.json");
  try {
    const first = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
    await first.grant("u1", { expiresAt: 2000 });

    // A fresh process, after the epoch has passed.
    const revoked = [];
    const second = new GrantLedger({
      file,
      apply: async () => {},
      revoke: async (id) => revoked.push(id),
      now: () => 3000,
    });
    assert.equal(second.has("u1"), true, "the ledger outlives the process");
    assert.deepEqual(await second.sweep(), ["u1"]);
    assert.deepEqual(revoked, ["u1"], "access is taken back even though the grant predates this run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-verification during the epoch extends access instead of being swept", async () => {
  await withLedger(async ({ ledger, revoked, clock }) => {
    await ledger.grant("u1", { expiresAt: 2000 });
    clock.t = 1900;
    await ledger.grant("u1", { expiresAt: 4000 }); // renewed before lapsing
    clock.t = 2500;
    assert.deepEqual(await ledger.sweep(), [], "the renewed grant is not due");
    assert.deepEqual(revoked, [], "and nothing was revoked out from under the member");
    assert.equal(ledger.live("u1"), true);
  });
});

test("a revoke failure keeps the record so it retries rather than losing track of live access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const clock = { t: 1000 };
    let fail = true;
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async () => {
        if (fail) throw new Error("platform unavailable");
      },
      now: () => clock.t,
      log: () => {},
    });
    await ledger.grant("u1", { expiresAt: 2000 }); // granted while valid
    clock.t = 3000;                                // and now past its deadline
    assert.deepEqual(await ledger.sweep(), [], "a failed revoke reports nothing revoked");
    assert.equal(ledger.has("u1"), true, "the record stays so the access is not left untracked");

    fail = false;
    assert.deepEqual(await ledger.sweep(), ["u1"], "the retry succeeds");
    assert.equal(ledger.has("u1"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record with no expiry is refused rather than granted forever", async () => {
  await withLedger(async ({ ledger }) => {
    await assert.rejects(ledger.grant("u1", {}), /malformed/);
    await assert.rejects(ledger.grant("u1", { expiresAt: "soon" }), /malformed/);
    assert.equal(ledger.has("u1"), false);
  });
});

// --- the adapter's own clock, and the upgrade gate ------------------------------------------------

test("a rolled-back clock cannot revive an expired grant", async () => {
  // The security property. The adapter decides admission against absolute deadlines, so winding its
  // clock back must not make a lapsed grant look live again.
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const clock = { t: 1000 };
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async () => {},
      now: () => clock.t,
    });
    await ledger.grant("u1", { expiresAt: 2000 });

    clock.t = 3000; // the grant lapses, and the mark records that this time was reached
    assert.equal(ledger.live("u1"), false);

    clock.t = 1500; // wound back to before the deadline
    assert.equal(ledger.live("u1"), false, "an expired grant must not come back to life");
    let admitted = false;
    const ok = await ledger.admitIfLive("u1", async () => {
      admitted = true;
    });
    assert.equal(ok, false);
    assert.equal(admitted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a small backward clock correction does not revoke healthy members", async () => {
  // The other half. An earlier cut treated any regression as "revoke everything", so a routine NTP
  // step of a second would have destroyed every live grant and forced the whole community to
  // re-verify. That is a self-inflicted outage, not a safety measure.
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const clock = { t: 1000 };
    const revoked = [];
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async (id) => revoked.push(id),
      now: () => clock.t,
    });
    await ledger.grant("u1", { expiresAt: 9000 });
    await ledger.grant("u2", { expiresAt: 9000 });

    clock.t = 999; // a one-second correction
    assert.deepEqual(await ledger.sweep(), [], "nothing is due, so nothing may be revoked");
    assert.deepEqual(revoked, []);
    assert.equal(ledger.live("u1"), true, "healthy members keep the access they proved for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the clock mark is durable even when no grant changes", async () => {
  // A quiet sweep or admission check used to advance the mark in memory only, so a restart compared
  // against an older mark and a rollback to a time between the two went unnoticed.
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.json");
  try {
    const clock = { t: 1000 };
    const first = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 4000 });

    clock.t = 5000; // past the deadline; nothing is granted or revoked, but time moved on
    await first.sweep();

    // A fresh process whose clock sits back before the deadline.
    clock.t = 3000;
    const second = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    assert.equal(second.live("u1"), false, "the persisted high-water keeps the grant expired");
    assert.equal(second.clockStatus.mark, 5000, "the quiet observation was written down");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clock regression is recorded for the operator and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.json");
  try {
    const clock = { t: 5000 };
    const first = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 9000 });
    clock.t = 2000;
    await first.admitIfLive("u1", async () => {});
    assert.equal(first.clockIsSane, false, "the regression is noticed");

    clock.t = 6000;
    const second = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    assert.equal(second.clockIsSane, false, "and a corrected clock does not erase the evidence");
    assert.equal(second.live("u1"), true, "while a still-valid grant is not punished for it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission is serialized against the sweep, so an approval cannot outlive its record", async () => {
  // The race all three reviewers found: check live, await the platform approval, and have the sweep
  // delete the record while that call is in flight, leaving a member admitted but untracked.
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const clock = { t: 1000 };
    const revoked = [];
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async (id) => revoked.push(id),
      now: () => clock.t,
    });
    await ledger.grant("u1", { expiresAt: 2000 });

    let release;
    const admitting = ledger.admitIfLive("u1", () => new Promise((r) => (release = r)));
    await new Promise((r) => setImmediate(r)); // the admission is now in flight, holding the queue

    clock.t = 2000; // the grant lapses while the approval is outstanding
    const sweeping = ledger.sweep();
    release();
    assert.equal(await admitting, true, "the admission that was already authorized completes");
    await sweeping;
    assert.deepEqual(revoked, ["u1"], "and the sweep still removes them afterwards, so nothing is untracked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admission requires the record to match the current target", async () => {
  await withLedger(async ({ ledger }) => {
    await ledger.grant("u1", { expiresAt: 2000, chatId: "-100old" });
    const ok = await ledger.admitIfLive("u1", async () => {}, (rec) => rec.chatId === "-100new");
    assert.equal(ok, false, "a grant issued for another chat must not admit here");
  });
});

// The rejection path in grant() is a decision made on the strength of the clock, so the advanced
// high-water mark has to be on disk before the caller hears about it. It used to only ENQUEUE that
// write, behind the very operation that was throwing, so the rejection always won the race. A crash
// in that window lost the observation, and a later backward correction let an existing grant that was
// already past its deadline read as live again.
test("a refused grant persists the clock it refused against before it returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.json");
  try {
    const clock = { t: 1000 };
    const first = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 2500 });

    // Time moves well past that grant, and a late renewal arrives carrying a deadline already gone.
    clock.t = 3000;
    await assert.rejects(first.grant("u1", { expiresAt: 2900 }), /already expired/);

    // Read the stored clock as it stands the instant the rejection returned. Before the fix this was
    // still 1000, because the write that would have raised it was queued behind the very operation
    // that threw. It is now written synchronously at the point of observation, so there is no window.
    assert.equal(storedMark(file), 3000, "the observation must be durable before the caller is told");

    // And the point of it: a restart with a corrected, lower clock must not revive the old grant.
    const second = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 2000 });
    assert.equal(second.live("u1"), false, "an expired grant must not come back under a rolled-back clock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Matrix and Telegram act on the target named in the record. Reading the module-level room or chat id
// meant that after an operator repointed the bot, a sweep removed the member from the NEW target and
// deleted the record, so their access to the OLD one became permanent with nothing left to revoke it.
test("a sweep revokes against the target the grant recorded, not the one now configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const calls = [];
    const clock = { t: 1000 };
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async (id, r) => calls.push([id, r.roomId]),
      validate: (r) => Boolean(r) && Number.isFinite(r.expiresAt) && Boolean(r.roomId),
      orphaned: (prev, next) => (String(prev.roomId) === String(next.roomId) ? null : prev),
      now: () => clock.t,
    });
    await ledger.grant("u1", { expiresAt: 2000, roomId: "!old:hs" });
    clock.t = 2000;
    assert.deepEqual(await ledger.sweep(), ["u1"]);
    assert.deepEqual(calls, [["u1", "!old:hs"]], "the old room is what gets revoked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a renewal onto a different target revokes the old one before granting the new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    const revoked = [];
    const applied = [];
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async (id, r) => applied.push(r.roomId),
      revoke: async (id, r) => revoked.push(r.roomId),
      validate: (r) => Boolean(r) && Number.isFinite(r.expiresAt) && Boolean(r.roomId),
      orphaned: (prev, next) => (String(prev.roomId) === String(next.roomId) ? null : prev),
      now: () => 1000,
    });
    await ledger.grant("u1", { expiresAt: 2000, roomId: "!old:hs" });
    await ledger.grant("u1", { expiresAt: 2000, roomId: "!new:hs" });
    assert.deepEqual(revoked, ["!old:hs"], "the orphaned room must not be left live and untracked");
    assert.deepEqual(applied, ["!old:hs", "!new:hs"]);

    // A renewal that stays put carries forward and revokes nothing.
    await ledger.grant("u1", { expiresAt: 2400, roomId: "!new:hs" });
    assert.deepEqual(revoked, ["!old:hs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The point of moving off the whole-map rewrite. That rewrite forced ONE global queue, so a slow
// platform call for one member blocked every other member's grant behind it. Locking is per member
// now, and a per-row write needs no cross-member coordination. If this ever regresses the test does
// not fail an assertion, it times out, which is exactly what the old design did to real members.
test("a slow platform call for one member does not hold up another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  try {
    let release;
    const gate = new Promise((r) => (release = r));
    const ledger = new GrantLedger({
      file: join(dir, "grants.db"),
      apply: async (id) => {
        if (id === "slow") await gate;
      },
      revoke: async () => {},
      now: () => 1000,
    });
    const slow = ledger.grant("slow", { expiresAt: 2000 });
    await new Promise((r) => setImmediate(r)); // "slow" is now inside its platform call

    await ledger.grant("fast", { expiresAt: 2000 });
    assert.equal(ledger.has("fast"), true, "an unrelated member must not wait on someone else's call");

    release();
    await slow;
    assert.equal(ledger.has("slow"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Cross-process safety, which the single-file ledger never had: two instances would have interleaved
// whole-map writes and lost grants. Both sides now see each other's rows, and the clock floor is read
// back from the database on every observation rather than trusted from memory, so a lagging process
// cannot admit against a floor another process has already moved past.
test("two ledgers on one database share the grants and the clock floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const aClock = { t: 1000 };
    const a = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => aClock.t });
    await a.grant("u1", { expiresAt: 2000 });

    // A second process, still back at its own start time.
    const b = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
    assert.equal(b.has("u1"), true, "the grant one process wrote is visible to the other");
    assert.equal(b.live("u1"), true);

    // The first process reaches a time past the deadline. The second one's own clock has not moved.
    aClock.t = 3000;
    assert.equal(a.live("u1"), false);

    assert.equal(b.live("u1"), false, "the shared floor expires the grant for both");
    assert.equal(storedMark(file), 3000, "and the lagging process did not pull the floor back down");

    // A grant the second process records is likewise visible to the first.
    await b.grant("u2", { expiresAt: 9000 });
    assert.equal(a.has("u2"), true);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
