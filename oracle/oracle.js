// Turn the live Dash deterministic masternode list into a Poseidon Merkle root.
//
// Source of truth is a real Dash node. Two ways to reach one:
//   - local dash-cli on PATH (the default), or
//   - a JSON-RPC endpoint via MNO_RPC_URL (your own dashd, or a provider like GetBlock).
//
// Auth for the RPC endpoint:
//   - MNO_RPC_USER and MNO_RPC_PASS  -> HTTP basic auth (a local dashd's rpcuser/rpcpassword)
//   - MNO_RPC_HEADER="x-api-key: ..." -> a custom header (hosted providers)
//
// The output is reproducible from public chain data, so anyone can recompute the root and
// catch a dishonest oracle. The oracle sees only public data, so it learns nothing private.
//
// Usage: node oracle/oracle.js [--out oracle/root.json]
import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import process from "node:process";
import { createPrivateKey } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { votingAddressToLeaf } from "../common/dml.js";
import { addSignature } from "../common/oracle_sig.js";

const TREE_DEPTH = 16; // up to 65536 leaves; raise if the network grows past that
const EMPTY_LEAF = 0n;
const RPC_URL = process.env.MNO_RPC_URL; // set to use JSON-RPC; otherwise local dash-cli

const { values } = parseArgs({
  options: { out: { type: "string", default: "oracle/root.json" } },
});

async function rpc(method, params = []) {
  const headers = { "content-type": "application/json" };
  if (process.env.MNO_RPC_USER) {
    const cred = `${process.env.MNO_RPC_USER}:${process.env.MNO_RPC_PASS ?? ""}`;
    headers.authorization = "Basic " + Buffer.from(cred).toString("base64");
  }
  if (process.env.MNO_RPC_HEADER) {
    const [k, ...v] = process.env.MNO_RPC_HEADER.split(":");
    headers[k.trim().toLowerCase()] = v.join(":").trim();
  }
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "mno-oracle", method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} -> HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

function cli(args) {
  return JSON.parse(execFileSync("dash-cli", args, { encoding: "utf8" }));
}

const call = (method, params) => (RPC_URL ? rpc(method, params) : cli([method, ...params.map(String)]));

const poseidon = await buildPoseidon();
const F = poseidon.F;

// The signed block hash anchors the snapshot to a chain position (so the gateway can later tell a
// genuine reorg from a replayed lower height, and an SPV check can pin it to the chain), so the height,
// the block hash, and the masternode list it describes must all be read at the same chain tip. A block
// landing mid-read would sign a block hash for one height and a list from another. Bracket the reads
// with the height before and after and retry if it moved, so the three agree.
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
  if (attempt >= 5) throw new Error(`oracle: chain height kept advancing during the read (${height} -> ${after})`);
  console.error(`[oracle] height advanced during read (${height} -> ${after}), retrying`);
}

// Read each node's voting address. Sorting by the key gives every honest oracle the same tree.
const entries = Object.entries(list).filter(([, m]) => m.status === "ENABLED");
entries.sort(([a], [b]) => (a < b ? -1 : 1));
const realLeaves = entries.map(([, m]) => votingAddressToLeaf(m.votingaddress));

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
  blockHash,
  depth: TREE_DEPTH,
  ts: Math.floor(Date.now() / 1000),
  root: F.toObject(level[0]).toString(),
  // Publishing the ordered real leaves lets a prover rebuild the tree locally and pull
  // their own path. Which leaf is theirs is never revealed to anyone.
  leaves: realLeaves.map((x) => x.toString()),
};

// Sign the snapshot if a key is configured, so the gateway can authenticate the leaf set against a
// pinned oracle key rather than trusting whoever serves the JSON. MNO_ORACLE_SIGNING_KEY is a PKCS8
// PEM, inline or a file path. The signature covers the root, which commits to the leaves. An operator
// running a quorum signs the same snapshot with each oracle and merges the `sigs` entries.
const keyEnv = process.env.MNO_ORACLE_SIGNING_KEY;
if (keyEnv) {
  const pem = keyEnv.includes("BEGIN") ? keyEnv : await readFile(keyEnv, "utf8");
  snapshot.sigs = addSignature(snapshot, createPrivateKey(pem));
}

await writeFile(values.out, JSON.stringify(snapshot));
console.error(
  `[oracle] ${RPC_URL ? "rpc" : "dash-cli"} height ${height}, ${realLeaves.length} ENABLED nodes, ` +
    `root ${snapshot.root.slice(0, 12)}...${snapshot.sigs ? ` signed by ${snapshot.sigs[0].key}` : " (unsigned)"} -> ${values.out}`
);
