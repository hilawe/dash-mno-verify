import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  snapshotMessage,
  publicKeyFromRaw,
  rawPublicB64,
  signSnapshot,
  verifySnapshotSig,
  addSignature,
} from "../common/oracle_sig.js";

// The oracle signature is what authenticates the leaf set: the gateway trusts a snapshot because a
// pinned key signed it, not just because the leaves hash to the root. These pin that the signature
// covers every field that fixes the snapshot, and that an untrusted or tampered signature is rejected.

const snap = { height: 100, blockHash: "00ff", depth: 16, root: "12345", ts: 1700000000 };

test("a snapshot signed by a key verifies under its pinned public key", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyFromRaw(rawPublicB64(privateKey));
  const sig = signSnapshot(snapshotMessage(snap), privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage(snap), sig, pub), true);
});

test("changing any signed field breaks the signature", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyFromRaw(rawPublicB64(privateKey));
  const sig = signSnapshot(snapshotMessage(snap), privateKey);
  for (const field of ["height", "blockHash", "depth", "root", "ts"]) {
    const tampered = { ...snap, [field]: String(snap[field]) + "X" };
    assert.equal(verifySnapshotSig(snapshotMessage(tampered), sig, pub), false, field);
  }
});

test("a signature from another key does not verify", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const sig = signSnapshot(snapshotMessage(snap), a.privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage(snap), sig, publicKeyFromRaw(rawPublicB64(b.privateKey))), false);
});

// v2 dual-root snapshots and the version separation (docs/ZKVM_INTEGRATION.md).
const snapV2 = { version: 2, height: 100, blockHash: "00ff", depth: 16, root: "12345", shaRoot: "ab".repeat(32), ts: 1700000000 };

test("a v2 message covers the shaRoot, so tampering it breaks the signature", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyFromRaw(rawPublicB64(privateKey));
  const sig = signSnapshot(snapshotMessage(snapV2), privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage(snapV2), sig, pub), true);
  const tampered = { ...snapV2, shaRoot: "cd".repeat(32) };
  assert.equal(verifySnapshotSig(snapshotMessage(tampered), sig, pub), false);
});

test("a v2 signature cannot be replayed as v1 or vice versa", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyFromRaw(rawPublicB64(privateKey));
  // A v2 signature does not verify when the same snapshot is read as v1 (shaRoot dropped from msg).
  const v2sig = signSnapshot(snapshotMessage(snapV2), privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage({ ...snapV2, version: 1 }), v2sig, pub), false);
  // A v1 signature does not verify as v2 either.
  const v1sig = signSnapshot(snapshotMessage({ ...snapV2, version: 1 }), privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage(snapV2), v1sig, pub), false);
});

test("a v2 message with no shaRoot is a hard error, not a silent v1 fallback", () => {
  assert.throws(() => snapshotMessage({ ...snapV2, shaRoot: undefined }), /requires a .*shaRoot/);
});

test("an unknown version fails closed rather than falling back to v1", () => {
  // version 3 must not produce a (legacy) v1 message that a v1 signature would authenticate.
  assert.throws(() => snapshotMessage({ ...snapV2, version: 3 }), /unsupported oracle snapshot version/);
  assert.throws(() => snapshotMessage({ ...snap, version: "1" }), /unsupported oracle snapshot version/);
});

test("a malformed signature returns false rather than throwing", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyFromRaw(rawPublicB64(privateKey));
  assert.equal(verifySnapshotSig(snapshotMessage(snap), "@@@ not base64 @@@", pub), false);
});

test("a raw public key round-trips through base64, from either key half", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  assert.equal(rawPublicB64(publicKey), rawPublicB64(privateKey));
  const sig = signSnapshot(snapshotMessage(snap), privateKey);
  assert.equal(verifySnapshotSig(snapshotMessage(snap), sig, publicKeyFromRaw(rawPublicB64(publicKey))), true);
});

test("a public key that is not 32 bytes is rejected", () => {
  assert.throws(() => publicKeyFromRaw(Buffer.from("too short").toString("base64")));
});

test("addSignature builds a quorum snapshot with one entry per key and dedups a re-sign", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  let s = { ...snap, sigs: [] };
  s = { ...s, sigs: addSignature(s, a.privateKey) };
  s = { ...s, sigs: addSignature(s, b.privateKey) };
  assert.equal(s.sigs.length, 2);
  // re-signing with A replaces A's entry rather than adding a second
  s = { ...s, sigs: addSignature(s, a.privateKey) };
  assert.equal(s.sigs.length, 2);
  // every entry verifies under its own pinned key over the shared snapshot message
  const msg = snapshotMessage(s);
  for (const { privateKey } of [a, b]) {
    const entry = s.sigs.find((e) => e.key === rawPublicB64(privateKey));
    assert.ok(entry, "each signer has an entry");
    assert.equal(verifySnapshotSig(msg, entry.sig, publicKeyFromRaw(entry.key)), true);
  }
});
