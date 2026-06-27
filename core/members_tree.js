// The members tree for the two-tier flow. Registration appends a member commitment here,
// and the cheap per-epoch proof shows membership in it. Poseidon hashing identical to the
// oracle and the DML tree, so depth and hashing never drift.
//
// This is a simple reference: it recomputes the tree when commitments change and caches
// the result. A production deployment would use an incremental Merkle tree.
import { buildPoseidon } from "circomlibjs";

const TREE_DEPTH = 16;

export class MembersTree {
  constructor(poseidon) {
    this.poseidon = poseidon;
    this.F = poseidon.F;
    this.commitments = []; // field elements as decimal strings
    this._levels = null;   // cache, invalidated on append
  }

  static async create() {
    return new MembersTree(await buildPoseidon());
  }

  // Rebuild a tree from a season's persisted commitments, in the order they were registered.
  // Used at boot and at a season boundary so the in-memory tree is a cache of the durable
  // registration records, never the source of truth.
  static async fromCommitments(commitments = []) {
    const t = new MembersTree(await buildPoseidon());
    for (const c of commitments) t.commitments.push(String(c));
    t._levels = null;
    return t;
  }

  size() {
    return this.commitments.length;
  }

  has(commitmentDec) {
    return this.commitments.includes(commitmentDec);
  }

  append(commitmentDec) {
    const index = this.commitments.length;
    this.commitments.push(commitmentDec);
    this._levels = null;
    return index;
  }

  levels() {
    if (this._levels) return this._levels;
    const F = this.F;
    let level = this.commitments.map((x) => F.e(BigInt(x)));
    while (level.length < 2 ** TREE_DEPTH) level.push(F.e(0n));
    const levels = [level];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(this.poseidon([level[i], level[i + 1]]));
      level = next;
      levels.push(level);
    }
    this._levels = levels;
    return levels;
  }

  root() {
    const levels = this.levels();
    return this.F.toObject(levels.at(-1)[0]).toString();
  }

  pathFor(index) {
    const levels = this.levels();
    const pathElements = [];
    const pathIndices = [];
    let idx = index;
    for (let l = 0; l < TREE_DEPTH; l++) {
      pathElements.push(this.F.toObject(levels[l][idx ^ 1]).toString());
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  }
}
