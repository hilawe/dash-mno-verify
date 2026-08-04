import { test } from "node:test";
import assert from "node:assert/strict";
import { DocumentNullifierStore, MemoryBackend, platformBackend } from "../core/platform_store.js";

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

test("closing the store disconnects the Platform client, and tolerates a backend with nothing to release", async () => {
  // The live backend holds an SDK client with open connections that a gateway shutting down has to
  // hand back. Driven through a stand-in client rather than a real one, because the Platform path
  // needs a funded identity and is not exercised in CI, but the wiring between store, backend, and
  // client is ordinary code and is what this checks.
  let disconnects = 0;
  const client = {
    disconnect: async () => {
      disconnects += 1;
    },
    platform: { documents: {} },
  };
  const store = new DocumentNullifierStore(platformBackend({ client, identity: {}, appName: "mnoVerify" }));
  await store.close();
  assert.equal(disconnects, 1, "the client's connections were released");
  await store.close();
  assert.equal(disconnects, 2, "and closing again is not an error, since two teardown paths reaching one store is ordinary");

  // An SDK build with no disconnect, and the in-memory backend, both have nothing to release. A
  // teardown that threw on either would turn a harmless case into a failure.
  await new DocumentNullifierStore(platformBackend({ client: { platform: { documents: {} } }, identity: {} })).close();
  await new DocumentNullifierStore(new MemoryBackend()).close();
});
