import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  leafFromPriv,
  leafFromPubkey,
  votingAddressToLeaf,
  wifToPriv,
  hash160ToAddress,
} from "../common/dml.js";

// Reference vector: the secp256k1 generator point (private key = 1). Its compressed
// public key and hash160 are well-known constants, so this vector is externally
// verifiable rather than self-referential. Never use a key like this for a real node.
const PRIV_ONE = Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex"));
const GEN_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const GEN_HASH160 = "751e76e8199196d454941c45d1b3a323f1433bd6";
const GEN_ADDRESS = "XmN7PQYWKn5MJFna5fRYgP6mxT2F7xpekE";
const GEN_WIF = "XBHddvWWiMu3nZhhpTXBQWJMmdz5JNKJD85b9fgKAckCT2coW3Y4";

test("leaf from the generator key matches the known hash160", () => {
  assert.equal(
    Buffer.from(secp256k1.getPublicKey(PRIV_ONE, true)).toString("hex"),
    GEN_PUBKEY
  );
  assert.equal(leafFromPriv(PRIV_ONE), BigInt("0x" + GEN_HASH160));
});

test("prover leaf equals oracle leaf for the same key", () => {
  // The prover computes the leaf from the private key, the oracle computes it from the
  // published address. They must converge. This is the single assumption the whole
  // membership proof rests on.
  assert.equal(leafFromPriv(PRIV_ONE), votingAddressToLeaf(GEN_ADDRESS));
});

test("votingAddress encode and decode round-trips", () => {
  const address = hash160ToAddress(Buffer.from(GEN_HASH160, "hex"));
  assert.equal(address, GEN_ADDRESS);
  assert.equal(votingAddressToLeaf(address), BigInt("0x" + GEN_HASH160));
});

test("WIF decodes to the private key", () => {
  assert.deepEqual(wifToPriv(GEN_WIF), PRIV_ONE);
});

test("leafFromPubkey agrees with leafFromPriv", () => {
  const pub = secp256k1.getPublicKey(PRIV_ONE, true);
  assert.equal(leafFromPubkey(pub), leafFromPriv(PRIV_ONE));
});
