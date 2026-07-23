// Recompute a DML or members Merkle root from the ordered real leaves, so the gateway can check an
// oracle snapshot against its own arithmetic instead of taking the published root on faith. The
// oracle already publishes the ordered real leaves (oracle/oracle.js). This catches an inconsistent
// or transport-corrupted snapshot, where the published root does not hash from the published
// leaves. It does NOT authenticate the leaf set itself: a compromised source can publish a forged
// but self-consistent pair, so closing that needs a signed root, Platform-published data, or an
// independent Dash Core cross-check (tracked in TODO.md). The recompute is the verification
// substrate those build on, plus cheap defense in depth against corruption and a naive tamper.
//
// The tree is the same one the oracle and MembersTree build: depth 16, the unused right slots
// padded with the empty leaf 0, Poseidon(2) bottom up. The difference is cost. A full build pads to
// 2**depth leaves and hashes every pair, which is about 65000 Poseidon calls per refresh. Here the
// all-zero right subtrees collapse to one cached constant per level (zero[l] is the root of an
// all-empty subtree of height l), so the work is O(real leaves), not O(2**depth), while the root is
// identical to the full build. test/dml_root.test.js pins that equivalence against MembersTree.
import { buildPoseidon } from "circomlibjs";
// The Poseidon field is the BN254 scalar field. FIELD_PRIME and the canonical-element check live in
// common/field.js, the neutral home for the field convention; they are re-exported here so existing
// importers and the equivalence test (which pins FIELD_PRIME against the live Poseidon modulus so it
// cannot drift) keep working.
export { FIELD_PRIME, isCanonicalField } from "./field.js";

const DEFAULT_DEPTH = 16;

export async function makeDmlRootHasher(depth = DEFAULT_DEPTH) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // zero[l] = root of an all-empty subtree of height l. zero[0] is the empty leaf itself.
  const zero = [F.e(0n)];
  for (let l = 1; l <= depth; l++) zero[l] = poseidon([zero[l - 1], zero[l - 1]]);

  // leaves: ordered real leaves as decimal strings (or anything BigInt() accepts). The rest of the
  // 2**depth slots are the empty leaf, so a missing right sibling at level l is zero[l].
  return function rootFromLeaves(leaves) {
    if (leaves.length > 2 ** depth) {
      throw new Error(`leaf count ${leaves.length} exceeds tree capacity ${2 ** depth}`);
    }
    if (leaves.length === 0) return F.toObject(zero[depth]).toString();

    let level = leaves.map((x) => F.e(BigInt(x)));
    for (let l = 0; l < depth; l++) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zero[l];
        next.push(poseidon([left, right]));
      }
      level = next;
    }
    return F.toObject(level[0]).toString();
  };
}
