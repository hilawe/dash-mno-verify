import { test } from "node:test";
import assert from "node:assert/strict";

import { MembersTree } from "../core/members_tree.js";
import { SeasonMembers } from "../core/season.js";
import { RegistrationStore, MemoryRegistrationBackend } from "../core/registration_store.js";

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

// THE INCREMENTAL ROOT MUST EQUAL THE FULL BUILD'S, at every size. This is the load-bearing property
// of the frontier change and not a nicety: durable registrations and every proof already generated
// are checked against roots built by the padded full rebuild, so a root that differs anywhere would
// silently invalidate them. The sizes below deliberately straddle subtree boundaries (powers of two
// and their neighbours), because that is where a frontier implementation goes wrong: it is the
// moment a level's left sibling stops being reused and a new one is cached.
test("the incremental root equals the full rebuild at every size, including subtree boundaries", async () => {
  const DEPTH = 6; // capacity 64, so a full rebuild is cheap enough to compare against exhaustively
  for (let n = 0; n <= 2 ** DEPTH; n += 1) {
    const t = await MembersTree.create(DEPTH);
    for (let i = 0; i < n; i += 1) t.append(String(1_000_000 + i));
    assert.equal(
      t.root(),
      t.rootFromFullBuild(),
      `incremental and full-build roots diverge at ${n} commitments`,
    );
  }
});

test("a tree rebuilt from durable commitments has the same root as one built by appends", async () => {
  // fromCommitments is the recovery path, reached lazily on the first touch of a context after a
  // boot or a rollover rather than eagerly at the rollover itself, so a divergence here would mean the
  // gateway served one root before a restart and a different one after, against the same members. A
  // first draft pushed straight into the commitments array, which left the frontier empty and made
  // this read as the EMPTY tree's root while reporting the right size.
  const DEPTH = 6;
  const commitments = Array.from({ length: 20 }, (_, i) => String(2_000_000 + i));
  const appended = await MembersTree.create(DEPTH);
  for (const c of commitments) appended.append(c);
  const rebuilt = await MembersTree.fromCommitments(commitments, DEPTH);
  assert.equal(rebuilt.size(), appended.size());
  assert.equal(rebuilt.root(), appended.root(), "a restart must not change the root");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild());
});

test("root() does no hashing at all, while a path request pays for the full build", async () => {
  // COUNTS THE WORK, not a cache slot. A first version asserted `_levels === null` after root(),
  // which is a proxy and a weak one: a reviewer mutated root() to run the full build and then null
  // the cache before returning, and the test still passed. It observed whether a cache was left
  // warm, never whether the expensive work happened. Counting hashes measures the actual claim, and
  // it does not pin a private field name either.
  const t = await MembersTree.create(6);
  t.append("12345");

  let hashes = 0;
  const realPoseidon = t.poseidon;
  t.poseidon = (...args) => { hashes += 1; return realPoseidon(...args); };

  t.root();
  assert.equal(hashes, 0, "root() is a cached read, so it hashes nothing");

  t.pathFor(0);
  assert.equal(hashes, 63, "and a path request pays the full padded build, 2^6 - 1 hashes");
});

test("a rejected append leaves no trace, so root() and the full build can never disagree", async () => {
  // Caching the root turned a loud failure into a quiet one. The conversion used to happen AFTER the
  // push, so a value that is not a decimal integer left the tree holding the bad entry with the root
  // never updated: size() had grown, commitments contained it, and root() silently returned the
  // previous leaf set's root while a full rebuild threw. The old code could not do that, because
  // root() recomputed from commitments and failed identically every time.
  const t = await MembersTree.create(6);
  t.append("11");
  t.append("22");
  const before = t.root();
  assert.throws(() => t.append("not-a-number"), SyntaxError);
  assert.equal(t.size(), 2, "the refused commitment was not kept");
  assert.deepEqual(t.commitments, ["11", "22"]);
  assert.equal(t.root(), before, "and the root still describes exactly those leaves");
  assert.equal(t.root(), t.rootFromFullBuild(), "the two views agree, which is the real property");
});



test("SeasonMembers.commitments hands out a copy, so a caller cannot desync the cached root", async () => {
  // Handing out the live array was harmless while the root was recomputed from it on every read.
  // With the root cached, a caller that mutated it would make /v1/members return a commitment list
  // that does not hash to the membersRoot in the same response.
  const store = new RegistrationStore(new MemoryRegistrationBackend());
  const sm = new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0, emptyRoot: "0", treeDepth: DEPTH });
  await sm.ensure(0);
  await sm.commit(0, CTX, "111", async () => ({ duplicate: false, index: 0 }));
  const handed = sm.commitments(CTX);
  const rootBefore = sm.root(CTX);
  handed.push("999");
  handed.sort();
  assert.deepEqual(sm.commitments(CTX), ["111"], "the caller mutated its own copy");
  assert.equal(sm.root(CTX), rootBefore, "and the served root still describes the real member set");
});

