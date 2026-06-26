// Generate the witness input for hash160_test.circom and print the expected digest.
//
// Vector: the secp256k1 generator point. Its compressed form hashes to the well-known
// hash160 0x751e76e8199196d454941c45d1b3a323f1433bd6. The coordinates are emitted in
// circom-ecdsa register layout (4 limbs of 64 bits, little-endian, register 0 least
// significant) so they match what ECDSAPrivToPub would feed CompressAndHash160.
//
// Usage: node test/hash160/make_input.mjs [outDir]   (default outDir: current dir)
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? ".";
const priv = Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex"));

const uncompressed = secp256k1.getPublicKey(priv, false); // 65 bytes: 04 || x(32) || y(32)
const x = BigInt("0x" + Buffer.from(uncompressed.slice(1, 33)).toString("hex"));
const y = BigInt("0x" + Buffer.from(uncompressed.slice(33, 65)).toString("hex"));

const mask = (1n << 64n) - 1n;
const limbs = (v) => [0, 1, 2, 3].map((i) => ((v >> (64n * BigInt(i))) & mask).toString());

const compressed = secp256k1.getPublicKey(priv, true);
const expected = Buffer.from(ripemd160(sha256(compressed))).toString("hex");

writeFileSync(join(outDir, "input.json"), JSON.stringify({ x: limbs(x), y: limbs(y) }));
writeFileSync(join(outDir, "expected.txt"), expected);
console.log("expected hash160:", expected);
