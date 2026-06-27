// Shared helper for the M1 negative circuit checks. Read a circuit's valid witness input, replace
// the private key with d + n (the secp256k1 group order added to the original d = 1), and write it
// back out. The new scalar yields the same public key, the same hash160 leaf, and the same Merkle
// path, so only the in-circuit d < n constraint can reject it. Witness generation must then fail.
//
// Usage: node test/bad_privkey.mjs <input.json> <bad_input.json>
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
const input = JSON.parse(readFileSync(inPath, "utf8"));

// secp256k1 group order n as 64-bit little-endian limbs. d = 1 in the fixtures, so d + n adds 1 to
// the least-significant limb with no carry.
const order = [13822214165235122497n, 13451932020343611451n, 18446744073709551614n, 18446744073709551615n];
input.privkey = order.map((x, i) => (i === 0 ? x + 1n : x).toString());

writeFileSync(outPath, JSON.stringify(input));
