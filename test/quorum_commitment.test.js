// Anchoring a signing quorum's public key to the chain via merkleRootQuorums.
//
// The vector is a real Dash regtest `protx diff` (base height 1), so newQuorums is the full active
// quorum set and cbTx is the block's coinbase. dashd v23.1.7 (post-v19, basic BLS scheme). It proves
// the CFinalCommitment serialization and the merkle reproduction against a value the chain enforced;
// the mainnet member-count parameters are validated separately against a live mainnet node.
//
// WHAT THIS DOES NOT ESTABLISH, so the suite is not misread: nothing here proves the coinbase belongs
// to the chain. That is dml_commitment.js (merkle branch to header) plus diff_snapshot.js (X11 and
// proof of work). This file proves only that the quorum set matches the coinbase's commitment, which
// is the link that makes a quorum public key the chain's rather than the node's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  verifyQuorumsCommitment,
  quorumsMerkleRoot,
  serializeCommitment,
  REGTEST_LLMQ_SIZES,
} from "../oracle/quorum_commitment.js";
import { cbTxCommitment } from "../oracle/dml_commitment.js";

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/quorum_commitment_regtest.json", import.meta.url)), "utf8"),
);

test("the quorum set reproduces the chain's merkleRootQuorums, anchoring every public key", () => {
  const keys = verifyQuorumsCommitment({
    newQuorums: vec.newQuorums,
    merkleRootQuorums: vec.merkleRootQuorums,
    sizes: REGTEST_LLMQ_SIZES,
  });
  // Every quorum key is returned, keyed by type and hash.
  assert.equal(keys.size, vec.newQuorums.length);
  for (const q of vec.newQuorums) {
    assert.equal(keys.get(`${q.llmqType}:${q.quorumHash}`), q.quorumPublicKey);
  }
});

test("the coinbase itself commits merkleRootQuorums, matching the diff", () => {
  const { merkleRootQuorums } = cbTxCommitment(vec.cbTx);
  assert.equal(merkleRootQuorums, vec.merkleRootQuorums);
});

test("a tampered quorum public key fails the commitment check (the anchor discriminates)", () => {
  const tampered = structuredClone(vec.newQuorums);
  const pk = Buffer.from(tampered[0].quorumPublicKey, "hex");
  pk[0] ^= 0x01;
  tampered[0].quorumPublicKey = pk.toString("hex");
  assert.throws(
    () =>
      verifyQuorumsCommitment({
        newQuorums: tampered,
        merkleRootQuorums: vec.merkleRootQuorums,
        sizes: REGTEST_LLMQ_SIZES,
      }),
    /does not match the coinbase commitment/,
  );
});

test("a missing member-count parameter refuses rather than guessing the bitset length", () => {
  assert.throws(
    () => quorumsMerkleRoot(vec.newQuorums, { 999: 3 }),
    /no member-count parameter for llmq type/,
  );
});

test("a legacy (pre-v19) commitment version is refused, not mis-serialized", () => {
  const legacy = { ...vec.newQuorums[0], version: 1 };
  assert.throws(() => serializeCommitment(legacy, 3), /unsupported quorum commitment version/);
});

test("a bitset whose packed length disagrees with the member count is refused", () => {
  // member count 3 packs to 1 byte; claiming 3 members against a 2-byte bitset must refuse.
  const bad = { ...vec.newQuorums[0], signers: "0700" };
  assert.throws(() => serializeCommitment(bad, 3), /must be exactly 1 bytes of hex/);
});

test("a malformed hex field is refused, not silently truncated (the returned keys are trusted)", () => {
  // Buffer.from(x,'hex') truncates at an invalid character, so an appended 'zz' would otherwise
  // serialize to the same 48 bytes and be returned as a trusted key. Strict validation must refuse it.
  for (const bad of ["zz", "a", "gg"]) {
    const q = structuredClone(vec.newQuorums);
    q[0].quorumPublicKey = vec.newQuorums[0].quorumPublicKey + bad;
    assert.throws(
      () => verifyQuorumsCommitment({ newQuorums: q, merkleRootQuorums: vec.merkleRootQuorums, sizes: REGTEST_LLMQ_SIZES }),
      /quorumPublicKey must be exactly 48 bytes/,
    );
  }
});

test("a duplicate (llmqType, quorumHash) in the set is refused", () => {
  const dup = [...vec.newQuorums, structuredClone(vec.newQuorums[0])];
  assert.throws(
    () => verifyQuorumsCommitment({ newQuorums: dup, merkleRootQuorums: vec.merkleRootQuorums, sizes: REGTEST_LLMQ_SIZES }),
    /duplicate quorum/,
  );
});

test("the version-4 (rotation) path serializes quorumIndex as a little-endian int16 after quorumHash", () => {
  // The regtest vector is all version 3 (non-indexed). Mainnet rotation quorums are version 4, which
  // inserts a 2-byte quorumIndex right after quorumHash. No live v4 vector is committed yet, so this
  // pins the structural difference: v4 is exactly the v3 bytes with the index spliced in at that offset.
  const base = vec.newQuorums[0];
  const v3 = serializeCommitment({ ...base, version: 3 }, 3).bytes;
  const v4 = serializeCommitment({ ...base, version: 4, quorumIndex: 0x0102 }, 3).bytes;
  assert.equal(v4.length, v3.length + 2, "v4 is 2 bytes longer (the quorumIndex)");
  // nVersion (bytes 0-1) differs by design (0x0300 vs 0x0400); everything else lines up around the splice.
  assert.deepEqual(v4.subarray(0, 2), Buffer.from([0x04, 0x00]), "v4 nVersion is 4 LE");
  assert.deepEqual(v3.subarray(0, 2), Buffer.from([0x03, 0x00]), "v3 nVersion is 3 LE");
  const spliceAt = 2 + 1 + 32; // after nVersion(2) + llmqType(1) + quorumHash(32)
  assert.deepEqual(v4.subarray(2, spliceAt), v3.subarray(2, spliceAt), "llmqType + quorumHash identical");
  assert.deepEqual(v4.subarray(spliceAt, spliceAt + 2), Buffer.from([0x02, 0x01]), "quorumIndex is int16 LE");
  assert.deepEqual(v4.subarray(spliceAt + 2), v3.subarray(spliceAt), "the remainder matches v3");
});
