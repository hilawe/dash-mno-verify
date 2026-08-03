// The Poseidon and SHA-256 DML root views must be structurally in lockstep (docs/ZKVM_INTEGRATION.md
// step 5): a zkVM root check must never see a snapshot the Poseidon check does not, or outlive it.
// RootWindows holds both roots per snapshot in one ring buffer, so eviction and aging drop a
// snapshot's two roots together. These pin that, including the v2-then-v1 case that split two
// independent windows (the full-review blocker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { leafSetCommitment, RootWindows } from "../core/stores.js";

test("a v2 snapshot is recent in both views; a v1 snapshot only in the Poseidon view", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 10, root: "P10", shaRoot: "S10", ts: 100 });
  w.adopt({ height: 11, root: "P11", shaRoot: null, ts: 110 }); // a v1 snapshot

  assert.equal(w.isRecent("P10"), true);
  assert.equal(w.isRecent("P11"), true);
  assert.equal(w.shaIsRecent("S10"), true);
  assert.equal(w.shaIsRecent("P11"), false, "the v1 Poseidon root is not a SHA-256 root");
  assert.equal(w.shaView().isRecent("S10"), true);
  assert.equal(w.current().root, "P11");
});

test("v2 then repeated v1 cannot leave a stale SHA-256 root past its Poseidon partner's eviction", () => {
  // Window size 2. A v2 at height 10, then two v1 snapshots. The single ring buffer evicts height 10
  // entirely (both its roots) once the window fills, so S10 is NOT recent even though independent
  // windows would have kept it. This is the blocker the paired record fixes.
  const w = new RootWindows(2);
  w.adopt({ height: 10, root: "P10", shaRoot: "S10", ts: 100 });
  w.adopt({ height: 11, root: "P11", shaRoot: null, ts: 110 });
  w.adopt({ height: 12, root: "P12", shaRoot: null, ts: 120 });

  assert.equal(w.isRecent("P10"), false, "height 10 evicted from the Poseidon view");
  assert.equal(w.shaIsRecent("S10"), false, "and its SHA-256 root evicted in lockstep, not lingering");
  assert.equal(w.isRecent("P11"), true);
  assert.equal(w.isRecent("P12"), true);
});

test("aging drops a snapshot's two roots together", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "Pold", shaRoot: "Sold", ts: 100 });
  w.adopt({ height: 2, root: "Pnew", shaRoot: "Snew", ts: 200 });
  w.dropOlderThan(150); // drops ts=100

  assert.equal(w.isRecent("Pold"), false);
  assert.equal(w.shaIsRecent("Sold"), false, "the aged SHA-256 root is dropped with its partner");
  assert.equal(w.isRecent("Pnew"), true);
  assert.equal(w.shaIsRecent("Snew"), true);
});

test("re-adopting a height replaces its record, both roots", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 5, root: "Pa", shaRoot: "Sa", ts: 50 });
  w.adopt({ height: 5, root: "Pb", shaRoot: "Sb", ts: 55 }); // same height, new roots
  assert.equal(w.isRecent("Pa"), false);
  assert.equal(w.shaIsRecent("Sa"), false);
  assert.equal(w.isRecent("Pb"), true);
  assert.equal(w.shaIsRecent("Sb"), true);
  assert.equal(w.current().ts, 55);
});

test("clear empties both views", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "P", shaRoot: "S", ts: 1 });
  w.clear();
  assert.equal(w.current(), null);
  assert.equal(w.isRecent("P"), false);
  assert.equal(w.shaIsRecent("S"), false);
});

// THE v2 TO v3 TRANSITION. The leaf order changed with the block-bound read, so the same set of
// masternodes produces two different roots. Keying the window on height alone meant the new snapshot
// replaced the old one at that height, and every prover still holding a v2 tree was locked out the
// moment the oracle switched.
test("both leaf orders are accepted at one height, so a changeover locks nobody out", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "poseidon-v2", shaRoot: "a".repeat(64), ts: 1000, order: null });
  w.adopt({ height: 100, root: "poseidon-v3", shaRoot: "b".repeat(64), ts: 1001, order: "proRegTxHash" });

  assert.equal(w.isRecent("poseidon-v2"), true, "a prover still holding the old tree can still prove");
  assert.equal(w.isRecent("poseidon-v3"), true, "and so can one that has rebuilt");
  assert.equal(w.shaIsRecent("a".repeat(64)), true);
  assert.equal(w.shaIsRecent("b".repeat(64)), true);
  assert.equal(w.current().root, "poseidon-v3", "the newest adoption is what the gateway publishes");
});

test("re-adopting the SAME order at a height still replaces, rather than accumulating", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "first", ts: 1000, order: "proRegTxHash" });
  w.adopt({ height: 100, root: "second", ts: 1001, order: "proRegTxHash" });
  assert.equal(w.isRecent("first"), false, "a corrected snapshot supersedes, it does not pile up");
  assert.equal(w.isRecent("second"), true);
});

test("the window counts heights, so running two orders does not halve the accepted history", () => {
  const w = new RootWindows(2);
  for (const h of [1, 2, 3]) {
    w.adopt({ height: h, root: `v2-${h}`, ts: h, order: null });
    w.adopt({ height: h, root: `v3-${h}`, ts: h, order: "proRegTxHash" });
  }
  // Two heights kept, both orders at each. Counting records instead would have kept one height.
  assert.equal(w.isRecent("v2-1"), false, "the oldest height is evicted");
  assert.equal(w.isRecent("v2-2"), true);
  assert.equal(w.isRecent("v3-2"), true);
  assert.equal(w.isRecent("v3-3"), true);
});

