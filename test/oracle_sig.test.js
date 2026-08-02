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
  // An unrecognised version must not produce a legacy v1 message that a v1 signature would
  // authenticate, which would leave every field the newer version added unsigned.
  assert.throws(() => snapshotMessage({ ...snapV2, version: 4 }), /unsupported oracle snapshot version/);
  assert.throws(() => snapshotMessage({ ...snap, version: "1" }), /unsupported oracle snapshot version/);
  assert.throws(() => snapshotMessage({ ...snap, version: 2.0000001 }), /unsupported oracle snapshot version/);
});

// v3 is the block-bound, ChainLock-gated snapshot. Its extra claims are the leaf ORDER and the
// ChainLock, and both have to be inside the signed bytes rather than travelling beside them.
const snapV3 = {
  ...snapV2,
  version: 3,
  order: "proRegTxHash",
  chainlocked: true,
};

test("a v3 message signs the leaf order and the chainlock claim, not just the roots", () => {
  const base = snapshotMessage(snapV3).toString();
  assert.match(base, /mno-oracle-snapshot-v3/, "its own domain, so no cross-version replay");
  assert.match(base, /proRegTxHash/, "the ordering rule is signed");

  // Change only the order label. A different message means a signature over one cannot authenticate
  // the other, which is the whole point: the window accepts both orders at a height, so the LABEL is
  // what keeps them apart. Unsigned, that acceptance would be the hole rather than the feature.
  const relabelled = snapshotMessage({ ...snapV3, order: "collateralOutpoint" }).toString();
  assert.notEqual(base, relabelled);

  // And the chainlock claim, which is what makes a v3 snapshot worth more than a v2 one.
  const unlocked = snapshotMessage({ ...snapV3, chainlocked: false }).toString();
  assert.notEqual(base, unlocked);
});

test("a v3 snapshot cannot be presented as v2, nor a v2 as v3", () => {
  // Same height, roots, and timestamp. Only the version differs, and the messages must not collide,
  // or a signature over one would authenticate the other with its extra claims unchecked.
  const asV3 = snapshotMessage(snapV3).toString();
  const asV2 = snapshotMessage({ ...snapV3, version: 2 }).toString();
  assert.notEqual(asV3, asV2);
  assert.match(asV2, /mno-oracle-snapshot-v2/);
});

test("a v3 message refuses to form without the fields it claims to sign", () => {
  const { order, ...noOrder } = snapV3;
  assert.throws(() => snapshotMessage(noOrder), /requires a non-empty string order/);
  assert.throws(() => snapshotMessage({ ...snapV3, order: "" }), /requires a non-empty string order/);
  const { shaRoot, ...noSha } = snapV3;
  assert.throws(() => snapshotMessage(noSha), /requires a string shaRoot/);
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
