// Regenerate the per-round vectors from the reference, and CHECK the block cases against it.
//
// The asymmetry is deliberate. The per-round vectors are whatever the reference says for a fixed set
// of inputs, so regenerating them from a freshly built reference is exactly right. The block cases
// are real mainnet headers and the names the chain gave them, gathered from a synced node, and they
// are the only evidence here that comes from outside anything this repository built. Overwriting them
// from a locally compiled binary would quietly replace external evidence with self-produced output,
// which is the failure this whole directory exists to correct. So they are verified, never rewritten.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IMAGE = process.env.X11REF_IMAGE ?? `x11ref:${process.env.DASH_TAG ?? "v23.1.3"}`;
// `docker` from PATH when it is there, falling back to the Homebrew location this project's Mac uses.
// Hard-coding that path made the tooling work on exactly one machine, which for a harness whose whole
// purpose is that someone else can re-derive the vectors is the wrong end to optimise.
function findDocker() {
  if (process.env.DOCKER) return process.env.DOCKER;
  const fromPath = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" });
  const found = fromPath.stdout?.trim();
  return found || "/opt/homebrew/bin/docker";
}
const DOCKER = findDocker();
const VECTORS = fileURLToPath(new URL("../../test/vectors/x11_round_vectors.json", import.meta.url));

// THE INPUTS COME FROM THE COMMITTED FILE, not from a list here, so a clean regeneration produces NO
// DIFF. That is the property worth having: running this against an unchanged pin must be a no-op, and
// any diff then means the reference itself answers differently, which is a fact about upstream rather
// than about whoever last ran the script. Inventing the inputs here instead replaced the committed set
// with a differently-shaped one on the first run and buried the real question in noise.
//
// Adding an input is therefore a deliberate edit to the vectors file followed by a regeneration, which
// is the right amount of friction for changing what the evidence covers.

function batch(requests) {
  return new Promise((resolve, reject) => {
    const proc = spawn(DOCKER, ["run", "--rm", "-i", "--entrypoint", "x11ref", IMAGE, "batch"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`reference exited ${code}`));
      resolve(out.trim().split("\n"));
    });
    proc.stdin.write(requests.join("\n") + "\n");
    proc.stdin.end();
  });
}

const existing = JSON.parse(readFileSync(VECTORS, "utf8"));
const roundNames = Object.keys(existing.vectors);
// Every round is asked the same questions it was asked before. They are read per round rather than
// assumed identical across rounds, so a file whose rounds carry different input sets regenerates
// faithfully instead of being silently flattened.
const inputsFor = (name) => existing.vectors[name].map((c) => c.in);

// Per-round vectors, regenerated.
const requests = [];
for (const name of roundNames) for (const hex of inputsFor(name)) requests.push(`round ${name} ${hex}`);
const answers = await batch(requests);
if (answers.length !== requests.length) throw new Error(`asked for ${requests.length} digests, got ${answers.length}`);

const vectors = {};
let at = 0;
for (const name of roundNames) {
  vectors[name] = inputsFor(name).map((hex) => ({ in: hex, out: answers[at++] }));
}

// Block cases, VERIFIED rather than regenerated.
const blockRequests = existing.blockHashes.cases.map((c) => `x11 ${c.header}`);
const blockAnswers = await batch(blockRequests);
const reverseHex = (h) => Buffer.from(h, "hex").reverse().toString("hex");
let mismatches = 0;
existing.blockHashes.cases.forEach((c, i) => {
  const named = reverseHex(blockAnswers[i]);
  if (named !== c.hash) {
    mismatches++;
    console.error(`block ${c.height}: reference names ${named}, the committed case says ${c.hash}`);
  }
});
if (mismatches > 0) {
  console.error(`\n${mismatches} block case(s) disagree with the reference. NOT writing the vectors file.`);
  console.error("Either the pinned Dash tag changed how a block is named, which would be extraordinary,");
  console.error("or a committed case is wrong. Resolve that before regenerating anything.");
  process.exit(1);
}

const referenceCommit = execFileSync(DOCKER, ["run", "--rm", "--entrypoint", "cat", IMAGE, "/build/REFERENCE_COMMIT"], { encoding: "utf8" }).trim();
const referenceTag = execFileSync(DOCKER, ["run", "--rm", "--entrypoint", "cat", IMAGE, "/build/REFERENCE_TAG"], { encoding: "utf8" }).trim();

const out = {
  _source: `per-round digests from the sph reference implementations in Dash Core ${referenceTag} (${referenceCommit}), compiled unmodified in a Linux container. Regenerate with tools/x11-reference/regenerate.sh, which reuses these inputs so an unchanged pin produces no diff.`,
  _why: existing._why,
  _blockCases:
    "the block cases below are real mainnet headers and the names the chain gave them, gathered from a " +
    "synced node. They are VERIFIED against the reference by tools/x11-reference/generate.mjs and never " +
    "rewritten by it, because they are the only evidence here that does not come from something this " +
    "repository built.",
  vectors,
  blockHashes: existing.blockHashes,
};

writeFileSync(VECTORS, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${roundNames.length} rounds, ${requests.length} vectors, from ${referenceTag} (${referenceCommit})`);
console.log(`and verified all ${existing.blockHashes.cases.length} block cases against the same reference`);
