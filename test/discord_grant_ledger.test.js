import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantLedger, extraTargets } from "../adapters/discord/grant_ledger.js";

// The grant ledger is what makes Discord-side access durable and correctly revoked. These pin the
// behaviors the review flagged: survive a restart, revoke on expiry, leave a fresh re-verification
// alone, and never keep a record for access that did not actually apply.

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "mno-grant-")), "grants.json");
const rec = (expiresAt) => ({ expiresAt, mode: "channel", channels: ["c1"] });
const noop = () => Promise.resolve();

test("a grant persists and applies, and a fresh ledger on the same file sees it (restart)", async () => {
  const file = tmpFile();
  const applied = [];
  const l1 = new GrantLedger({ file, apply: (u, r) => (applied.push([u, r.expiresAt]), noop()), revoke: noop, now: () => 100 });
  await l1.grant("u1", rec(200));
  assert.deepEqual(applied, [["u1", 200]]);
  assert.ok(existsSync(file));
  const l2 = new GrantLedger({ file, apply: noop, revoke: noop, now: () => 100 });
  assert.equal(l2.has("u1"), true);
});

test("the sweep revokes an expired grant, removes it, reports it, and leaves a valid one", async () => {
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ file, apply: noop, revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await l.grant("expired", rec(50));
  await l.grant("valid", rec(500));
  assert.deepEqual(await l.sweep(), ["expired"]);
  assert.deepEqual(revoked, ["expired"]);
  assert.equal(l.has("expired"), false);
  assert.equal(l.has("valid"), true);
});

test("a not-yet-expired grant is left alone by the sweep", async () => {
  const file = tmpFile();
  const revoked = [];
  const l = new GrantLedger({ file, apply: noop, revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await l.grant("u1", rec(500));
  assert.deepEqual(await l.sweep(), []);
  assert.equal(revoked.length, 0);
});

// The race the review found: the sweep deletes an expired record then awaits the revoke, and a fresh
// re-verification can land in that window. The per-user lock must serialize the two, so the revoke
// fully completes before the new grant applies, and the fresh grant wins.
test("a grant and a revoke for the same user do not interleave", async () => {
  const file = tmpFile();
  const events = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const l = new GrantLedger({
    file,
    apply: async (u) => { events.push(`apply:${u}`); },
    revoke: async (u) => { events.push(`revoke-start:${u}`); await gate; events.push(`revoke-end:${u}`); },
    now: () => 100,
  });
  await l.grant("u1", rec(50)); // expired
  events.length = 0;
  const sweepP = l.sweep();              // begins revoking u1, then blocks on the gate
  const grantP = l.grant("u1", rec(999)); // queues behind the revoke on the per-user lock
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
  const l = new GrantLedger({ file, apply: () => Promise.reject(new Error("discord down")), revoke: (u) => (revoked.push(u), noop()), now: () => 100 });
  await assert.rejects(l.grant("u1", rec(200)), /discord down/);
  assert.equal(l.has("u1"), true);
  assert.deepEqual(revoked, ["u1"]);
  assert.equal("u1" in JSON.parse(readFileSync(file, "utf8")), true);
});

// A failed renewal must not touch the member's existing valid access, and must keep tracking it under
// the prior grant's expiry, not the failed new one.
// Same target, so there is no orphan to migrate and the still-live access is what the record describes.
// A failed apply keeps that record (never strands), and nothing is revoked.
test("a failed same-target renewal keeps the new grant and strands nothing", async () => {
  const file = tmpFile();
  let fail = false;
  const revoked = [];
  const l = new GrantLedger({
    file,
    apply: () => (fail ? Promise.reject(new Error("down")) : noop()),
    revoke: (u) => (revoked.push(u), noop()),
    now: () => 100,
  });
  await l.grant("u1", rec(200));
  fail = true;
  await assert.rejects(l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }), /down/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).u1.expiresAt, 999);
  assert.equal(revoked.length, 0);
});

test("a missing ledger file loads as empty (first run), a corrupt one fails startup", () => {
  const empty = tmpFile(); // the dir exists, the file does not
  assert.equal(new GrantLedger({ file: empty, apply: noop, revoke: noop }).size(), 0);

  const corrupt = tmpFile();
  writeFileSync(corrupt, "{ not json");
  assert.throws(() => new GrantLedger({ file: corrupt, apply: noop, revoke: noop }), /not valid JSON/);

  const malformed = tmpFile();
  writeFileSync(malformed, JSON.stringify({ u1: { mode: "channel" } })); // no expiresAt
  assert.throws(() => new GrantLedger({ file: malformed, apply: noop, revoke: noop }), /malformed record/);

  const noChannels = tmpFile();
  writeFileSync(noChannels, JSON.stringify({ u1: { expiresAt: 100, mode: "channel" } })); // mode but no target
  assert.throws(() => new GrantLedger({ file: noChannels, apply: noop, revoke: noop }), /malformed record/);

  const noRole = tmpFile();
  writeFileSync(noRole, JSON.stringify({ u1: { expiresAt: 100, mode: "role" } })); // mode but no roleId
  assert.throws(() => new GrantLedger({ file: noRole, apply: noop, revoke: noop }), /malformed record/);
});

