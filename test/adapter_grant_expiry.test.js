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
