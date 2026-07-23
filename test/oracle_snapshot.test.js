// Pins the oracle snapshot assembly (oracle/snapshot.js) without a Dash node, via the
// injectable call(). The load-bearing cases are the tip-consistency guard: a block landing
// mid-read, or a same-height branch swap mid-read, must drive a retry, so the signed block
// hash and the list it anchors always share a tip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildSnapshot } from "../oracle/snapshot.js";
import { hash160ToAddress, votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { addSignature } from "../common/oracle_sig.js";

const addr = (byte) => hash160ToAddress(Buffer.alloc(20, byte));

const LIST = {
  "bbbb-1": { status: "ENABLED", votingaddress: addr(2) },
  "aaaa-0": { status: "ENABLED", votingaddress: addr(1) },
  "cccc-0": { status: "POSE_BANNED", votingaddress: addr(3) },
};

// A scripted chain source. `heights` yields one entry per getblockcount call and `lists` one
// per masternodelist call (the last of each repeats), so a test controls exactly when the tip
// advances and which list each attempt sees. `hashes` optionally yields one entry per
// getblockhash call, so a same-height branch swap is scriptable; the default derives the hash
// from the height, one branch per height. Every call is recorded for assertions.
function scriptedCall(heights, lists = [LIST], hashes = null) {
  const calls = [];
  let i = 0;
  let li = 0;
  let hi = 0;
  return {
    calls,
    call: async (method, params) => {
      calls.push([method, ...params]);
      if (method === "getblockcount") return heights[Math.min(i++, heights.length - 1)];
      if (method === "getblockhash") {
        if (hashes) return hashes[Math.min(hi++, hashes.length - 1)];
        return `hash-${params[0]}`;
      }
      if (method === "masternodelist") return lists[Math.min(li++, lists.length - 1)];
      throw new Error(`unexpected method ${method}`);
    },
  };
}

// The golden constants for LIST's two ENABLED leaves, pinned so a serialization or hashing
// drift fails loudly (the root is the depth-16 Poseidon root over [LEAF_1, LEAF_2]).
const LEAF_1 = "5731378969925109483151705226338364782964441345";
const LEAF_2 = "11462757939850218966303410452676729565928882690";
const ROOT_1_2 = "6333782983308199132950349382112172379696390098936227780111242572586524375316";

test("a stable tip builds the snapshot in one attempt", async () => {
  const { calls, call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });

  assert.equal(snap.height, 100);
  assert.equal(snap.blockHash, "hash-100");
  assert.equal(snap.ts, 1234);
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 1);
});

test("golden snapshot, exact field set, order, and serialization", async () => {
  const { call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });

  assert.deepEqual(Object.keys(snap), ["height", "blockHash", "depth", "ts", "root", "leaves"]);
  assert.equal(
    JSON.stringify(snap),
    `{"height":100,"blockHash":"hash-100","depth":16,"ts":1234,` +
      `"root":"${ROOT_1_2}","leaves":["${LEAF_1}","${LEAF_2}"]}`
  );
});

test("a block landing mid-read drives a retry, and the retried snapshot is consistent", async () => {
  // Attempt 1 brackets 100 -> 101 (a block landed during the read), attempt 2 is stable at 101.
  // Each attempt sees a different list, so the test pins that the snapshot keeps the second
  // bracket's list, not just its height and hash.
  const staleList = { "zzzz-0": { status: "ENABLED", votingaddress: addr(9) } };
  const { calls, call } = scriptedCall([100, 101, 101, 101], [staleList, LIST]);
  const retries = [];
  const snap = await buildSnapshot({ call, now: () => 1234, retryDelayMs: 0, log: (m) => retries.push(m) });

  // The list was re-read, and the published height, block hash, AND leaves all come from the
  // second, consistent bracket, never the first.
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 2);
  assert.equal(snap.height, 101);
  assert.equal(snap.blockHash, "hash-101");
  assert.deepEqual(snap.leaves, [LEAF_1, LEAF_2]);
  assert.equal(retries.length, 1);
  assert.match(retries[0], /100 -> 101/);
});

test("a same-height branch swap mid-read drives a retry, so hash and list share a branch", async () => {
  // The height holds at 100 the whole time, but the tip hash the read started from (branch A)
  // is gone by the end of attempt 1 (branch B), so height equality alone would publish branch
  // A's signed hash over branch B's list. Attempt 2 sees a stable branch B.
  const staleList = { "zzzz-0": { status: "ENABLED", votingaddress: addr(9) } };
  const { calls, call } = scriptedCall(
    [100, 100, 100, 100],
    [staleList, LIST],
    ["hash-A", "hash-B", "hash-B", "hash-B"]
  );
  const retries = [];
  const snap = await buildSnapshot({ call, now: () => 1234, retryDelayMs: 0, log: (m) => retries.push(m) });

  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 2);
  assert.equal(snap.height, 100);
  assert.equal(snap.blockHash, "hash-B");
  assert.deepEqual(snap.leaves, [LEAF_1, LEAF_2]);
  assert.equal(retries.length, 1);
});

test("a tip that keeps moving fails after maxAttempts instead of publishing a torn snapshot", async () => {
  // Every bracket sees the height move: 100->101, 102->103, 104->105.
  const { calls, call } = scriptedCall([100, 101, 102, 103, 104, 105]);
  await assert.rejects(
    buildSnapshot({ call, maxAttempts: 3, retryDelayMs: 0, log: () => {} }),
    /chain tip kept moving/
  );
  assert.equal(calls.filter(([m]) => m === "masternodelist").length, 3);
});

test("the retry path waits via the injected sleep, so a syncing node is not hammered", async () => {
  const { call } = scriptedCall([100, 101, 101, 101]);
  const waits = [];
  await buildSnapshot({ call, now: () => 1234, log: () => {}, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [1000]);
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

test("a voting address that decodes to the empty-leaf value is refused, not published", async () => {
  const zeroList = { "aaaa-0": { status: "ENABLED", votingaddress: hash160ToAddress(Buffer.alloc(20, 0)) } };
  const { call } = scriptedCall([100, 100], [zeroList]);
  await assert.rejects(buildSnapshot({ call, now: () => 1234 }), /empty-leaf value/);
});

test("signing appends sigs to the snapshot without changing the unsigned fields", async () => {
  const { call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });
  const unsigned = JSON.stringify(snap);

  // The CLI's signing step: compute the signature over the unsigned fields, then attach it.
  const { privateKey } = generateKeyPairSync("ed25519");
  snap.sigs = addSignature(snap, privateKey);

  const signed = JSON.parse(JSON.stringify(snap));
  assert.equal(signed.sigs.length, 1);
  assert.ok(signed.sigs[0].key);
  assert.ok(signed.sigs[0].sig);
  delete signed.sigs;
  assert.equal(JSON.stringify(signed), unsigned);
});
