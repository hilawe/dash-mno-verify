import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantLedger, extraTargets } from "../adapters/discord/grant_ledger.js";

// The grant ledger is what makes Discord-side access durable and correctly revoked. These pin the
// behaviors the review flagged: survive a restart, revoke on expiry, leave a fresh re-verification
// alone, and never keep a record for access that did not actually apply.

const tmpDir = () => mkdtempSync(join(tmpdir(), "mno-grant-"));
const tmpFile = () => join(tmpDir(), "grants.db");

// Read the durable state back independently of the instance under test, which is the whole point of
// the assertions that use it. Opening a second connection is also the closest thing to what a restart
// or a second adapter process would see.
function onDisk(file) {
  const db = new DatabaseSync(file);
  try {
    const out = {};
    for (const r of db.prepare("SELECT user_id, record FROM grants").all()) out[r.user_id] = JSON.parse(r.record);
    return out;
  } finally {
    db.close();
  }
}
const rec = (expiresAt) => ({ expiresAt, mode: "channel", channels: ["c1"] });
const noop = () => Promise.resolve();

test("a grant persists and applies, and a fresh ledger on the same file sees it (restart)", async () => {
  const file = tmpFile();
  const applied = [];
  const l1 = new GrantLedger({ exclusive: false, file, apply: (u, r) => (applied.push([u, r.expiresAt]), noop()), revoke: noop, now: () => 100 });
  await l1.grant("u1", rec(200));
  assert.deepEqual(applied, [["u1", 200]]);
  assert.ok(existsSync(file));
  l1.close(); // a restart means the first process is gone, and closing releases its claim
  const l2 = new GrantLedger({ exclusive: false, file, apply: noop, revoke: noop, now: () => 100 });
  assert.equal(l2.has("u1"), true);
});

test("the sweep revokes an expired grant, removes it, reports it, and leaves a valid one", async () => {
  const file = tmpFile();
  const revoked = [];
  const clock = { t: 100 };
  const l = new GrantLedger({ exclusive: false, file, apply: noop, revoke: (u) => (revoked.push(u), noop()), now: () => clock.t });
  await l.grant("expired", rec(200)); // both granted while valid
  await l.grant("valid", rec(5000));
  clock.t = 300; // only the first has lapsed
  assert.deepEqual(await l.sweep(), ["expired"]);
  assert.deepEqual(revoked, ["expired"]);
  assert.equal(l.has("expired"), false);
  assert.equal(l.has("valid"), true);
});

test("a not-yet-expired grant is left alone by the sweep", async () => {
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ exclusive: false, file, apply: noop, revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await l.grant("u1", rec(500));
  assert.deepEqual(await l.sweep(), []);
  assert.equal(revoked.length, 0);
});

// The race the review found: the sweep deletes an expired record then awaits the revoke, and a fresh
// re-verification can land in that window. The per-user lock must serialize the two, so the revoke
// fully completes before the new grant applies, and the fresh grant wins.
test("a grant and a revoke for the same user do not interleave", async () => {
  const file = tmpFile();
  // The grant is made while it is still valid and the clock then moves past it, which is how a grant
  // actually expires. Granting an already-expired record is refused now, since that would apply
  // access that is dead on arrival.
  const clock = { t: 100 };
  const events = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: async (u) => { events.push(`apply:${u}`); },
    revoke: async (u) => { events.push(`revoke-start:${u}`); await gate; events.push(`revoke-end:${u}`); },
    now: () => clock.t,
  });
  await l.grant("u1", rec(200)); // granted while valid
  clock.t = 300;                // and now lapsed, so the sweep has work
  events.length = 0;
  const sweepP = l.sweep();              // begins revoking u1, then blocks on the gate
  const grantP = l.grant("u1", rec(9999)); // a fresh re-verification, queued behind the revoke
  await Promise.resolve();
  release();
  await Promise.all([sweepP, grantP]);
  assert.deepEqual(events, ["revoke-start:u1", "revoke-end:u1", "apply:u1"]);
  assert.equal(l.has("u1"), true); // the fresh grant wins
});

// A failed apply may have partially granted, so the record must be kept (so the sweep cleans it up),
// and the bot best-effort revokes the uncertain access now. Never leave live access untracked.
test("a failed first grant keeps a record and best-effort revokes", async () => {
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ exclusive: false, file, apply: () => Promise.reject(new Error("discord down")), revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await assert.rejects(l.grant("u1", rec(200)), /discord down/);
  assert.equal(l.has("u1"), true);
  assert.deepEqual(revoked, ["u1"]);
  assert.equal("u1" in onDisk(file), true);
});

