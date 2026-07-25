import { test } from "node:test";
import assert from "node:assert/strict";

import { MembersTree } from "../core/members_tree.js";
import { SeasonMembers } from "../core/season.js";

// The members tree is a fixed-depth Merkle tree, and the circuits verify a path of exactly that
// depth. Past capacity the zero-padding in levels() is skipped and the tree grows deeper, which
// fails in one of two ways depending on how far past it goes:
//
//   odd overflow          the pairwise reduction hashes a node against undefined and throws
//   power-of-two overflow every level length stays even, so a deeper tree is built with NO error and
//                         root() returns a root that pathFor can never produce a path to, so every
//                         proof fails verification silently
//
// The second is the dangerous one. These run at a small depth, since exercising the real depth-16
// boundary would mean building a 65,536-leaf tree.

const DEPTH = 2; // capacity 4
const CTX = "99";

test("a tree reports its capacity and fills exactly to it", async () => {
  const t = await MembersTree.create(DEPTH);
  assert.equal(t.capacity(), 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(t.full(), false, `must accept commitment ${i}`);
    t.append(String(i + 1));
  }
  assert.equal(t.size(), 4);
  assert.equal(t.full(), true, "at capacity the tree is full");
});

test("a tree at capacity still produces a usable root and paths", async () => {
  const t = await MembersTree.create(DEPTH);
  for (let i = 0; i < 4; i++) t.append(String(i + 1));
  const root = t.root();
  assert.match(root, /^\d+$/);
  const { pathElements, pathIndices } = t.pathFor(0);
  assert.equal(pathElements.length, DEPTH, "a path is exactly the circuit's depth");
  assert.equal(pathIndices.length, DEPTH);
});

test("appending past capacity throws instead of building a deeper tree", async () => {
  const t = await MembersTree.create(DEPTH);
  for (let i = 0; i < 4; i++) t.append(String(i + 1));
  assert.throws(() => t.append("5"), /members tree is full/);
  assert.equal(t.size(), 4, "the refused append leaves the tree untouched");
});

test("the power-of-two overflow that would silently deepen the tree is refused", async () => {
  // Doubling capacity keeps every level length even, so without the guard this would build a
  // depth-3 tree and publish a root no depth-2 path can reach, with no error raised anywhere.
  const t = await MembersTree.create(DEPTH);
  for (let i = 0; i < 4; i++) t.append(String(i + 1));
  for (const extra of ["5", "6", "7", "8"]) {
    assert.throws(() => t.append(extra), /members tree is full/);
  }
  assert.equal(t.levels().length, DEPTH + 1, "the tree stays exactly DEPTH levels deep");
});

test("materializing an over-capacity record set fails loudly rather than deepening", async () => {
  // A bucket this large means the commit-side guard was bypassed. Refusing beats serving a root that
  // verifies nothing.
  await assert.rejects(
    MembersTree.fromCommitments(["1", "2", "3", "4", "5"], DEPTH),
    /members tree over capacity/,
  );
  // Exactly at capacity is fine.
  const ok = await MembersTree.fromCommitments(["1", "2", "3", "4"], DEPTH);
  assert.equal(ok.size(), 4);
});

test("commit refuses at capacity WITHOUT writing the durable record", async () => {
  // The ordering is the point: the durable record is the commit point, so writing it and then
  // failing to append would leave a bucket that can never be materialized again.
  const records = [];
  const store = {
    forSeasonContext: async () => records.slice(),
    append: async (r) => {
      records.push(r);
      return { duplicate: false, index: records.length - 1 };
    },
  };
  const sm = new SeasonMembers({
    store,
    rootWindow: 4,
    emptyRoot: "0",
    nowSec: () => 1000,
    treeDepth: DEPTH,
  });
  await sm.ensureContext(0, CTX);

  for (let i = 0; i < 4; i++) {
    const r = await sm.commit(0, CTX, String(i + 1), () =>
      store.append({ season: 0, contextHash: CTX, regNullifier: `n${i}`, commitment: String(i + 1) }),
    );
    assert.equal(r.ok, true, `commitment ${i} should be accepted`);
  }
  assert.equal(records.length, 4);

  let durableCalled = false;
  const over = await sm.commit(0, CTX, "5", async () => {
    durableCalled = true;
    return store.append({ season: 0, contextHash: CTX, regNullifier: "n4", commitment: "5" });
  });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "members-tree-full");
  assert.equal(over.capacity, 4);
  assert.equal(durableCalled, false, "the durable write must not run once the tree is full");
  assert.equal(records.length, 4, "no record was persisted for the refused registration");
});

test("a full context does not block a different context in the same season", async () => {
  const byBucket = new Map();
  const store = {
    forSeasonContext: async (season, ctx) => (byBucket.get(`${season}:${ctx}`) ?? []).slice(),
    append: async (r) => {
      const k = `${r.season}:${r.contextHash}`;
      const list = byBucket.get(k) ?? [];
      list.push(r);
      byBucket.set(k, list);
      return { duplicate: false, index: list.length - 1 };
    },
  };
  const sm = new SeasonMembers({ store, rootWindow: 4, emptyRoot: "0", nowSec: () => 1000, treeDepth: DEPTH });
  await sm.ensureContext(0, CTX);
  for (let i = 0; i < 4; i++) {
    await sm.commit(0, CTX, String(i + 1), () =>
      store.append({ season: 0, contextHash: CTX, regNullifier: `n${i}`, commitment: String(i + 1) }),
    );
  }
  assert.equal((await sm.commit(0, CTX, "5", async () => ({}))).reason, "members-tree-full");

  const other = "77";
  await sm.ensureContext(0, other);
  const r = await sm.commit(0, other, "9", () =>
    store.append({ season: 0, contextHash: other, regNullifier: "m0", commitment: "9" }),
  );
  assert.equal(r.ok, true, "capacity is per (season, context), not global");
});
