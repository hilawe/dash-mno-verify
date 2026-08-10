import { test } from "node:test";
import assert from "node:assert/strict";
import { SeasonMembers } from "../core/season.js";
import { RegistrationStore, MemoryRegistrationBackend } from "../core/registration_store.js";
import { verifyRegistrationCore } from "../core/verifier.js";
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
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(first.ok, true);
  assert.equal(m.size(CTX), 1);
  const rootAfterFirst = m.root(CTX);

  // A custody registration for the same bucket is rejected with statement-mismatch, and the members
  // tree is not touched (no durable record was written).
  const mismatch = await m.commit(0, CTX, "222", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "zkvm", statement: "custody" }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "statement-mismatch");
  assert.deepEqual(mismatch.declared, { engine: "plonk", statement: "derive" });
  assert.equal(m.size(CTX), 1, "the members tree was not appended to");
  assert.equal(m.root(CTX), rootAfterFirst);

  // An impossible engine/statement pair (plonk custody) is rejected the same way, tree untouched.
  const invalid = await m.commit(0, CTX, "333", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "137", commitment: "333", engine: "plonk", statement: "custody" }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-engine-statement");
  assert.equal(m.size(CTX), 1);
  assert.equal(m.root(CTX), rootAfterFirst);
});

test("A2: a durable-but-stranded member is reconciled on the already-registered retry, preserving prior roots", async () => {
  // The internal assurance round's strand, corrected after a different-family review showed the first
  // fix sat on a path production never reaches. On a retry the store reports the record already durable,
  // so verifyRegistrationCore returns already-registered at registrationStore.has() BEFORE commit() runs.
  // The recovery is therefore triggered from that already-registered path: it rebuilds the cache from the
  // durable records when the cache is behind, and it preserves the context's root window so a still-live
  // root a challenge was minted against is not evicted.
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);

  // Member A registers normally: durable AND in the tree. Capture the root the tree served with A alone.
  const a = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(a.ok, true);
  const rootWithA = m.root(CTX);
  assert.equal(m.rootStore(CTX).isRecent(rootWithA), true);

  // Member B is stranded: durably written but never appended to the tree (its commit threw after the
  // durable write). Appending straight to the store reproduces that exact state.
  await store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "plonk", statement: "derive" });
  assert.equal(m.size(CTX), 1, "the cached tree is missing the stranded member");
  assert.deepEqual((await store.forSeasonContext(0, CTX)).map((r) => r.commitment), ["111", "222"], "both are durable");

  // B retries registration. registrationStore.has() is true, so the core answers already-registered
  // without reaching the proof verify or commit (both throw here if reached); recover must reconcile first.
  const result = await verifyRegistrationCore({
    claims: { commitment: "222", regNullifier: "136", root: "r", season: 0, contextHash: CTX },
    verifyProof: () => {
      throw new Error("proof verify must not run on an already-registered retry");
    },
    // A STALE anchor (isRecent false): recovery must NOT be blocked by anchor freshness (finding P1-a),
    // because an already-durable member cannot be required to re-anchor and may have left the list.
    expected: { rootStore: { isRecent: () => false }, season: 0, contextHash: CTX, engine: "plonk", statement: "derive" },
    registrationStore: store,
    commit: () => {
      throw new Error("commit must not run on an already-registered retry");
    },
    recover: (s, c) => m.recoverMember(s, c),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "already-registered", "recovered despite a stale anchor, not stale-or-unknown-root");
  assert.equal(m.size(CTX), 2, "the stranded member is reconciled into the tree");
  assert.ok(m.commitments(CTX).includes("222"), "so a later /v1/members read serves them a valid path");
  assert.equal(m.rootStore(CTX).isRecent(rootWithA), true, "the previously served root is preserved, not evicted");
  assert.equal(m.rootStore(CTX).isRecent(m.root(CTX)), true, "and the new root is present too");

  // A NEW registration (unknown nullifier) with the same stale anchor is still rejected: the reorder
  // did not weaken the anchor rule for a genuine new registration, only lifted it off the durable replay.
  const fresh = await verifyRegistrationCore({
    claims: { commitment: "333", regNullifier: "137", root: "r", season: 0, contextHash: CTX },
    verifyProof: () => true,
    expected: { rootStore: { isRecent: () => false }, season: 0, contextHash: CTX, engine: "plonk", statement: "derive" },
    registrationStore: store,
    commit: () => {
      throw new Error("commit must not run once the anchor is refused");
    },
    recover: (s, c) => m.recoverMember(s, c),
  });
  assert.equal(fresh.reason, "stale-or-unknown-root", "a new registration still needs a fresh anchor");
});

