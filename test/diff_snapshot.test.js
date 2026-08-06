import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDiffSnapshot } from "../oracle/diff_snapshot.js";
import { hash160ToAddress, votingAddressToLeaf } from "../common/dml.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { smlMerkleRoot } from "../oracle/dml_commitment.js";
import { blockHashFromHeader } from "../common/x11/index.js";
import { meetsProofOfWork } from "../oracle/proof_of_work.js";
import { fileURLToPath } from "node:url";

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
  // verifyCommitment is off HERE ONLY, and for a reason worth stating rather than for convenience.
  // These cases drive synthetic lists to exercise the ordering, filtering, and versioning boundaries,
  // and a synthetic list has no real coinbase committing to it. The commitment check has its own
  // tests against captured mainnet blocks in test/dml_commitment.test.js, and the read path that
  // wires it is covered below.
  const snap = await buildDiffSnapshot({ call, verifyCommitment: false });

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

// The RPC boundary refuses missing and mistyped security fields rather than reading absence as
// affirmation. The old checks tested only the shapes a lying-by-omission response never takes:
// known_block was compared `=== false`, so a response without the field passed as if it had
// affirmed it, and the block-bound comparison String()-coerced, so a singleton array containing the
// right hash compared equal.
test("a ChainLock response with no known_block field is refused, absence is not affirmation", async () => {
  const { blockhash, height } = LOCK;
  const { call } = callerFor({ lock: { blockhash, height }, diff: goodDiff() });
  await assert.rejects(() => buildDiffSnapshot({ call }), /known_block undefined/);
});

test("a mistyped known_block is refused, only boolean true is the statement", async () => {
  const { call } = callerFor({ lock: { ...LOCK, known_block: "true" }, diff: goodDiff() });
  await assert.rejects(() => buildDiffSnapshot({ call }), /known_block "true"/);
});

test("a malformed ChainLock block hash is refused before anything is read against it", async () => {
  const { call } = callerFor({ lock: { ...LOCK, blockhash: "zz".repeat(32) }, diff: goodDiff("zz".repeat(32)) });
  await assert.rejects(() => buildDiffSnapshot({ call }), /malformed block hash/);
});

test("a non-string diff blockHash is refused, so an array cannot coerce into a match", async () => {
  // String(["aa...aa"]) is "aa...aa", so the old comparison passed the one check this read exists
  // to make on a response whose shape was wrong.
  const wrapped = goodDiff();
  wrapped.blockHash = [LOCK.blockhash];
  const { call } = callerFor({ diff: wrapped });
  await assert.rejects(() => buildDiffSnapshot({ call }), /not a string/);
});

test("a mistyped isValid is refused rather than silently dropping the member", async () => {
  // "true" the string fails a strict === true filter, so coercion here would not admit a banned
  // node, it would silently DROP a valid one, which is the quieter and worse failure.
  const broken = goodDiff();
  broken.mnList[1].isValid = "true";
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /isValid "true", not a boolean/);
});

test("a malformed proRegTxHash is refused, the canonical order sorts by it", async () => {
  const broken = goodDiff();
  broken.mnList[0].proRegTxHash = 42;
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /malformed proRegTxHash/);
});

test("a non-string votingAddress is refused at the boundary, naming the entry", async () => {
  const broken = goodDiff();
  broken.mnList[1].votingAddress = { addr: V1 };
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /non-string votingAddress/);
});

test("a duplicate proRegTxHash is refused, one masternode twice has no canonical order", async () => {
  const broken = goodDiff();
  broken.mnList.push({ ...broken.mnList[0] });
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /twice/);
});

test("a duplicate is refused even when one copy is invalid, the claim is about the list", async () => {
  // A first version checked duplicates after the validity filter, so a pair sharing a hash with one
  // copy isValid false slipped through while the refusal message claimed any duplicate refuses.
  const broken = goodDiff();
  broken.mnList.push({ ...broken.mnList[0], isValid: false });
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /twice/);
});

test("a syncing node is diagnosed as syncing even when its lock hash is also malformed", async () => {
  // The specific diagnosis must win over the generic one. A first version checked the hash shape
  // before known_block, so a syncing node with a malformed hash was reported as a malformed hash
  // and the operator lost the actionable fact, that the node just needs to finish syncing.
  const { call } = callerFor({
    lock: { blockhash: "zz".repeat(32), height: LOCK.height, known_block: false },
    diff: goodDiff("zz".repeat(32)),
  });
  await assert.rejects(() => buildDiffSnapshot({ call }), /still syncing/);
});

test("no ChainLock means no snapshot, because there is no degraded mode here", async () => {
  const { call } = callerFor({ lock: {}, diff: goodDiff() });
  await assert.rejects(() => buildDiffSnapshot({ call }), /did not return a block hash and height/);
});

test("isValid is the validity filter, so a PoSe-banned node is in the list and out of the tree", async () => {
  const { call } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call, verifyCommitment: false });
  assert.equal(snap.leaves.length, 2, "three entries, one banned");
});

