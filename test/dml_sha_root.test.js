// Pins the SHA-256 DML tree (common/dml_sha_root.js), the second root the oracle publishes for
// the zkVM registration statement, against the same frozen fixture the guest and the Rust vectors
// crate reproduce (test/vectors/zkvm_golden.json). If this agrees with the fixture, the gateway's
// recompute produces exactly the tree the zkVM guest verifies inclusion against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeShaDmlRootHasher, shaRootFromLeaves, leafToKeyId } from "../common/dml_sha_root.js";
import { votingAddressToLeaf, votingAddressToKeyId, hash160ToAddress } from "../common/dml.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./vectors/zkvm_golden.json", import.meta.url)));

test("the empty depth-16 root matches the pinned fixture", () => {
  const h = makeShaDmlRootHasher(16);
  assert.equal(h([]), FIXTURE.emptyDepth16Hex);
});

test("the two-leaf root matches the pinned fixture, both leaf orders", () => {
  const h = makeShaDmlRootHasher(16);
  const gen = Buffer.from(FIXTURE.genKeyidHex, "hex");
  const k2 = Buffer.alloc(20, 2);
  assert.equal(h([gen, k2]), FIXTURE.rootTwoLeavesHex);
  assert.equal(h([k2, gen]), FIXTURE.rootTwoLeavesRightHex);
});

test("leafToKeyId recovers the 20-byte keyID from a decimal leaf, with leading-zero padding", () => {
  const addr = hash160ToAddress(Buffer.from(FIXTURE.genKeyidHex, "hex"));
  const leafDec = votingAddressToLeaf(addr).toString();
  assert.equal(leafToKeyId(leafDec).toString("hex"), FIXTURE.genKeyidHex);
  assert.equal(leafToKeyId(leafDec).toString("hex"), votingAddressToKeyId(addr).toString("hex"));

  // A keyID with a leading zero byte must still round-trip to 20 bytes, not lose the pad.
  const leading = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(19, 0xab)]);
  const dec = BigInt("0x" + leading.toString("hex")).toString();
  assert.equal(leafToKeyId(dec).toString("hex"), leading.toString("hex"));
});

test("shaRootFromLeaves (decimal input) equals the keyID hasher", () => {
  const h = makeShaDmlRootHasher(16);
  const gen = Buffer.from(FIXTURE.genKeyidHex, "hex");
  const addr = hash160ToAddress(gen);
  const leafDec = votingAddressToLeaf(addr).toString();
  assert.equal(shaRootFromLeaves([leafDec], 16), h([gen]));
});

test("a leaf exceeding 20 bytes is rejected, not silently truncated", () => {
  const tooBig = (BigInt(1) << BigInt(160)).toString(); // 21 bytes
  assert.throws(() => leafToKeyId(tooBig), /exceeds 20 bytes/);
});
