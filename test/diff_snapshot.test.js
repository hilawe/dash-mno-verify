import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDiffSnapshot } from "../oracle/diff_snapshot.js";
import { hash160ToAddress, votingAddressToLeaf } from "../common/dml.js";

// Real base58check addresses, built the same way the existing oracle test builds them, because
// votingAddressToLeaf validates the checksum and a made-up string fails at the boundary rather than
// exercising anything.
const addr = (byte) => hash160ToAddress(Buffer.alloc(20, byte));

// A block-bound read gated on ChainLock. Every test drives the real builder through an injected call,
// so the guards below are exercised rather than described.

const LOCK = { blockhash: "aa".repeat(32), height: 2_100_000, known_block: true };

// Two valid nodes and one PoSe-banned, deliberately supplied out of proRegTxHash order so the sort is
// doing work rather than agreeing with the input by accident.
const ENTRY = (hash, votingAddress, isValid = true) => ({
  proRegTxHash: hash,
  confirmedHash: "cc".repeat(32),
  service: "1.2.3.4:9999",
  pubKeyOperator: "dd".repeat(48),
  votingAddress,
  isValid,
});
const V1 = addr(1);
const V2 = addr(2);
const V3 = addr(3);

function callerFor({ lock = LOCK, diff } = {}) {
  const seen = [];
  const call = async (method, params) => {
    seen.push([method, ...(params ?? [])]);
    if (method === "getbestchainlock") return lock;
    if (method === "protx") return diff;
    throw new Error(`unexpected call ${method}`);
  };
  return { call, seen };
}

const goodDiff = (blockHash = LOCK.blockhash) => ({
  blockHash,
  cbTx: "00",
  cbTxMerkleTree: "00",
  mnList: [
    ENTRY("ff".repeat(32), V2),
    ENTRY("11".repeat(32), V1),
    ENTRY("77".repeat(32), V3, false), // PoSe-banned: in the list, isValid false
  ],
});

test("the read is pinned to the ChainLocked block, chosen before the list is asked for", async () => {
  const { call, seen } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call });

  assert.equal(seen[0][0], "getbestchainlock", "the lock is read FIRST, so the node cannot pick a block to suit the answer");
  assert.deepEqual(seen[1], ["protx", "diff", 1, LOCK.height]);
  assert.equal(snap.height, LOCK.height);
  assert.equal(snap.blockHash, LOCK.blockhash);
  assert.equal(snap.chainlocked, true);
});

test("a diff describing a different block is refused, which is what closes the A to B to A residual", async () => {
  // The old read could not detect this at all: masternodelist says nothing about which block it
  // describes, so a reorg away and back inside one read window looked identical to no reorg.
  const { call } = callerFor({ diff: goodDiff("bb".repeat(32)) });
  await assert.rejects(
    () => buildDiffSnapshot({ call }),
    /described block bbbb.*ChainLock names aaaa/s,
  );
});

test("a node that reports a ChainLock for a block it does not have is refused", async () => {
  const { call } = callerFor({ lock: { ...LOCK, known_block: false }, diff: goodDiff() });
  await assert.rejects(() => buildDiffSnapshot({ call }), /still syncing/);
});

test("no ChainLock means no snapshot, because there is no degraded mode here", async () => {
  const { call } = callerFor({ lock: {}, diff: goodDiff() });
  await assert.rejects(() => buildDiffSnapshot({ call }), /did not return a block hash and height/);
});

test("isValid is the validity filter, so a PoSe-banned node is in the list and out of the tree", async () => {
  const { call } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call });
  assert.equal(snap.leaves.length, 2, "three entries, one banned");
});

test("leaves are ordered by proRegTxHash, which is DIP4's own canonical order", async () => {
  const { call } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call });

  // Recompute independently: sort the valid entries by hash and map to leaves in that order.
  const expected = [
    votingAddressToLeaf(V1).toString(), // 11...
    votingAddressToLeaf(V2).toString(), // ff...
  ];
  assert.deepEqual(snap.leaves, expected, "supplied out of order, published in canonical order");
  assert.equal(snap.order, "proRegTxHash", "and the snapshot says which rule it used");
});

test("an entry missing a field this build needs fails loudly instead of dropping a member", async () => {
  const broken = goodDiff();
  delete broken.mnList[0].votingAddress;
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /missing votingAddress/);
});

test("a diff with no mnList is refused rather than published as an empty tree", async () => {
  const { call } = callerFor({ diff: { blockHash: LOCK.blockhash } });
  await assert.rejects(() => buildDiffSnapshot({ call }), /no mnList array/);
});

test("the snapshot is version 3, because the leaf ORDER changed and roots are not interchangeable", async () => {
  const { call } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call });
  assert.equal(snap.version, 3);
  assert.ok(typeof snap.root === "string" && snap.root.length > 0);
  assert.ok(typeof snap.shaRoot === "string" && snap.shaRoot.length === 64);
});