test("leaves are ordered by proRegTxHash, which is DIP4's own canonical order", async () => {
  const { call } = callerFor({ diff: goodDiff() });
  const snap = await buildDiffSnapshot({ call, verifyCommitment: false });

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
  const snap = await buildDiffSnapshot({ call, verifyCommitment: false });
  assert.equal(snap.version, 3);
  assert.ok(typeof snap.root === "string" && snap.root.length > 0);
  assert.ok(typeof snap.shaRoot === "string" && snap.shaRoot.length === 64);
});

test("a primitive list entry is refused by name, not by a raw TypeError from the field probe", async () => {
  const broken = goodDiff();
  broken.mnList.push(42);
  const { call } = callerFor({ diff: broken });
  await assert.rejects(() => buildDiffSnapshot({ call }), /is 42, not an object/);
});

// THE COMMITMENT CHECK, driven through the read path with a real mainnet block. The fixture is the
// whole `protx diff` response and block header for height 1,028,162, so the node these cases stand up
// answers exactly as a real one did. Its 14 entries are all nVersion 1 and nType 0; the version 2,
// evo, and IPv6 shapes are covered by their own vectors in test/dml_commitment.test.js.
const BLOCK = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/dml_commitment_mainnet_1028162.json", import.meta.url)), "utf8"),
);

function nodeServing(over = {}) {
  const b = { ...BLOCK, ...over };
  return async (method, params) => {
    if (method === "getbestchainlock") return { blockhash: b.blockHash, height: b.height, known_block: true };
    if (method === "protx") return { blockHash: b.blockHash, mnList: b.mnList, cbTx: b.cbTx, cbTxMerkleTree: b.cbTxMerkleTree };
    if (method === "getblockheader") return b.blockHeader;
    throw new Error(`unexpected call ${method} ${JSON.stringify(params)}`);
  };
}

test("a real block passes the commitment check through the read path, with the check ON by default", async () => {
  const snap = await buildDiffSnapshot({ call: nodeServing() });
  assert.equal(snap.version, 3);
  assert.equal(snap.height, BLOCK.height);
  // Every entry in this block is valid, so the leaf count is the entry count. That is a property of
  // the fixture rather than of the check, and it is asserted so a fixture swap cannot quietly change
  // what these cases are testing.
  assert.equal(BLOCK.mnList.filter((m) => m.isValid).length, BLOCK.mnList.length);
  assert.equal(snap.leaves.length, BLOCK.mnList.length);
});

test("a node that alters the list is refused, even though every other answer it gives is consistent", async () => {
  // The whole point. This node returns the real block hash, the real ChainLock, the real coinbase,
  // the real header and merkle branch, and a list with one entry's validity flipped. Every check that
  // existed before this one passes.
  const tampered = BLOCK.mnList.map((e, i) => (i === 5 ? { ...e, isValid: !e.isValid } : e));
  await assert.rejects(
    () => buildDiffSnapshot({ call: nodeServing({ mnList: tampered }) }),
    /does not match the coinbase commitment/,
  );

  // And an entry removed, which is how a node would hide a masternode from the membership set.
  await assert.rejects(
    () => buildDiffSnapshot({ call: nodeServing({ mnList: BLOCK.mnList.slice(1) }) }),
    /does not match the coinbase commitment/,
  );
});

// THE WHOLE-LIST PROPERTY IS TESTED ONE LEVEL DOWN, and this note records why it cannot be tested
// here. The commitment must be verified over the unfiltered list, because the coinbase commits to
// banned nodes too. Showing that requires a block whose full list matches the commitment while the
// filtered list does not, which means a block containing a banned node. On mainnet no such block is
// small: lists were entirely valid until they were already thousands of entries, so no committable
// fixture has one. The previous version of this test built a synthetic block to get there, and the
// header identity and proof of work checks now refuse a fabricated block, which is the checks working
// rather than a regression. The property lives in test/dml_commitment.test.js, where verifyDmlCommitment
// is called directly and a synthetic block is legitimate because that function reads only the header's
// merkle root and never names the block.


test("the commitment rejects a list altered after the block committed to it", async () => {
  // The coinbase commits to every entry, valid or not. Verifying after the filter would compare a
  // different set than the chain committed to and would fail on any block containing a banned node,
  // which is most of them. This drives that case: a list where one entry is invalid, taken from a
  // real block, must still verify.
  const withInvalid = BLOCK.mnList.map((e, i) => (i === 2 ? { ...e, isValid: false } : e));
  // It no longer matches the real commitment, so this cannot use the real fixture root. What it CAN
  // establish is that the failure names the commitment rather than the filter, and that the valid
  // count and the verified count differ, which is the arrangement that would break a filter-first
  // implementation.
  await assert.rejects(() => buildDiffSnapshot({ call: nodeServing({ mnList: withInvalid }) }), /does not match the coinbase commitment/);
  assert.equal(withInvalid.filter((m) => m.isValid).length, BLOCK.mnList.length - 1, "the fixture really does contain an invalid entry now");
});

