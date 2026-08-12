// Anchor a signing quorum's BLS public key to the chain, so ChainLock verification does not have to
// trust the node's word for the key. The coinbase commits `merkleRootQuorums` (parsed in
// dml_commitment.js and tied to the block by the same merkle branch and X11 header the DML root is).
// This module recomputes that root from the quorum commitments a `protx diff` returns, and only if it
// matches are the quorum public keys treated as the chain's.
//
// The leaf is SHA256d of the CFinalCommitment serialization, the root is ComputeMerkleRoot over the
// leaves sorted by their internal bytes, and both match Dash consensus (src/evo/cbtx.cpp
// CalcCbTxMerkleRootQuorums, src/llmq/commitment.h SERIALIZE_METHODS). Confirmed end to end against a
// live regtest network: 8 commitments across four llmq types reproduce the block's merkleRootQuorums.
//
// SCOPE: this handles the BASIC BLS scheme (commitment versions 3 and 4), which is what a post-v19
// chain uses. Legacy versions (1 and 2) serialize the BLS pubkey and sigs in the old byte order and are
// refused rather than mis-serialized, because a post-v19 active set does not contain them and guessing
// would silently produce a wrong root.
import { sha256 } from "@noble/hashes/sha256";
import { merkleRootFromLeaves } from "./dml_commitment.js";

const BASIC_NON_INDEXED = 3;
const BASIC_INDEXED = 4;

// Quorum member count per llmq type, which sets the DYNBITSET bit-length in the commitment. These are
// consensus constants, so they are data, not logic. The bit-length must be exact or the leaf hash and
// the root diverge. Keyed by network because the type numbers overlap (regtest reuses 100+).
//
// regtest: the types observed in a live regtest node's active set, each confirmed at 3 members via
// `quorum info`. Only the observed set is listed; an unobserved type (for example a rotated 103 if
// rotation is enabled) is deliberately absent, so it fails closed rather than being served a guessed
// size. Verified against dashmate regtest (dashd v23.1.7): newQuorums held exactly these four types.
export const REGTEST_LLMQ_SIZES = { 100: 3, 102: 3, 104: 3, 106: 3 };
// mainnet: from Dash consensus (src/chainparams.cpp llmq params). PENDING confirmation against a live
// synced mainnet node before this path is trusted on mainnet; the regtest vectors prove the mechanism,
// these numbers are what a mainnet run must be checked against.
// The table doubles as the mainnet allowlist (verifyQuorumsCommitment fails closed on an unknown type),
// so it holds only the types active on mainnet. Type 6 (llmq_25_67) is testnet-only and is excluded.
export const MAINNET_LLMQ_SIZES = {
  1: 50, // llmq_50_60
  2: 400, // llmq_400_60 (historic ChainLock quorum)
  3: 400, // llmq_400_85
  4: 100, // llmq_100_67 (platform)
  5: 60, // llmq_60_75 (rotated / DIP-24)
};

const rev = (b) => Buffer.from(b).reverse();
const sha256d = (b) => Buffer.from(sha256(sha256(b)));

// Strict hex of an EXACT byte length. Buffer.from(x, "hex") silently truncates at the first invalid
// character or a trailing half-byte, so a malformed field would serialize to fewer bytes (still able to
// reproduce the root if the dropped tail was noise) and be returned to callers as a trusted string.
// This refuses anything that is not exactly `bytes` lowercase-or-uppercase hex characters, and returns
// the normalized lowercase hex alongside the buffer so the caller-facing map holds validated values.
function strictHex(value, bytes, name) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be exactly ${bytes} bytes of hex, got ${JSON.stringify(value)}`);
  }
  const hex = value.toLowerCase();
  return { buf: Buffer.from(hex, "hex"), hex };
}

function u8(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be a uint8, got ${JSON.stringify(value)}`);
  }
  return value;
}

function i16(value, name) {
  if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
    throw new Error(`${name} must be an int16, got ${JSON.stringify(value)}`);
  }
  return value;
}

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function i16le(n) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(n, 0);
  return b;
}
function compactSize(n) {
  if (n < 0) throw new Error(`compactSize of a negative number: ${n}`);
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  throw new Error(`compactSize too large for this use: ${n}`);
}

// DYNBITSET: WriteCompactSize(bitCount) then ceil(bitCount/8) packed bytes (LSB first). The RPC hands
// over the packed bytes as hex; bitCount comes from the llmq type's member count, not from the bytes,
// since the trailing bits of the last byte are unused and cannot be recovered from the bytes alone.
function dynbitset(bitCount, packedHex, name) {
  const expected = Math.ceil(bitCount / 8);
  const { buf } = strictHex(packedHex, expected, `${name} (${bitCount}-bit bitset)`);
  return Buffer.concat([compactSize(bitCount), buf]);
}

