// Shared helper for the key-0 negative circuit checks. Read a circuit's valid witness input, set the
// private key to 0, and give it a tree whose only leaf is the one key 0 proves (KEY_ZERO_LEAF, the
// hash160 of the placeholder (0, 0)), with the matching root and Merkle path. Every other constraint
// then holds, which the circuits before the key-0 rejection demonstrated, so only that rejection can
// refuse it. scripts/check_circuits.sh also checks the failure is reported at that constraint's line.
//
// Usage: node test/zero_privkey.mjs <input.json> <zero_input.json>
import { readFileSync, writeFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { KEY_ZERO_LEAF } from "../common/dml.js";
import { merklePathFor } from "../common/merkle_path.js";

const [, , inPath, outPath] = process.argv;
const input = JSON.parse(readFileSync(inPath, "utf8"));

const poseidon = await buildPoseidon();
const { pathElements, pathIndices, root } = merklePathFor(poseidon, [KEY_ZERO_LEAF.toString()], 0, 16);
input.privkey = ["0", "0", "0", "0"];
input.pathElements = pathElements;
input.pathIndices = pathIndices;
input.root = root;

writeFileSync(outPath, JSON.stringify(input));
