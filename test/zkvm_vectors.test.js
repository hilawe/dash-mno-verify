// Golden vectors for the zkVM integration, work-plan step 1 of docs/ZKVM_INTEGRATION.md.
//
// The single source both suites consume is the committed fixture
// test/vectors/zkvm_golden.json. This test REGENERATES every value from circomlibjs (the
// reference the circuits are built against) and byte-compares against the fixture, so the
// fixture cannot drift from the reference. The Rust side
// (research/risc0-registration/vectors/) parses the same file and must reproduce it with
// light-poseidon and sha2, so neither implementation can drift alone, and neither side
// holds its own copy of the constants.
//
// The fixture also carries the complete 136-byte journal for the pinned witness, built
// here with independent field encoding (BigInt to big-endian hex by hand), so a shared
// layout mistake between the Rust host and the Rust guest cannot hide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { leafFromPriv } from "../common/dml.js";
import { FIELD_PRIME } from "../common/field.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./vectors/zkvm_golden.json", import.meta.url)));

// d = n - 2 (secp256k1 group order minus 2), a canonical key near the top of the range.
const D2 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413fn;

// The limb layout of prover/two_tier.js privToLimbs: 4 little-endian 64-bit limbs.
const limbs = (d) => {
  const mask = (1n << 64n) - 1n;
  return [0n, 1n, 2n, 3n].map((i) => (d >> (64n * i)) & mask);
};

const sha = (buf) => createHash("sha256").update(buf).digest();
const leafHash = (keyid20) => sha(Buffer.concat([Buffer.from([0x00]), keyid20]));
const nodeHash = (l, r) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

// Independent journal field encoding, deliberately NOT shared with any implementation
// under test: decimal string to 32-byte big-endian hex by hand.
const be32hex = (dec) => BigInt(dec).toString(16).padStart(64, "0");
const be8hex = (n) => BigInt(n).toString(16).padStart(16, "0");

test("the fixture's Poseidon values regenerate exactly from circomlibjs", async () => {
  const p = await buildPoseidon();
  const F = p.F;
  const out = (x) => F.toObject(x).toString();

  assert.equal(out(p([1n])), FIXTURE.poseidon1_of_1);
  assert.equal(out(p([FIELD_PRIME - 1n])), FIXTURE.poseidon1_of_pMinus1);

  const kh1 = p(limbs(1n).map((x) => F.e(x)));
  const kh2 = p(limbs(D2).map((x) => F.e(x)));
  assert.equal(out(kh1), FIXTURE.kh_d1);
  assert.equal(out(kh2), FIXTURE.kh_d2);

  const season = F.e(BigInt(FIXTURE.season));
  const ctx = F.e(BigInt(FIXTURE.contextHash));
  assert.equal(out(p([kh1, season, ctx])), FIXTURE.rn_d1);
  assert.equal(out(p([kh2, season, ctx])), FIXTURE.rn_d2);
});

test("the fixture's generator keyID matches the repository's own leaf derivation", () => {
  const priv = Buffer.alloc(32);
  priv[31] = 1;
  const leaf = leafFromPriv(Uint8Array.from(priv));
  assert.equal(leaf.toString(16).padStart(40, "0"), FIXTURE.genKeyidHex);
});

test("the fixture's SHA-256 tree values regenerate from the pinned spec, both directions", () => {
  const emptyLeaf = leafHash(Buffer.alloc(20));
  assert.equal(emptyLeaf.toString("hex"), FIXTURE.emptyLeafHashHex);

  const empty = [emptyLeaf];
  for (let i = 1; i <= 16; i++) empty.push(nodeHash(empty[i - 1], empty[i - 1]));
  assert.equal(empty[16].toString("hex"), FIXTURE.emptyDepth16Hex);

  const genKeyid = Buffer.from(FIXTURE.genKeyidHex, "hex");
  const keyid2 = Buffer.alloc(20, 2);
  let left = nodeHash(leafHash(genKeyid), leafHash(keyid2));
  let right = nodeHash(leafHash(keyid2), leafHash(genKeyid));
  for (let i = 1; i < 16; i++) {
    left = nodeHash(left, empty[i]);
    right = nodeHash(right, empty[i]);
  }
  assert.equal(left.toString("hex"), FIXTURE.rootTwoLeavesHex);
  assert.equal(right.toString("hex"), FIXTURE.rootTwoLeavesRightHex);
});

test("the complete 136-byte journal regenerates from independently encoded fields", () => {
  const journal =
    be32hex(FIXTURE.poseidon1_of_1) +
    be32hex(FIXTURE.rn_d1) +
    FIXTURE.rootTwoLeavesHex +
    be8hex(FIXTURE.season) +
    be32hex(FIXTURE.contextHash);
  assert.equal(journal.length, 272);
  assert.equal(journal, FIXTURE.journalLeftHex);
});
