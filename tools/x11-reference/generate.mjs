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
import { join } from "node:path";
import { createHash } from "node:crypto";

// THE PIN AND THE IMAGE NAME COME FROM ONE PLACE. They were written out in four files, and the two
// scripts disagreed: generate.mjs honoured DASH_TAG while fuzz.mjs hard-coded a tag, so
// `DASH_TAG=vX ./fuzz.sh` built vX and then fuzzed the stale image. The name folds a hash of the
// build inputs for the same reason build.sh does, so a changed harness or Dockerfile can never
// resolve to an image built from the old ones.
function resolveImage() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const tag = process.env.DASH_TAG ?? readFileSync(join(here, "PIN"), "utf8").trim().split(/\s+/)[0];
  const inputs = ["Dockerfile", "harness.cpp", "PIN"].map((f) => readFileSync(join(here, f))).join("");
  const hash = createHash("sha256").update(inputs).digest("hex").slice(0, 12);
  return `x11ref:${tag}-${hash}`;
}
const IMAGE = process.env.X11REF_IMAGE ?? resolveImage();
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

// COMPARED, NOT JUST REPLACED. The first version overwrote every digest and printed "wrote 110
// vectors" with exit 0 whether or not they reproduced, so "all 110 reproduce" was a claim established
// by a human remembering to run git diff afterwards. A reviewer corrupted a committed digest and
// watched the script silently replace it and report success. The failing case has to look different
// from the passing one in the script's OWN output, or the script is not the check.
const vectors = {};
const changed = [];
let at = 0;
for (const name of roundNames) {
  vectors[name] = inputsFor(name).map((hex, i) => {
    const out = answers[at++];
    const before = existing.vectors[name][i].out;
    if (before !== out) changed.push({ round: name, in: hex, before, after: out });
    return { in: hex, out };
  });
}

// Block cases, VERIFIED rather than regenerated.
//
// A MINIMUM COUNT, because the guard below only fires on a case that is present and disagrees, so an
// EMPTY set passed it and printed "verified all 0 block cases" with exit 0. The one check protecting
// the only external evidence here was disabled by deleting that evidence, which a reviewer
// demonstrated. The number is the count committed when this was written; adding cases is fine and
// losing them is not.
const MIN_BLOCK_CASES = 11;
if (!Array.isArray(existing.blockHashes?.cases) || existing.blockHashes.cases.length < MIN_BLOCK_CASES) {
  console.error(
    `the vectors file carries ${existing.blockHashes?.cases?.length ?? 0} block cases, fewer than the ` +
      `${MIN_BLOCK_CASES} expected. They are the only evidence here that this repository did not ` +
      `produce, and the round ORDER rests on them. Refusing rather than regenerating against nothing.`,
  );
  process.exit(1);
}
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

// EVERY UNDERSCORE KEY THE FILE ALREADY CARRIES IS PRESERVED. The output used to be built from a
// fixed list, so any metadata this script did not know about was silently dropped on the next
// regeneration. Provenance notes added by hand disappeared the first time someone ran it, which the
// test asserting they exist is what caught. A regeneration should change digests and nothing else.
const carried = Object.fromEntries(
  Object.entries(existing).filter(([k]) => k.startsWith("_") && !["_source", "_why", "_blockCases"].includes(k)),
);

const out = {
  _source: `per-round digests from the sph reference implementations in Dash Core ${referenceTag} (${referenceCommit}), compiled unmodified in a Linux container. Regenerate with tools/x11-reference/regenerate.sh, which reuses these inputs so an unchanged pin produces no diff.`,
  _why: existing._why,
  _blockCases:
    "the block cases below are real mainnet headers and the names the chain gave them, gathered from a " +
    "synced node. They are VERIFIED against the reference by tools/x11-reference/generate.mjs and never " +
    "rewritten by it, because they are the only evidence here that does not come from something this " +
    "repository built.",
  ...carried,
  vectors,
  blockHashes: existing.blockHashes,
};

writeFileSync(VECTORS, JSON.stringify(out, null, 1) + "\n");
console.log(`${requests.length} vectors across ${roundNames.length} rounds, from ${referenceTag} (${referenceCommit})`);
console.log(`${existing.blockHashes.cases.length} block cases verified against the same reference`);

if (changed.length === 0) {
  console.log("every committed digest reproduced. Nothing changed, which is the result worth having.");
} else {
  console.error(`\n${changed.length} DIGEST(S) CHANGED against what was committed:`);
  for (const c of changed.slice(0, 10)) {
    console.error(`  ${c.round} in=${c.in.slice(0, 32)}${c.in.length > 32 ? "..." : ""}`);
    console.error(`    was ${c.before}`);
    console.error(`    now ${c.after}`);
  }
  console.error("\nThe file has been written, so `git diff` shows exactly what moved. This is either a");
  console.error("deliberate pin change, in which case commit the new digests alongside it, or something");
  console.error("upstream answers differently now, which is worth understanding before anything else.");
  process.exit(1);
}