// A real revoke failure (a Discord outage or lost permission, not a 404) must not drop the record, or
// the access goes untracked and permanent. The sweep keeps it and a later sweep retries.
test("a revoke failure during the sweep keeps the grant for a later retry", async () => {
  const file = tmpFile();
  let failRevoke = true;
  const l = new GrantLedger({
    file,
    apply: noop,
    revoke: () => (failRevoke ? Promise.reject(new Error("discord 500")) : noop()),
    now: () => 100,
  });
  await l.grant("u1", rec(50)); // expired
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
  const l = new GrantLedger({
    file,
    apply: noop,
    revoke: (u, r) => (revokedRecords.push(r), noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  await l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }); // drops c2
  assert.deepEqual(revokedRecords, [{ mode: "channel", channels: ["c2"] }]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).u1, { expiresAt: 999, mode: "channel", channels: ["c1"] });
});

// If revoking the orphaned target fails, the renewal must abort with the prior grant intact, so the
// old access stays both live and tracked rather than half-migrated and stranded.
test("if migrating the prior grant fails, the renewal aborts and keeps the prior grant", async () => {
  const file = tmpFile();
  let migrateFail = false;
  const l = new GrantLedger({
    file,
    apply: noop,
    revoke: () => (migrateFail ? Promise.reject(new Error("revoke down")) : noop()),
    now: () => 100,
  });
  await l.grant("u1", { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
  migrateFail = true;
  await assert.rejects(l.grant("u1", { expiresAt: 999, mode: "channel", channels: ["c1"] }), /could not migrate/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).u1, { expiresAt: 200, mode: "channel", channels: ["c1", "c2"] });
});

// The write path must reject a malformed record (here a non-finite expiry), or it would persist and
// apply access that never expires and then breaks the next startup load.
test("grant refuses a malformed record before writing or applying", async () => {
  const file = tmpFile();
  const applied = [];
  const l = new GrantLedger({ file, apply: (u) => (applied.push(u), noop()), revoke: noop, now: () => 100 });
  await assert.rejects(l.grant("u1", { mode: "channel", channels: ["c1"] }), /malformed/); // no expiresAt
  assert.equal(l.has("u1"), false);
  assert.equal(applied.length, 0);
  assert.equal(existsSync(file), false); // nothing was written
});

// Operations are globally serialized, so concurrent grants for different users must not clobber the
// shared temp file or lose an update: all three must end up persisted.
test("concurrent grants for different users all persist", async () => {
  const file = tmpFile();
  const l = new GrantLedger({ file, apply: noop, revoke: noop, now: () => 100 });
  await Promise.all([l.grant("u1", rec(200)), l.grant("u2", rec(200)), l.grant("u3", rec(200))]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["u1", "u2", "u3"]);
});

// The commit-boundary invariant, the point of serializing every operation: when a grant's own persist
// fails, it rolls back in memory and the file must not contain it either. A prior committed grant is
// left intact. (Global serialization is what keeps a concurrent grant from having persisted the
// in-flight record in the meantime.)
test("a persist failure rolls back the grant and writes nothing", async () => {
  const file = tmpFile();
  let failNextWrite = false;
  const l = new GrantLedger({
    file,
    apply: noop,
    revoke: noop,
    now: () => 100,
    writeFileFn: async (tmp, data) => {
      if (failNextWrite) throw new Error("disk full");
      return writeFile(tmp, data);
    },
  });
  await l.grant("a", rec(200)); // committed
  failNextWrite = true;
  await assert.rejects(l.grant("b", rec(300)), /could not persist/);
  assert.equal(l.has("b"), false); // rolled back in memory
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["a"]); // and never written
});

test("extraTargets returns only targets the prior grant did not cover", () => {
  assert.equal(extraTargets({ mode: "channel", channels: ["c1"] }, { mode: "channel", channels: ["c1"] }), null);
  assert.deepEqual(extraTargets({ mode: "channel", channels: ["c1", "c2"] }, { mode: "channel", channels: ["c1"] }), { mode: "channel", channels: ["c2"] });
  assert.deepEqual(extraTargets({ mode: "role", roleId: "r2" }, { mode: "role", roleId: "r1" }), { mode: "role", roleId: "r2" });
  assert.equal(extraTargets({ mode: "role", roleId: "r1" }, { mode: "role", roleId: "r1" }), null);
  // a mode switch carries nothing over, so the whole new target is extra
  assert.deepEqual(extraTargets({ mode: "channel", channels: ["c1"] }, { mode: "role", roleId: "r1" }), { mode: "channel", channels: ["c1"] });
});
