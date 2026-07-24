// The Poseidon and SHA-256 DML root windows must stay in lockstep (docs/ZKVM_INTEGRATION.md step 5),
// so a zkVM registration root check sees exactly the snapshots the Poseidon check does. These pin the
// updateRootWindows helper the gateway uses: a v2 snapshot populates both windows, a v1 snapshot only
// the Poseidon one, and the two age by the same cutoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RootStore, updateRootWindows } from "../core/stores.js";

test("a v2 snapshot populates both windows in lockstep", () => {
  const dml = new RootStore(8);
  const sha = new RootStore(8);
  updateRootWindows(dml, sha, { height: 10, root: "P10", shaRoot: "S10", ts: 100 });
  updateRootWindows(dml, sha, { height: 11, root: "P11", shaRoot: "S11", ts: 110 });

  assert.equal(dml.isRecent("P10"), true);
  assert.equal(dml.isRecent("P11"), true);
  assert.equal(sha.isRecent("S10"), true);
  assert.equal(sha.isRecent("S11"), true);
  // current() tracks the latest on both
  assert.equal(dml.current().root, "P11");
  assert.equal(sha.current().root, "S11");
  // an unknown root is not recent in either
  assert.equal(sha.isRecent("S99"), false);
});

test("a v1 snapshot (no shaRoot) updates only the Poseidon window", () => {
  const dml = new RootStore(8);
  const sha = new RootStore(8);
  updateRootWindows(dml, sha, { height: 5, root: "P5", shaRoot: null, ts: 50 });
  assert.equal(dml.isRecent("P5"), true);
  assert.equal(sha.current(), null, "the SHA-256 window stays empty for a v1 snapshot");
});

test("both windows age by the same cutoff, so the SHA-256 window never outlives the Poseidon one", () => {
  const dml = new RootStore(8);
  const sha = new RootStore(8);
  updateRootWindows(dml, sha, { height: 1, root: "Pold", shaRoot: "Sold", ts: 100 });
  updateRootWindows(dml, sha, { height: 2, root: "Pnew", shaRoot: "Snew", ts: 200 });

  const cutoff = 150; // drops ts=100, keeps ts=200
  dml.dropOlderThan(cutoff);
  sha.dropOlderThan(cutoff);

  assert.equal(dml.isRecent("Pold"), false);
  assert.equal(sha.isRecent("Sold"), false, "the aged SHA-256 root is dropped in lockstep");
  assert.equal(dml.isRecent("Pnew"), true);
  assert.equal(sha.isRecent("Snew"), true);
});

test("the windows respect the ring-buffer bound in step", () => {
  const dml = new RootStore(2);
  const sha = new RootStore(2);
  for (let h = 1; h <= 4; h++) {
    updateRootWindows(dml, sha, { height: h, root: `P${h}`, shaRoot: `S${h}`, ts: h });
  }
  // only the last 2 heights survive in both
  assert.equal(dml.isRecent("P2"), false);
  assert.equal(sha.isRecent("S2"), false);
  assert.equal(dml.isRecent("P3"), true);
  assert.equal(sha.isRecent("S3"), true);
  assert.equal(dml.isRecent("P4"), true);
  assert.equal(sha.isRecent("S4"), true);
});