test("a coinbase from a different height is refused even when everything else agrees with it", async () => {
  // A node serving an older block's coinbase, header, list, and hash as a consistent trio passes the
  // three commitment checks, because they are consistent. The height the coinbase names is what
  // catches it, compared against the height the ChainLock named.
  const call = async (method, params) => {
    if (method === "getbestchainlock") return { blockhash: BLOCK.blockHash, height: BLOCK.height + 1, known_block: true };
    if (method === "protx") return { blockHash: BLOCK.blockHash, mnList: BLOCK.mnList, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree };
    if (method === "getblockheader") return BLOCK.blockHeader;
    throw new Error(`unexpected call ${method}`);
  };
  await assert.rejects(() => buildDiffSnapshot({ call }), /coinbase commits to height 1028162 but the ChainLock names 1028163/);
});

test("a node that cannot produce a header is refused rather than skipping the check", async () => {
  for (const header of [undefined, null, 42, "not-hex!!"]) {
    await assert.rejects(
      () => buildDiffSnapshot({ call: nodeServing({ blockHeader: header }) }),
      /the commitment cannot be checked without the header/,
      `header ${JSON.stringify(header)}`,
    );
  }
});

test("the header is fetched for the CHAINLOCKED hash, not for whatever the diff named", async () => {
  // The read already refuses a diff describing another block, so the two hashes agree by the time the
  // header is fetched. Asking by the ChainLocked hash keeps that true if the earlier check is ever
  // reordered, and this records which one is asked for.
  const asked = [];
  const call = async (method, params) => {
    if (method === "getbestchainlock") return { blockhash: BLOCK.blockHash, height: BLOCK.height, known_block: true };
    if (method === "protx") return { blockHash: BLOCK.blockHash, mnList: BLOCK.mnList, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree };
    if (method === "getblockheader") {
      asked.push(params);
      return BLOCK.blockHeader;
    }
    throw new Error(`unexpected call ${method}`);
  };
  await buildDiffSnapshot({ call });
  assert.deepEqual(asked, [[BLOCK.blockHash, false]], "asked for the ChainLocked block's header, in raw form");
});

test("the header must BE the ChainLocked block, not merely agree with the list and coinbase", async () => {
  // THE CHECK THAT CHANGES THE TRUST MODEL. Everything else establishes that the list, the coinbase,
  // and the header agree with one another, and agreeing is cheap: a node can build all three to
  // agree in the time it takes to hash them. Naming the block is not cheap, because it means
  // producing a header whose X11 hash is a particular value.
  //
  // The fixture block is real, so the honest node passes. The dishonest one here serves a header
  // that is internally fine and simply is not the block it was asked for.
  const other = JSON.parse(
    readFileSync(fileURLToPath(new URL("./vectors/x11_round_vectors.json", import.meta.url)), "utf8"),
  ).blockHashes.cases.find((c) => c.height !== BLOCK.height);
  await assert.rejects(
    () => buildDiffSnapshot({ call: nodeServing({ blockHeader: other.header }) }),
    /hashes to .*\. A block is named by/,
    "a real header for a different block is refused",
  );

  // And the honest case still passes, so the check has an exit.
  const snap = await buildDiffSnapshot({ call: nodeServing() });
  assert.equal(snap.height, BLOCK.height);
});

test("a header that was never mined is refused, so inventing one is not free", async () => {
  // Naming the block only says the header is self-consistent with the hash claimed for it. A node is
  // free to invent a header and claim its hash, so proof of work is what puts a price on it.
  //
  // Built by taking the real header and moving its nonce, which destroys the work while leaving every
  // other field exactly as the chain has it. The node then reports the hash of that header as the
  // ChainLocked one, so the identity check above passes and this one is what refuses.
  const forged = Buffer.from(BLOCK.blockHeader, "hex");
  forged.writeUInt32LE(0x0badf00d, 76);
  const forgedHex = forged.toString("hex");
  const forgedHash = blockHashFromHeader(forgedHex);
  assert.notEqual(forgedHash, BLOCK.blockHash, "moving the nonce really does change the block's name");

  const call = async (method) => {
    if (method === "getbestchainlock") return { blockhash: forgedHash, height: BLOCK.height, known_block: true };
    if (method === "protx") return { blockHash: forgedHash, mnList: BLOCK.mnList, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree };
    if (method === "getblockheader") return forgedHex;
    throw new Error(`unexpected call ${method}`);
  };
  await assert.rejects(() => buildDiffSnapshot({ call }), /does not meet the proof of work/);
});

test("every real header in the fixture set meets its own proof of work", () => {
  // The refusal above is only worth having if it never fires on a real block. These span the chain
  // from genesis to the current tip, across every difficulty era Dash has had.
  const cases = JSON.parse(
    readFileSync(fileURLToPath(new URL("./vectors/x11_round_vectors.json", import.meta.url)), "utf8"),
  ).blockHashes.cases;
  for (const c of cases) {
    assert.equal(meetsProofOfWork(c.header), true, `height ${c.height}`);
  }
});
