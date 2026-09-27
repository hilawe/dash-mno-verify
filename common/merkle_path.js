// A Merkle path and root for one leaf, built from the occupied branches only.
//
// Every tree in this project has the same shape: Poseidon over pairs, left-filled, padded with the
// zero leaf to a fixed depth (16, so 65,536 slots). The member-side provers used to build that tree
// in full, padding to 65,536 leaves and hashing 65,535 nodes, so a one-member community cost about
// eight seconds of hashing before the proof even started (review finding F3, 2026-09-27). Here each
// level holds only the nodes that have a real leaf beneath them, and a missing right sibling at level
// l is the precomputed root of an all-zero subtree of height l. The result is identical to the padded
// build (test/merkle_path.test.js compares them at every index and size tried, and folds each path
// back to its root), at about 2n + depth hashes instead of 2^depth.
//
// The path is built from the full leaf list the member already holds. Asking a server for one
// member's path would tell it which leaf the member is, which is what the proof exists to hide.
export function merklePathFor(poseidon, leavesDec, index, depth = 16) {
  const F = poseidon.F;
  if (!Array.isArray(leavesDec) || leavesDec.length === 0) throw new Error("merklePathFor: no leaves");
  if (leavesDec.length > 2 ** depth) throw new Error(`merklePathFor: ${leavesDec.length} leaves exceed the capacity ${2 ** depth}`);
  if (!Number.isInteger(index) || index < 0 || index >= leavesDec.length) throw new Error(`merklePathFor: index ${index} is not a leaf`);

  // zeros[l] is the root of an all-zero subtree of height l, so zeros[0] is the empty leaf itself.
  const zeros = [F.e(0n)];
  for (let l = 0; l < depth; l++) zeros.push(poseidon([zeros[l], zeros[l]]));

  let level = leavesDec.map((x) => F.e(BigInt(x)));
  let idx = index;
  const pathElements = [];
  const pathIndices = [];
  for (let l = 0; l < depth; l++) {
    const sibling = idx ^ 1;
    pathElements.push(F.toObject(sibling < level.length ? level[sibling] : zeros[l]).toString());
    pathIndices.push(idx & 1); // 0 = this node is the left child, 1 = the right child
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], i + 1 < level.length ? level[i + 1] : zeros[l]]));
    level = next;
    idx >>= 1;
  }
  return { pathElements, pathIndices, root: F.toObject(level[0]).toString() };
}