test("A2 (P1-b): a concurrent retry reaching commit's duplicate branch is also reconciled", async () => {
  // A re-review found the verifier has() short-circuit recovers only a SEQUENTIAL retry. Two retries can
  // both read has()==false before either enters the season queue; the first writes durably and throws
  // before the tree append, and the second reaches commit(), gets duplicate from the durable append, and
  // must reconcile the cache there too rather than answering already-registered with the member absent.
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  const a = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(a.ok, true);
  // Strand B durably, outside the tree.
  await store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "plonk", statement: "derive" });
  assert.equal(m.size(CTX), 1);

  // The second concurrent retry reaches commit and its appendDurable reports duplicate.
  const res = await m.commit(0, CTX, "222", async () => ({ duplicate: true }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "already-registered");
  assert.equal(m.size(CTX), 2, "commit's duplicate branch reconciled the stranded member into the tree");
  assert.ok(m.commitments(CTX).includes("222"));
});

test("A2 (P2): recoverMember never rolls the cache backward, it reports season-rolled", async () => {
  // A re-review found that recoverMember called _roll(season), which throws under monotonic when a
  // rollover queued ahead of the call has advanced the cache past this request's season. It now checks
  // the cache season instead of rolling, so a mismatched season is a no-op season-rolled result.
  const store = newStore();
  const m = new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT, monotonic: true });
  await m.ensureContext(1, CTX); // the cache is now on season 1
  const r = await m.recoverMember(0, CTX); // a straggler for the ended season 0
  assert.deepEqual(r, { rebuilt: false, reason: "season-rolled" }, "no throw, no backward roll");
  assert.equal(m.current, 1, "the cache season is unchanged");
});

test("A2 (Finding 1): a normal commit after a strand reconciles first, so leaf order stays a durable prefix", async () => {
  // The third-round blocker. A strand leaves the cache behind the durable records, and before this fix a
  // later NORMAL commit appended onto that lagging cache, assigning the new member a tree position below
  // the durable index the store handed back. The served tree and a restart rebuild then diverged, and the
  // capacity guard under-counted. commit now reconciles before assigning a position.
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  // A registers normally: durable and cached at index 0.
  const a = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  assert.equal(a.ok, true);
  // B is stranded: durable at index 1, never in the tree.
  await store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "plonk", statement: "derive" });
  assert.equal(m.size(CTX), 1, "the cache lags: it holds only A");

  // C registers normally. Its durable index is 2; commit must reconcile B in first so C lands at 2, not 1.
  const c = await m.commit(0, CTX, "333", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "137", commitment: "333", engine: "plonk", statement: "derive" }),
  );
  assert.equal(c.ok, true);
  assert.equal(c.index, 2, "C takes the durable index 2, not the lagging cache position 1");
  assert.equal(m.size(CTX), 3);
  assert.deepEqual(m.commitments(CTX), ["111", "222", "333"], "the tree is the durable prefix, with B reconciled in");
});

