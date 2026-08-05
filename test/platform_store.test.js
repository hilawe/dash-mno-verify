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

test("closing the store disconnects the Platform client exactly once, however many times it is closed", async () => {
  // The live backend holds an SDK client with open connections that a gateway shutting down has to
  // hand back. Driven through a stand-in client rather than a real one, because the Platform path
  // needs a funded identity and is not exercised in CI, but the wiring between store, backend, and
  // client is ordinary code and is what this checks.
  //
  // THE FAKE REFUSES A SECOND DISCONNECT, deliberately. An earlier version of this test asserted the
  // disconnect count went from 1 to 2 and called that idempotence, which it is not. It showed the
  // fake tolerated a repeat, while the claim was that the store makes only one. A real SDK client is
  // not obliged to accept a second disconnect. An external pass called the old test false evidence
  // and was right.
  let disconnects = 0;
  const client = {
    disconnect: async () => {
      disconnects += 1;
      if (disconnects > 1) throw new Error("the client was already disconnected");
    },
    platform: { documents: {} },
  };
  const store = new DocumentNullifierStore(platformBackend({ client, identity: {}, appName: "mnoVerify" }));
  await store.close();
  assert.equal(disconnects, 1, "the client's connections were released");
  await store.close();
  await store.close();
  assert.equal(disconnects, 1, "and no later close reached the client again");

  // The guard belongs to the BACKEND too, because platformBackend is exported and a caller can hold
  // one without a store around it.
  let bare = 0;
  const backend = platformBackend({
    client: {
      disconnect: async () => {
        bare += 1;
        if (bare > 1) throw new Error("the client was already disconnected");
      },
      platform: { documents: {} },
    },
    identity: {},
  });
  await backend.close();
  await backend.close();
  assert.equal(bare, 1);

  // AND THE STORE'S OWN GUARD, observed on a backend that has none. With both guards in place the
  // cases above cannot tell them apart, since removing the store guard left them passing while the
  // backend's guard absorbed the repeat. DocumentNullifierStore wraps whatever backend it is given,
  // including ones written elsewhere, so the property has to hold on its own rather than by relying
  // on what it happens to wrap.
  let unguarded = 0;
  const storeOverUnguarded = new DocumentNullifierStore({
    async exists() {
      return false;
    },
    async insert() {
      return { duplicate: false };
    },
    async close() {
      unguarded += 1;
      if (unguarded > 1) throw new Error("this backend cannot be closed twice");
    },
  });
  await storeOverUnguarded.close();
  await storeOverUnguarded.close();
  assert.equal(unguarded, 1, "the store closed its backend once, without help from the backend");

  // An SDK build with no disconnect, and the in-memory backend, both have nothing to release. A
  // teardown that threw on either would turn a harmless case into a failure.
  await new DocumentNullifierStore(platformBackend({ client: { platform: { documents: {} } }, identity: {} })).close();
  await new DocumentNullifierStore(new MemoryBackend()).close();
});

test("a close that FAILS is not remembered as a success, and a racing close waits for the same one", async () => {
  // Found by an external pass on the first version of the guard, which was a boolean set BEFORE the
  // awaited release. That reports success to every later caller the moment the release starts, so a
  // disconnect that then fails is remembered as a completed close, and a second caller racing the
  // first returns before the release it is meant to be waiting for has finished. Memoizing the
  // operation is the same shape the gateway's own teardown uses, and it makes both cases behave.
  const boom = new Error("the client refused to disconnect");
  let attempts = 0;
  const failing = new DocumentNullifierStore({
    async exists() {
      return false;
    },
    async insert() {
      return { duplicate: false };
    },
    async close() {
      attempts += 1;
      throw boom;
    },
  });
  await assert.rejects(failing.close(), (e) => e === boom, "the failure reaches the caller");
  await assert.rejects(failing.close(), (e) => e === boom, "and a later caller sees it too, rather than a false success");
  assert.equal(attempts, 1, "the failed release is not silently retried behind the caller's back");

  // A RACING CLOSE AWAITS THE SAME OPERATION. Without memoization the second call resolves while the
  // first release is still in flight, which is the same "returned before it was done" defect the
  // gateway teardown had.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let finished = false;
  const slow = new DocumentNullifierStore({
    async exists() {
      return false;
    },
    async insert() {
      return { duplicate: false };
    },
    async close() {
      await held;
      finished = true;
    },
  });
  const first = slow.close();
  const second = slow.close();
  assert.equal(first, second, "every caller gets the same operation, not their own");
  let secondSettled = false;
  second.then(() => {
    secondSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondSettled, false, "the racing caller has not been told the release is done");
  release();
  await Promise.all([first, second]);
  assert.equal(finished, true);

  // THE BACKEND ON ITS OWN, for both properties. The cases above reach platformBackend only through
  // a store, whose guard would absorb a repeat and hide a backend that had none, so reverting just
  // the backend would leave them passing. platformBackend is exported and a caller can hold one
  // directly, so it owns the property rather than borrowing it.
  const clientBoom = new Error("the client refused to disconnect");
  let clientAttempts = 0;
  const failingBackend = platformBackend({
    client: {
      disconnect: async () => {
        clientAttempts += 1;
        throw clientBoom;
      },
      platform: { documents: {} },
    },
    identity: {},
  });
  await assert.rejects(failingBackend.close(), (e) => e === clientBoom);
  await assert.rejects(failingBackend.close(), (e) => e === clientBoom, "a later caller sees the failure, not a false success");
  assert.equal(clientAttempts, 1);

  let releaseClient;
  const clientHeld = new Promise((resolve) => {
    releaseClient = resolve;
  });
  const slowBackend = platformBackend({
    client: { disconnect: async () => clientHeld, platform: { documents: {} } },
    identity: {},
  });
  const b1 = slowBackend.close();
  const b2 = slowBackend.close();
  assert.equal(b1, b2, "racing callers share the backend's one disconnect");
  let b2Settled = false;
  b2.then(() => {
    b2Settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(b2Settled, false);
  releaseClient();
  await Promise.all([b1, b2]);
});
