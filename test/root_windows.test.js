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