test("A2 (Finding 1 guard): a durable index that disagrees with the tree size fails closed, tree untouched", async () => {
  // The second guard the review asked for: even if reconciliation ever failed to align them, a durable
  // index that does not equal the tree position must not append the member at the wrong slot.
  const store = newStore();
  const m = newSeason(store);
  await m.ensureContext(0, CTX);
  const res = await m.commit(0, CTX, "111", async () => ({ duplicate: false, index: 5 }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "index-tree-mismatch", "a mismatched durable index is refused, not appended");
  assert.equal(m.size(CTX), 0, "the tree is not mutated");
});

test("A2 (Finding 2a): a key that becomes durable during the proof recovers when the anchor then ages out", async () => {
  // The concurrent race the third round found: a request passes the initial has() (false) and anchor
  // (fresh), and while its proof verifies a concurrent request lands and strands the member. If this
  // request's post-proof anchor recheck then fails, it must recover the now-durable member rather than
  // returning stale-or-unknown-root and leaving it stranded.
  let hasCalls = 0;
  let rootCalls = 0;
  let recovered = null;
  const result = await verifyRegistrationCore({
    claims: { commitment: "222", regNullifier: "136", root: "r", season: 0, contextHash: CTX },
    verifyProof: () => true,
    expected: {
      rootStore: { isRecent: () => (++rootCalls === 1) }, // fresh at the initial check, aged out on the recheck
      season: 0,
      contextHash: CTX,
      engine: "plonk",
      statement: "derive",
    },
    registrationStore: { has: async () => ++hasCalls >= 2 }, // not durable initially, durable by the recheck
    commit: () => {
      throw new Error("commit must not run when the anchor aged out");
    },
    recover: async (s, c) => {
      recovered = [s, c];
    },
  });
  assert.equal(result.reason, "already-registered", "recovered instead of returning stale-or-unknown-root");
  assert.deepEqual(recovered, [0, CTX], "recovery ran for the right season and context");
});

test("A2 (round 4): a duplicate at the full-tree boundary answers already-registered, not members-tree-full", async () => {
  // The fourth-round edge. A concurrent duplicate can reconcile a member into the LAST slot, and the
  // capacity check would then refuse the retry as members-tree-full before the durable append could report
  // the duplicate. A read-only commitment check answers already-registered first.
  const store = newStore();
  const m = new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT, treeDepth: 1 }); // capacity 2
  await m.ensureContext(0, CTX);
  await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  await m.commit(0, CTX, "222", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "plonk", statement: "derive" }),
  );
  assert.equal(m.size(CTX), 2, "the tree is full");

  // A retry of an already-registered member (nullifier 136) must not be refused as members-tree-full,
  // and must not attempt a durable write.
  const retry = await m.commit(
    0,
    CTX,
    "222",
    async () => {
      throw new Error("appendDurable must not run for a known duplicate at capacity");
    },
    "136",
  );
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "already-registered", "a duplicate at the full boundary is already-registered");
});

test("A2 (round 5): the duplicate check is keyed by nullifier, not commitment", async () => {
  const store = newStore();
  const m = new SeasonMembers({ store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT, treeDepth: 1 }); // capacity 2
  await m.ensureContext(0, CTX);
  await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }), "135");
  await m.commit(0, CTX, "222", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "222", engine: "plonk", statement: "derive" }), "136");
  assert.equal(m.size(CTX), 2, "full");

  // SAME nullifier 136 with a DIFFERENT commitment 999 at capacity: still a durable duplicate, so
  // already-registered (the old commitment-based check would have missed it and returned members-tree-full).
  const sameNf = await m.commit(0, CTX, "999", async () => {
    throw new Error("no durable write for a nullifier already registered");
  }, "136");
  assert.equal(sameNf.reason, "already-registered", "keyed by nullifier, catches a different commitment");

  // A durable duplicate whose appendDurable would report a stale anchor is caught BEFORE that check.
  const stale = await m.commit(0, CTX, "222", async () => ({ staleRoot: true }), "136");
  assert.equal(stale.reason, "already-registered", "the durable duplicate is caught before the anchor check");
});

test("A2 (round 5): distinct nullifiers sharing a commitment are NOT treated as duplicates", async () => {
  const store = newStore();
  const m = newSeason(store); // ample room
  await m.ensureContext(0, CTX);
  await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }), "135");
  // A DIFFERENT nullifier 136 carrying the SAME commitment 111 is a distinct registration (two voting keys
  // sharing a member secret), and with room it is accepted, not short-circuited to already-registered.
  const second = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "136", commitment: "111", engine: "plonk", statement: "derive" }), "136");
  assert.equal(second.ok, true, "a distinct nullifier is a new registration, not a duplicate");
  assert.equal(second.index, 1);
  assert.equal(m.size(CTX), 2);
});

