import { test } from "node:test";
import assert from "node:assert/strict";
import { SeasonMembers } from "../core/season.js";
import { RegistrationStore, MemoryRegistrationBackend } from "../core/registration_store.js";

// SeasonMembers is the season-scoped members cache and the home of the M2 fix: rollovers and
// member commits run on one serialized queue, and a commit re-checks the season before it touches
// the tree. These tests pin the season scoping and that serialization without needing a proof
// (the gateway's HTTP layer reaches commit only past a real PLONK verify).

const CTX = "12345";
const newStore = () => new RegistrationStore(new MemoryRegistrationBackend());
const newSeason = (store) => new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0 });

test("a member is scoped to its season: present on that season's rebuild, absent on another", async () => {
  const store = newStore();
  const m = newSeason(store);

  await m.ensure(0);
  assert.equal(m.current, 0);
  assert.equal(m.size(), 0);
  const emptyRoot = m.root(); // the all-empty season root, reused to avoid a second tree build

  const r = await m.commit(0, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111" }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.index, 0);
  assert.equal(m.size(), 1);
  const seasonZeroRoot = m.root();
  assert.notEqual(seasonZeroRoot, emptyRoot);

  // A new season starts a fresh empty tree, so last season's root is gone (the season-scoping P0).
  await m.ensure(1);
  assert.equal(m.current, 1);
  assert.equal(m.size(), 0);
  assert.equal(m.root(), emptyRoot);

  // Going back rebuilds season 0 from the durable record, so the member is still there.
  await m.ensure(0);
  assert.equal(m.size(), 1);
  assert.equal(m.root(), seasonZeroRoot);
});

test("a commit for a season that is no longer current is rejected and writes nothing", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensure(0);
  await m.ensure(1); // roll forward; current is now 1

  let appendCalled = false;
  const r = await m.commit(0, "111", () => {
    appendCalled = true;
    return store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111" });
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "season-rolled-retry");
  assert.equal(appendCalled, false, "no durable write for a stale season");
  assert.deepEqual(await store.forSeason(0), [], "store untouched");
  assert.equal(m.size(), 0, "the current (season 1) tree is still empty");
});

test("a rollover cannot interleave with an in-flight commit (M2 serialization)", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensure(0);

  // Hold the commit open inside its critical section, then queue a rollover behind it. The
  // serialization must make the rollover wait, so the member lands under season 0 and only then
  // does season 1 reset to a fresh empty tree. Without serialization the rollover could swap the
  // tree mid-commit and publish a stale-season root.
  let release;
  const gate = new Promise((r) => (release = r));
  const commitP = m.commit(0, "111", async () => {
    await gate;
    return store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111" });
  });
  const rolloverP = m.ensure(1);

  release();
  const r = await commitP;
  assert.equal(r.ok, true, "the in-flight commit completes under its own season");
  assert.equal(r.index, 0);

  await rolloverP;
  assert.equal(m.current, 1);
  assert.equal(m.size(), 0, "season 1 is a fresh empty tree, not the stale one");
  assert.deepEqual(
    (await store.forSeason(0)).map((x) => x.commitment),
    ["111"],
    "the member is durably recorded under season 0",
  );
});

test("concurrent commits in the same season get distinct, ordered leaf indices", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensure(0);

  const mk = (n, c) => m.commit(0, c, () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: n, commitment: c }),
  );
  const [a, b] = await Promise.all([mk("n0", "111"), mk("n1", "222")]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.index, b.index].sort(), [0, 1], "indices are distinct and dense");
  assert.equal(m.size(), 2);
  // The durable record order and the leaf index agree, so a prover's path matches the gateway root.
  const recs = await store.forSeason(0);
  for (const rec of recs) assert.equal(recs[rec.index].commitment, rec.commitment);
});
