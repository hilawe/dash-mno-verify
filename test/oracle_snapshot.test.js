// Pins the oracle snapshot assembly (oracle/snapshot.js) without a Dash node, via the
// injectable call(). The load-bearing case is the height/list race guard: a block landing
// between the height read and the list read must drive a retry, so the signed block hash
// and the list it anchors always share a tip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../oracle/snapshot.js";
import { hash160ToAddress, votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../core/dml_root.js";

const addr = (byte) => hash160ToAddress(Buffer.alloc(20, byte));

const LIST = {
  "bbbb-1": { status: "ENABLED", votingaddress: addr(2) },
  "aaaa-0": { status: "ENABLED", votingaddress: addr(1) },
  "cccc-0": { status: "POSE_BANNED", votingaddress: addr(3) },
};

// A scripted chain source. `heights` yields one entry per getblockcount call, so a test
// controls exactly when the tip advances. `lists` yields one list per masternodelist call
// (the last repeats), so a test can hand each attempt a different list and pin which one
// the snapshot kept. Every call is recorded for assertions.
function scriptedCall(heights, lists = [LIST]) {
  const calls = [];
  let i = 0;
  let li = 0;
  return {
    calls,
    call: async (method, params) => {
      calls.push([method, ...params]);
      if (method === "getblockcount") return heights[Math.min(i++, heights.length - 1)];
      if (method === "getblockhash") return `hash-${params[0]}`;
      if (method === "masternodelist") return lists[Math.min(li++, lists.length - 1)];
      throw new Error(`unexpected method ${method}`);
    },
  };
}

test("a stable tip builds the snapshot in one attempt", async () => {
  const { calls, call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });

  assert.equal(snap.height, 100);
  assert.equal(snap.blockHash, "hash-100");
  assert.equal(snap.ts, 1234);
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 1);
});

test("a block landing mid-read drives a retry, and the retried snapshot is consistent", async () => {
  // Attempt 1 brackets 100 -> 101 (a block landed during the read), attempt 2 is stable at 101.
  // Each attempt sees a different list, so the test pins that the snapshot keeps the second
  // bracket's list, not just its height and hash.
  const staleList = { "zzzz-0": { status: "ENABLED", votingaddress: addr(9) } };
  const { calls, call } = scriptedCall([100, 101, 101, 101], [staleList, LIST]);
  const retries = [];
  const snap = await buildSnapshot({ call, now: () => 1234, log: (m) => retries.push(m) });

  // The list was re-read, and the published height, block hash, AND leaves all come from the
  // second, consistent bracket, never the first.
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 2);
  assert.equal(snap.height, 101);
  assert.equal(snap.blockHash, "hash-101");
  assert.deepEqual(snap.leaves, [
    votingAddressToLeaf(addr(1)).toString(),
    votingAddressToLeaf(addr(2)).toString(),
  ]);
  assert.equal(retries.length, 1);
  assert.match(retries[0], /100 -> 101/);
});

test("a tip that keeps advancing fails after maxAttempts instead of publishing a torn snapshot", async () => {
  // Every bracket sees the height move: 100->101, 102->103, 104->105.
  const { calls, call } = scriptedCall([100, 101, 102, 103, 104, 105]);
  await assert.rejects(
    buildSnapshot({ call, maxAttempts: 3, log: () => {} }),
    /height kept advancing/
  );
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 3);
});

test("only ENABLED nodes enter the tree, sorted by list key, and the root hashes from the leaves", async () => {
  const { call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });

  // POSE_BANNED cccc-0 is excluded, and aaaa-0 sorts before bbbb-1 by key.
  assert.deepEqual(snap.leaves, [
    votingAddressToLeaf(addr(1)).toString(),
    votingAddressToLeaf(addr(2)).toString(),
  ]);
  const rootFromLeaves = await makeDmlRootHasher(snap.depth);
  assert.equal(snap.root, rootFromLeaves(snap.leaves));
});
