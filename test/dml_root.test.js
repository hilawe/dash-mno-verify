import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoseidon } from "circomlibjs";
import { makeDmlRootHasher, FIELD_PRIME } from "../core/dml_root.js";
import { MembersTree } from "../core/members_tree.js";

// The gateway's fast root recompute (cached zero-hashes, O(real leaves)) must produce exactly the
// root the oracle and MembersTree produce by padding to 2**depth and hashing every pair. If these
// ever diverge, the gateway would reject honest snapshots or, worse, accept dishonest ones, so this
// equivalence is the load-bearing invariant behind review finding M3.

const hasher = await makeDmlRootHasher(); // production depth 16

// One shared Poseidon for the small-depth reference, so the exhaustive sweep does not rebuild it.
const poseidon = await buildPoseidon();
const F = poseidon.F;
function fullPad(leaves, depth) {
  let level = leaves.map((x) => F.e(BigInt(x)));
  while (level.length < 2 ** depth) level.push(F.e(0n));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
    level = next;
  }
  return F.toObject(level[0]).toString();
}

// Exhaustive at small depths (every leaf count, including the odd/even boundaries), which is cheap
// because the trees are tiny. The fast hasher is depth-parametric, so matching here exercises the
// same code path it runs at depth 16.
test("the fast recompute matches a full-pad build at every leaf count (small depths)", async () => {
  for (const depth of [1, 2, 3, 4]) {
    const h = await makeDmlRootHasher(depth);
    for (let n = 0; n <= 2 ** depth; n++) {
      const leaves = Array.from({ length: n }, (_, i) => String(i * 7 + 1));
      assert.equal(h(leaves), fullPad(leaves, depth), `depth ${depth}, ${n} leaves`);
    }
  }
});

// One production-depth case pins the hasher against the actual MembersTree the season rebuild uses.
test("the fast recompute matches MembersTree at the production depth", async () => {
  const leaves = ["5", "9", "13", "21", "34"];
  const t = await MembersTree.fromCommitments(leaves);
  assert.equal(hasher(leaves), t.root());
});

test("recompute is order sensitive, so a reordered leaf set gives a different root", async () => {
  assert.notEqual(hasher(["1", "2", "3"]), hasher(["3", "2", "1"]));
});

test("more leaves than the tree can hold is rejected", async () => {
  const tiny = await makeDmlRootHasher(2); // capacity 4
  assert.throws(() => tiny(["1", "2", "3", "4", "5"]), /exceeds tree capacity/);
});

test("the exported field prime matches the live Poseidon field modulus", () => {
  // Pins the canonical-leaf bound the gateway enforces against the actual field, so it cannot drift.
  assert.equal(FIELD_PRIME, F.p);
});
