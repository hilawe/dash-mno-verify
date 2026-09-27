// Run the compiled ECDSAPrivToPub(64, 4) component on edge and random keys and compare its output with
// OpenSSL's secp256k1 through node:crypto.
//
// check_constants.mjs checks the table, the dummy point, and the case analysis on a model of the selection
// formula. This checks the component itself: the witness calculator must produce privkey * G, and for the
// keys that drive an adder through its degenerate paths (two equal points, the all-zero placeholder) the
// full witness must satisfy every R1CS constraint, which the calculator alone does not guarantee. Those
// paths are where an honest key could fail to prove.
//
// It proves only what it runs. It says nothing about a witness other than the honest one, which is the
// determinism question tools/circuit-analysis/RESULTS.md records as the residual.
//
//   node tools/circuit-analysis/ecdsa/check_witness.mjs [random-count]
//
// Needs circom on PATH (or CIRCOM=...) and the circuit dependency from scripts/setup_circom_ecdsa.sh.
import { createECDH, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { releaseProvingThreads } from "../../../prover/proving_threads.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const randomCount = Number(process.argv[2] ?? 200);
const limbs = (v) => [0, 1, 2, 3].map((i) => ((v >> (64n * BigInt(i))) & (2n ** 64n - 1n)).toString());
const fromLimbs = (ls) => ls.reduce((acc, l, i) => acc + (BigInt(l) << (64n * BigInt(i))), 0n);

function mulG(k) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
  const pub = ecdh.getPublicKey(null, "uncompressed");
  return { x: BigInt("0x" + pub.subarray(1, 33).toString("hex")), y: BigInt("0x" + pub.subarray(33, 65).toString("hex")) };
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL ${msg}`);
};

const dir = mkdtempSync(join(tmpdir(), "p2p-"));
try {
  const circom = process.env.CIRCOM ?? "circom";
  execFileSync(
    circom,
    [join(repo, "tools/circuit-analysis/ecne/wrappers/ecdsa_privtopub.circom"), "--r1cs", "--wasm", "-o", dir,
      "-l", join(repo, "node_modules"), "-l", join(repo, "circuits/.deps")],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const wasm = join(dir, "ecdsa_privtopub_js/ecdsa_privtopub.wasm");
  const r1cs = join(dir, "ecdsa_privtopub.r1cs");

  async function run(k, { check }) {
    const wtns = join(dir, "w.wtns");
    await snarkjs.wtns.calculate({ privkey: limbs(k) }, wasm, wtns);
    const w = await snarkjs.wtns.exportJson(wtns);
    // Wire 0 is the constant 1, then the 8 outputs in declaration order, pubkey[0][0..3] then pubkey[1][0..3].
    const out = { x: fromLimbs(w.slice(1, 5)), y: fromLimbs(w.slice(5, 9)) };
    const satisfied = check ? await snarkjs.wtns.check(r1cs, wtns, { info() {}, warn() {}, error() {} }) : null;
    return { out, satisfied };
  }

  // The five degenerate-path keys come from check_constants.mjs: with the dummy equal to 255 * G, a key
  // whose low 16 bits are 0x00ff hands adder 0 two copies of 255 * G, and a key whose two low windows are
  // both zero hands it two copies of the dummy. Keys whose two low windows are both zero then carry the
  // all-zero placeholder into the next adder. A key with only window 0 zero (256) starts from the dummy
  // and takes window 1's point directly, with no zero placeholder in between.
  const edges = [
    [1n, "smallest key"],
    [2n, "2"],
    [255n, "window 0 = 255, window 1 = 0 (equal points in a discarded adder)"],
    [255n + (1n << 16n), "same, with a later non-zero window"],
    [255n + (7n << 200n), "same, far later"],
    [256n, "window 0 = 0 (the dummy as adder 0's first input)"],
    [2n ** 248n, "only the top window set (dummy against dummy, then the zero placeholder)"],
    [2n ** 255n, "top bit only"],
    [N - 1n, "largest valid key"],
    [N - 255n, "near n"],
    [2n ** 256n - 2n ** 248n - 1n, "all windows 255 except the top"],
  ];
  for (const [k, what] of edges) {
    const { out, satisfied } = await run(k, { check: true });
    const want = mulG(k);
    if (out.x !== want.x || out.y !== want.y) fail(`${what}: output is not privkey * G`);
    if (satisfied !== true) fail(`${what}: the witness does not satisfy the R1CS`);
  }
  console.log(`edge: ${edges.length} keys give privkey * G per OpenSSL, and each full witness satisfies every constraint`);

  for (let r = 0; r < randomCount; r++) {
    const k = (BigInt("0x" + randomBytes(32).toString("hex")) % (N - 1n)) + 1n;
    const { out } = await run(k, { check: r < 5 });
    const want = mulG(k);
    if (out.x !== want.x || out.y !== want.y) fail(`random key ${k}: output is not privkey * G`);
  }
  console.log(`random: ${randomCount} keys give privkey * G per OpenSSL (the first 5 also checked against the R1CS)`);

  // Keys outside [1, n). privkey = 0 has no public key, and the component emits the all-zero placeholder,
  // which is not a curve point, so its hash160 names no real voting key. privkey = n makes the last adder
  // add a point to its negation, which check_constants.mjs predicts is unsatisfiable.
  const zero = await run(0n, { check: true });
  if (zero.out.x !== 0n || zero.out.y !== 0n) fail("privkey = 0 does not give the all-zero placeholder");
  else console.log(`zero: privkey = 0 gives (0, 0), not a curve point, and the witness ${zero.satisfied ? "satisfies" : "does not satisfy"} the R1CS`);
  let atN;
  try {
    atN = await run(N, { check: true });
  } catch (err) {
    atN = { refused: String(err?.message ?? err).split("\n")[0] };
  }
  if (atN.refused) console.log(`n: privkey = n is refused by the witness calculator (${atN.refused})`);
  else if (atN.satisfied) fail("privkey = n produced a witness that satisfies the R1CS, which the case analysis says is impossible");
  else console.log("n: privkey = n produces a witness that does NOT satisfy the R1CS, as the case analysis predicts");
} finally {
  await releaseProvingThreads();
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
