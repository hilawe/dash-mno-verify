// Turn the live Dash deterministic masternode list into a Poseidon Merkle root.
//
// The output is fully reproducible from public chain data, so any third party can
// recompute the root and catch a dishonest oracle. The oracle sees only public data,
// so it learns nothing private. Run two or three of these on independent nodes and
// require their roots to agree, or have the gateway recompute locally.
//
// Usage: node oracle/oracle.js [--out oracle/root.json]
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildPoseidon } from "circomlibjs";
import { votingAddressToLeaf } from "../common/dml.js";

const TREE_DEPTH = 16; // up to 65536 leaves; raise if the network grows past that
const EMPTY_LEAF = 0n;

const { values } = parseArgs({
  options: { out: { type: "string", default: "oracle/root.json" } },
});

const dashCli = (args) =>
  JSON.parse(execFileSync("dash-cli", args, { encoding: "utf8" }));

const poseidon = await buildPoseidon();
const F = poseidon.F;

const height = dashCli(["getblockcount"]);
const mns = dashCli(["protx", "list", "valid", "1"]);

// Deterministic leaf order so every honest oracle builds the identical tree.
mns.sort((a, b) => (a.proTxHash < b.proTxHash ? -1 : 1));
const realLeaves = mns.map((m) => votingAddressToLeaf(m.state.votingAddress));

const leaves = realLeaves.slice();
while (leaves.length < 2 ** TREE_DEPTH) leaves.push(EMPTY_LEAF);

// Bottom-up Poseidon(2), identical hashing to the Circom MerkleInclusion template.
let level = leaves.map((x) => F.e(x));
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
  level = next;
}

const snapshot = {
  height,
  depth: TREE_DEPTH,
  ts: Math.floor(Date.now() / 1000),
  root: F.toObject(level[0]).toString(),
  // Publishing the ordered real leaves lets a prover rebuild the tree locally and
  // pull its own path. Which leaf is theirs is never revealed to anyone.
  leaves: realLeaves.map((x) => x.toString()),
};

await writeFile(values.out, JSON.stringify(snapshot));
console.error(`[oracle] height ${height}, ${realLeaves.length} nodes, root ${snapshot.root.slice(0, 12)}... -> ${values.out}`);