test("a member is scoped to its season: present on that season's rebuild, absent on another", async () => {
  const store = newStore();
  const m = newSeason(store);

  await m.ensureContext(0, CTX);
  assert.equal(m.current, 0);
  assert.equal(m.size(CTX), 0);
  const emptyRoot = m.root(CTX); // the all-empty tree root, reused to avoid a second tree build

  const r = await m.commit(0, CTX, "111", () =>
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
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
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
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
    store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" }),
  );
  const b = await m.commit(0, CTX_B, "222", () =>
    store.append({ season: 0, contextHash: CTX_B, regNullifier: "135", commitment: "222", engine: "plonk", statement: "derive" }),
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
    return store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" });
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
    return store.append({ season: 0, contextHash: CTX, regNullifier: "135", commitment: "111", engine: "plonk", statement: "derive" });
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
  const [a, b] = await Promise.all([mk("135", "111"), mk("136", "222")]);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.deepEqual([a.index, b.index].sort(), [0, 1], "indices are distinct and dense");
  assert.equal(m.size(CTX), 2);
  // The durable record order and the leaf index agree, so a prover's path matches the gateway root.
  const recs = await store.forSeasonContext(0, CTX);
  for (const rec of recs) assert.equal(recs[rec.index].commitment, rec.commitment);
});

// THE WALL-CLOCK BOUNDARY, which is a different race from the serialization one above. The commit
// compared the caller's season against SeasonMembers' own CACHE, and that cache only moves when an
// ensure() runs, with the background rollover firing once a minute. So a registration that started
// before a boundary and finished after it passed the check, durably appended a record for a season
// that had already ended, and returned success for a membership the next rollover made unusable,
// after the member had paid the heavy proving cost. Two reviewers reproduced it independently.
test("a commit refuses when WALL TIME has left the season, even while the cache still holds it", async () => {
  const store = newStore();
  let season = 0;
  const sm = new SeasonMembers({
    store,
    rootWindow: 8,
    nowSec: () => 0,
    emptyRoot: EMPTY_ROOT,
    seasonNow: () => season, // the guarded clock, authoritative
  });
  await sm.ensure(0);
  assert.equal(sm.current, 0, "the cache holds season 0");

  // The boundary passes while the caller's proof is being verified. Nothing calls ensure(), so the
  // cache is untouched and the old check would still have compared 0 against 0 and passed.
  season = 1;
  const res = await sm.commit(0, CTX, "111", async () => ({ duplicate: false, index: 0 }));

  assert.equal(res.ok, false, "the registration is refused rather than written to a dead season");
  assert.equal(res.reason, "season-rolled-retry");
  assert.equal(sm.current, 0, "and the cache is left alone, so the rollover still owns that move");
  assert.deepEqual(await store.forSeasonContext(0, CTX), [], "nothing durable was written");
});

test("a commit still succeeds when wall time agrees with the claimed season", async () => {
  // The guard must not refuse ordinary correct operation, which is the other half of every guard.
  const store = newStore();
  const sm = new SeasonMembers({
    store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT, seasonNow: () => 3,
  });
  await sm.ensure(3);
  const res = await sm.commit(3, CTX, "111", async () => ({ duplicate: false, index: 0 }));
  assert.equal(res.ok, true, "the normal path is unaffected");
  assert.equal(res.size, 1);
});

test("the season is re-read AFTER materialization, not before it", async () => {
  // Position, not just presence. A first draft checked the clock before `_materialize()`, which is
  // itself an await and can take seconds on a first-use context, so the season could end inside
  // that await and the guard would look correct while proving nothing. This moves the boundary
  // during materialization specifically.
  const store = newStore();
  let season = 0;
  const sm = new SeasonMembers({
    store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT, seasonNow: () => season,
  });
  await sm.ensure(0);
  const realMaterialize = sm._materialize.bind(sm);
  sm._materialize = async (ctx) => {
    const c = await realMaterialize(ctx);
    season = 1; // the boundary passes inside the await the guard used to sit before
    return c;
  };
  const res = await sm.commit(0, CTX, "111", async () => {
    throw new Error("the durable append must never be reached for a season that has ended");
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "season-rolled-retry");
  assert.deepEqual(await store.forSeasonContext(0, CTX), [], "nothing durable was written");
});

// THE DURABLE WRITER'S RESULT DECIDES WHETHER THE TREE IS TOUCHED. Everything after the refusal
// branches mutates the tree, so an unrecognised result shape must not fall through into the append.
// That is how a tree gains a member with no durable record behind it, which no rebuild reproduces
// and nothing can revoke. Found while wiring an anchor recheck whose refusal shape the commit did
// not know: the refusal would have skipped the durable write and appended to the tree anyway.
test("a durable writer refusing on a stale anchor appends nothing to the tree", async () => {
  const store = newStore();
  const sm = newSeason(store);
  await sm.ensure(0);
  const res = await sm.commit(0, CTX, "111", async () => ({ staleRoot: true }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale-or-unknown-root");
  assert.equal(sm.size(CTX), 0, "the tree is untouched");
});

test("an unrecognised durable result fails closed rather than appending", async () => {
  const store = newStore();
  const sm = newSeason(store);
  await sm.ensure(0);
  const res = await sm.commit(0, CTX, "111", async () => ({ somethingNobodyAnticipated: true }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "durable-write-unrecognised");
  assert.equal(sm.size(CTX), 0, "no member without a durable record behind it");
});

test("SeasonMembers builds Poseidon once and reuses it for every tree it materializes", async () => {
  // The injectable parameter existed and production never passed it, so every first materialization
  // paid buildPoseidon again: twenty trees measured 4.8 seconds with fresh instances against 40
  // milliseconds with one shared, 120x. A comment claimed the seam let callers stop paying that
  // cost, which was a benefit nothing collected. Counted rather than timed, because a timing
  // assertion on a shared runner flakes.
  const store = newStore();
  const sm = newSeason(store);
  await sm.ensure(0);

  const contexts = ["11", "22", "33"];
  for (const c of contexts) {
    await sm.commit(0, c, "111", async () => ({ duplicate: false, index: 0 }));
  }
  for (const c of contexts) {
    assert.ok(sm.root(c), `context ${c} materialized`);
  }
  // One instance, shared by every context's tree. Identity is the assertion: a per-tree build would
  // give each its own.
  const trees = contexts.map((c) => sm.ctx.get(c).tree);
  assert.equal(trees.length, 3);
  assert.equal(trees[0].poseidon, trees[1].poseidon, "two contexts share one Poseidon");
  assert.equal(trees[1].poseidon, trees[2].poseidon, "and so does the third");
});

test("a commit refuses when the clock has gone backward, even inside the same season", async () => {
  // A backward step that crosses an EPOCH boundary but not a season boundary left every check here
  // satisfied: the season still matched, so the record was written under a numbering the gateway had
  // already stopped trusting. The membership path checked both periods and registration did not.
  // This is the fourth site where reading one clock fact instead of all of them produced a defect.
  const store = newStore();
  let regressed = false;
  const sm = new SeasonMembers({
    store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT,
    seasonNow: () => 0,             // the season is unchanged, which is the point
    clockRegressed: () => regressed,
  });
  await sm.ensure(0);

  regressed = true;
  const res = await sm.commit(0, CTX, "111", async () => {
    throw new Error("the durable append must never run under an untrusted clock");
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "clock-regressed");
  assert.deepEqual(await store.forSeasonContext(0, CTX), [], "nothing durable was written");
});

test("an untouched clock still commits, so the guard has an exit", async () => {
  const store = newStore();
  const sm = new SeasonMembers({
    store, rootWindow: 8, nowSec: () => 0, emptyRoot: EMPTY_ROOT,
    seasonNow: () => 0, clockRegressed: () => false,
  });
  await sm.ensure(0);
  const res = await sm.commit(0, CTX, "111", async () => ({ duplicate: false, index: 0 }));
  assert.equal(res.ok, true, "ordinary correct operation is unaffected");
});
