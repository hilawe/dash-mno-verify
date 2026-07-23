// Assemble a DML snapshot from a chain source, factored out of the oracle CLI so the read
// logic is unit-testable. `call(method, params)` is injected, so a test can drive the
// height/list race and the CLI can pass either dash-cli or JSON-RPC without this module
// knowing which.
import { votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../core/dml_root.js";

export const TREE_DEPTH = 16; // up to 65536 leaves; raise if the network grows past that

// Read the chain tip and the masternode list at one consistent height, then build the
// snapshot object (unsigned; the CLI adds signatures).
//
// The signed block hash anchors the snapshot to a chain position (so the gateway can later tell a
// genuine reorg from a replayed lower height, and an SPV check can pin it to the chain), so the
// height, the block hash, and the masternode list it describes must all be read at the same chain
// tip. A block landing mid-read would sign a block hash for one height and a list from another.
// Bracket the reads with the height before and after and retry if it moved, so the three agree.
export async function buildSnapshot({
  call,
  depth = TREE_DEPTH,
  maxAttempts = 5,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  let height, blockHash, list;
  for (let attempt = 1; ; attempt++) {
    height = await call("getblockcount", []);
    blockHash = await call("getblockhash", [height]);
    // masternodelist json returns a map keyed by "txid-index" with every node. The only other
    // status is POSE_BANNED, so keeping status === "ENABLED" is the valid-masternode filter,
    // the same set as `protx list valid`. Evonodes are included and carry a votingaddress too.
    list = await call("masternodelist", ["json"]);
    const after = await call("getblockcount", []);
    if (after === height) break; // no block landed during the read, so list and blockHash share height
    if (attempt >= maxAttempts) {
      throw new Error(`oracle: chain height kept advancing during the read (${height} -> ${after})`);
    }
    log(`[oracle] height advanced during read (${height} -> ${after}), retrying`);
  }

  // Read each node's voting address. Sorting by the key gives every honest oracle the same tree.
  const entries = Object.entries(list).filter(([, m]) => m.status === "ENABLED");
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const realLeaves = entries.map(([, m]) => votingAddressToLeaf(m.votingaddress));

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
