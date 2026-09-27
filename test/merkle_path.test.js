import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoseidon } from "circomlibjs";
import { merklePathFor } from "../common/merkle_path.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { MembersTree } from "../core/members_tree.js";

// Review finding F3. The provers built the whole padded tree for one path. merklePathFor builds only
// the occupied branches, and must give the IDENTICAL path and root, since the circuits were checked
// against the padded build. These compare it with that old build, with two other root
// implementations in this repository, and with the path folded back to its root.

const poseidon = await buildPoseidon();
const F = poseidon.F;

// The old padded build, copied as it was, as the reference.
function paddedPath(leavesDec, index, depth) {
  let level = leavesDec.map((x) => F.e(BigInt(x)));
  while (level.length < 2 ** depth) level.push(F.e(0n));
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
    level = next;
    levels.push(level);
  }
  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let l = 0; l < depth; l++) {
    pathElements.push(F.toObject(levels[l][idx ^ 1]).toString());
    pathIndices.push(idx & 1);
    idx >>= 1;
  }
  return { pathElements, pathIndices, root: F.toObject(levels.at(-1)[0]).toString() };
}

// Hash the leaf up its path, as the circuit does.
function fold(leaf, { pathElements, pathIndices }) {
  let cur = F.e(BigInt(leaf));
  for (let l = 0; l < pathElements.length; l++) {
    const sib = F.e(BigInt(pathElements[l]));
    cur = pathIndices[l] === 0 ? poseidon([cur, sib]) : poseidon([sib, cur]);
  }
  return F.toObject(cur).toString();
}

const leavesOf = (n) => Array.from({ length: n }, (_, i) => String(1000003n * BigInt(i + 1)));

test("identical to the padded build at every index of every size, at depth 5", () => {
  const depth = 5;
  for (let n = 1; n <= 2 ** depth; n++) {
    const leaves = leavesOf(n);
    for (let i = 0; i < n; i++) {
      assert.deepEqual(merklePathFor(poseidon, leaves, i, depth), paddedPath(leaves, i, depth), `n=${n} i=${i}`);
    }
  }
});

test("identical to the padded build at the real depth of 16", () => {
  // One case at full depth, since the padded reference costs 65,535 hashes each time.
  const leaves = leavesOf(3);
  assert.deepEqual(merklePathFor(poseidon, leaves, 2), paddedPath(leaves, 2, 16));
});

test("at depth 16 the root matches two independent root implementations, and every path folds to it", async () => {
  const dmlRoot = await makeDmlRootHasher();
  for (const n of [1, 2, 3, 17, 100]) {
    const leaves = leavesOf(n);
    const tree = await MembersTree.create();
    for (const l of leaves) tree.append(l);
    for (const i of [0, Math.floor(n / 2), n - 1]) {
      const p = merklePathFor(poseidon, leaves, i);
      assert.equal(p.root, dmlRoot(leaves), `n=${n} i=${i} against dml_root`);
      assert.equal(p.root, tree.root(), `n=${n} i=${i} against the members tree frontier`);
      assert.equal(fold(leaves[i], p), p.root, `n=${n} i=${i} path folds to the root`);
      assert.equal(p.pathElements.length, 16);
    }
  }
});

test("a one-member path costs 32 hashes instead of 65,535", () => {
  let calls = 0;
  const counting = Object.assign((x) => { calls++; return poseidon(x); }, { F: poseidon.F });
  merklePathFor(counting, leavesOf(1), 0);
  assert.equal(calls, 32, "16 empty-subtree roots plus one hash per level");
});

test("bad input is refused rather than producing a wrong path", () => {
  assert.throws(() => merklePathFor(poseidon, [], 0), /no leaves/);
  assert.throws(() => merklePathFor(poseidon, leavesOf(3), 3), /not a leaf/);
  assert.throws(() => merklePathFor(poseidon, leavesOf(3), -1), /not a leaf/);
  assert.throws(() => merklePathFor(poseidon, leavesOf(5), 0, 2), /exceed the capacity/);
});
