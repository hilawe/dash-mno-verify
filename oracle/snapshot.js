// Assemble a DML snapshot from a chain source, factored out of the oracle CLI so the read
// logic is unit-testable. `call(method, params)` is injected, so a test can drive the
// height/list race and the CLI can pass either dash-cli or JSON-RPC without this module
// knowing which.
import { votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";

export const TREE_DEPTH = 16; // up to 65536 leaves; raise if the network grows past that

// Read the chain tip and the masternode list at one consistent height, then build the
// snapshot object (unsigned; the CLI adds signatures).
//
// The signed block hash anchors the snapshot to a chain position (so the gateway can later tell a
// genuine reorg from a replayed lower height, and an SPV check can pin it to the chain), so the
// height, the block hash, and the masternode list it describes must all be read at the same chain
// tip. A block landing mid-read would sign a block hash for one height and a list from another, and
// a same-height reorg mid-read would sign one branch's hash over the other branch's list. Bracket
// the reads with the tip identity, height AND hash, before and after, and retry if either moved, so
// the three agree. The retry waits retryDelayMs so a node catching up on blocks (where the tip
// moves every read) gets a chance to settle instead of burning every attempt in milliseconds.
//
// Known residual: bracketing cannot detect an A -> B -> A sequence, a reorg away from the observed
// tip and back to it entirely inside one read window, because masternodelist has no block-bound
// form and both bracket reads see tip A. The window is one RPC round-trip and the sequence needs
// two opposite reorgs inside it, and the torn result stays internally consistent (the root still
// hashes from the published leaves), so the only corrupted claim is which branch the signed block
// hash names. Closing it for real means a block-bound list read or verifying the leaves against
// the on-chain commitment at the signed hash, both tracked with the chain-anchor item in TODO.md.
// The concrete block-bound candidate is Dash Core's protx diff, whose response names the block
// hash it describes, so the oracle could demand that hash equal the sampled tip; it needs a
// live-node check that the diff carries the voting address and validity fields this read uses.
export async function buildSnapshot({
  call,
  depth = TREE_DEPTH,
  maxAttempts = 5,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
  retryDelayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let height, blockHash, list;
  for (let attempt = 1; ; attempt++) {
    height = await call("getblockcount", []);
    blockHash = await call("getblockhash", [height]);
    // masternodelist json returns a map keyed by "txid-index" with every node. The only other
    // status is POSE_BANNED, so keeping status === "ENABLED" is the valid-masternode filter,
    // the same set as `protx list valid`. Evonodes are included and carry a votingaddress too.
    list = await call("masternodelist", ["json"]);
    const afterHeight = await call("getblockcount", []);
    const afterHash = await call("getblockhash", [afterHeight]);
    // Same height and same hash, so no block landed and no branch swap happened during the read,
    // and the list shares the tip the signed hash names.
    if (afterHeight === height && afterHash === blockHash) break;
    if (attempt >= maxAttempts) {
      throw new Error(`oracle: chain tip kept moving during the read (${height} -> ${afterHeight})`);
    }
    log(`[oracle] chain tip moved during read (${height} -> ${afterHeight}), retrying`);
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }

  // Read each node's voting address. Sorting by the key gives every honest oracle the same tree.
  const entries = Object.entries(list).filter(([, m]) => m.status === "ENABLED");
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const realLeaves = entries.map(([key, m]) => {
    const leaf = votingAddressToLeaf(m.votingaddress);
    // The empty-leaf value pads the unused tree slots, so a real leaf equal to it would vanish
    // from the inclusion boundary. Unreachable for an honest hash160 (probability 2^-160), so
    // hitting it means corrupted or crafted input, and the oracle refuses rather than publishes.
    if (leaf === 0n) throw new Error(`oracle: voting address for ${key} decodes to the empty-leaf value`);
    return leaf;
  });

  // Same tree as the full-pad build (depth `depth`, empty slots 0, Poseidon(2) bottom up);
  // test/dml_root.test.js pins the equivalence against MembersTree.
  const rootFromLeaves = await makeDmlRootHasher(depth);
  const leaves = realLeaves.map((x) => x.toString());

  return {
    height,
    blockHash,
    depth,
    ts: now(),
    root: rootFromLeaves(leaves),
    // Publishing the ordered real leaves lets a prover rebuild the tree locally and pull
    // their own path. Which leaf is theirs is never revealed to anyone.
    leaves,
  };
}
