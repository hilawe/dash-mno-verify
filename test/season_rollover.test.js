import { test } from "node:test";
import assert from "node:assert/strict";
import { SeasonMembers } from "../core/season.js";
import { RegistrationStore, MemoryRegistrationBackend } from "../core/registration_store.js";
import { makeDmlRootHasher } from "../core/dml_root.js";

// The shared empty members root an unmaterialized context serves, computed once via the fast hasher.
const EMPTY_ROOT = (await makeDmlRootHasher())([]);

// SeasonMembers is the season-scoped, per-context members cache. It is the home of the M2 fix
// (rollovers and commits run on one serialized queue, and a commit re-checks the season before it
// touches the tree) and the B2 fix (one tree per (season, context), so a member registered for one
// community cannot prove in another). These tests pin the season scoping, the context scoping, and
// the serialization without needing a proof (the gateway's HTTP layer reaches commit only past a
// real PLONK verify).

const CTX = "12345";
const CTX_B = "67890";
const newStore = () => new RegistrationStore(new MemoryRegistrationBackend());
const newSeason = (store) => new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT });

test("a commit into a bucket declared for a different statement is rejected, tree unchanged", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);

  // First registration declares (plonk, derive) for this (season, context).
  const first = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(first.ok, true);
  assert.equal(m.size(CTX), 1);
  const rootAfterFirst = m.root(CTX);

  // A custody registration for the same bucket is rejected with statement-mismatch, and the members
  // tree is not touched (no durable record was written).
  const mismatch = await m.commit(0, CTX, "222", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n1", commitment: "222", engine: "zkvm", statement: "custody" }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "statement-mismatch");
  assert.deepEqual(mismatch.declared, { engine: "plonk", statement: "derive" });
  assert.equal(m.size(CTX), 1, "the members tree was not appended to");
  assert.equal(m.root(CTX), rootAfterFirst);

  // An impossible engine/statement pair (plonk custody) is rejected the same way, tree untouched.
  const invalid = await m.commit(0, CTX, "333", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n2", commitment: "333", engine: "plonk", statement: "custody" }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-engine-statement");
  assert.equal(m.size(CTX), 1);
  assert.equal(m.root(CTX), rootAfterFirst);
});

test("a member is scoped to its season: present on that season's rebuild, absent on another", async () => {
  const store = newStore();
  const m = newSeason(store);

  await m.ensureContext(0, CTX);
  assert.equal(m.current, 0);
  assert.equal(m.size(CTX), 0);
  const emptyRoot = m.root(CTX); // the all-empty tree root, reused to avoid a second tree build

  const r = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.index, 0);
  assert.equal(m.size(CTX), 1);
  const seasonZeroRoot = m.root(CTX);
  assert.notEqual(seasonZeroRoot, emptyRoot);

  // A new season starts a fresh empty tree, so last season's root is gone (the season-scoping P0).
  await m.ensureContext(1, CTX);
  assert.equal(m.current, 1);
  assert.equal(m.size(CTX), 0);
  assert.equal(m.root(CTX), emptyRoot);

  // Going back rebuilds season 0 from the durable record, so the member is still there.
  await m.ensureContext(0, CTX);
  assert.equal(m.size(CTX), 1);
  assert.equal(m.root(CTX), seasonZeroRoot);
});

test("a member is scoped to its context: absent from another community's tree (B2)", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  await m.ensureContext(0, CTX_B);
  const emptyRoot = m.root(CTX_B);

  await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" }),
  );

  // The member is in CTX's tree but not in CTX_B's, so registering for one community does not grant
  // membership in another that season.
  assert.equal(m.size(CTX), 1);
  assert.equal(m.size(CTX_B), 0);
  assert.equal(m.root(CTX_B), emptyRoot, "the other community's tree is unchanged");
  assert.deepEqual(await store.forSeasonContext(0, CTX_B), []);
  assert.deepEqual((await store.forSeasonContext(0, CTX)).map((r) => r.commitment), ["111"]);
});

test("the same registration nullifier is a distinct spend per context, indexed from zero", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  await m.ensureContext(0, CTX_B);
  // The unique key is (season, context, nullifier), so the same nullifier value spends once in each
  // context, and each context indexes its own leaves from 0.
  const a = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  const b = await m.commit(0, CTX_B, "222", () =>
    store.append({ season: 0, contextHash: CTX_B, regNullifier: "n0", commitment: "222", engine: "plonk", statement: "derive" }),
  );
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.index, b.index], [0, 0], "each context's leaf index starts at 0");
});

test("a commit for a season that is no longer current is rejected and writes nothing", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  await m.ensure(1); // roll forward; current is now 1

  let appendCalled = false;
  const r = await m.commit(0, CTX, "111", () => {
    appendCalled = true;
    return store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" });
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "season-rolled-retry");
  assert.equal(appendCalled, false, "no durable write for a stale season");
  assert.deepEqual(await store.forSeasonContext(0, CTX), [], "store untouched");
});

test("a rollover cannot interleave with an in-flight commit (M2 serialization)", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);

  // Hold the commit open inside its critical section, then queue a rollover behind it. The
  // serialization must make the rollover wait, so the member lands under season 0 and only then does
  // season 1 reset to a fresh empty tree. Without serialization the rollover could swap the tree
  // mid-commit and publish a stale-season root.
  let release;
  const gate = new Promise((r) => (release = r));
  const commitP = m.commit(0, CTX, "111", async () => {
    await gate;
    return store.append({ season: 0, contextHash: CTX, regNullifier: "n0", commitment: "111", engine: "plonk", statement: "derive" });
  });
  const rolloverP = m.ensure(1);

  release();
  const r = await commitP;
  assert.equal(r.ok, true, "the in-flight commit completes under its own season");
  assert.equal(r.index, 0);

  await rolloverP;
  assert.equal(m.current, 1);
  await m.ensureContext(1, CTX);
  assert.equal(m.size(CTX), 0, "season 1 is a fresh empty tree, not the stale one");
  assert.deepEqual(
    (await store.forSeasonContext(0, CTX)).map((x) => x.commitment),
    ["111"],
    "the member is durably recorded under season 0",
  );
});

test("concurrent commits in the same season and context get distinct, ordered leaf indices", async () => {
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);

  const mk = (n, c) =>
    m.commit(0, CTX, c, () => store.append({ season: 0, contextHash: CTX, regNullifier: n, commitment: c, engine: "plonk", statement: "derive" }));
  const [a, b] = await Promise.all([mk("n0", "111"), mk("n1", "222")]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.index, b.index].sort(), [0, 1], "indices are distinct and dense");
  assert.equal(m.size(CTX), 2);
  // The durable record order and the leaf index agree, so a prover's path matches the gateway root.
  const recs = await store.forSeasonContext(0, CTX);
  for (const rec of recs) assert.equal(recs[rec.index].commitment, rec.commitment);
});
