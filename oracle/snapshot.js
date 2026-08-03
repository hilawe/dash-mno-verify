// Assemble a DML snapshot from a chain source, factored out of the oracle CLI so the read
// logic is unit-testable. `call(method, params)` is injected, so a test can drive the
// height/list race and the CLI can pass either dash-cli or JSON-RPC without this module
// knowing which.
import { votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { makeShaDmlRootHasher, leafToKeyId } from "../common/dml_sha_root.js";

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
// The statuses masternodelist json emits for a deterministic masternode list. ENABLED is the valid
// set (the same one `protx list valid` returns) and POSE_BANNED is a node still in the list carrying
// a failed proof-of-service. Enumerated so an unknown status is a loud refusal rather than a silent
// exclusion; a Core release adding a status must be a deliberate update here.
const KNOWN_STATUSES = new Set(["ENABLED", "POSE_BANNED"]);

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

  // THE RESPONSE IS VALIDATED BEFORE IT IS FILTERED. This is the live twin of the boundary the
  // block-bound read now enforces, and it is the one actually wired in, so it matters more. Filtering
  // first means every malformed shape leaves quietly: an ARRAY response is accepted and ordered by
  // numeric index rather than by collateral outpoint, an entry with a missing or mistyped status is
  // dropped as if it were PoSe-banned, and a null entry dies on a raw property access. Each of those
  // publishes or refuses a SHORTENED member set, and no recompute downstream can notice, because the
  // root the oracle signs is the root of exactly the set it built.
  if (list === null || typeof list !== "object" || Array.isArray(list)) {
    throw new Error(
      `oracle: masternodelist json returned ${Array.isArray(list) ? "an array" : JSON.stringify(list)}, ` +
        `not an object keyed by collateral outpoint. The key is what the canonical order sorts by.`,
    );
  }
  const all = Object.entries(list);
  for (const [key, m] of all) {
    // "txid-index", the collateral outpoint. It is the sort key, so a malformed one makes the tree
    // order arbitrary rather than canonical.
    if (!/^[0-9a-f]{64}-\d+$/.test(key)) {
      throw new Error(`oracle: masternodelist key ${JSON.stringify(key)} is not a txid-index outpoint`);
    }
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new Error(`oracle: masternodelist entry ${key} is ${JSON.stringify(m)}, not an object`);
    }
    // The status must be one this build KNOWS, not merely a non-empty string. A typo or a status a
    // future Core adds would otherwise pass the shape check and then be filtered out as if the node
    // were banned, which is the same silent shortening of the member set, just one step later.
    // Refusing means a Core release that adds a status stops the oracle loudly, with the unknown
    // value named, instead of quietly publishing a tree missing everyone who carries it.
    if (!KNOWN_STATUSES.has(m.status)) {
      throw new Error(
        `oracle: masternodelist entry ${key} has status ${JSON.stringify(m.status)}, which this build ` +
          `does not know (expected one of ${[...KNOWN_STATUSES].join(", ")}). Treating an unknown ` +
          `status as not-ENABLED would silently drop a member from the tree.`,
      );
    }
    // Only an ENABLED entry contributes a leaf, so only it needs a usable address. Demanding one
    // from a banned entry would refuse a response that is entirely well formed.
    if (m.status === "ENABLED" && typeof m.votingaddress !== "string") {
      throw new Error(`oracle: masternodelist entry ${key} is ENABLED with a non-string votingaddress`);
    }
  }

  // Read each node's voting address. Sorting by the key gives every honest oracle the same tree.
  // The keys are validated outpoints and Object.entries cannot repeat a key, so the comparison is
  // total and the order is canonical.
  const entries = all.filter(([, m]) => m.status === "ENABLED");
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const realLeaves = entries.map(([key, m]) => {
    const leaf = votingAddressToLeaf(m.votingaddress);
    // The empty-leaf value pads the unused tree slots, so a real leaf equal to it would vanish
    // from the inclusion boundary. Unreachable for an honest hash160 (probability 2^-160), so
    // hitting it means corrupted or crafted input, and the oracle refuses rather than publishes.
    if (leaf === 0n) throw new Error(`oracle: voting address for ${key} decodes to the empty-leaf value`);
    return leaf;
  });

  // Two roots over the SAME ordered leaves. The Poseidon root is the full-pad build (depth `depth`,
  // empty slots 0, Poseidon(2) bottom up; test/dml_root.test.js pins the equivalence). The SHA-256
  // root is the zkVM registration tree (docs/ZKVM_INTEGRATION.md), derived from the same leaves, so
  // the two provably describe one leaf set and the gateway recomputes both.
  const rootFromLeaves = await makeDmlRootHasher(depth);
  const shaRootFromKeyIds = makeShaDmlRootHasher(depth);
  const leaves = realLeaves.map((x) => x.toString());

  return {
    // v2 snapshot: carries both roots. The version selects the signed-message form (common/oracle_sig.js)
    // and lets a gateway with any zkVM context require v2, refusing a downgraded v1 snapshot.
    version: 2,
    height,
    blockHash,
    depth,
    ts: now(),
    root: rootFromLeaves(leaves),
    // The SHA-256 root for the zkVM statement, 64 lowercase hex. Derived from the same leaves.
    shaRoot: shaRootFromKeyIds(realLeaves.map((x) => leafToKeyId(x))),
    // Publishing the ordered real leaves lets a prover rebuild the tree locally and pull
    // their own path. Which leaf is theirs is never revealed to anyone.
    leaves,
  };
}
