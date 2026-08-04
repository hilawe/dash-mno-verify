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

test("a SMALL rebuild replays appends, which is the branch every real deployment takes", async () => {
  // THE BRANCH THE OTHER TESTS MISS, and the miss inverted coverage against production. At depth 6
  // the replay branch needs N <= 10, and every other fromCommitments call in this file uses 20 at
  // depth 6 or 4 at depth 2, all of which exceed the threshold and take the full build. A reviewer
  // deleted the replay branch entirely and every test here still passed. At the production depth of
  // 16 that branch covers up to 4096 members, which is to say every community this will ever serve,
  // so the file was testing only the branch that starts past 4097.
  const DEPTH = 6;
  const cs = Array.from({ length: 8 }, (_, i) => String(4_000_000 + i)); // 8*6 = 48 <= 64, replays
  const rebuilt = await MembersTree.fromCommitments(cs, DEPTH);
  const appended = await MembersTree.create(DEPTH);
  for (const c of cs) appended.append(c);
  assert.equal(rebuilt.root(), appended.root());

  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild(), "and it agrees with the reference build");
  rebuilt.append("555");
  appended.append("555");
  assert.equal(rebuilt.root(), appended.root(), "the replayed frontier serves later appends");
});

test("a large rebuild seeds the frontier from a full build and still matches an appended tree", async () => {
  // The OTHER branch. Replaying appends costs depth hashes per member and the padded full
  // build costs capacity-1 whatever the count, so they cross at capacity/depth. Below it the replay
  // wins, above it the full build does and the frontier is derived from it. A reviewer measured the
  // crossover on the real depth: making appends cheap while making the RECOVERY path unboundedly
  // worse would have moved the stall rather than removed it.
  const DEPTH = 6; // capacity 64, so replay needs N*6 <= 64, i.e. N <= 10; 20 takes the full build
  const cs = Array.from({ length: 20 }, (_, i) => String(3_000_000 + i));
  const rebuilt = await MembersTree.fromCommitments(cs, DEPTH);
  const appended = await MembersTree.create(DEPTH);
  for (const c of cs) appended.append(c);
  assert.equal(rebuilt.root(), appended.root(), "the two rebuild strategies agree");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild());

  // And the DERIVED frontier must serve future appends exactly as a replayed one would, which is the
  // part a root comparison alone would not catch.
  rebuilt.append("999");
  appended.append("999");
  assert.equal(rebuilt.root(), appended.root(), "the derived frontier is usable, not just decorative");
  assert.equal(rebuilt.root(), rebuilt.rootFromFullBuild());
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

// THE WORK IS COUNTED, because the roots cannot tell the branches apart. Both rebuild strategies are
// correct and produce identical roots, so deleting the cheap one is a PERFORMANCE regression that no
// assertion about a root can catch. A first attempt asserted on the level cache instead, and two
// reviewers independently pointed out that this is a proxy: a mutation can do the expensive work and
// then clear the cache. Counting Poseidon calls measures the claim itself.
test("each rebuild branch does the hashing its size warrants, counted rather than inferred", async () => {
  const DEPTH = 6;
  const CAP = 2 ** DEPTH;
  const base = await MembersTree.create(DEPTH);

  // The constructor precomputes `depth` zero-subtree roots, so that is the floor for any new tree.
  const countFor = async (n) => {
    let hashes = 0;
    const counting = (...a) => { hashes += 1; return base.poseidon(...a); };
    counting.F = base.poseidon.F;
    const cs = Array.from({ length: n }, (_, i) => String(6_000_000 + i));
    await MembersTree.fromCommitments(cs, DEPTH, counting);
    return hashes - DEPTH; // discount the zeros
  };

  // Small: replay, so depth hashes per member.
  assert.equal(await countFor(4), 4 * DEPTH, "four members replayed cost four appends' worth");

  // Large: one padded build, capacity-1 hashes, independent of the member count.
  const big = await countFor(40);
  assert.equal(big, CAP - 1, "forty members cost one full build, not forty appends");
  assert.ok(big < 40 * DEPTH, "which is cheaper than replaying them, the entire point of the branch");
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

test("a seeded rebuild does not retain the full padded tree it built", async () => {
  // The seeded branch calls levels(), which builds and CACHES the whole padded tree. Everything
  // needed from it (the frontier entries and the root) is copied out immediately, so leaving the
  // cache populated retained 131,071 nodes at depth 16 for the life of the process, with no
  // consumer: the gateway never asks for a path. A reviewer found it by reading; measured at 131,071
  // before the fix. The replay branch never had it, because append() nulls the cache.
  const DEPTH = 6;
  const cs = Array.from({ length: 40 }, (_, i) => String(5_500_000 + i)); // 40*6 > 63, seeded branch
  const seeded = await MembersTree.fromCommitments(cs, DEPTH);
  assert.equal(seeded._levels, null, "the tree it built to seed itself is not kept");
  assert.equal(seeded.root(), seeded.rootFromFullBuild(), "and the root survived the drop");
  seeded.append("42");
  assert.equal(seeded.root(), seeded.rootFromFullBuild(), "as does the frontier it extracted");
});
