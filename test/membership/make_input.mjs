// Generate a valid witness input for the full mno_membership circuit, so the proving and
// verification keys can be exercised with a real prove-and-verify.
//
// It uses the secp256k1 generator as the "voting key" and builds a depth-16 tree with that
// key's hash160 as the only real leaf, so the Merkle path is consistent with the root the
// circuit checks. Never use a key like this for a real node.
//
// Usage: node test/membership/make_input.mjs [outDir]   (default outDir: current dir)
import { buildPoseidon } from "circomlibjs";
import { leafFromPriv } from "../../common/dml.js";
import { contextHash, signalHash } from "../../common/index.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TREE_DEPTH = 16;
const outDir = process.argv[2] ?? ".";
const priv = Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex"));

const poseidon = await buildPoseidon();
const F = poseidon.F;

// tree with our leaf at index 0, the rest empty
const leaves = [leafFromPriv(priv)];
while (leaves.length < 2 ** TREE_DEPTH) leaves.push(0n);
let level = leaves.map((x) => F.e(x));
const levels = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
  level = next;
  levels.push(level);
}
const root = F.toObject(levels.at(-1)[0]).toString();

const pathElements = [];
const pathIndices = [];
let idx = 0;
for (let l = 0; l < TREE_DEPTH; l++) {
  pathElements.push(F.toObject(levels[l][idx ^ 1]).toString());
  pathIndices.push(idx & 1);
  idx >>= 1;
}

const d = BigInt("0x" + Buffer.from(priv).toString("hex"));
const mask = (1n << 64n) - 1n;
const privkey = [0, 1, 2, 3].map((i) => ((d >> (64n * BigInt(i))) & mask).toString());

const input = {
  privkey,
  pathElements,
  pathIndices,
  root,
  epoch: "1",
  contextHash: contextHash({ platform: "test", communityId: "test", roleId: "test" }).toString(),
  signalHash: signalHash("test-nonce").toString(),
};

writeFileSync(join(outDir, "input.json"), JSON.stringify(input));
console.log("membership witness input written; root", root.slice(0, 14) + "...");
