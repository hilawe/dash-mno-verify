// Generate the witness input for hash160_test.circom at the placeholder (0, 0), and print the expected
// digest.
//
// For a private key of 0, ECDSAPrivToPub outputs (0, 0), which is not a curve point, and the circuits
// accept that key (tools/circuit-analysis/RESULTS.md, item A2). This vector pins that the circuit hashes
// it to KEY_ZERO_LEAF, the leaf the oracle leaves out of the tree. If the two ever disagreed, the oracle
// would be leaving out the wrong leaf. test/hash160.test.js derives the constant independently.
//
// Usage: node test/hash160/make_input_zero.mjs [outDir]   (default outDir: current dir)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_ZERO_LEAF } from "../../common/dml.js";

const outDir = process.argv[2] ?? ".";
const expected = KEY_ZERO_LEAF.toString(16).padStart(40, "0");

writeFileSync(join(outDir, "input.json"), JSON.stringify({ x: ["0", "0", "0", "0"], y: ["0", "0", "0", "0"] }));
writeFileSync(join(outDir, "expected.txt"), expected);
console.log("expected hash160:", expected);
