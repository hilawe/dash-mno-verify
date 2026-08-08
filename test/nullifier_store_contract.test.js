import { test } from "node:test";
import assert from "node:assert/strict";
import { NullifierStore } from "../core/stores.js";
import { SqliteNullifierStore } from "../core/nullifier_sqlite.js";
import { DocumentNullifierStore, MemoryBackend } from "../core/platform_store.js";

// Every nullifier (claim) store the verifier accepts must satisfy one contract, so a future store
// cannot silently fail at runtime or drop idempotency. has() reports whether a tag is spent, add()
// records it once and reports a duplicate on a second insert, and get() returns the claim record with
// the granting account, or null when the store does not persist the account. The Platform-backed
// store returns null by design (it does not write the account to a public ledger), so it shares the
// spend contract but does not support idempotent re-grant.

const stores = [
  ["NullifierStore", () => new NullifierStore(), { persistsAccount: true }],
  ["SqliteNullifierStore(:memory:)", () => new SqliteNullifierStore(":memory:"), { persistsAccount: true }],
  ["DocumentNullifierStore(MemoryBackend)", () => new DocumentNullifierStore(new MemoryBackend()), { persistsAccount: false }],
];

for (const [name, make, { persistsAccount }] of stores) {
  test(`${name} satisfies the spend contract`, async () => {
    const s = make();
    assert.equal(await s.has("7", "c", "n"), false);
    assert.equal(await s.get("7", "c", "n"), null);
    const first = await s.add("7", "c", "n", { account: "alice" });
    assert.equal(first.duplicate, false);
    assert.equal(await s.has("7", "c", "n"), true);
    const second = await s.add("7", "c", "n", { account: "alice" });
    assert.equal(second.duplicate, true);
  });

  test(`${name} get() returns the claim record or null per its account persistence`, async () => {
    const s = make();
    await s.add("7", "c", "n", { account: "alice" });
    const claim = await s.get("7", "c", "n");
    if (persistsAccount) assert.deepEqual(claim, { account: "alice" });
    else assert.equal(claim, null);
  });
}

test("the in-memory store prunes old epochs, like the durable one has all along", () => {
  // The gateway prunes only stores that implement prune(), and this one did not, so a memory-mode
  // gateway kept every tag it had ever seen for the life of the process. "Ephemeral" describes what a
  // restart does, not what happens while it runs. Small exposure, since every entry costs a valid
  // membership proof, but the two stores had no reason to differ on the same schedule.
  const store = new NullifierStore();
  store.add(10, "ctx", "tagA", { account: "alice" });
  store.add(11, "ctx", "tagB", { account: "bob" });
  store.add(12, "ctx", "tagC", { account: "carol" });
  assert.equal(store.size(), 3);

  // Keeping the current epoch and one past epoch is the gateway's window, so pruning below 11 must
  // take epoch 10 and nothing else.
  const { removed } = store.prune(11);
  assert.equal(removed, 1);
  assert.equal(store.size(), 2);
  assert.equal(store.has(10, "ctx", "tagA"), false, "the aged-out epoch is gone");
  assert.equal(store.has(11, "ctx", "tagB"), true, "the retained past epoch is not");
  assert.equal(store.has(12, "ctx", "tagC"), true, "and neither is the current one");

  // A malformed cutoff must not silently empty the store, and the input set here is the point. An
  // earlier version tried only NaN-producing values, concluded the guard was redundant because every
  // comparison against NaN is false, and deleted it. A reviewer supplied Infinity, which compares
  // fine in the direction that matters and emptied the store completely. The guard is back, and the
  // table now includes the infinities that showed why it was needed.
  for (const bad of [undefined, null, "not-a-number", NaN, Infinity, -Infinity]) {
    assert.deepEqual(store.prune(bad), { removed: 0 }, `cutoff ${String(bad)}`);
  }
  assert.equal(store.size(), 2, "an unusable cutoff removes nothing rather than everything");
});

test("pruning the in-memory store keeps the claim record of what survives", () => {
  // The record carries the account that first spent the tag, which is what makes an idempotent
  // re-grant possible. A prune that dropped the account while keeping the key would turn a re-grant
  // into a refusal for the member whose adapter failed.
  const store = new NullifierStore();
  store.add(5, "ctx", "old", { account: "alice" });
  store.add(6, "ctx", "live", { account: "bob" });
  store.prune(6);
  assert.deepEqual(store.get(6, "ctx", "live"), { account: "bob" });
  assert.equal(store.get(5, "ctx", "old"), null);
});