test("an aged-out v2 root stops being accepted with no switch to remember", () => {
  // The transition is bounded by the ordinary age rule, so nothing has to be turned off later.
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "old-order", ts: 1000, order: null });
  w.adopt({ height: 101, root: "new-order", ts: 2000, order: "proRegTxHash" });
  w.dropOlderThan(1500);
  assert.equal(w.isRecent("old-order"), false, "it ages out on its own once the oracle stops publishing it");
  assert.equal(w.isRecent("new-order"), true);
});

// COEXISTENCE IS CHECKED, NOT ASSUMED. The transition claim is that a v2 and a v3 root over the same
// masternodes commit to the same leaf set and differ only in build order. The window stored nothing
// that could verify that, so a member present only in a stale, orphaned, or inconsistent set could
// keep proving after the canonical root arrived.
test("two orders coexist only when block and leaf set both match", () => {
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111", "222"]);
  w.adopt({ height: 100, root: "v2", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });

  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET }),
    true,
    "same block, same set, different order: the legitimate pair",
  );
  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: "bb".repeat(32), setCommitment: SET }),
    false,
    "a different block at the same height is a fork, not an ordering change",
  );
  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: leafSetCommitment(["111", "999"]) }),
    false,
    "a different member set is the case this check exists for",
  );
  assert.equal(
    w.mayCoexist({ height: 100, order: null, blockHash: BLOCK, setCommitment: SET }),
    false,
    "the SAME order twice is a changed root, not a transition",
  );
});

test("an unanswerable question is answered no", () => {
  // A snapshot carrying no block hash or no commitment cannot be shown to describe the same set, and
  // the safe reading of "cannot tell" is "not allowed".
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  w.adopt({ height: 100, root: "v2", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: null, setCommitment: SET }), false);
  assert.equal(w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: null }), false);
});

test("a height with nothing in it accepts anything, since there is nothing to disagree with", () => {
  const w = new RootWindows(8);
  assert.equal(w.mayCoexist({ height: 7, order: "proRegTxHash", blockHash: null, setCommitment: null }), true);
});

test("the leaf set commitment ignores order and preserves duplicates", () => {
  // Order independence is the whole point. Duplicate preservation matters because two masternodes can
  // share a voting key, so collapsing them would let a set with a duplicate match one without it.
  assert.equal(leafSetCommitment(["3", "1", "2"]), leafSetCommitment(["1", "2", "3"]));
  assert.notEqual(leafSetCommitment(["1", "1", "2"]), leafSetCommitment(["1", "2"]));
  assert.notEqual(leafSetCommitment(["1", "2"]), leafSetCommitment(["1", "3"]));
  // Numeric, not lexical: "10" must not sort before "9" in a way that differs from another ordering
  // of the same members.
  assert.equal(leafSetCommitment(["10", "9"]), leafSetCommitment(["9", "10"]));
});

// THE WINDOW MUST STAY BOUNDED. Keying on height alone guaranteed at most one record per height, and
// adding the order to the key destroyed that guarantee without replacing it. A source that could
// choose the order string could therefore create unlimited records at one height. The replacement is
// that the key is DERIVED from the validated version, so the key space is the size of the version
// enumeration, and the bound is a property of that rather than a counter.
test("a height holds at most one record per known ordering, however many adoptions arrive", () => {
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  // Only two order keys can ever reach adopt, because the gateway derives them from the version.
  for (let i = 0; i < 500; i += 1) {
    w.adopt({ height: 100, root: `legacy-${i}`, ts: i, order: null, blockHash: BLOCK, setCommitment: SET });
    w.adopt({ height: 100, root: `v3-${i}`, ts: i, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET });
  }
  const atHeight = w.snaps.filter((s) => s.height === 100);
  assert.equal(atHeight.length, 2, "1000 adoptions, two orderings, two records");
});

test("the window never exceeds its configured size in heights", () => {
  const w = new RootWindows(3);
  for (let h = 1; h <= 20; h += 1) {
    w.adopt({ height: h, root: `r-${h}`, ts: h, order: null });
  }
  assert.equal(new Set(w.snaps.map((s) => s.height)).size, 3);
});

test("an unknown ordering is refused by the store itself, not just by its caller", () => {
  // Defence in depth, and the reason it matters: the gateway derives the key from the validated
  // version, so only known orderings can arrive today. That is a property of ONE caller. The store's
  // bound depends on the key space, so it enforces the key space itself rather than trusting whoever
  // calls it. With an attacker-chosen key this held a thousand records at one height.
  const w = new RootWindows(8);
  assert.throws(() => w.adopt({ height: 1, root: "r", ts: 1, order: "attacker-chosen" }), /unknown leaf ordering/);
  assert.equal(w.snaps.length, 0, "and nothing was stored on the way to refusing");
});

test("current() is the last ADOPTED record at the top height, including on re-adoption", () => {
  // The changeover flap, at the STORE contract level. Map.set on an existing key updates in place,
  // keeping its old position, and the height sort is stable, so before the fix a legacy record
  // re-adopted AFTER the v3 one stayed first in the array and current() reported v3, violating its
  // own docstring ("the LAST adopted wins"). No live gateway path is known to reach this today,
  // because the refresh path's mayCoexist refuses a same-order re-adoption at a held height, so
  // the divergence was latent. The store enforces its documented contract itself rather than
  // relying on that property of one caller, the same defence-in-depth stance as the unknown-order
  // throw below.
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  w.adopt({ height: 100, root: "legacy-root", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });
  w.adopt({ height: 100, root: "v3-root", ts: 2, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.current().root, "v3-root", "last adopted wins after the switch");
  w.adopt({ height: 100, root: "legacy-root", ts: 3, order: null, blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.current().root, "legacy-root", "and wins again when the legacy order is re-adopted");
  assert.equal(w.snaps.filter((s) => s.height === 100).length, 2, "still one record per ordering");
});
