// Local prover. Runs on the masternode owner's own machine.
//
// The voting key is read here and never sent anywhere. The output, proof.json, carries
// no secret: it is a zero-knowledge proof plus the public signals and the challenge
// nonce. Submit it through whatever adapter you are using.
//
// Usage:
//   node prover/prover.js --challenge challenge.json --voting-key <WIF> [--oracle oracle/root.json]
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import bs58check from "bs58check";

const TREE_DEPTH = 16;
const WASM = "circuits/build/mno_membership_js/mno_membership.wasm";
const ZKEY = "circuits/build/circuit_final.zkey";

const { values } = parseArgs({
  options: {
    challenge: { type: "string" },
    "voting-key": { type: "string" },
    oracle: { type: "string", default: "oracle/root.json" },
    out: { type: "string", default: "proof.json" },
  },
});

// Dash WIF to a 32-byte private key. Drop the version byte, drop the trailing
// compression flag if present, keep the 32 key bytes.
function wifToPriv(wif) {
  const payload = bs58check.decode(wif).slice(1);
  return Uint8Array.from(payload.slice(0, 32));
}

// hash160 of the compressed public key, as a big-endian BigInt. This must match the
// in-circuit CompressAndHash160 output and the oracle leaf encoding.
function leafFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, true); // 33-byte compressed
  const h = ripemd160(sha256(pub));
  return BigInt("0x" + Buffer.from(h).toString("hex"));
}

// secp256k1 scalar to circom-ecdsa limb layout: k=4 limbs of n=64 bits, little-endian.
function privToLimbs(priv) {
  const d = BigInt("0x" + Buffer.from(priv).toString("hex"));
  const mask = (1n << 64n) - 1n;
  return [0n, 1n, 2n, 3n].map((i) => ((d >> (64n * i)) & mask).toString());
}

function buildLevels(poseidon, leavesDec) {
  const F = poseidon.F;
  const leaves = leavesDec.map((x) => F.e(BigInt(x)));
  while (leaves.length < 2 ** TREE_DEPTH) leaves.push(F.e(0n));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1);
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(poseidon([cur[i], cur[i + 1]]));
    levels.push(next);
  }
  return levels;
}

function merklePath(poseidon, levels, index) {
  const F = poseidon.F;
  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let level = 0; level < TREE_DEPTH; level++) {
    pathElements.push(F.toObject(levels[level][idx ^ 1]).toString());
    pathIndices.push(idx & 1); // 0 = we are the left child, 1 = the right child
    idx >>= 1;
  }
  return { pathElements, pathIndices };
}

const challenge = JSON.parse(await readFile(values.challenge, "utf8"));
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const priv = wifToPriv(values["voting-key"]);

const poseidon = await buildPoseidon();
const F = poseidon.F;

const myLeaf = leafFromPriv(priv).toString();
const index = oracle.leaves.indexOf(myLeaf);
if (index < 0) {
  console.error("This voting key does not match any masternode in the current list.");
  process.exit(1);
}

const levels = buildLevels(poseidon, oracle.leaves);
const builtRoot = F.toObject(levels.at(-1)[0]).toString();
if (builtRoot !== challenge.root) {
  console.error(
    "The local masternode list does not match the challenge root. The list has moved.\n" +
      "Refresh your oracle snapshot and request a new challenge, then try again."
  );
  process.exit(1);
}

const { pathElements, pathIndices } = merklePath(poseidon, levels, index);

const input = {
  privkey: privToLimbs(priv),
  pathElements,
  pathIndices,
  root: challenge.root,
  epoch: String(challenge.epoch),
  contextHash: challenge.contextHash,
  signalHash: challenge.signalHash,
};

const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
await writeFile(values.out, JSON.stringify({ nonce: challenge.nonce, proof, publicSignals }, null, 2));
console.log(`Wrote ${values.out}. Submit it through your adapter. Your voting key never left this machine.`);
