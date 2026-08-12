// End-to-end ChainLock verification against a chain-anchored quorum set.
//
// The vector is a real Dash regtest ChainLock plus the protx-diff quorum set active for it (base 1),
// dashd v23.1.7 (post-v19 basic BLS). The full chain: the quorum commitments reproduce the block's
// merkleRootQuorums (so the public keys are the chain's), and the ChainLock BLS-verifies against the
// signing quorum among them. Regtest ChainLocks use llmq type 100; mainnet's type is validated
// separately against a live node before the wired path is trusted there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyChainLock, chainlockRequestId } from "../oracle/chainlock.js";
import { verifyQuorumsCommitment } from "../oracle/quorum_commitment.js";

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/chainlock_regtest.json", import.meta.url)), "utf8"),
);
const cl = vec.chainlock;

// Anchor the quorum keys first (the merkleRootQuorums check), exactly as the wired path will.
function anchoredKeys() {
  return verifyQuorumsCommitment({
    newQuorums: vec.newQuorums,
    merkleRootQuorums: vec.merkleRootQuorums,
    sizes: vec.memberSizes,
  });
}

test("a real ChainLock verifies against the chain-anchored signing quorum", () => {
  const keys = anchoredKeys();
  const { quorumId } = verifyChainLock({
    height: cl.height,
    blockHash: cl.blockhash,
    signature: cl.signature,
    quorumKeys: keys,
    llmqType: vec.chainlockLlmqType,
  });
  // The verifier returns the EXACT quorum whose anchored key verified, and it is one of the set.
  assert.match(quorumId, new RegExp(`^${vec.chainlockLlmqType}:[0-9a-f]{64}$`));
  assert.ok(keys.has(quorumId), "the verifying quorum is one of the chain-anchored quorums");
});

test("a tampered block hash fails to verify (the signature is bound to the block)", () => {
  const bad = Buffer.from(cl.blockhash, "hex");
  bad[0] ^= 0x01;
  assert.throws(
    () =>
      verifyChainLock({
        height: cl.height,
        blockHash: bad.toString("hex"),
        signature: cl.signature,
        quorumKeys: anchoredKeys(),
        llmqType: vec.chainlockLlmqType,
      }),
    /did not verify against any active quorum/,
  );
});

test("a wrong height fails to verify (the requestId is bound to the height)", () => {
  assert.throws(
    () =>
      verifyChainLock({
        height: cl.height + 1,
        blockHash: cl.blockhash,
        signature: cl.signature,
        quorumKeys: anchoredKeys(),
        llmqType: vec.chainlockLlmqType,
      }),
    /did not verify against any active quorum/,
  );
});

test("a ChainLock type with no anchored quorum is refused rather than silently passing", () => {
  assert.throws(
    () =>
      verifyChainLock({
        height: cl.height,
        blockHash: cl.blockhash,
        signature: cl.signature,
        quorumKeys: anchoredKeys(),
        llmqType: 250, // no such quorum in the set
      }),
    /no active quorum of ChainLock type 250/,
  );
});

test("a corrupted signature is rejected (bad point encoding or non-verifying, both are rejections)", () => {
  // Flipping a byte in the signature either breaks the G2 point encoding (fromHex throws) or yields a
  // valid-but-wrong point that fails the pairing check. Either way the ChainLock must be rejected.
  const bad = Buffer.from(cl.signature, "hex");
  bad[0] ^= 0x01;
  assert.throws(() =>
    verifyChainLock({
      height: cl.height,
      blockHash: cl.blockhash,
      signature: bad.toString("hex"),
      quorumKeys: anchoredKeys(),
      llmqType: vec.chainlockLlmqType,
    }),
  );
});

test("requestId is the exact clsig construction, pinned to a known value", () => {
  // SHA256d( 0x05 "clsig" int32LE(height) ). The pinned value for height 1 was cross-checked against a
  // second independent implementation, so this asserts the serialization, not just determinism.
  assert.equal(
    chainlockRequestId(1).toString("hex"),
    "77524627f2ae590c7992f06974fdb264012e04dc440a854dd7c709b21bb41aab",
  );
  assert.notEqual(chainlockRequestId(1).toString("hex"), chainlockRequestId(2).toString("hex"));
});
