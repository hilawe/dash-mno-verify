import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentNullifierStore, MemoryBackend } from "../core/platform_store.js";

// The Dash Platform backend cannot run in CI (it needs a funded identity and DAPI), but the
// store logic is backend-agnostic. MemoryBackend enforces the same unique index the Platform
// contract does, so these tests pin the behavior the gateway relies on.

test("records a tag and rejects the duplicate (the cross-gateway race)", async () => {
  const s = new DocumentNullifierStore(new MemoryBackend());
  assert.equal(await s.has(1, "ctx", "nf1"), false);

  const first = await s.add(1, "ctx", "nf1");
  assert.equal(first.duplicate, false);
  assert.equal(await s.has(1, "ctx", "nf1"), true);

  // a second gateway recording the same tag loses at the unique index
  const second = await s.add(1, "ctx", "nf1");
  assert.equal(second.duplicate, true);
});

test("epoch, context, and tag are independent dimensions", async () => {
  const s = new DocumentNullifierStore(new MemoryBackend());
  await s.add(1, "ctx", "nf");
  assert.equal(await s.has(2, "ctx", "nf"), false); // different epoch or season
  assert.equal(await s.has(1, "ctx2", "nf"), false); // different community
  assert.equal(await s.has(1, "ctx", "nf2"), false); // different tag
});
