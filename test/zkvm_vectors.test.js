// Golden vectors for the zkVM integration, work-plan step 1 of docs/ZKVM_INTEGRATION.md.
//
// This is the circomlibjs half of the cross-implementation pin. The identical constants live
// in research/risc0-registration/vectors/src/lib.rs, where the Rust side (light-poseidon and
// sha2) must reproduce them. This side proves the constants really are what circomlibjs, the
// reference the circuits are built against, computes, so neither suite can drift alone.
//
// Poseidon forms pinned: Poseidon(secret) (the member commitment) and
// Poseidon(Poseidon(d_limbs), season, contextHash) (the registration nullifier), with the
// 4x64 little-endian limb layout of prover/two_tier.js. SHA-256 tree spec pinned: leaf =
// SHA-256(0x00 || keyID20), node = SHA-256(0x01 || left || right), empty leaf = 20 zero
// bytes, depth 16.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { leafFromPriv } from "../common/dml.js";
import { FIELD_PRIME } from "../common/field.js";

const VECTORS = {
  poseidon1_of_1: "18586133768512220936620570745912940619677854269274689475585506675881198879027",
  poseidon1_of_pMinus1: "3366645945435192953002076803303112651887535928162668198103357554665518664470",
  kh_d1: "12367897091404705650828429310777103242839675713861485408658822466779430954331",
  kh_d2: "17733228908332928336250677456484071725019237794152871801635728024063440347582",
  rn_d1: "15227301960485994341830905575422680556053229133647037318432828740967973824578",
  rn_d2: "5331113805761365827444637754639205013995575527913347682073454633956069601495",
  genKeyidHex: "751e76e8199196d454941c45d1b3a323f1433bd6",
  emptyLeafHashHex: "c90232586b801f9558a76f2f963eccd831d9fe6775e4c8f1446b2331aa2132f2",
  emptyDepth16Hex: "aea2c3f1ca4e45228d7905549472467b418662bf5736df886e474a2aeade070b",
  rootTwoLeavesHex: "6c0f8060bd905e707dacb197e739b7915d683842711ce16ffeae4ae6d9e51e66",
};

// d = n - 2 (secp256k1 group order minus 2), a canonical key near the top of the range.
const D2 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413fn;
const SEASON = 7n;
const CONTEXT = 999n;

// The limb layout of prover/two_tier.js privToLimbs: 4 little-endian 64-bit limbs.
const limbs = (d) => {
  const mask = (1n << 64n) - 1n;
  return [0n, 1n, 2n, 3n].map((i) => (d >> (64n * i)) & mask);
};

const sha = (buf) => createHash("sha256").update(buf).digest();
const leafHash = (keyid20) => sha(Buffer.concat([Buffer.from([0x00]), keyid20]));
const nodeHash = (l, r) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

test("Poseidon commitment form matches the pinned vectors", async () => {
  const p = await buildPoseidon();
  const out = (x) => p.F.toObject(x).toString();
  assert.equal(out(p([1n])), VECTORS.poseidon1_of_1);
  assert.equal(out(p([FIELD_PRIME - 1n])), VECTORS.poseidon1_of_pMinus1);
});

test("Poseidon limb and nullifier forms match the pinned vectors", async () => {
  const p = await buildPoseidon();
  const F = p.F;
  const out = (x) => F.toObject(x).toString();

  const kh1 = p(limbs(1n).map((x) => F.e(x)));
  const kh2 = p(limbs(D2).map((x) => F.e(x)));
  assert.equal(out(kh1), VECTORS.kh_d1);
  assert.equal(out(kh2), VECTORS.kh_d2);
  assert.equal(out(p([kh1, F.e(SEASON), F.e(CONTEXT)])), VECTORS.rn_d1);
  assert.equal(out(p([kh2, F.e(SEASON), F.e(CONTEXT)])), VECTORS.rn_d2);
});

test("the generator keyID constant matches the repository's own leaf derivation", () => {
  const priv = Buffer.alloc(32);
  priv[31] = 1;
  const leaf = leafFromPriv(Uint8Array.from(priv));
  assert.equal(leaf.toString(16).padStart(40, "0"), VECTORS.genKeyidHex);
});

test("the SHA-256 tree spec matches the pinned vectors", () => {
  const emptyLeaf = leafHash(Buffer.alloc(20));
  assert.equal(emptyLeaf.toString("hex"), VECTORS.emptyLeafHashHex);

  const empty = [emptyLeaf];
  for (let i = 1; i <= 16; i++) empty.push(nodeHash(empty[i - 1], empty[i - 1]));
  assert.equal(empty[16].toString("hex"), VECTORS.emptyDepth16Hex);

  const genKeyid = Buffer.from(VECTORS.genKeyidHex, "hex");
  const keyid2 = Buffer.alloc(20, 2);
  let cur = nodeHash(leafHash(genKeyid), leafHash(keyid2));
  for (let i = 1; i < 16; i++) cur = nodeHash(cur, empty[i]);
  assert.equal(cur.toString("hex"), VECTORS.rootTwoLeavesHex);
});
