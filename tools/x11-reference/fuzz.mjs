// Differential fuzz: every round of the JavaScript port against Dash Core's own C, over random
// inputs at lengths the committed vectors never reach.
//
// WHY THIS EXISTS SEPARATELY FROM THE VECTORS. X11 feeds the first round 80 bytes and the other ten
// exactly 64, so the committed block cases exercise every round at those two lengths and nowhere
// else. A review demonstrated the consequence by mutating the multi-block padding in Grostl and BMW
// and watching every committed vector still pass: those branches are unreachable from X11, and they
// were also unevidenced. This is what covers them.
//
// Usage:
//   node tools/x11-reference/fuzz.mjs [count] [--seed N]
//
// The seed is printed on every run and accepted as an argument, so a failure is reproducible rather
// than a story about something that happened once.
import { spawn, spawnSync } from "node:child_process";
import { ROUNDS, x11 } from "../../common/x11/index.js";

const IMAGE = process.env.X11REF_IMAGE ?? "x11ref:v23.1.3";
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

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 128);
const seedArg = args.indexOf("--seed");
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : Math.floor(Math.random() * 2 ** 31);

// A small deterministic generator, so a seed reproduces a run exactly. Math.random cannot be seeded,
// and a fuzz failure nobody can reproduce is an anecdote.
function makeRng(s) {
  let x = s >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

const rng = makeRng(seed);

// LENGTHS CHOSEN TO REACH THE BRANCHES, not merely to be random. The interesting boundaries are the
// block sizes of the rounds (64 and 128 bytes) and the points where the length field forces an extra
// block, which is where Grostl and BMW hide their uncovered path. Everything from 0 to 300 is
// eligible, and the boundary neighbourhoods are sampled deliberately on top of that.
const BOUNDARIES = [0, 1, 55, 56, 63, 64, 65, 110, 111, 112, 118, 119, 120, 121, 127, 128, 129, 191, 192, 193, 255, 256];

function randomLengths(n) {
  const lengths = [...BOUNDARIES];
  while (lengths.length < n) lengths.push(Math.floor(rng() * 301));
  return lengths.slice(0, Math.max(n, BOUNDARIES.length));
}

function randomBytes(len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = Math.floor(rng() * 256);
  return b;
}

// ONE BATCH, WRITTEN IN FULL, THEN STDIN CLOSED. An interactive request-and-await loop deadlocked:
// the reference answered correctly when fed everything at once, and hung when fed a line at a time,
// because stdin forwarding through the container runtime does not deliver a single short line
// promptly. Fifty minutes of a container sitting idle established that. Batching is also far faster,
// so there was never a reason to do it the other way.
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

const lengths = randomLengths(count);
console.log(`seed ${seed}, ${lengths.length} inputs, lengths 0 to 300, image ${IMAGE}`);

// Every input is generated first, so the request list and the comparison walk the same order.
const inputs = lengths.map((len) => randomBytes(len));
const requests = [];
for (const input of inputs) {
  const hex = input.toString("hex");
  for (const [name] of ROUNDS) requests.push(`round ${name} ${hex}`);
}
const chainInputs = [80, 0, 1, 64, 200].map((len) => randomBytes(len));
for (const input of chainInputs) requests.push(`x11 ${input.toString("hex")}`);

const answers = await batch(requests);
if (answers.length !== requests.length) {
  throw new Error(`asked the reference for ${requests.length} digests and got ${answers.length}`);
}

let comparisons = 0;
const failures = [];
let at = 0;
for (const input of inputs) {
  for (const [name, fn] of ROUNDS) {
    const expected = answers[at++];
    const got = Buffer.from(fn(input)).toString("hex");
    comparisons++;
    if (got !== expected) {
      failures.push({ round: name, len: input.length });
      if (failures.length <= 5) {
        console.error(`MISMATCH ${name} at ${input.length} bytes\n  input     ${input.toString("hex")}\n  reference ${expected}\n  port      ${got}`);
      }
    }
  }
}
for (const input of chainInputs) {
  const expected = answers[at++];
  const got = Buffer.from(x11(input)).toString("hex");
  comparisons++;
  if (got !== expected) {
    failures.push({ round: "x11", len: input.length });
    console.error(`MISMATCH x11 at ${input.length} bytes\n  reference ${expected}\n  port      ${got}`);
  }
}

console.log(`${comparisons} comparisons, ${failures.length} mismatched`);
if (failures.length > 0) {
  console.error(`\nreproduce with: node tools/x11-reference/fuzz.mjs ${count} --seed ${seed}`);
  process.exit(1);
}