test("a frontier seeded from a full build serves later appends at EVERY starting size", async () => {
  // The seeded path was covered at one size with one append, and a reviewer noted that a seed which
  // skipped, say, level 1 would still pass there because 20 has that bit clear. The bug would appear
  // only from a different starting size. So this walks every size and appends through the carry
  // boundaries that follow it.
  const DEPTH = 5;
  const CAP = 2 ** DEPTH;
  const shared = await MembersTree.create(DEPTH);
  for (let n = 0; n <= CAP; n += 1) {
    const cs = Array.from({ length: n }, (_, i) => String(7_000_000 + i));
    const seeded = await MembersTree.fromCommitments(cs, DEPTH, shared.poseidon);
    const replayed = await MembersTree.create(DEPTH, shared.poseidon);
    for (const c of cs) replayed.append(c);
    assert.equal(seeded.root(), replayed.root(), `rebuilt root differs at ${n}`);
    // Append through several carries, which is where a missing frontier level shows up.
    for (let k = 0; k < Math.min(5, CAP - n); k += 1) {
      const v = String(8_000_000 + k);
      seeded.append(v);
      replayed.append(v);
      assert.equal(seeded.root(), replayed.root(), `diverged ${k + 1} appends after a seed at ${n}`);
      assert.equal(seeded.root(), seeded.rootFromFullBuild(), `seeded root left the reference at ${n}`);
    }
  }
});


// THE REBUILD IS ONE PASS NOW, so there is no branch to witness and no threshold to get wrong. What
// replaces those tests is a direct measurement of the cost, because the whole point of the carry
// stack is what it costs: the roots were always correct under every previous strategy too.
test("a rebuild costs N-1 hashes plus one fold, whatever the member count", async () => {
  const DEPTH = 6;
  const base = await MembersTree.create(DEPTH);

  const countFor = async (n) => {
    let hashes = 0;
    const counting = (...a) => { hashes += 1; return base.poseidon(...a); };
    counting.F = base.poseidon.F;
    const cs = Array.from({ length: n }, (_, i) => String(6_000_000 + i));
    await MembersTree.fromCommitments(cs, DEPTH, counting);
    return hashes - DEPTH; // discount the zero-subtree roots the constructor precomputes
  };

  // Each combine removes one node, and the walk starts with N and ends with popcount(N) entries, so
  // the combines number N - popcount(N). The fold to the root costs `depth` more. This test is why
  // the code comment says that rather than "N-1": the first version claimed N-1, which holds only
  // for powers of two, and this caught it at three members.
  const popcount = (x) => x.toString(2).split("").filter((b) => b === "1").length;
  for (const n of [1, 2, 3, 5, 8, 13, 40]) {
    assert.equal(
      await countFor(n),
      n - popcount(n) + DEPTH,
      `wrong hash count rebuilding ${n} members`,
    );
  }

  // Cheaper than both strategies it replaced, at a size where they differ: replaying appends costs
  // N*depth (240 here) and a padded build costs capacity-1 (63), against this one's 44.
  const cost40 = 40 - popcount(40) + DEPTH;
  assert.ok(cost40 < 40 * DEPTH, "cheaper than replaying appends");
  assert.ok(cost40 < 2 ** DEPTH - 1, "and cheaper than a padded full build");
});

test("an exactly-full tree rebuilds to the right root, which the bit fold alone cannot do", async () => {
  // The carry stack combines an exactly-full tree all the way to a single node at the root level,
  // and at that size there is no next insertion position for the bit fold to describe: every bit
  // below the root is clear, so the fold would return the EMPTY tree's root. Found by walking every
  // size rather than the interesting-looking ones. It cannot self-correct either, since a full tree
  // refuses every append.
  const DEPTH = 4;
  const CAP = 2 ** DEPTH;
  const shared = await MembersTree.create(DEPTH);
  const cs = Array.from({ length: CAP }, (_, i) => String(7_700_000 + i));
  const rebuilt = await MembersTree.fromCommitments(cs, DEPTH, shared.poseidon);
  const appended = await MembersTree.create(DEPTH, shared.poseidon);
  for (const c of cs) appended.append(c);

  assert.equal(rebuilt.size(), CAP);
  assert.equal(rebuilt.full(), true);
  assert.equal(rebuilt.root(), appended.root(), "an exactly-full rebuild matches the appended tree");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild(), "and the reference build");
  assert.notEqual(rebuilt.root(), (await MembersTree.create(DEPTH, shared.poseidon)).root(),
    "and is emphatically not the empty tree's root, which is what the fold alone would have given");
});

test("a rebuild never builds the level array, so it retains nothing to serve paths with", async () => {
  // The previous strategy called levels() to seed itself and left all 131,071 nodes cached at depth
  // 16, about 32 MiB retained with no consumer. The carry stack never touches levels() at all.
  const rebuilt = await MembersTree.fromCommitments(
    Array.from({ length: 40 }, (_, i) => String(5_500_000 + i)), 6,
  );
  assert.equal(rebuilt._levels, null, "nothing cached");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild());
  rebuilt.append("42");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild(), "and the frontier it built still works");
});
