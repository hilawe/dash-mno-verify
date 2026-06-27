// Generate a valid witness input for the cheap recurring mno_members circuit, so CI can
// run a full PLONK prove-and-verify on every push.
//
// It builds a depth-16 members tree with one known secret's commitment at index 0, so the
// Merkle path is consistent with the root the circuit checks.
//
// Usage: node test/members/make_input.mjs [outDir]   (default outDir: current dir)
import { buildPoseidon } from "circomlibjs";
import { contextHash, signalHash } from "../../common/index.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TREE_DEPTH = 16;
const outDir = process.argv[2] ?? ".";
const secret = 424242n; // fixed test secret; a real member draws this randomly

const poseidon = await buildPoseidon();
const F = poseidon.F;

// commitment = Poseidon(secret), the members-tree leaf
const leaves = [poseidon([F.e(secret)])];
while (leaves.length < 2 ** TREE_DEPTH) leaves.push(F.e(0n));
let level = leaves;
const levels = [level];
while (level.length > 1) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
  level = next;
  levels.push(level);
}
const membersRoot = F.toObject(levels.at(-1)[0]).toString();

const pathElements = [];
const pathIndices = [];
let idx = 0;
for (let l = 0; l < TREE_DEPTH; l++) {
  pathElements.push(F.toObject(levels[l][idx ^ 1]).toString());
  pathIndices.push(idx & 1);
  idx >>= 1;
}

const input = {
  secret: secret.toString(),
  pathElements,
  pathIndices,
  membersRoot,
  epoch: "1",
  contextHash: contextHash({ platform: "test", communityId: "test", roleId: "test" }).toString(),
  signalHash: signalHash("test-nonce", "test-account").toString(),
};

writeFileSync(join(outDir, "input.json"), JSON.stringify(input));
console.log("members witness input written; membersRoot", membersRoot.slice(0, 14) + "...");
