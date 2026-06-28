import { test } from "node:test";
import assert from "node:assert/strict";
import { NullifierStore } from "../core/stores.js";
import { DocumentNullifierStore, MemoryBackend } from "../core/platform_store.js";

// Every nullifier (claim) store the verifier accepts must satisfy one contract, so a future store
// cannot silently fail at runtime or drop idempotency. has() reports whether a tag is spent, add()
// records it once and reports a duplicate on a second insert, and get() returns the claim record with
// the granting account, or null when the store does not persist the account. The Platform-backed
// store returns null by design (it does not write the account to a public ledger), so it shares the
// spend contract but does not support idempotent re-grant.

const stores = [
  ["NullifierStore", () => new NullifierStore(), { persistsAccount: true }],
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
