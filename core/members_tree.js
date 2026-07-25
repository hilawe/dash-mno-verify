// The members tree for the two-tier flow. Registration appends a member commitment here,
// and the cheap per-epoch proof shows membership in it. Poseidon hashing identical to the
// oracle and the DML tree, so depth and hashing never drift.
//
// This is a simple reference: it recomputes the tree when commitments change and caches
// the result. A production deployment would use an incremental Merkle tree.
import { buildPoseidon } from "circomlibjs";

// Must match the depth the circuits are compiled for. The per-instance override exists so capacity
// behaviour can be tested at a small depth; production always uses this default.
const TREE_DEPTH = 16;

export class MembersTree {
  constructor(poseidon, depth = TREE_DEPTH) {
    this.poseidon = poseidon;
    this.F = poseidon.F;
    this.depth = depth;
    this.commitments = []; // field elements as decimal strings
    this._levels = null;   // cache, invalidated on append
  }

  static async create(depth = TREE_DEPTH) {
    return new MembersTree(await buildPoseidon(), depth);
  }

  // How many commitments this tree can hold. Past it the zero-padding in levels() is skipped and the
  // tree silently grows deeper than the circuit verifies against, so it is a hard boundary rather
  // than a soft one. See append().
  capacity() {
    return 2 ** this.depth;
  }

  full() {
    return this.commitments.length >= this.capacity();
  }

  // Rebuild a tree from a season's persisted commitments, in the order they were registered.
  // Used at boot and at a season boundary so the in-memory tree is a cache of the durable
  // registration records, never the source of truth.
  static async fromCommitments(commitments = [], depth = TREE_DEPTH) {
    const t = new MembersTree(await buildPoseidon(), depth);
    // Refuse to materialize an over-capacity bucket rather than build a deeper tree whose root no
    // prover-generated path can reach. A durable record set this large means the commit-side guard
    // was bypassed, so surface it here instead of serving a root that silently verifies nothing.
    if (commitments.length > t.capacity()) {
      throw new Error(
        `members tree over capacity: ${commitments.length} commitments for a depth-${depth} tree (max ${t.capacity()})`,
      );
    }
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

  // Past capacity, levels() would skip its zero-padding and build a tree deeper than TREE_DEPTH.
  // Depending on how far past, that either throws mid-hash (an odd level length pairs a node with
  // undefined) or, at an exact power of two, succeeds and publishes a root that pathFor can never
  // produce a path to, so every proof fails verification with no error anywhere. Both are worse than
  // refusing the append, and the caller must check full() before writing anything durable.
  append(commitmentDec) {
    if (this.full()) {
      throw new Error(`members tree is full: ${this.capacity()} commitments at depth ${this.depth}`);
    }
    const index = this.commitments.length;
    this.commitments.push(commitmentDec);
    this._levels = null;
    return index;
  }

  levels() {
    if (this._levels) return this._levels;
    const F = this.F;
    let level = this.commitments.map((x) => F.e(BigInt(x)));
    while (level.length < this.capacity()) level.push(F.e(0n));
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
    for (let l = 0; l < this.depth; l++) {
      pathElements.push(this.F.toObject(levels[l][idx ^ 1]).toString());
      pathIndices.push(idx & 1);
      idx >>= 1;
    }
    return { pathElements, pathIndices };
  }
}
