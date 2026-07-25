import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrantLedger } from "../adapters/common/grant_ledger.js";

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
    let fail = true;
    const ledger = new GrantLedger({
      file: join(dir, "grants.json"),
      apply: async () => {},
      revoke: async () => {
        if (fail) throw new Error("platform unavailable");
      },
      now: () => 3000,
      log: () => {},
    });
    await ledger.grant("u1", { expiresAt: 2000 });
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

test("an adapter clock moving backwards refuses admission rather than reviving a grant", async () => {
  // The adapter decides admission independently of the gateway, against absolute deadlines. Its clock
  // was unguarded, so moving it back before a sweep made an expired grant live again, admitting a
  // member whose epoch had ended even while the gateway refused new proofs.
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
    assert.equal(ledger.live("u1"), true);

    clock.t = 3000; // past expiry, the mark advances
    assert.equal(ledger.live("u1"), false);

    clock.t = 1500; // the clock is wound back to before the deadline
    assert.equal(ledger.live("u1"), false, "a rolled-back clock must not revive an expired grant");
    assert.equal(ledger.clockIsSane, false);

    let admitted = false;
    const ok = await ledger.admitIfLive("u1", async () => {
      admitted = true;
    });
    assert.equal(ok, false, "admission is refused once the clock cannot be trusted");
    assert.equal(admitted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the clock mark survives a restart, so a rollback across one is still caught", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-grant-"));
  const file = join(dir, "grants.json");
  try {
    const first = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 5000 });
    await first.grant("u1", { expiresAt: 9000 });

    // A fresh process whose clock is behind where the previous one had reached.
    const second = new GrantLedger({ file, apply: async () => {}, revoke: async () => {}, now: () => 2000 });
    assert.equal(second.live("u1"), false, "a restart must not clear the adapter's high-water clock");
    assert.equal(second.clockIsSane, false);
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
