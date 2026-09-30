// Local prover. Runs on the masternode owner's own machine.
//
// The voting key is read here and never sent anywhere. The output, proof.json, carries
// no secret: it is a zero-knowledge proof plus the public signals and the challenge
// nonce. Submit it through whatever adapter you are using.
//
// Usage:
//   node prover/prover.js --challenge challenge.json --voting-key-file key.wif [--oracle oracle/root.json]
// The key may also be piped in with --voting-key-stdin. --voting-key <WIF> still works but leaves
// the key in shell history and the process list, so it warns.
import { readFile } from "node:fs/promises";
import { writeFileWhole } from "./write_whole.js";
import { parseArgs } from "node:util";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { wifToPriv, leafFromPriv } from "../common/dml.js";
import { loadVotingKey } from "./voting_key.js";
import { releaseProvingThreads } from "./proving_threads.js";
import { merklePathFor } from "../common/merkle_path.js";

const TREE_DEPTH = 16;
// The single-tier circuit is proved under Groth16 with its own setup-ceremony key. MNO_CIRCUIT_DIR
// points the prover at another build of the two heavy circuits, for example a development key set in
// circuits/build/dev, without touching the default artifacts.
const HEAVY = process.env.MNO_CIRCUIT_DIR ?? "circuits/build";
const WASM = `${HEAVY}/mno_membership_js/mno_membership.wasm`;
const ZKEY = `${HEAVY}/mno_membership.zkey`; // Groth16 proving key

const { values } = parseArgs({
  options: {
    challenge: { type: "string" },
    // --voting-key-file (or --voting-key-stdin) keeps the key out of shell history and the process
    // list; --voting-key still works and warns. See prover/voting_key.js.
    "voting-key": { type: "string" },
    "voting-key-file": { type: "string" },
    "voting-key-stdin": { type: "boolean" },
    oracle: { type: "string", default: "oracle/root.json" },
    out: { type: "string", default: "proof.json" },
  },
});

// secp256k1 scalar to circom-ecdsa limb layout: k=4 limbs of n=64 bits, little-endian.
function privToLimbs(priv) {
  const d = BigInt("0x" + Buffer.from(priv).toString("hex"));
  const mask = (1n << 64n) - 1n;
  return [0n, 1n, 2n, 3n].map((i) => ((d >> (64n * i)) & mask).toString());
}

const challenge = JSON.parse(await readFile(values.challenge, "utf8"));
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const priv = wifToPriv(await loadVotingKey(values));

const poseidon = await buildPoseidon();

const myLeaf = leafFromPriv(priv).toString();
const index = oracle.leaves.indexOf(myLeaf);
if (index < 0) {
  console.error("This voting key does not match any masternode in the current list.");
  process.exit(1);
}

// Occupied branches only (common/merkle_path.js). The padded full build took seconds of hashing.
const { pathElements, pathIndices, root: builtRoot } = merklePathFor(poseidon, oracle.leaves, index, TREE_DEPTH);
if (builtRoot !== challenge.root) {
  console.error(
    "The local masternode list does not match the challenge root. The list has moved.\n" +
      "Refresh your oracle snapshot and request a new challenge, then try again."
  );
  process.exit(1);
}

const input = {
  privkey: privToLimbs(priv),
  pathElements,
  pathIndices,
  root: challenge.root,
  epoch: String(challenge.epoch),
  contextHash: challenge.contextHash,
  signalHash: challenge.signalHash,
};

// Released in a finally, or the CLI never exits after writing proof.json (see proving_threads.js).
let proof, publicSignals;
try {
  ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY));
} finally {
  await releaseProvingThreads();
}
// Whole or not at all, so a member watching for proof.json never attaches a half-written file.
await writeFileWhole(values.out, JSON.stringify({ nonce: challenge.nonce, proof, publicSignals }, null, 2));
console.log(`Wrote ${values.out}. Submit it through your adapter. Your voting key never left this machine.`);