// A failed renewal must not touch the member's existing valid access, and must keep tracking it under
// the prior grant's expiry, not the failed new one.
// Same target, so there is no orphan to migrate and the still-live access is what the record describes.
// A failed apply keeps that record (never strands), and nothing is revoked.
test("a failed same-target renewal keeps the new grant and strands nothing", async () => {
  const file = tmpFile();
  let fail = false;
  const revoked = [];
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: () => (fail ? Promise.reject(new Error("down")) : noop()),
    revoke: (u) => (revoked.push(u), noop()),
    now: () => 100,
  });
  await l.grant("u1", rec(200));
  fail = true;
  await assert.rejects(l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }), /down/);
  assert.equal(onDisk(file).u1.expiresAt, 999);
  assert.equal(revoked.length, 0);
});

// A ledger that cannot be read is an error, never "nothing to revoke". Reading it as empty would
// silently strand every live grant, because the sweep only ever looks at what it loaded.
test("a missing ledger loads as empty (first run), an unreadable one fails startup", () => {
  const empty = tmpFile(); // the dir exists, the file does not
  assert.equal(new GrantLedger({ exclusive: false, file: empty, apply: noop, revoke: noop }).size(), 0);

  const notADatabase = tmpFile();
  writeFileSync(notADatabase, "{ not a database");
  assert.throws(() => new GrantLedger({ exclusive: false, file: notADatabase, apply: noop, revoke: noop }));
});

// A row that does not satisfy the adapter's own validator fails the load rather than being skipped.
// The mode-specific target has to be there, or a sweep would delete the record without being able to
// revoke the real access behind it.
test("a malformed row already in the database fails startup", () => {
  for (const bad of [
    { mode: "channel" }, // no expiresAt
    { expiresAt: 100, mode: "channel" }, // a mode with no target
    { expiresAt: 100, mode: "role" }, // likewise
  ]) {
    const file = tmpFile();
    new GrantLedger({ file, apply: noop, revoke: noop }).close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO grants (user_id, expires_at, record, updated_at) VALUES (?, ?, ?, ?)").run(
      "u1",
      Number(bad.expiresAt ?? 0),
      JSON.stringify(bad),
      0,
    );
    db.close();
    assert.throws(() => new GrantLedger({ file, apply: noop, revoke: noop }), /malformed record/);
  }
});

// The migration off the JSON file this store replaces. It has to move the grants and the clock state
// across, refuse a file it cannot vouch for rather than adopt it partially, and leave the old file
// behind under a new name so the operator keeps their only copy of the previous state.
test("a legacy JSON ledger is adopted once, with its clock state, and moved aside", () => {
  const dir = tmpDir();
  const legacy = join(dir, "grants.json");
  const file = join(dir, "grants.db");
  writeFileSync(
    legacy,
    JSON.stringify({
      meta: { clockMark: 4242, clockRegressed: { observed: 5, mark: 9, at: 5 } },
      grants: { u1: { expiresAt: 9000, mode: "channel", channels: ["c1"] } },
    }),
  );

  const l = new GrantLedger({ exclusive: false, file, importFrom: legacy, apply: noop, revoke: noop, now: () => 100 });
  assert.equal(l.has("u1"), true, "the grant came across");
  assert.equal(l.clockStatus.mark, 4242, "and so did the high-water clock");
  assert.equal(l.clockIsSane, false, "a recorded regression is not forgotten by the migration");
  assert.equal(existsSync(legacy), false, "the old file is moved aside");
  assert.equal(existsSync(`${legacy}.migrated`), true, "but never deleted");
  l.close();

  // Re-opening must not import a second time, including if someone restores the old file by hand.
  writeFileSync(legacy, JSON.stringify({ grants: { u2: { expiresAt: 9000, mode: "role", roleId: "r1" } } }));
  const again = new GrantLedger({ exclusive: false, file, importFrom: legacy, apply: noop, revoke: noop, now: () => 100 });
  assert.equal(again.has("u2"), false, "a database that has already been imported into is left alone");
  assert.equal(existsSync(legacy), true, "and the restored file is not consumed");
});

test("a legacy ledger with a malformed record fails the migration rather than adopting part of it", () => {
  const dir = tmpDir();
  const legacy = join(dir, "grants.json");
  const file = join(dir, "grants.db");
  writeFileSync(
    legacy,
    JSON.stringify({
      grants: {
        u1: { expiresAt: 9000, mode: "channel", channels: ["c1"] },
        u2: { expiresAt: 9000, mode: "channel" }, // no target
      },
    }),
  );
  assert.throws(
    () => new GrantLedger({ exclusive: false, file, importFrom: legacy, apply: noop, revoke: noop }),
    /malformed record for u2/,
  );
  assert.equal(existsSync(legacy), true, "the source is untouched so it can be fixed and retried");
  assert.deepEqual(onDisk(file), {}, "and nothing was adopted, not even the record that was fine");
});

