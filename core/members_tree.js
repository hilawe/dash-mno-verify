// The members tree for the two-tier flow. Registration appends a member commitment here,
// and the cheap per-epoch proof shows membership in it. Poseidon hashing identical to the
// oracle and the DML tree, so depth and hashing never drift.
//
// THE ROOT IS MAINTAINED INCREMENTALLY; the full level array is built only for the callers that
// genuinely need sibling paths.
//
// It used to rebuild every level on any change: pad to 65,536 leaves and compute 65,535 Poseidon
// hashes for one appended member. A reviewer measured about 9 seconds for one root and 19.6 seconds
// for a first-context commit, all of it blocking the event loop, which means one ordinary
// registration made the whole gateway unresponsive for twenty seconds and repeated ones could keep
// it that way. The cost was proportional to the tree's CAPACITY rather than to the number of
// members, so it did not shrink for a small community.
//
// A left-filled, zero-padded tree of fixed depth admits the standard frontier: hold one cached left
// sibling per level plus the precomputed all-zero subtree roots, and an append touches exactly
// `depth` nodes. The root it produces is BYTE-FOR-BYTE the root the full build produces, which is
// not a nicety: existing durable registrations and every proof already generated are checked against
// roots built the old way, so a different root would silently invalidate them all. That equivalence
// is the property the tests pin, over every size from empty to past a subtree boundary.
//
// levels() and pathFor() still do the full build, because a sibling path genuinely needs the whole
// tree. The gateway never calls them (a prover fetches commitments from /v1/members and builds its
// own tree), so they are off the request path.
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
    this._levels = null;   // full-build cache for pathFor(), invalidated on append
    // zeros[l] is the root of an all-zero subtree of height l, so zeros[0] is the empty leaf and
    // zeros[depth] is the root of an entirely empty tree. Computed once per instance, depth hashes.
    this._zeros = [this.F.e(0n)];
    for (let l = 0; l < depth; l += 1) {
      this._zeros.push(this.poseidon([this._zeros[l], this._zeros[l]]));
    }
    // The left sibling waiting at each level for its right-hand partner. Only the entries below the
    // current fill height are meaningful, which is why every read of one is guarded by the parity of
    // the index at that level.
    this._frontier = new Array(depth).fill(null);
    this._root = this._zeros[depth];
  }

  // `poseidon` is injectable so a caller can REUSE one instead of paying buildPoseidon() per tree,
  // and so a test can wrap it to count hashes. IT MUST BE THE circomlibjs POSEIDON the circuits are
  // compiled against, or over the same field: a different hash or field produces roots no proof can
  // ever satisfy, and nothing here can detect that. The constructor was always public and took the
  // same argument, so this widens nothing, but the contract is worth stating where a caller reads it. Counting is the only way to pin the performance
  // properties here: both rebuild strategies produce identical roots, so no assertion about a root
  // can tell which ran, and asserting on the level cache only observes whether a cache was left
  // warm, which a mutation can satisfy while doing the expensive work anyway. Two reviewers landed
  // on that same point about two different tests.
  static async create(depth = TREE_DEPTH, poseidon = null) {
    return new MembersTree(poseidon ?? (await buildPoseidon()), depth);
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
  static async fromCommitments(commitments = [], depth = TREE_DEPTH, poseidon = null) {
    const t = new MembersTree(poseidon ?? (await buildPoseidon()), depth);
    // Refuse to materialize an over-capacity bucket rather than build a deeper tree whose root no
    // prover-generated path can reach. A durable record set this large means the commit-side guard
    // was bypassed, so surface it here instead of serving a root that silently verifies nothing.
    if (commitments.length > t.capacity()) {
      throw new Error(
        `members tree over capacity: ${commitments.length} commitments for a depth-${depth} tree (max ${t.capacity()})`,
      );
    }
    // WHICHEVER REBUILD IS CHEAPER, because they cross over and the crossing is inside the range
    // this tree is built for. Appending one at a time costs depth hashes per member; the padded full
    // build costs capacity-1 hashes whatever the member count. So they meet at capacity/depth, which
    // at depth 16 is 4096 members, and MEASURED on this machine: 1000 members take 2.2s
    // incrementally against 7.7s for a full build, 4096 take 9.1s against that same 7.7s, and 30,000
    // take 62.3s.
    //
    // This matters because fromCommitments is the RECOVERY path, reached lazily on the first touch of
    // a context after a boot or a rollover (see _materializeFrom in core/season.js, which builds on
    // demand rather than eagerly at the rollover itself), and it is one synchronous block. Making appends cheap while making recovery
    // unboundedly worse would have moved the twenty-second stall rather than removed it, which a
    // reviewer caught by measuring it rather than by reading the code.
    //
    // Above the crossover the full build runs once and the frontier is DERIVED from it, so later
    // appends stay incremental either way.
    //
    // THE COMPARISON IS ON HASH COUNTS ONLY, and that is a narrower claim than "whichever is
    // faster". Replaying costs N*depth hashes, the padded build costs capacity-1, and the branch
    // picks the smaller. It does NOT model the constant factors, so around the crossing the two are
    // within noise of each other and the measured wall times do not line up exactly with the hash
    // counts (at depth 16 and 4096 members the replay measured 9.1s against the full build's 7.7s,
    // even though the hash counts are near-equal). Being wrong by a few seconds in a narrow band is
    // acceptable; being wrong by 54 seconds at 30,000 members was not, and that is what this fixes.
    // The strict `<` keeps the exactly-equal case on the full-build side, where the measurement says
    // it belongs.
    for (const c of commitments) t.commitments.push(String(c));
    if (t.commitments.length * depth < t.capacity() - 1) {
      const replay = t.commitments;
      t.commitments = [];
      for (const c of replay) t.append(c);
    } else {
      t.#seedFromFullBuild();
    }
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
    // CONVERT BEFORE COMMITTING. The conversion can throw on a value that is not a decimal integer,
    // and doing it after the push left the tree holding the bad entry with `_root` never updated, so
    // size() had grown, commitments contained it, and root() silently returned the root of the
    // PREVIOUS leaf set while a full rebuild threw. The old code could not do that, because root()
    // recomputed from commitments and so failed the same way every time; caching the root is what
    // turned a loud failure into a quiet disagreement between root() and pathFor(). No reachable
    // caller passes a non-decimal today (the commitment is canonical-field-checked in both decoders),
    // but the guard that makes it unreachable is upstream and one refactor away from moving.
    const leafF = this.F.e(BigInt(commitmentDec));
    const index = this.commitments.length;
    this.commitments.push(commitmentDec);
    this._levels = null;
    this.#insert(leafF, index);
    return index;
  }

  // One appended leaf touches exactly `depth` nodes. A throw from the hash partway up would leave the
  // lower frontier entries written and `_root` stale, with no rollback. That is the same
  // compute-then-commit gap as append()'s, and it is not closed here: the hash is over field elements
  // that have already been converted, so there is no input it rejects. Stated rather than guarded,
  // because a guard for an unreachable case is a guard nobody can test. At each level the leaf's index parity says
  // whether this node is a LEFT child, in which case it is cached as the frontier and paired with an
  // empty subtree for now, or a RIGHT child, in which case it is paired with the left sibling cached
  // earlier. Pairing with zeros[l] rather than with nothing is what keeps the tree exactly `depth`
  // deep and the root equal to the padded full build's.
  #insert(leafF, index) {
    let cur = leafF;
    let idx = index;
    for (let l = 0; l < this.depth; l += 1) {
      let left;
      let right;
      if ((idx & 1) === 0) {
        this._frontier[l] = cur;
        left = cur;
        right = this._zeros[l];
      } else {
        left = this._frontier[l];
        right = cur;
      }
      cur = this.poseidon([left, right]);
      idx >>= 1;
    }
    this._root = cur;
  }

  // Derive the frontier and the root from one full padded build, for the case where that is cheaper
  // than replaying every append. For a future append at index N, level l reads the frontier only when
  // (N >> l) is odd, and the value it needs is the completed subtree immediately to its left, which
  // is exactly levels[l][(N >> l) - 1]. Levels where it is even are written before they are read, so
  // they need no seed.
  #seedFromFullBuild() {
    const levels = this.levels();
    const n = this.commitments.length;
    for (let l = 0; l < this.depth; l += 1) {
      const idx = n >> l;
      if ((idx & 1) === 1) this._frontier[l] = levels[l][idx - 1];
    }
    this._root = levels.at(-1)[0];
    // AND DROP THE LEVEL ARRAY. levels() built and cached the whole padded tree, 131,071 nodes at
    // depth 16, and everything needed from it (the frontier entries and the root) has now been
    // copied out. Leaving it cached meant a recovery rebuild silently retained the entire tree for
    // the life of the process, or until an append happened to null it, which is a memory cost with
    // no consumer: the gateway never asks for a path. Measured at 131,071 retained nodes before this
    // line existed. The replay branch never had the problem, because append() nulls the cache.
    this._levels = null;
  }

  // THE EXPENSIVE PATH, O(capacity), for sibling paths only. The gateway never calls this; a prover
  // fetches commitments from /v1/members and builds its own tree. Kept lazy and cached.
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

  // O(1). The frontier already holds it, updated by the last append.
  root() {
    return this.F.toObject(this._root).toString();
  }

  // The reference root, from a full padded rebuild. Kept because it is the definition the
  // incremental root must agree with, and the tests compare the two rather than trusting one.
  rootFromFullBuild() {
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
