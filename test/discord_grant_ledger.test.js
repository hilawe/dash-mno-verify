import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PermissionFlagsBits } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GrantLedger,
  extraTargets,
  authorizesTarget,
  targetKey,
  parseTargetKey,
  staleTargets,
  memberDenialsOnGatedChannel,
  roleDenialsAcrossChannels,
  foreignGuildRecords,
  isGone,
  isNotOurs,
  retireTargetTransform,
} from "../adapters/discord/grant_ledger.js";

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
  // "left alone" includes still being there. Without this a sweep that dropped the row while reporting
  // nothing revoked would pass, and the member would silently stop being tracked.
  assert.equal(l.has("u1"), true, "the record must survive, not merely go unreported");
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

// A FAILED FIRST GRANT HAS THREE OUTCOMES, and collapsing them into one caused two separate defects.
//
// This was one test asserting the record is always kept and the revoke always runs. That is right for
// exactly one of the three cases. Compensating an apply that sent nothing cleared access the member
// already held, so declining to grant took access away, and that is why an earlier denial refusal was
// deleted rather than repaired. Keeping the record after a compensation that SUCCEEDED left a live
// record with no access behind it, which the sweep will not repair because a live record looks fine to
// it, and nothing else creates a missing overwrite.
const refusal = (msg) => Object.assign(new Error(msg), { mutated: false });

test("a first grant that sent nothing is not compensated, and leaves no record behind", async () => {
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ exclusive: false, file, apply: () => Promise.reject(refusal("denied")), revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await assert.rejects(l.grant("u1", rec(200)), /denied/);
  assert.deepEqual(revoked, [], "compensating a refusal is what used to strip pre-existing access");
  assert.equal(l.has("u1"), false, "no access was applied, so a record claiming it would be a lie");
  assert.equal("u1" in onDisk(file), false);
});

test("a transient first grant keeps its record and is NOT compensated, so a repair can reapply it", async () => {
  // This asserted the opposite a few commits ago, and the reason it changed is that a repair path now
  // exists. Without one, a kept record was a live grant with no access behind it and nothing that
  // would ever fix it, so revoking and dropping the row was the least-wrong option. With
  // reconciliation converging in both directions, the record is the authority that repairs the access,
  // and the proof that earned it cannot be spent twice in an epoch, so throwing it away locks the
  // member out until expiry. Compensating is wrong for a second reason too: it clears the channels
  // that DID succeed, which the repair would only put back.
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ exclusive: false, file, apply: () => Promise.reject(new Error("discord down")), revoke: (u) => (revoked.push(u), noop()), now: () => 100, log: () => {} });
  await assert.rejects(l.grant("u1", rec(200)), /discord down/);
  assert.deepEqual(revoked, [], "no compensating revoke, because the repair pass reapplies instead");
  assert.equal(l.has("u1"), true, "the record survives, and it is what the repair reads");
  assert.equal("u1" in onDisk(file), true);
});

// A failed renewal keeps the NEW record, not the prior one, and that is deliberate. Same target, so
// there is no orphan to migrate: the record describes access that may now be partly applied, and
// keeping it is what guarantees the sweep can find and clear it. Reverting to the prior expiry would
// leave any newly applied part of the grant untracked past that earlier deadline. So the assertion
// below expects the new expiry, and nothing is revoked, because the prior access is still live.
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
  // ORDER is the claim in the name, and the previous version never checked it: apply was a noop, so a
  // regression that applied the new grant first and revoked afterwards would have passed. The sequence
  // is recorded and asserted below.
  const order = [];
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: () => (order.push("apply"), noop()),
    revoke: (u, r) => (revokedRecords.push(r), order.push("revoke"), noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  await l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }); // drops c2
  assert.deepEqual(revokedRecords, [{ mode: "channel", channels: ["c2"] }]);
  assert.deepEqual(
    order,
    ["apply", "revoke", "apply"],
    "the first grant applies, then the renewal revokes the orphaned target BEFORE applying the new one",
  );
  assert.deepEqual(onDisk(file).u1, { expiresAt: 999, mode: "channel", channels: ["c1"] });
});

