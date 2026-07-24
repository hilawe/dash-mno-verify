// The SHA-256 DML tree root, the second root the oracle publishes for the zkVM registration
// statement (docs/ZKVM_INTEGRATION.md). The zkVM guest verifies DML inclusion with SHA-256
// because the zkVM accelerates it, while the Poseidon root (common/dml_root.js) stays for the
// PLONK single-tier circuit and the members tree. The two roots commit to the same ordered
// leaves, so the gateway recomputes both and no in-circuit bridge is needed.
//
// The spec is frozen and pinned twice (test/vectors/zkvm_golden.json, reproduced by the guest
// and the Rust vectors crate):
//   leaf  = SHA-256(0x00 || keyID20)          the 20-byte hash160, big-endian bytes
//   node  = SHA-256(0x01 || left || right)    over the two 32-byte children
//   empty leaf = 20 zero bytes, so the pad hash is SHA-256(0x00 || 0x00^20)
//   depth 16, empty right subtrees collapse to one cached constant per level
import { createHash } from "node:crypto";

const DEFAULT_DEPTH = 16;

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

// leaf hash of a 20-byte keyID
function leafHash(keyId20) {
  return sha256(Buffer.concat([Buffer.from([0x00]), keyId20]));
}

// internal node over two 32-byte children
function nodeHash(left, right) {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

// Build the SHA-256 DML root from the ordered real keyIDs (each a 20-byte Buffer), padding the
// rest of the 2**depth slots with the empty leaf. Like the Poseidon builder, the all-empty right
// subtrees collapse to one cached constant per level, so the work is O(real leaves) and the root
// is identical to a full-pad build. Returns the root as 64 lowercase hex characters, the wire
// encoding the snapshot and the zkVM statement use.
export function makeShaDmlRootHasher(depth = DEFAULT_DEPTH) {
  // zero[l] = root of an all-empty subtree of height l. zero[0] is the empty leaf hash.
  const zero = [leafHash(Buffer.alloc(20))];
  for (let l = 1; l <= depth; l++) zero[l] = nodeHash(zero[l - 1], zero[l - 1]);

  return function rootFromKeyIds(keyIds) {
    if (keyIds.length > 2 ** depth) {
      throw new Error(`leaf count ${keyIds.length} exceeds tree capacity ${2 ** depth}`);
    }
    if (keyIds.length === 0) return zero[depth].toString("hex");

    let level = keyIds.map((k) => leafHash(k));
    for (let l = 0; l < depth; l++) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zero[l];
        next.push(nodeHash(left, right));
      }
      level = next;
    }
    return level[0].toString("hex");
  };
}

// A published leaf is BigInt(hash160), so the 20-byte keyID is its big-endian bytes, left-padded.
// Both the oracle and the gateway derive keyIDs from the same `leaves`, so the SHA-256 root needs
// no extra snapshot field and the two roots provably describe one leaf set.
export function leafToKeyId(leaf) {
  const hex = BigInt(leaf).toString(16).padStart(40, "0");
  if (hex.length !== 40) throw new Error(`leaf exceeds 20 bytes: ${leaf}`);
  return Buffer.from(hex, "hex");
}

// Recompute the SHA-256 root from the ordered leaves given as decimal strings (the snapshot form),
// so the gateway can check a published shaRoot against its own arithmetic, the M3 discipline
// applied to the second root.
export function shaRootFromLeaves(leaves, depth = DEFAULT_DEPTH) {
  const hasher = makeShaDmlRootHasher(depth);
  return hasher(leaves.map((l) => leafToKeyId(l)));
}
