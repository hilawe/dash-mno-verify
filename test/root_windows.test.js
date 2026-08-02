// The Poseidon and SHA-256 DML root views must be structurally in lockstep (docs/ZKVM_INTEGRATION.md
// step 5): a zkVM root check must never see a snapshot the Poseidon check does not, or outlive it.
// RootWindows holds both roots per snapshot in one ring buffer, so eviction and aging drop a
// snapshot's two roots together. These pin that, including the v2-then-v1 case that split two
// independent windows (the full-review blocker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RootWindows } from "../core/stores.js";

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
