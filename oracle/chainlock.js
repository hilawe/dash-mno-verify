// Verify a Dash ChainLock signature against the chain-anchored signing quorum, so direct-node mode can
// stop trusting the node's word that a block is ChainLocked. The quorum public keys come from
// oracle/quorum_commitment.js (anchored to the coinbase's merkleRootQuorums), so the only thing trusted
// here is the block header the existing dml_commitment + X11 + proof-of-work path already ties down.
//
// A ChainLock is a recovered threshold BLS signature by an LLMQ (the ChainLock quorum type). Post-v19
// Dash uses the basic BLS scheme. The construction was pinned against a live node with `quorum getrecsig`:
//   requestId = SHA256d( compactSize("clsig") "clsig" int32LE(height) )
//   signHash  = SHA256d( u8(llmqType) quorumHash(internal) requestId(internal) blockHash(internal) )
//   verify basic scheme: e(pubkey_G1, H(signHash)) == e(G1, sig_G2), DST the basic ciphersuite.
// The signing quorum is one of the active quorums of the ChainLock type; rather than reimplement Dash's
// requestId-based quorum selection, this verifies against every active quorum of that type and accepts
// if one matches. A forged signature verifies against none; a real one verifies against exactly the signer.
//
// TRUST BOUNDARY, read before wiring this in. This function proves only that some quorum WHOSE KEY THE
// CALLER SUPPLIED signed (this block, this height, that quorum's hash). It does NOT establish that those
// keys are the real chain's. That is the caller's job, and it is the hard part. Anchoring the keys to the
// SAME block's coinbase (its merkleRootQuorums) is INSUFFICIENT and circular: a node that fabricates a
// cheap block mined at the powLimit floor can put a fake quorum with a key it controls into that block's
// own coinbase and sign a fake ChainLock with it, and every check here passes. A real close needs the
// quorum keys anchored to an INDEPENDENT trust point, a hardcoded checkpoint whose masternode and quorum
// state is followed forward through verified diffs against headers whose difficulty chains from the
// checkpoint (the light-client bootstrap). Two further requirements for correct wiring, both noted by
// review: the ChainLock signer is selected from the pool as of height minus 8, not the current tip, so the
// anchored set must be that historical pool; and rotated (DIP-24) quorum types are disambiguated by
// quorumIndex as well as (type, quorumHash). This module is a correct primitive for that larger design; it
// is not, on its own, a trust anchor.
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";

const BASIC_DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_";
const rev = (b) => Buffer.from(b).reverse();
const sha256d = (b) => Buffer.from(sha256(sha256(b)));

function strictHex(value, bytes, name) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be exactly ${bytes} bytes of hex, got ${JSON.stringify(value)}`);
  }
  return Buffer.from(value.toLowerCase(), "hex");
}

// requestId = SHA256d( compactSize("clsig") "clsig" int32LE(height) ), in internal byte order.
export function chainlockRequestId(height) {
  if (!Number.isInteger(height) || height < 0 || height > 0x7fffffff) {
    throw new Error(`ChainLock height must be an int32, got ${JSON.stringify(height)}`);
  }
  const prefix = Buffer.from("clsig", "ascii");
  const h = Buffer.alloc(4);
  h.writeInt32LE(height, 0);
  return sha256d(Buffer.concat([Buffer.from([prefix.length]), prefix, h]));
}

// The message the quorum's recovered signature is over. All uint256 arguments are internal byte order.
// Inputs are validated so the exported helper cannot be handed a coercible llmqType or a wrong-length
// hash that Buffer.concat would silently accept.
export function buildChainLockSignHash(llmqType, quorumHashInternal, requestId, blockHashInternal) {
  if (!Number.isInteger(llmqType) || llmqType < 0 || llmqType > 0xff) {
    throw new Error(`llmqType must be a uint8, got ${JSON.stringify(llmqType)}`);
  }
  for (const [buf, name] of [
    [quorumHashInternal, "quorumHashInternal"],
    [requestId, "requestId"],
    [blockHashInternal, "blockHashInternal"],
  ]) {
    if (!Buffer.isBuffer(buf) || buf.length !== 32) {
      throw new Error(`${name} must be a 32-byte Buffer`);
    }
  }
  return sha256d(Buffer.concat([Buffer.from([llmqType]), quorumHashInternal, requestId, blockHashInternal]));
}

// Basic-scheme BLS verify (pubkey on G1, signature on G2). Returns a boolean; a malformed point throws.
function blsBasicVerify(pubkeyHex, msg32, sigG2) {
  const pub = bls.G1.Point.fromHex(pubkeyHex);
  const H = bls.G2.hashToCurve(msg32, { DST: BASIC_DST });
  return bls.fields.Fp12.eql(bls.pairing(pub, H), bls.pairing(bls.G1.Point.BASE, sigG2));
}

// Verify a ChainLock against the chain-anchored active quorums.
//   height, blockHash: the ChainLocked block (blockHash a 32-byte RPC-display hex string).
//   signature: the 96-byte ChainLock BLS signature hex.
//   quorumKeys: Map "<llmqType>:<quorumHash>" -> 48-byte pubkey hex, from verifyQuorumsCommitment.
//   llmqType: the ChainLock signing quorum type for this network.
// Returns { quorumId } of the quorum whose key verified. Throws if none does.
export function verifyChainLock({ height, blockHash, signature, quorumKeys, llmqType }) {
  if (!Number.isInteger(llmqType) || llmqType < 0 || llmqType > 0xff) {
    throw new Error(`llmqType must be a uint8, got ${JSON.stringify(llmqType)}`);
  }
  if (!(quorumKeys instanceof Map)) throw new Error("quorumKeys must be the Map from verifyQuorumsCommitment");
  const blockInternal = rev(strictHex(blockHash, 32, "blockHash"));
  const sigG2 = bls.G2.Point.fromHex(strictHex(signature, 96, "signature").toString("hex"));
  const requestId = chainlockRequestId(height);

  const prefix = `${llmqType}:`;
  const candidates = [...quorumKeys.keys()].filter((id) => id.startsWith(prefix));
  if (candidates.length === 0) {
    throw new Error(`no active quorum of ChainLock type ${llmqType} in the anchored set`);
  }
  for (const id of candidates) {
    const quorumHashRpc = id.slice(prefix.length);
    const quorumHashInternal = rev(strictHex(quorumHashRpc, 32, "quorumHash"));
    const signHash = buildChainLockSignHash(llmqType, quorumHashInternal, requestId, blockInternal);
    if (blsBasicVerify(quorumKeys.get(id), signHash, sigG2)) {
      return { quorumId: id };
    }
  }
  throw new Error(
    `ChainLock signature did not verify against any active quorum of type ${llmqType} ` +
      `(${candidates.length} candidate(s)) for block ${blockHash} at height ${height}`,
  );
}
