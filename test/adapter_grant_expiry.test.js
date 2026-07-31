import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
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

// AWAITS the callback, for the same reason scopeDir below does. This one was the ORIGINAL fixture and
// it kept the defect after its sibling was fixed and commented: a synchronous function returning the
// callback's promise runs its finally at the first await, so the directory was removed while every
// test built on it was still running. They then operated on an unlinked handle, which happens to work
// on this platform and would not everywhere, so the tests appeared to exercise a durable file they had
// already deleted. Fixing one fixture, writing a comment about why it mattered, and leaving its twin
// fifteen lines away is the exact shape this component keeps producing.
async function withLedger(fn, { now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const applied = [];
  const revoked = [];
  const clock = { t: 1000 };
  const ledger = new GrantLedger({ exclusive: false,
    file: join(dir, "grants.json"),
    apply: async (id, r) => applied.push([id, r]),
    revoke: async (id) => revoked.push(id),
    now: now ?? (() => clock.t),
  });
  try {
    return await fn({ ledger, applied, revoked, clock, dir });
  } finally {
    ledger.close();
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
    const first = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
    await first.grant("u1", { expiresAt: 2000 });
    first.close(); // a restart means the first process is gone, and closing releases its claim

    // A fresh process, after the epoch has passed.
    const revoked = [];
    const second = new GrantLedger({ exclusive: false,
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const first = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 4000 });

    clock.t = 5000; // past the deadline; nothing is granted or revoked, but time moved on
    await first.sweep();
    first.close();

    // A fresh process whose clock sits back before the deadline.
    clock.t = 3000;
    const second = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
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
    const first = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 9000 });
    clock.t = 2000;
    await first.admitIfLive("u1", async () => {});
    assert.equal(first.clockIsSane, false, "the regression is noticed");
    first.close();

    clock.t = 6000;
    const second = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const first = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => clock.t });
    await first.grant("u1", { expiresAt: 2500 });

    // Time moves well past that grant, and a late renewal arrives carrying a deadline already gone.
    clock.t = 3000;
    await assert.rejects(first.grant("u1", { expiresAt: 2900 }), /already expired/);

    // Read the stored clock as it stands the instant the rejection returned. Before the fix this was
    // still 1000, because the write that would have raised it was queued behind the very operation
    // that threw. It is now written synchronously at the point of observation, so there is no window.
    assert.equal(storedMark(file), 3000, "the observation must be durable before the caller is told");

    // And the point of it: a restart with a corrected, lower clock must not revive the old grant.
    first.close();
    const second = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => 2000 });
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const ledger = new GrantLedger({ exclusive: false,
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
    const ledger = new GrantLedger({ exclusive: false,
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

// Shared state between two instances. `exclusive: false` on both, because the lock normally
// refuses the second one outright; what is under test here is what the state does when two of them
// DO coexist, which is what the revision guard exists to survive if the lock is ever lost.
test("two ledgers on one database share the grants and the clock floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const aClock = { t: 1000 };
    const a = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => aClock.t });
    await a.grant("u1", { expiresAt: 2000 });

    // A second process, still back at its own start time.
    const b = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
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

// The blocker two independent reviewers found in the SQLite migration, and the reason the sweep's
// delete is conditional on the revision it read.
//
// The per-member chain is a promise chain in memory, so it binds only the process it lives in. Two
// adapter processes therefore have no shared lock across the platform call in the middle of a
// removal. Process A's sweep reads an expired row and starts removing the access; process B records
// a fresh grant for that member and applies it; A then finishes and deletes the row. With an
// unconditional delete that left the member holding live access with NO record, which no later sweep
// can find, and which is exactly the outcome the whole lifecycle exists to prevent.
//
// The exclusive lock normally stops two processes coexisting at all. This is the backstop for the
// case the revision guard exists for, so both instances here run with the lock off.
test("a sweep overtaken by a fresh grant deletes nothing (the revision guard itself)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const clock = { t: 1000 };
    let releaseRevoke;
    const revokeGate = new Promise((r) => (releaseRevoke = r));
    let applied = false;

    const a = new GrantLedger({ exclusive: false,
      file,
      apply: async () => {},
      revoke: async () => {
        await revokeGate; // A is inside the platform call, holding only ITS OWN in-memory lock
      },
      now: () => clock.t,
      log: () => {},
    });
    const b = new GrantLedger({ exclusive: false,
      file,
      apply: async () => {
        applied = true;
      },
      revoke: async () => {},
      now: () => clock.t,
    });

    await a.grant("u1", { expiresAt: 2000 });
    clock.t = 3000; // the grant lapses

    const sweeping = a.sweep(); // reads the expired row, then blocks inside revoke
    await new Promise((r) => setImmediate(r));

    // The member re-verifies against the OTHER process while that removal is still in flight.
    await b.grant("u1", { expiresAt: 9000 });
    assert.equal(applied, true, "the fresh access was applied on the platform");

    releaseRevoke();
    const revoked = await sweeping;

    assert.deepEqual(revoked, [], "a sweep that was overtaken must not report a revocation");
    assert.equal(b.has("u1"), true, "the fresh grant must survive the stale sweep");
    assert.equal(b.get("u1").expiresAt, 9000, "and it must still be the fresh record");
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The layer that stops the situation above arising at all.
// A REAL second process, because two constructions inside one process prove nothing about what the
// kernel does between processes.
//
// The first version of this test had the holder end with `await new Promise(() => {})`, which does NOT
// keep Node's event loop alive: the child printed "held" and exited with code 13, so the lock was
// released and the parent was admitted. Under load that produced an intermittent failure that looked
// like the lock leaking, and the diagnostic said the holder was "alive" because `kill(pid, 0)`
// succeeds on an unreaped zombie. It was a test that did not test what its name claimed, which is the
// same defect the reviews kept finding elsewhere. Hence the explicit liveness assertion below: never
// conclude anything from this test without first proving the holder still exists.
test("a second process is refused while the first holds the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  const url = new URL("../adapters/common/grant_ledger.js", import.meta.url).href;
  const holder = `
    const { GrantLedger } = await import(${JSON.stringify(url)});
    const l = new GrantLedger({ file: ${JSON.stringify(file)}, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
    await l.grant("u1", { expiresAt: 9000 });
    setInterval(() => {}, 1000);   // this, not a pending promise, is what keeps the process alive
    console.log("held");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holder], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => String(d).includes("held") && resolve());
      child.on("exit", (code) => reject(new Error(`the holder exited (code ${code}) before taking the ledger`)));
    });
    assert.equal(child.exitCode, null, "the holder must still be running, or this proves nothing");

    const opts = { file, apply: async () => {}, revoke: async () => {}, now: () => 1000 };
    assert.throws(() => new GrantLedger(opts), /locked|busy|in use/i, "two adapters on one ledger");

    // And the moment that process is gone the ledger is available again, with its contents intact.
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    const second = new GrantLedger(opts);
    assert.equal(second.has("u1"), true, "the ledger is intact for the process that takes over");
    second.close();
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// The previous version of this test kept the "crashed" ledger open in this very process and advanced a
// fake clock, which both reviewers correctly said proves nothing about a dead process. This one really
// exits a child and checks that the lock died with it, with no staleness window to wait out.
test("the ledger is released when the process holding it exits, however it exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const url = new URL("../adapters/common/grant_ledger.js", import.meta.url).href;
    const child = `
      const { GrantLedger } = await import(${JSON.stringify(url)});
      const l = new GrantLedger({ file: ${JSON.stringify(file)}, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
      await l.grant("u1", { expiresAt: 9000 });
      process.kill(process.pid, "SIGKILL");   // no close(), no handler, nothing released by hand
    `;
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "ignore" });
      p.on("exit", resolve);
    });

    const after = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 1000 });
    assert.equal(after.has("u1"), true, "the grant the child wrote is there");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The revision must never be reused, including after a row is deleted and a new one inserted for the
// same member. Deriving it from the ROW (start at 1 on insert, increment on update) failed exactly
// there: a sweep could read revision 1, another sweep could delete the row, a fresh grant could insert
// a new row that also got revision 1, and the first sweep's conditional delete would then match the
// fresh row and delete it. Two reviewers reproduced that independently. The counter is database-wide,
// so a revision retired by a delete is never handed out again.
test("a revision is never reused, so delete-then-reinsert cannot collide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const revOf = (l) => {
      const db = new DatabaseSync(file);
      try {
        return db.prepare("SELECT rev FROM grants WHERE user_id='u1'").get()?.rev ?? null;
      } finally {
        db.close();
      }
    };
    const clock = { t: 1000 };
    const ledger = new GrantLedger({
      exclusive: false,
      file,
      apply: async () => {},
      revoke: async () => {},
      now: () => clock.t,
    });

    await ledger.grant("u1", { expiresAt: 2000 });
    const first = revOf();

    // Retire the row entirely, the way an expiry sweep does.
    clock.t = 2000;
    assert.deepEqual(await ledger.sweep(), ["u1"]);
    assert.equal(revOf(), null, "the row is gone");

    // A fresh grant for the same member is an INSERT, which is where the revision used to restart.
    await ledger.grant("u1", { expiresAt: 9000 });
    const second = revOf();

    assert.ok(second > first, `a reinserted row must not reuse a retired revision (${first} then ${second})`);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A decision must never rest on a clock reading that was not written down. The old code sampled TWICE
// per decision, once to persist and once to decide, and real time can cross an expiry boundary between
// the two. The adapter would then refuse on the strength of a time it had never recorded, and a later
// start with a lower clock found a floor one tick short of what it had already acted on and let the
// expired grant back in. The invariant, stated without reference to how it is achieved: once the
// ledger has reported a grant dead, no restart at any clock may report it live again.
test("a decision is never made on a clock reading that was not persisted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    // Advances on EVERY call, which is what a real clock does, and what a double sample cannot survive.
    let t = 1998;
    const mode = { advancing: false, fixed: 1000 };
    const now = () => (mode.advancing ? ++t : mode.fixed);

    const first = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now });
    await first.grant("u1", { expiresAt: 2000 });

    mode.advancing = true; // the next reading is 1999, the one after that 2000
    const reportedDead = first.live("u1") === false;
    first.close();

    // A restart with the clock well before the deadline.
    mode.advancing = false;
    mode.fixed = 1500;
    const second = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now });
    if (reportedDead) {
      assert.equal(second.live("u1"), false, "a grant already reported dead must not come back after a restart");
    }
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The error says "fix or remove it", so the operator has to be able to open the database to do that.
// The exclusive lock is taken by the first statement, so a constructor that threw while still holding
// the handle left the ledger locked by the very process that had just refused to start.
test("a constructor that refuses to start does not leave the ledger locked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const opts = { file, apply: async () => {}, revoke: async () => {}, now: () => 100 };
    const seed = new GrantLedger(opts);
    await seed.grant("u1", { expiresAt: 9000 });
    seed.close();

    // A validator this row cannot satisfy, so the next construction throws after opening.
    const strict = { ...opts, validate: (r) => Boolean(r) && Number.isFinite(r.expiresAt) && Boolean(r.mustHave) };
    assert.throws(() => new GrantLedger(strict), /malformed record/);

    // The operator must now be able to get in and repair it.
    const repair = new GrantLedger(opts);
    assert.equal(repair.has("u1"), true, "the ledger is openable again, and intact");
    repair.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// grant() was the fourth decision site and the one missed when the other three were fixed. It observed
// the clock, discarded the sample, and called the clock AGAIN for its deadline check, so it could
// refuse on a reading that was never persisted. The invariant, stated without reference to how it is
// achieved: if grant refuses a deadline as already passed, the clock it refused against must be on
// disk, so no restart can find a floor below it. Under the old code the refusal used 2000 while 1999
// was persisted, and a restart at 1500 then revived a grant that expired at 2000.
test("grant refuses on the same clock sample it persisted, not a later one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    let t = 1998;
    const mode = { advancing: false, fixed: 1000 };
    const now = () => (mode.advancing ? ++t : mode.fixed);
    const DEADLINE = 2000;

    const ledger = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now });
    await ledger.grant("u1", { expiresAt: DEADLINE });

    // Readings from here: 1999, then 2000, then 2001. A single sample sees 1999 and lets the renewal
    // through; a double sample sees 1999 then 2000 and refuses on the 2000 it never wrote down.
    mode.advancing = true;
    let refused = false;
    try {
      await ledger.grant("u1", { expiresAt: DEADLINE });
    } catch (e) {
      refused = /already expired/.test(e.message);
    }
    const mark = storedMark(file);
    ledger.close();

    if (refused) {
      assert.ok(
        mark >= DEADLINE,
        `refused a deadline of ${DEADLINE} but persisted only ${mark}, so a restart would revive it`,
      );
    }
    // And the consequence, checked directly: a restart well before the deadline must not disagree with
    // whatever this process already decided.
    mode.advancing = false;
    mode.fixed = 1500;
    const after = new GrantLedger({ exclusive: false, file, apply: async () => {}, revoke: async () => {}, now });
    assert.equal(after.live("u1"), !refused, "a grant refused as expired must not read as live after a restart");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The counter is the backstop for a lost exclusive lock, and it used to fail on exactly the databases
// that would need it: one written by the previous version, where the revision came from the row and
// restarted at 1 on every insert. Opening such a database created the counter at 1 all over again.
test("the revision counter is seeded above rows written before it existed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const opts = { exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => 1000 };
    new GrantLedger(opts).close();

    // Reproduce the previous version's state: rows carrying revisions, and no counter at all.
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO grants (user_id, expires_at, record, updated_at, rev) VALUES (?,?,?,?,?)")
      .run("u1", 9000, JSON.stringify({ expiresAt: 9000 }), 0, 7);
    db.prepare("DELETE FROM meta WHERE k='revSeq'").run();
    db.close();

    const ledger = new GrantLedger(opts);
    await ledger.grant("u2", { expiresAt: 9000 });
    const revs = (() => {
      const d = new DatabaseSync(file);
      try {
        return Object.fromEntries(d.prepare("SELECT user_id, rev FROM grants").all().map((r) => [r.user_id, r.rev]));
      } finally {
        d.close();
      }
    })();
    assert.ok(revs.u2 > revs.u1, `a fresh write must not reuse an existing revision (${revs.u1} then ${revs.u2})`);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Malformed counter text used to CAST to zero and quietly restart the sequence, which is the same
// collision by another route. Refuse to start instead.
test("a malformed revision counter refuses to start rather than restarting the sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.db");
  try {
    const opts = { exclusive: false, file, apply: async () => {}, revoke: async () => {}, now: () => 1000 };
    new GrantLedger(opts).close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO meta (k,v) VALUES ('revSeq','not a number') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
    db.close();
    assert.throws(() => new GrantLedger(opts), /malformed revision counter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- scope binding ---------------------------------------------------------------------------------
//
// A repointed adapter used to be able to delete the record of access that was still live somewhere
// else. A legacy record carried no place, "unknown" was read as "ours", the revoke went to the new
// place, the not-found came back, isGone called it already gone, and the row was deleted. The access
// stayed live and nothing tracked it. Per-record fields could not fix that, because the rows that
// caused it predate the field. The database itself is bound instead.

// AWAITS the callback. An earlier version of this helper did not, so the finally below removed the
// directory while an async test was still running, the reopen found no file, created a fresh empty
// database, and bound it silently. One test then failed for the right reason and another PASSED for
// the wrong one. A fixture that tears down early makes every test built on it meaningless in whichever
// direction it happens to land.
async function scopeDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-scope-"));
  const mk = (o) =>
    new GrantLedger({
      exclusive: false,
      apply: async () => {},
      revoke: async () => {},
      now: () => 1000,
      log: () => {},
      ...o,
    });
  const rec = (expiresAt) => ({ expiresAt, mode: "channel", channels: ["c1"] });
  try {
    return await fn({ dir, mk, rec, file: (n) => join(dir, n) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a fresh ledger binds to its scope, and reopening at the same scope is accepted", () =>
  scopeDir(({ mk, file }) => {
    const f = file("a.db");
    const first = mk({ file: f, scope: "guildA" });
    assert.equal(first.scope(), "guildA");
    first.close();
    const again = mk({ file: f, scope: "guildA" });
    assert.equal(again.scope(), "guildA");
    again.close();
  }));

test("reopening a bound ledger at a different scope throws and deletes nothing", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const f = file("a.db");
    const first = mk({ file: f, scope: "guildA" });
    await first.grant("u1", rec(9999));
    first.close();

    assert.throws(() => mk({ file: f, scope: "guildB" }), /bound to guildA/);

    // The refusal must not have swept, revoked, or dropped the row it refused to reason about.
    const back = mk({ file: f, scope: "guildA" });
    assert.equal(back.size(), 1, "the refused repoint left the grant intact");
    assert.equal(back.get("u1").expiresAt, 9999);
    back.close();
  }));

test("an unbound ledger that already holds grants refuses to bind on its own", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const f = file("legacy.db");
    const seed = mk({ file: f, scope: null });
    await seed.grant("u1", rec(9999));
    assert.equal(seed.scope(), null, "no scope was configured, so nothing was bound");
    seed.close();

    assert.throws(() => mk({ file: f, scope: "guildA" }), /not bound to any scope/);
  }));

test("adopting an unbound ledger requires naming the scope, and a mistyped name is refused", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const f = file("legacy.db");
    const seed = mk({ file: f, scope: null });
    await seed.grant("u1", rec(9999));
    seed.close();

    assert.throws(
      () => mk({ file: f, scope: "guildA", adoptScope: "guildZ" }),
      /was guildZ, which is not guildA/,
      "an assertion that does not match the configured scope must not adopt",
    );

    const adopted = mk({ file: f, scope: "guildA", adoptScope: "guildA" });
    assert.equal(adopted.scope(), "guildA");
    assert.equal(adopted.size(), 1, "adoption keeps the grants rather than starting over");
    adopted.close();
  }));

test("a legacy JSON import reaches the same fail-closed path as rows already in the database", () =>
  scopeDir(({ mk, rec, file }) => {
    const f = file("imported.db");
    const json = file("grants.json");
    writeFileSync(json, JSON.stringify({ grants: { u9: rec(9999) } }));
    // The import commits before the binding is judged, so these rows are held to the same rule: their
    // origin is unknowable, so they are not assumed local.
    assert.throws(() => mk({ file: f, scope: "guildA", importFrom: json }), /not bound to any scope/);
  }));

// The guard that refuses a repoint has to have an exit that correct operation reaches, or it is a trap
// rather than a guard. An operator who decommissions the old place properly ends up with an empty
// ledger, and an empty ledger has no live access to forget, so it rebinds.
test("an emptied ledger rebinds to a new scope, so the documented recovery can finish", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const f = file("a.db");
    const old = mk({ file: f, scope: "guildA" });
    await old.grant("u1", rec(9999));
    old.close();

    assert.throws(() => mk({ file: f, scope: "guildB" }), /still holds 1 grant/,
      "while the grant is there the repoint is refused");

    // What a decommission does: take the access back on the platform, then stop tracking it.
    const settling = mk({ file: f, scope: "guildA" });
    const out = settling.retireAll(() => null);
    assert.deepEqual(
      { deleted: out.deleted, remaining: out.remaining },
      { deleted: 1, remaining: 0 },
      "retiring the last target empties the ledger",
    );
    settling.close();

    const moved = mk({ file: f, scope: "guildB" });
    assert.equal(moved.scope(), "guildB", "the emptied ledger rebound instead of refusing forever");
    moved.close();
  }));

test("retireAll narrows, deletes, and leaves records alone in one pass", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const l = mk({ file: file("r.db"), scope: "g" });
    await l.grant("keep", rec(9999));
    await l.grant("narrow", { expiresAt: 9999, mode: "channel", channels: ["c1", "c2"] });
    await l.grant("drop", { expiresAt: 9999, mode: "channel", channels: ["c2"] });

    const out = l.retireAll((record, userId) => {
      if (userId === "keep") return record;
      const left = record.channels.filter((c) => c !== "c2");
      return left.length ? { ...record, channels: left } : null;
    });

    assert.deepEqual({ changed: out.changed, deleted: out.deleted, remaining: out.remaining },
      { changed: 1, deleted: 1, remaining: 2 });
    assert.deepEqual(l.get("narrow").channels, ["c1"], "the retired channel is gone and the other stays");
    assert.deepEqual(l.get("keep").channels, ["c1"], "a record the transform returned unchanged is untouched");
    assert.equal(l.has("drop"), false, "a record left with no target at all is gone from the ledger");
    l.close();
  }));

test("a retirement that would leave an invalid record changes nothing at all", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const f = file("bad.db");
    const l = mk({ file: f, scope: "g", validate: (r) => Boolean(r) && Number.isFinite(r.expiresAt) });
    await l.grant("u1", rec(9999));
    await l.grant("u2", rec(9999));

    assert.throws(
      () => l.retireAll((record, userId) => (userId === "u2" ? { ...record, expiresAt: NaN } : null)),
      /invalid record/,
    );
    // u1 was transformed to null BEFORE u2 failed, so if the transaction did not roll back it would
    // already be gone. This assertion is the whole point of the test.
    assert.equal(l.size(), 2, "the rollback put back the row the failing pass had already deleted");
    l.close();
  }));

// A forward clock jump raises the durable floor. Correcting the clock afterwards leaves the floor
// above the raw reading, so a deadline can sit in the future against the clock and in the past against
// the floor. grant() used to compare against the raw reading while every expiry decision used the
// floor, and it does not merely persist a record, it calls apply() directly. So the access reached the
// platform while live() already reported false, and sat there until the next sweep. A member could
// repeat it after every sweep for as long as the inflated floor stood.
test("a grant is refused when the durable floor is past its deadline, even when the clock is not", async () =>
  scopeDir(async ({ mk, file }) => {
    const clock = { t: 1000 };
    const applied = [];
    const l = mk({
      file: file("clock.db"),
      scope: "g",
      now: () => clock.t,
      apply: async (id) => applied.push(id),
    });

    clock.t = 10000; // a forward jump
    l.live("nobody"); // observing the clock is what records it in the durable floor
    clock.t = 1000; // and the clock is corrected back

    // 2000 is in the future against the corrected clock and in the past against the floor.
    await assert.rejects(() => l.grant("u1", { expiresAt: 2000, mode: "channel", channels: ["c1"] }),
      /already observed time 10000/);
    assert.deepEqual(applied, [], "nothing reached the platform, which is the half a refusal alone would not prove");
    assert.equal(l.has("u1"), false, "and nothing was persisted");

    // Past the floor it works again, so this is a refusal and not a wedge.
    clock.t = 10001;
    await l.grant("u2", { expiresAt: 20000, mode: "channel", channels: ["c1"] });
    assert.deepEqual(applied, ["u2"]);
    l.close();
  }));

// An empty database bound elsewhere used to be rebound BEFORE the legacy import ran, so the import
// then brought in rows of unknown origin and the adoption guard never fired. The comment on the
// binding says imported rows meet the same rule as rows already present, and that was true of every
// path except this one.
test("a pending legacy import counts as rows, so an empty foreign ledger is not rebound around it", async () =>
  scopeDir(async ({ mk, rec, file }) => {
    const db = file("bound.db");
    const json = file("legacy.json");

    // An empty database, bound to guildA.
    const first = mk({ file: db, scope: "guildA" });
    assert.equal(first.scope(), "guildA");
    assert.equal(first.size(), 0, "empty, which is what used to make the rebind look safe");
    first.close();

    writeFileSync(json, JSON.stringify({ grants: { u1: rec(9999) } }));

    // Opening for guildB with that import pending must NOT quietly rebind and adopt.
    assert.throws(
      () => mk({ file: db, scope: "guildB", importFrom: json }),
      /still holds 1 grant/,
      "the pending import is counted, so the foreign-scope refusal fires",
    );

    // And the refusal must not have consumed the operator's file.
    assert.equal(existsSync(json), true, "the legacy file was peeked at, not moved aside");
    assert.equal(existsSync(`${json}.migrated`), false);
  }));

test("an empty ledger with no pending import still rebinds, so the recovery is not blocked", async () =>
  scopeDir(async ({ mk, file }) => {
    const db = file("bound.db");
    mk({ file: db, scope: "guildA" }).close();
    const moved = mk({ file: db, scope: "guildB" });
    assert.equal(moved.scope(), "guildB", "genuinely empty still rebinds");
    moved.close();
  }));