// A real revoke failure (a Discord outage or lost permission, not a 404) must not drop the record, or
// the access goes untracked and permanent. The sweep keeps it and a later sweep retries.
test("a revoke failure during the sweep keeps the grant for a later retry", async () => {
  const file = tmpFile();
  const clock = { t: 100 };
  let failRevoke = true;
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: noop,
    revoke: () => (failRevoke ? Promise.reject(new Error("discord 500")) : noop()),
    now: () => clock.t,
  });
  await l.grant("u1", rec(200)); // granted while valid
  clock.t = 300; // and now past its deadline
  assert.deepEqual(await l.sweep(), []); // revoke failed, nothing reported revoked
  assert.equal(l.has("u1"), true); // record kept
  failRevoke = false;
  assert.deepEqual(await l.sweep(), ["u1"]); // retry succeeds
  assert.equal(l.has("u1"), false);
});

// A renewal that drops a target (here c2, or a mode or role-id change) must revoke the orphaned old
// target before applying the new grant, so the old access does not stay live and untracked.
test("a renewal that drops a target revokes the orphaned one before applying", async () => {
  const file = tmpFile();
  const revokedRecords = [];
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: noop,
    revoke: (u, r) => (revokedRecords.push(r), noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  await l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }); // drops c2
  assert.deepEqual(revokedRecords, [{ mode: "channel", channels: ["c2"] }]);
  assert.deepEqual(onDisk(file).u1, { expiresAt: 999, mode: "channel", channels: ["c1"] });
});

// If revoking the orphaned target fails, the renewal must abort with the prior grant intact, so the
// old access stays both live and tracked rather than half-migrated and stranded.
test("if migrating the prior grant fails, the renewal aborts and keeps the prior grant", async () => {
  const file = tmpFile();
  let migrateFail = false;
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: noop,
    revoke: () => (migrateFail ? Promise.reject(new Error("revoke down")) : noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  migrateFail = true;
  await assert.rejects(l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }), /could not migrate/);
  assert.deepEqual(onDisk(file).u1, { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
});

// The write path must reject a malformed record (here a non-finite expiry), or it would persist and
// apply access that never expires and then breaks the next startup load.
test("grant refuses a malformed record before writing or applying", async () => {
  const file = tmpFile();
  const applied = [];
  const l = new GrantLedger({ exclusive: false, file, apply: (u) => (applied.push(u), noop()), revoke: noop, now: () => 100 });
  await assert.rejects(l.grant("u1", { mode: "channel", channels: ["c1"] }), /malformed/); // no expiresAt
  assert.equal(l.has("u1"), false);
  assert.equal(applied.length, 0);
  assert.deepEqual(onDisk(file), {}, "nothing was written");
});

// Grants for different members now run in parallel rather than behind one global queue, so this is
// the check that parallelism does not lose an update. Under the old whole-map rewrite two saves could
// interleave and one would win; a per-row write cannot.
test("concurrent grants for different users all persist", async () => {
  const file = tmpFile();
  const l = new GrantLedger({ exclusive: false, file, apply: noop, revoke: noop, now: () => 100 });
  await Promise.all([l.grant("u1", rec(200)), l.grant("u2", rec(200)), l.grant("u3", rec(200))]);
  assert.deepEqual(Object.keys(onDisk(file)).sort(), ["u1", "u2", "u3"]);
});

// The commit boundary: when a grant's own write fails, nothing is granted and the ledger does not
// contain it either, while a prior committed grant is left intact. There is no in-memory rollback to
// get wrong any more, because a single row write either committed or it did not.
test("a persist failure grants nothing and writes nothing", async () => {
  const file = tmpFile();
  let failNextWrite = false;
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: noop,
    revoke: noop,
    now: () => 100,
    putFn: (write) => {
      if (failNextWrite) throw new Error("disk full");
      return write();
    },
  });
  await l.grant("a", rec(200)); // committed
  failNextWrite = true;
  await assert.rejects(l.grant("b", rec(300)), /could not persist/);
  assert.equal(l.has("b"), false);
  assert.deepEqual(Object.keys(onDisk(file)), ["a"]); // and never written
});

test("extraTargets returns only targets the prior grant did not cover", () => {
  assert.equal(extraTargets({ mode: "channel", channels: ["c1"] }, { mode: "channel", channels: ["c1"] }), null);
  assert.deepEqual(extraTargets({ mode: "channel", channels: ["c1", "c2"] }, { mode: "channel", channels: ["c1"] }), { mode: "channel", channels: ["c2"] });
  assert.deepEqual(extraTargets({ mode: "role", roleId: "r2" }, { mode: "role", roleId: "r1" }), { mode: "role", roleId: "r2" });
  assert.equal(extraTargets({ mode: "role", roleId: "r1" }, { mode: "role", roleId: "r1" }), null);
  // a mode switch carries nothing over, so the whole new target is extra
  assert.deepEqual(extraTargets({ mode: "channel", channels: ["c1"] }, { mode: "role", roleId: "r1" }), { mode: "channel", channels: ["c1"] });
});
