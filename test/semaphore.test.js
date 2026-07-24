// The verify-concurrency Semaphore (core/stores.js): it caps how many expensive verifies run at
// once and sheds load when the wait queue is full, so a distributed flood cannot spawn unbounded
// concurrent proof checks. These pin the concurrency cap, no over-subscription, FIFO wakeups, and
// the shed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore, ChallengeStore } from "../core/stores.js";

const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("never runs more than max concurrently, and tracks the peak", async () => {
  const sem = new Semaphore({ max: 2, maxQueue: 100 });
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 6 }, () => defer());
  const tasks = gates.map((g, i) =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await g.promise;
      active -= 1;
      return i;
    }),
  );
  // let the first two start
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(active, 2, "only max start immediately");
  // release them one at a time; a waiter should take each freed slot, never exceeding 2.
  for (const g of gates) {
    g.resolve();
    await new Promise((r) => setTimeout(r, 2));
  }
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2, "the cap was never exceeded (no over-subscription)");
});

test("sheds with an overloaded error when the wait queue is full", async () => {
  const sem = new Semaphore({ max: 1, maxQueue: 1 });
  const g1 = defer();
  const running = sem.run(() => g1.promise); // takes the one slot
  await new Promise((r) => setTimeout(r, 5));
  const g2 = defer();
  const queued = sem.run(() => g2.promise); // fills the one queue place
  // The next arrival has no slot and no queue place, so it is shed.
  await assert.rejects(sem.run(async () => "nope"), (e) => e.overloaded === true);

  g1.resolve();
  g2.resolve();
  await running;
  await queued;
});

test("wakeups are FIFO", async () => {
  const sem = new Semaphore({ max: 1, maxQueue: 10 });
  const order = [];
  const g0 = defer();
  const first = sem.run(() => g0.promise); // holds the slot
  await new Promise((r) => setTimeout(r, 5));
  const rest = [1, 2, 3].map((n) => sem.run(async () => order.push(n)));
  g0.resolve();
  await first;
  await Promise.all(rest);
  assert.deepEqual(order, [1, 2, 3], "queued tasks run in arrival order");
});

test("an exception in the task still releases the slot", async () => {
  const sem = new Semaphore({ max: 1, maxQueue: 10 });
  await assert.rejects(sem.run(async () => { throw new Error("boom"); }), /boom/);
  // the slot must be free again
  const ran = await sem.run(async () => "ok");
  assert.equal(ran, "ok");
});

// ChallengeStore.restore backs the overload fix: a taken-but-not-processed challenge is put back so a
// transient verify overload does not burn the member's one-time nonce, preserving the original expiry.
test("restore puts back a taken challenge with its original expiry, so overload does not burn it", () => {
  const cs = new ChallengeStore(600);
  cs.put("n", { account: "alice", epoch: 3 });
  const pending = cs.take("n");
  assert.ok(pending, "the challenge was taken");
  assert.equal(cs.take("n"), null, "and consumed (a second take is empty)");

  // Restore it (as the gateway does on overload) and confirm it is takeable again with the SAME expiry.
  assert.equal(cs.restore("n", pending), true);
  const again = cs.take("n");
  assert.deepEqual({ account: again.account, epoch: again.epoch, expires: again.expires }, {
    account: "alice", epoch: 3, expires: pending.expires,
  });
});

test("restore refuses ONLY an already-expired challenge", () => {
  const cs = new ChallengeStore(600);
  const expired = { account: "bob", epoch: 1, expires: Date.now() - 1 };
  assert.equal(cs.restore("x", expired), false);
  assert.equal(cs.take("x"), null, "nothing was restored");
});

test("restore respects the cap, so the take/fill/restore cycle cannot grow the store past maxPending", () => {
  // maxPending 1. take frees the slot, a new challenge fills it, then restore is refused because the
  // store is full, so the store stays bounded at maxPending (an earlier cap-bypass let this cycle
  // inflate the store without bound). The gateway then tells the member to request a new challenge.
  const cs = new ChallengeStore(600, 1);
  cs.put("n", { account: "a", epoch: 0 });
  const pending = cs.take("n"); // size 0
  cs.put("filler", { account: "b", epoch: 0 }); // size 1 (full)
  assert.equal(cs.restore("n", pending), false, "restore refused when the store is full");
  assert.equal(cs.pending.size, 1, "the store stays bounded at maxPending, not grown past it");
});

test("restore does not extend a challenge's life under repeated overload", () => {
  // put() resets the TTL; restore() must not, or repeated overload could keep a nonce alive forever.
  const cs = new ChallengeStore(600);
  cs.put("n", { account: "a", epoch: 0 });
  const p = cs.take("n");
  const originalExpiry = p.expires;
  cs.restore("n", p);
  const p2 = cs.take("n");
  assert.equal(p2.expires, originalExpiry, "the expiry is unchanged across restore");
});
