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

// The keys are real "txid-index" collateral outpoints, 64 lowercase hex and an index, because that
// is what masternodelist json emits and the builder now refuses anything else. They were "bbbb-1"
// and friends, a shape Core cannot produce, so the suite was proving the builder against input the
// system never sees. The relative order (a < b < c) is preserved deliberately, so the leaf order and
// every golden constant below are unchanged by the fixture correction.
const OUT_A = `${"aa".repeat(32)}-0`;
const OUT_B = `${"bb".repeat(32)}-1`;
const OUT_C = `${"cc".repeat(32)}-0`;
const LIST = {
  [OUT_B]: { status: "ENABLED", votingaddress: addr(2) },
  [OUT_A]: { status: "ENABLED", votingaddress: addr(1) },
  [OUT_C]: { status: "POSE_BANNED", votingaddress: addr(3) },
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

const SHA_ROOT_1_2 = "753074d0b441c621d485b92aaf2d6d07dffa068ff801096d5d02201d083a753a";

test("golden snapshot, exact field set, order, and serialization (v2 dual-root)", async () => {
  const { call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });

  assert.deepEqual(Object.keys(snap), [
    "version", "height", "blockHash", "depth", "ts", "root", "shaRoot", "leaves",
  ]);
  assert.equal(
    JSON.stringify(snap),
    `{"version":2,"height":100,"blockHash":"hash-100","depth":16,"ts":1234,` +
      `"root":"${ROOT_1_2}","shaRoot":"${SHA_ROOT_1_2}","leaves":["${LEAF_1}","${LEAF_2}"]}`
  );
});

test("the shaRoot is self-consistent with the published leaves", async () => {
  const { call } = scriptedCall([100, 100]);
  const snap = await buildSnapshot({ call, now: () => 1234 });
  const { shaRootFromLeaves } = await import("../common/dml_sha_root.js");
  assert.equal(snap.shaRoot, shaRootFromLeaves(snap.leaves, snap.depth));
  assert.equal(snap.version, 2);
});

test("a block landing mid-read drives a retry, and the retried snapshot is consistent", async () => {
  // Attempt 1 brackets 100 -> 101 (a block landed during the read), attempt 2 is stable at 101.
  // Each attempt sees a different list, so the test pins that the snapshot keeps the second
  // bracket's list, not just its height and hash.
  const staleList = { [`${"ee".repeat(32)}-0`]: { status: "ENABLED", votingaddress: addr(9) } };
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
  const staleList = { [`${"ee".repeat(32)}-0`]: { status: "ENABLED", votingaddress: addr(9) } };
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

  // The POSE_BANNED outpoint is excluded, and OUT_A sorts before OUT_B by key.
  assert.deepEqual(snap.leaves, [
    votingAddressToLeaf(addr(1)).toString(),
    votingAddressToLeaf(addr(2)).toString(),
  ]);
  const rootFromLeaves = await makeDmlRootHasher(snap.depth);
  assert.equal(snap.root, rootFromLeaves(snap.leaves));
});

test("a voting address that decodes to the empty-leaf value is refused, not published", async () => {
  const zeroList = { [OUT_A]: { status: "ENABLED", votingaddress: hash160ToAddress(Buffer.alloc(20, 0)) } };
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

// THE RESPONSE IS VALIDATED BEFORE IT IS FILTERED. This is the live twin of the block-bound read's
// boundary, and it is the one actually wired in. Filtering first let every malformed shape leave
// quietly, publishing a signed, self-consistent snapshot over a SHORTENED member set that no
// downstream recompute can notice.
test("an array response is refused, not ordered by numeric index", async () => {
  const { call } = scriptedCall([100, 100], [[{ status: "ENABLED", votingaddress: addr(1) }]]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /returned an array/);
});

test("a null response is refused rather than read as an empty list", async () => {
  const { call } = scriptedCall([100, 100], [null]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /not an object keyed by collateral outpoint/);
});

test("a malformed collateral key is refused, since the canonical order sorts by it", async () => {
  const { call } = scriptedCall([100, 100], [{ "not-an-outpoint": { status: "ENABLED", votingaddress: addr(1) } }]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /is not a txid-index outpoint/);
});

test("a primitive or null entry is refused by name", async () => {
  const { call } = scriptedCall([100, 100], [{ [OUT_A]: 42 }]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /is 42, not an object/);
  const { call: c2 } = scriptedCall([100, 100], [{ [OUT_A]: null }]);
  await assert.rejects(buildSnapshot({ call: c2, now: () => 1 }), /is null, not an object/);
});

test("a missing or mistyped status is refused rather than read as banned", async () => {
  // This is the quiet one. Reading absence as not-ENABLED DROPS a valid masternode from the tree,
  // and the published root is the root of exactly the set that was built, so nothing downstream
  // can tell that a member is missing.
  const { call } = scriptedCall([100, 100], [{ [OUT_A]: { votingaddress: addr(1) } }]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /has status undefined, which this build does not know/);
  const { call: c2 } = scriptedCall([100, 100], [{ [OUT_A]: { status: 1, votingaddress: addr(1) } }]);
  await assert.rejects(buildSnapshot({ call: c2, now: () => 1 }), /has status 1, which this build does not know/);
});

test("an ENABLED entry with a non-string voting address is refused, a banned one need not carry one", async () => {
  const { call } = scriptedCall([100, 100], [{ [OUT_A]: { status: "ENABLED", votingaddress: null } }]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /ENABLED with a non-string votingaddress/);
  // A banned entry carrying no address at all is a perfectly well-formed response.
  const { call: c2 } = scriptedCall([100, 100], [{ [OUT_A]: { status: "ENABLED", votingaddress: addr(1) }, [OUT_C]: { status: "POSE_BANNED" } }]);
  const snap = await buildSnapshot({ call: c2, now: () => 1 });
  assert.equal(snap.leaves.length, 1, "the banned entry is excluded without being refused");
});

test("an unknown status string is refused, not filtered out as if it were banned", async () => {
  // The subtler half of the same defect. A shape check that accepts any non-empty string lets a
  // typo or a status a future Core adds through, and the filter below then drops that node exactly
  // as if it were PoSe-banned, shortening the signed member set with nothing to notice it.
  const { call } = scriptedCall([100, 100], [{ [OUT_A]: { status: "ENABLEDD", votingaddress: addr(1) } }]);
  await assert.rejects(buildSnapshot({ call, now: () => 1 }), /"ENABLEDD", which this build does not know/);
});
