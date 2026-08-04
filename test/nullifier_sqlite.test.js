import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { SqliteNullifierStore } from "../core/nullifier_sqlite.js";

// These pin the property the durable store exists to provide: a gateway restart mid-epoch must not
// forget a spend, because forgetting one lets the same voting key claim a second account inside the
// same epoch. The in-memory store fails every reopen test here by construction, which is why it is
// now behind an explicit opt-in.

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-nf-"));
  const path = join(dir, "nullifiers.sqlite");
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a spend survives reopening the store", () => {
  withStore((path) => {
    const a = new SqliteNullifierStore(path);
    assert.equal(a.add("7", "ctx", "nf1", { account: "alice" }).duplicate, false);
    a.close();

    const b = new SqliteNullifierStore(path);
    assert.equal(b.has("7", "ctx", "nf1"), true, "the spend must outlive the process");
    assert.deepEqual(b.get("7", "ctx", "nf1"), { account: "alice" });
    b.close();
  });
});

test("the same account re-grants after reopening, a different account is still rejected", () => {
  withStore((path) => {
    const a = new SqliteNullifierStore(path);
    a.add("7", "ctx", "nf1", { account: "alice" });
    a.close();

    // This is the verifier's re-grant decision, made against the reopened store.
    const b = new SqliteNullifierStore(path);
    const prior = b.get("7", "ctx", "nf1");
    assert.equal(String(prior.account) === "alice", true, "alice may re-verify and re-grant");
    assert.equal(String(prior.account) === "mallory", false, "a different account must not");
    // And a second insert on the same tag still reports the duplicate rather than overwriting.
    assert.equal(b.add("7", "ctx", "nf1", { account: "mallory" }).duplicate, true);
    assert.deepEqual(b.get("7", "ctx", "nf1"), { account: "alice" }, "the first claim stands");
    b.close();
  });
});

test("the claim key separates epoch, context, and nullifier", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    s.add("7", "ctx", "nf1", { account: "alice" });
    assert.equal(s.has("8", "ctx", "nf1"), false, "a later epoch is a fresh tag");
    assert.equal(s.has("7", "other", "nf1"), false, "another context is a fresh tag");
    assert.equal(s.has("7", "ctx", "nf2"), false, "another nullifier is a fresh tag");
    s.close();
  });
});

test("only one insert wins a race on the same tag", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    const results = ["a", "b", "c", "d"].map((who) => s.add("7", "ctx", "nf1", { account: who }));
    assert.equal(results.filter((r) => !r.duplicate).length, 1, "exactly one winner");
    assert.deepEqual(s.get("7", "ctx", "nf1"), { account: "a" }, "the winner's claim is the one kept");
    s.close();
  });
});

test("prune drops only epochs older than the window, never the current one", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    s.add("5", "ctx", "old", { account: "alice" });
    s.add("6", "ctx", "prev", { account: "bob" });
    s.add("7", "ctx", "now", { account: "carol" });

    const { removed } = s.prune(6); // keep epochs >= 6
    assert.equal(removed, 1);
    assert.equal(s.has("5", "ctx", "old"), false, "an aged-out epoch is dropped");
    assert.equal(s.has("6", "ctx", "prev"), true, "the retained window is untouched");
    assert.equal(s.has("7", "ctx", "now"), true, "the current epoch must never be pruned");
    s.close();
  });
});

test("prune ignores a nonsense window rather than deleting everything", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    s.add("7", "ctx", "nf1", { account: "alice" });
    assert.deepEqual(s.prune("not-a-number"), { removed: 0 });
    assert.equal(s.has("7", "ctx", "nf1"), true, "a bad window must not clear live spends");
    s.close();
  });
});

test("a claim recorded without an account reads back as null, not as a match", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    s.add("7", "ctx", "nf1", {});
    assert.deepEqual(s.get("7", "ctx", "nf1"), { account: null });
    s.close();
  });
});

test("close() is idempotent, because two teardown paths reaching one store is ordinary", () => {
  withStore((path) => {
    const s = new SqliteNullifierStore(path);
    s.close();
    s.close();
    s.close();
  });
});

test("a constructor that refuses closes the database it had already opened", () => {
  // The schedule check runs after the open, and a throwing constructor returns nothing, so the
  // caller holds no reference to close the handle through. The database's own close is counted,
  // because an open handle left behind is otherwise unobservable from out here.
  withStore((path) => {
    new SqliteNullifierStore(path, "sched-A").close();

    // The DATABASE the refused construct opened, captured so the assertion can be about the handle
    // rather than about a call having happened. A close() that recorded the call and released nothing
    // would satisfy a counter and leave the file open, which is the whole defect.
    const opened = [];
    const realPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function patched(...args) {
      if (!opened.includes(this)) opened.push(this);
      return realPrepare.apply(this, args);
    };
    try {
      assert.throws(() => new SqliteNullifierStore(path, "sched-B"), /was written under epoch\/season schedule/);
      assert.equal(opened.length, 1, "the refused construct did open a database");
      assert.throws(() => opened[0].prepare("SELECT 1"), /not open/, "and it is closed, not merely marked closed");
    } finally {
      DatabaseSync.prototype.prepare = realPrepare;
    }
  });
});
