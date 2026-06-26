// Generate the witness input for ripemd160_test.circom and print the expected digest.
//
// The vector is the inner hash of the secp256k1 generator point: RIPEMD160(SHA256(G)),
// which equals the well-known hash160 0x751e76e8199196d454941c45d1b3a323f1433bd6. This
// is the same generator vector test/hash160.test.js pins on the JavaScript side, so a
// passing circuit witness proves the in-circuit hash160 matches the off-chain one.
//
// Usage: node test/ripemd160/make_input.mjs [outDir]   (default outDir: current dir)
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { secp256k1 } from "@noble/curves/secp256k1";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".";
const priv = Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex"));
const pub = secp256k1.getPublicKey(priv, true);
const message = sha256(pub); // 32 bytes, the inner-hash input
const expected = Buffer.from(ripemd160(message)).toString("hex");

// big-endian bits: bit b of byte i at index 8*i+b, b = 0 the MSB
const bits = [];
for (let i = 0; i < 32; i++) for (let b = 0; b < 8; b++) bits.push((message[i] >> (7 - b)) & 1);

writeFileSync(join(outDir, "input.json"), JSON.stringify({ in: bits.map(String) }));
writeFileSync(join(outDir, "expected.txt"), expected);
console.log("message (sha256 of generator pubkey):", Buffer.from(message).toString("hex"));
console.log("expected ripemd160:", expected);
console.log("expected as field element:", BigInt("0x" + expected).toString());