// If revoking the orphaned target fails, the renewal must abort with the prior grant intact, so the
// old access stays both live and tracked rather than half-migrated and stranded.
test("if migrating the prior grant fails, the renewal aborts and keeps the prior grant", async () => {
  const file = tmpFile();
  let migrateFail = false;
  // apply was a noop here too, so a mutant that applied the replacement inside the failure path still
  // rejected and still kept the prior row, passing every assertion while the member held BOTH targets
  // and the ledger tracked only the old one.
  const applied = [];
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: (u, r) => (applied.push(r.channels ?? r.roleId), noop()),
    revoke: () => (migrateFail ? Promise.reject(new Error("revoke down")) : noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  migrateFail = true;
  await assert.rejects(l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }), /could not migrate/);
  assert.deepEqual(
    applied,
    [["c1", "c2"]],
    "an aborted renewal must not have applied the replacement; only the original grant applied",
  );
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
  // "grants nothing" is half the name and was asserted only by implication, with apply as a noop that
  // recorded nothing. A mutant that applied access BEFORE the failed write satisfied every assertion
  // here while leaving member b holding untracked access. Record the calls.
  const applied = [];
  const l = new GrantLedger({ exclusive: false,
    file,
    apply: (u) => (applied.push(u), noop()),
    revoke: noop,
    now: () => 100,
    putFn: (write) => {
      if (failNextWrite) throw new Error("disk full");
      return write();
    },
  });
  await l.grant("a", rec(200)); // committed
  assert.deepEqual(applied, ["a"]);
  failNextWrite = true;
  await assert.rejects(l.grant("b", rec(300)), /could not persist/);
  assert.deepEqual(applied, ["a"], "a write that failed must not have applied any access");
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

// The startup reconciliation decides, for every member currently holding access, whether to leave it
// alone. Getting this wrong in one direction strips a member who just re-verified; in the other it
// leaves access from a previous target in place, which is the whole thing reconciliation exists to
// find. Liveness alone is not the answer, because a record for an old target can still be live.
test("authorizesTarget accepts only a live record for the configured target", () => {
  const role = { mode: "role", channel: null, roleId: "r1" };
  assert.equal(authorizesTarget({ mode: "role", roleId: "r1" }, true, role), true);
  assert.equal(authorizesTarget({ mode: "role", roleId: "r1" }, false, role), false, "expired");
  assert.equal(authorizesTarget({ mode: "role", roleId: "OLD" }, true, role), false, "a previous role");
  assert.equal(authorizesTarget({ mode: "channel", channels: ["c1"] }, true, role), false, "a mode switch");
  assert.equal(authorizesTarget(null, true, role), false, "no record at all");

  // ONE channel at a time. This used to take the whole configured set and require the record to cover
  // all of it, so adding a second channel made every existing member fail the check on the channel they
  // legitimately held, and the startup pass cleared it. The ledger row survived, so the sweep never put
  // it back.
  const onC1 = { mode: "channel", channel: "c1", roleId: null };
  const onC2 = { mode: "channel", channel: "c2", roleId: null };
  assert.equal(authorizesTarget({ mode: "channel", channels: ["c1"] }, true, onC1), true);
  assert.equal(
    authorizesTarget({ mode: "channel", channels: ["c1"] }, true, onC2),
    false,
    "a record for c1 does not authorize an overwrite on c2",
  );
  assert.equal(
    authorizesTarget({ mode: "channel", channels: ["c1"] }, true, onC1),
    true,
    "and c1 is kept even once the configuration has grown to include c2",
  );
  assert.equal(authorizesTarget({ mode: "channel", channels: ["c1", "c2"] }, true, onC2), true);
  assert.equal(authorizesTarget({ mode: "channel", channels: [] }, true, onC1), false);
  assert.equal(authorizesTarget({ mode: "channel", channels: ["c1"] }, false, onC1), false, "expired");
});

test("targetKey treats channel ids as a set, so reordering is not a new target", () => {
  assert.equal(targetKey("channel", ["c2", "c1"]), targetKey("channel", ["c1", "c2"]));
  assert.equal(targetKey("channel", ["c1", "c1", "c2"]), targetKey("channel", ["c1", "c2"]));
  assert.notEqual(targetKey("channel", ["c1"]), targetKey("channel", ["c1", "c2"]));
  assert.notEqual(targetKey("role", ["r1"]), targetKey("channel", ["r1"]));
});

// This has been wrong twice, in both possible directions. First it returned null for anything it did
// not recognise and the caller dropped it silently. Then it threw on obvious rubbish but destructured
// only the first two colon-separated parts, so `role:a:role:b` quietly became `role:a` and the rest was
// forgotten. Either way a target could go unswept while the operation reported success, so the whole
// string is validated now.
test("parseTargetKey validates the whole string, not just the front of it", () => {
  assert.deepEqual(parseTargetKey("role:r1"), { mode: "role", ids: ["r1"] });
  assert.deepEqual(parseTargetKey("channel:c1,c2"), { mode: "channel", ids: ["c1", "c2"] });

  for (const [bad, why] of [
    ["", "empty"],
    ["nonsense", "no separator"],
    ["bogus:x", "unknown mode"],
    ["role:", "no id"],
    ["channel:", "no id"],
    [":c1", "no mode"],
    ["role:a:role:b", "a second target hidden behind an extra colon"],
    ["channel:c1:channel:c9", "likewise"],
    ["channel:,c1", "an empty id"],
    ["channel:c1,", "a trailing empty id"],
    ["role:r1,r2", "two roles in a role target"],
  ]) {
    assert.throws(() => parseTargetKey(bad), /malformed target/, `should refuse ${JSON.stringify(bad)} (${why})`);
  }
});

// Startup REPORTS targets the bot no longer manages and never acts on them. Bulk removal is a
// deliberate operator act, which is the whole point of the split: three rounds of trying to make it
// automatic produced a blocker every time, the last one stripping access an operator had granted by
// hand on a channel the bot had finished with.
//
// This is BEST EFFORT and the tests must not imply otherwise. It can only see targets that surviving
// ledger rows still name, so an old channel whose rows have expired and been swept, or that held
// access predating the ledger entirely, is invisible to it. That is why the README tells operators to
// decommission on every repoint rather than to wait for a warning.
test("staleTargets names the stale targets DISCOVERABLE from surviving records, and nothing current", () => {
  const chanNow = { mode: "channel", channels: ["c1"], roleId: null };

  assert.deepEqual(staleTargets([{ mode: "channel", channels: ["c1"] }], chanNow), [], "the current target is not stale");

  assert.deepEqual(
    staleTargets([{ mode: "channel", channels: ["c1", "c9"] }], chanNow),
    [targetKey("channel", ["c9"])],
    "a channel dropped from the configuration is stale, the kept one is not",
  );

  assert.deepEqual(
    staleTargets([{ mode: "role", roleId: "r9" }], chanNow),
    [targetKey("role", ["r9"])],
    "a record from before a mode switch is stale",
  );

  // Several records naming the same old channel report once, not once each.
  assert.deepEqual(
    staleTargets([{ mode: "channel", channels: ["c9"] }, { mode: "channel", channels: ["c9"] }], chanNow),
    [targetKey("channel", ["c9"])],
  );

  const roleNow = { mode: "role", channels: [], roleId: "r1" };
  assert.deepEqual(staleTargets([{ mode: "role", roleId: "r1" }], roleNow), [], "the current role is not stale");
  assert.deepEqual(staleTargets([{ mode: "role", roleId: "old" }], roleNow), [targetKey("role", ["old"])]);
  assert.deepEqual(
    staleTargets([], chanNow),
    [],
    "an empty ledger means nothing DISCOVERABLE, not nothing owed: access on a target with no surviving " +
      "rows is real and this cannot see it",
  );
});

// Removing access must never GRANT it, and granting must never remove it. Two rounds were spent trying
// to make the bot reason about denials a moderator had set, and both attempts produced a worse defect:
// preserving them meant a read-modify-write against a CACHED overwrite, so a denial the cache had not
// seen was wiped by the code written to protect it, and refusing to grant over one meant the ledger's
// uncertain-apply cleanup then stripped the member's pre-existing access.
//
// The bot no longer reasons about them. It owns the per-member overwrite slot on a gated channel and
// refuses to run if it finds a denial there. These pin the two detections that refusal rests on.
const fakeOverwrite = (id, allow = [], deny = []) => ({
  id,
  allow: { has: (b) => allow.includes(b) },
  deny: { has: (b) => deny.includes(b) },
});

test("a per-member denial on a gated channel is detected, so the bot can refuse rather than fight it", () => {
  assert.deepEqual(
    memberDenialsOnGatedChannel([fakeOverwrite("u1", ["ViewChannel", "SendMessages"])]),
    [],
    "an overwrite that only grants is the bot's own work and is not a conflict",
  );
  assert.deepEqual(
    memberDenialsOnGatedChannel([fakeOverwrite("u1", [], ["ViewChannel"])]),
    [{ id: "u1", deny: ["ViewChannel"] }],
    "a denial means somebody else is using the slot this bot owns",
  );
  assert.deepEqual(
    memberDenialsOnGatedChannel([fakeOverwrite("u1", ["SendMessages"], ["ViewChannel"])]),
    [{ id: "u1", deny: ["ViewChannel"] }],
    "a mixed overwrite is still a conflict: clearing it would lift the denial",
  );
  assert.deepEqual(
    memberDenialsOnGatedChannel([fakeOverwrite("a", [], ["ViewChannel"]), fakeOverwrite("b", [], ["SendMessages"])]).map((o) => o.id),
    ["a", "b"],
    "every offender is named, so the operator fixes them all in one go",
  );
  assert.deepEqual(memberDenialsOnGatedChannel([]), []);
  assert.deepEqual(memberDenialsOnGatedChannel(undefined), []);
});

// A role the bot adds and removes must only ever ADD permissions. Carrying a deny anywhere means adding
// it takes access away from the member on that channel, and removing it hands access back, so a grant
// revokes and a revocation grants. Reproduced against the real permission resolver by two reviewers.
//
// ANY denied bit counts, not just the three channel mode manages. A role denying Connect inverts voice
// access exactly as one denying ViewChannel inverts text access, and an earlier version of this check
// looked only at the managed three, so it would have caught the reproduction it was written for and
// missed every other permission.
// REAL bit values, from discord.js. The first version of this gave every non-empty denial
// `bitfield: 1n`, so a regression that read the wrong bit passed every assertion while missing real
// denials. ViewChannel is 1024, Connect 1048576, Speak 2097152, AddReactions 64.
const denyBits = (names) => ({
  bitfield: names.reduce((acc, n) => acc | BigInt(PermissionFlagsBits[n] ?? 0n), 0n),
  toArray: () => names,
});
const roleOverwrite = (id, denied = []) => ({ id, deny: denyBits(denied) });

test("a role carrying ANY denial is detected, because adding it would remove access", () => {
  const ch = (id, overwrites) => ({ id, overwrites });

  assert.deepEqual(
    roleDenialsAcrossChannels([ch("c1", [roleOverwrite("r1")])], "r1"),
    [],
    "a role that denies nothing is monotonic and safe to add and remove",
  );
  assert.deepEqual(
    roleDenialsAcrossChannels([ch("c9", [roleOverwrite("r1", ["ViewChannel"])])], "r1"),
    [{ channel: "c9", deny: ["ViewChannel"] }],
    "a denial on an unrelated channel is what makes adding the role remove access there",
  );
  assert.deepEqual(
    roleDenialsAcrossChannels([ch("v1", [roleOverwrite("r1", ["Connect", "Speak"])])], "r1"),
    [{ channel: "v1", deny: ["Connect", "Speak"] }],
    "a bit outside the three managed ones inverts just as surely, and must be caught",
  );
  assert.deepEqual(
    roleDenialsAcrossChannels([ch("c9", [roleOverwrite("SOMEONE_ELSE", ["ViewChannel"])])], "r1"),
    [],
    "another id's denial is not this role's problem",
  );
  assert.deepEqual(
    roleDenialsAcrossChannels(
      [ch("c1", [roleOverwrite("r1")]), ch("c2", [roleOverwrite("r1", ["AddReactions"])])],
      "r1",
    ),
    [{ channel: "c2", deny: ["AddReactions"] }],
    "one bad channel among good ones is still reported",
  );
  assert.deepEqual(roleDenialsAcrossChannels([], "r1"), []);
});

// A record naming another guild describes access this process cannot reach. Treating that as "already
// gone" let a sweep resolve and DELETE the row, so repointing the bot at a different server silently
// discarded the records of access still live in the old one. "Cannot act here" and "nothing to act on"
// are different, which is why isNotOurs is separate from isGone.
test("a record from another guild is detected, so a repoint cannot delete what it cannot reach", () => {
  assert.deepEqual(foreignGuildRecords([{ guildId: "g1" }], "g1"), [], "our own guild is not foreign");
  assert.deepEqual(foreignGuildRecords([{ guildId: "OLD" }], "g1"), [{ guildId: "OLD" }]);
  assert.deepEqual(
    foreignGuildRecords([{ expiresAt: 1, mode: "channel", channels: ["c1"] }], "g1"),
    [],
    "a record written before records carried a guild reads as unknown, not foreign",
  );
  assert.deepEqual(
    foreignGuildRecords([{ guildId: "g1" }, { guildId: "OLD" }, { guildId: "OTHER" }], "g1").map((f) => f.guildId),
    ["OLD", "OTHER"],
    "every foreign guild is named so the operator knows where to go",
  );
  assert.deepEqual(foreignGuildRecords([], "g1"), []);
});

test("isNotOurs and isGone say different things, because conflating them deleted live records", () => {
  assert.equal(isGone({ code: 10003 }), true, "Unknown Channel in this guild: nothing to take back");
  assert.equal(isGone({ status: 404 }), true);
  assert.equal(isNotOurs({ code: "GuildChannelUnowned" }), true, "another guild's channel: alive, unreachable");
  assert.equal(isGone({ code: "GuildChannelUnowned" }), false, "and NOT gone, or the record would be deleted");
  assert.equal(isNotOurs({ code: 10003 }), false);
  assert.equal(isGone({ code: 50013 }), false, "Missing Permissions is a real failure, not absence");
  assert.equal(isNotOurs({ code: 50013 }), false);
});

// ---- retiring a decommissioned target ---------------------------------------------------------------
//
// A decommission takes access back on Discord and then has to say so here, because the sweep does not
// read a row as history. It reads every row as revocation work still owed, so a retired channel left in
// a record gets its permission bits cleared a SECOND time when that record finally expires, possibly
// long after the channel was repurposed and somebody was given access there for an unrelated reason.
// What must not be retired matters as much as what must: whatever did not actually come back stays
// tracked.

test("retiring a channel narrows the records that name it and drops the ones left with nothing", () => {
  const t = retireTargetTransform({ mode: "channel", ids: ["c1"] });
  assert.deepEqual(
    t({ expiresAt: 9, mode: "channel", channels: ["c1", "c2"] }, "u1"),
    { expiresAt: 9, mode: "channel", channels: ["c2"] },
    "a member who also holds another channel keeps that one",
  );
  assert.equal(
    t({ expiresAt: 9, mode: "channel", channels: ["c1"] }, "u1"),
    null,
    "a record with nothing left is dropped rather than left invalid",
  );
});

test("a member whose removal failed keeps naming the target, so the sweep keeps trying", () => {
  const t = retireTargetTransform({
    mode: "channel",
    ids: ["c1"],
    failedPairs: new Set(["c1/stuck"]),
  });
  const held = { expiresAt: 9, mode: "channel", channels: ["c1"] };
  assert.equal(t(held, "stuck"), held, "the record is returned unchanged, not narrowed and not dropped");
  assert.equal(t({ expiresAt: 9, mode: "channel", channels: ["c1"] }, "cleared"), null,
    "one stuck member does not keep the target tracked for everybody else");
});

test("a channel skipped whole is retired for nobody, even members with no failure of their own", () => {
  const t = retireTargetTransform({ mode: "channel", ids: ["c1", "c2"], skippedChannels: new Set(["c1"]) });
  assert.deepEqual(
    t({ expiresAt: 9, mode: "channel", channels: ["c1", "c2"] }, "u1"),
    { expiresAt: 9, mode: "channel", channels: ["c1"] },
    "c2 was cleared and is retired, c1 was never touched and stays tracked",
  );
});

test("retiring a role drops the records naming it and leaves every other record alone", () => {
  const t = retireTargetTransform({ mode: "role", ids: ["r1"], failedMembers: new Set(["stuck"]) });
  assert.equal(t({ expiresAt: 9, mode: "role", roleId: "r1" }, "u1"), null);
  const other = { expiresAt: 9, mode: "role", roleId: "r2" };
  assert.equal(t(other, "u1"), other, "a different role is not this decommission's business");
  const stuck = { expiresAt: 9, mode: "role", roleId: "r1" };
  assert.equal(t(stuck, "stuck"), stuck, "a member who still holds the role stays tracked");
  const chan = { expiresAt: 9, mode: "channel", channels: ["c1"] };
  assert.equal(t(chan, "u1"), chan, "a channel record is untouched by a role decommission");
});