// One CFinalCommitment, serialized exactly as consensus hashes it. `memberCount` is the llmq type's
// size (the DYNBITSET bit-length). Only the basic-scheme versions are handled. Every field is strictly
// validated, so a malformed input refuses here rather than serializing to truncated bytes.
export function serializeCommitment(q, memberCount) {
  if (q.version !== BASIC_NON_INDEXED && q.version !== BASIC_INDEXED) {
    throw new Error(
      `unsupported quorum commitment version ${JSON.stringify(q.version)} (only basic-scheme 3 and 4 ` +
        `are handled; a legacy pre-v19 commitment must not be mis-serialized)`,
    );
  }
  const llmqType = u8(q.llmqType, "llmqType");
  const quorumHash = strictHex(q.quorumHash, 32, "quorumHash");
  const parts = [u16le(q.version), Buffer.from([llmqType]), rev(quorumHash.buf)];
  if (q.version === BASIC_INDEXED) parts.push(i16le(i16(q.quorumIndex, "quorumIndex")));
  parts.push(
    dynbitset(memberCount, q.signers, "signers"),
    dynbitset(memberCount, q.validMembers, "validMembers"),
    strictHex(q.quorumPublicKey, 48, "quorumPublicKey").buf, // basic BLS pubkey, as-is
    rev(strictHex(q.quorumVvecHash, 32, "quorumVvecHash").buf),
    strictHex(q.quorumSig, 96, "quorumSig").buf, // basic BLS sig, as-is
    strictHex(q.membersSig, 96, "membersSig").buf,
  );
  const ser = Buffer.concat(parts);
  return { hash: sha256d(ser), bytes: ser, llmqType, quorumHash: quorumHash.hex };
}

// Recompute the merkleRootQuorums a coinbase would commit for this active quorum set. `newQuorums` is
// the full active set a `protx diff` from base height 1 returns. `sizes` maps llmqType to member count.
// Returns the leaves' root plus the normalized (validated) quorum public keys, keyed by identity.
export function quorumsMerkleRoot(newQuorums, sizes) {
  if (!Array.isArray(newQuorums)) throw new Error("newQuorums must be an array");
  const leaves = [];
  const keys = new Map();
  for (const q of newQuorums) {
    const size = sizes[q.llmqType];
    if (size == null) {
      throw new Error(`no member-count parameter for llmq type ${JSON.stringify(q.llmqType)}; refusing to guess the bitset length`);
    }
    const { hash, llmqType, quorumHash } = serializeCommitment(q, size);
    const id = `${llmqType}:${quorumHash}`;
    // A duplicate (llmqType, quorumHash) would let a redundant commitment reproduce the same root via
    // the merkle odd-node duplication rule, so "the quorum set matches" would not be an exact identity.
    // The chain's active set never repeats one, so refuse rather than accept an ambiguous set.
    if (keys.has(id)) throw new Error(`duplicate quorum ${id} in the set`);
    keys.set(id, strictHex(q.quorumPublicKey, 48, "quorumPublicKey").hex);
    leaves.push(hash);
  }
  // uint256 std::sort compares the raw internal bytes with memcmp (byte 0 first).
  leaves.sort(Buffer.compare);
  return { root: merkleRootFromLeaves(leaves), keys };
}

// Verify the quorum set against the coinbase commitment and return the chain-anchored public keys.
// Throws if the recomputed root does not equal `merkleRootQuorums` (a hex string in RPC display order,
// as `oracle/dml_commitment.js` cbTxCommitment returns it). On success returns a Map keyed
// `"<llmqType>:<quorumHash>"` to the 48-byte hex public key, which callers may then trust.
export function verifyQuorumsCommitment({ newQuorums, merkleRootQuorums, sizes }) {
  if (typeof merkleRootQuorums !== "string" || !/^[0-9a-fA-F]{64}$/.test(merkleRootQuorums)) {
    throw new Error(`merkleRootQuorums must be a 64-hex string, got ${JSON.stringify(merkleRootQuorums)}`);
  }
  const { root, keys } = quorumsMerkleRoot(newQuorums, sizes);
  const recomputed = rev(root).toString("hex");
  if (recomputed !== merkleRootQuorums.toLowerCase()) {
    throw new Error(
      `quorum set does not match the coinbase commitment: recomputed ${recomputed}, coinbase commits ${merkleRootQuorums.toLowerCase()}`,
    );
  }
  // keys already holds normalized (validated) identities and public keys.
  return keys;
}
