// Check the constants and the collision argument that ECDSAPrivToPub (circom-ecdsa, n=64, k=4) rests on.
//
// ECDSAPrivToPub computes privkey * G as a sum of 32 table lookups, one per 8-bit window, added with
// Secp256k1AddUnequal. That adder is only constrained to the right answer when its two inputs have
// different x coordinates. With equal inputs its constraints reduce to 0 = 0 and its output is free, so
// the component's soundness depends on (1) every table point being the point it claims to be, and (2) no
// adder whose output is used ever receiving two points with the same x. This script checks both against an
// independent implementation, OpenSSL's secp256k1 through node:crypto, rather than against circom-ecdsa's
// own generator.
//
//   node tools/circuit-analysis/ecdsa/check_constants.mjs [path/to/circom-ecdsa]
//
// Exits 0 only if every check passes. Each check prints what it covered.
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? fileURLToPath(new URL("../../../circuits/.deps/circom-ecdsa", import.meta.url));
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL ${msg}`);
};

// k * G from OpenSSL, as BigInt coordinates. Refuses a scalar outside [1, n).
function mulG(k) {
  if (k <= 0n || k >= N) throw new Error(`scalar out of range: ${k}`);
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
  const pub = ecdh.getPublicKey(null, "uncompressed");
  return { x: BigInt("0x" + pub.subarray(1, 33).toString("hex")), y: BigInt("0x" + pub.subarray(33, 65).toString("hex")) };
}

const onCurve = ({ x, y }) => (y * y - (x * x * x + 7n)) % P === 0n;
const fromLimbs = (limbs) => limbs.reduce((acc, l, i) => acc + (l << (64n * BigInt(i))), 0n);

// 1. The stride-8 table, powers[i][j] = j * 2^(8i) * G for 1 <= j < 256.
const tableSrc = readFileSync(`${root}/circuits/ecdsa_func.circom`, "utf8");
const table = new Map();
for (const m of tableSrc.matchAll(/powers\[(\d+)\]\[(\d+)\]\[(\d)\]\[(\d)\] = (\d+);/g)) {
  const [, i, j, c, l, v] = m;
  const key = `${i},${j}`;
  if (!table.has(key)) table.set(key, [[0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n], new Set()]);
  const entry = table.get(key);
  const limb = BigInt(v);
  if (limb >= 2n ** 64n) fail(`powers[${i}][${j}][${c}][${l}] is not a 64-bit limb`);
  entry[Number(c)][Number(l)] = limb;
  entry[2].add(`${c},${l}`);
}
let checked = 0;
const tableXs = new Set();
for (let i = 0; i < 32; i++) {
  for (let j = 1; j < 256; j++) {
    const entry = table.get(`${i},${j}`);
    if (!entry || entry[2].size !== 8) {
      fail(`powers[${i}][${j}] is missing limbs`);
      continue;
    }
    const got = { x: fromLimbs(entry[0]), y: fromLimbs(entry[1]) };
    const want = mulG(BigInt(j) << BigInt(8 * i));
    if (got.x !== want.x || got.y !== want.y) fail(`powers[${i}][${j}] is not ${j} * 2^${8 * i} * G`);
    if (got.x >= P || got.y >= P) fail(`powers[${i}][${j}] is not canonical (coordinate >= p)`);
    if (!onCurve(got)) fail(`powers[${i}][${j}] is not on the curve`);
    tableXs.add(got.x);
    checked++;
  }
}
console.log(`table: ${checked} of ${32 * 255} entries equal j * 2^(8i) * G per OpenSSL, canonical, on the curve`);
if (tableXs.has(0n)) fail("a table point has x = 0, which would share x with the all-zero placeholder");

// 2. The dummy point, documented as 2^255 * G.
const funcSrc = readFileSync(`${root}/circuits/secp256k1_func.circom`, "utf8");
const dummyBlock = funcSrc.slice(funcSrc.indexOf("function get_dummy_point"));
const elseBlock = dummyBlock.slice(dummyBlock.indexOf("} else {"), dummyBlock.indexOf("return ret;"));
const d = [[0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n]];
let dummyLimbs = 0;
for (const m of elseBlock.matchAll(/ret\[(\d)\]\[(\d)\] = (\d+);/g)) {
  d[Number(m[1])][Number(m[2])] = BigInt(m[3]);
  dummyLimbs++;
}
if (dummyLimbs !== 8) fail(`dummy point has ${dummyLimbs} limbs in the k=4 branch, expected 8`);

// The group order the callers' privkey < n bound compares against (get_secp256k1_order, n=64, k=4).
const orderBlock = funcSrc.slice(funcSrc.indexOf("function get_secp256k1_order"), funcSrc.indexOf("function get_dummy_point"));
const orderLimbs = [...orderBlock.slice(orderBlock.indexOf("n == 64 && k == 4) {")).matchAll(/ret\[(\d)\] = (\d+);/g)].slice(0, 4);
if (orderLimbs.length !== 4 || fromLimbs(orderLimbs.map((m) => BigInt(m[2]))) !== N) fail("get_secp256k1_order(64, 4) is not the secp256k1 group order n");
else console.log("order: get_secp256k1_order(64, 4) equals the secp256k1 group order n");
const dummy = { x: fromLimbs(d[0]), y: fromLimbs(d[1]) };
if (!onCurve(dummy) || dummy.x >= P || dummy.y >= P) fail("the dummy point is not a canonical curve point");
if (dummy.x === 0n) fail("the dummy point has x = 0");
// ecdsa.circom documents the dummy as 2^255 * G. Find what it actually is among the scalars it could
// plausibly be, so the conditions below are evaluated on the real constant rather than the comment.
let D = null;
const candidates = [];
for (let e = 0; e < 256; e++) candidates.push(1n << BigInt(e));
for (let i = 0; i < 32; i++) for (let j = 1; j < 256; j++) candidates.push(BigInt(j) << BigInt(8 * i));
for (const s of candidates) {
  const q = mulG(s);
  if (q.x === dummy.x && q.y === dummy.y) {
    D = s;
    break;
  }
}
if (D === null) fail("the dummy point is none of 2^e * G or j * 2^(8i) * G, so the conditions below cannot be evaluated");
else if (D === 2n ** 255n) console.log("dummy: equals 2^255 * G, as documented");
else console.log(`dummy: equals ${D} * G per OpenSSL, NOT the 2^255 * G that ecdsa.circom documents`);

// 3. The collision argument. In window i (1..31) the adder's output is USED only when some earlier window
// was non-zero and window i is non-zero. Its inputs are then S*G, with S the scalar accumulated so far
// (1 <= S < 2^(8i)), and w * 2^(8i) * G with 1 <= w <= 255. A used adder never takes the dummy as a zero
// window's stand-in. It can take 255 * G as a real partial sum (key 511 does, at window 1), which has the
// same value as the dummy and is still S * G with S = 255. Same x means S = +-w*2^(8i) mod n. These are
// the integer facts that rule out equal points. The one negation, at privkey = n, is a point against its
// own negative, the same x with a different y.
const maxWindowScalar = 255n * 2n ** 248n;
const facts = [
  ["the largest table scalar, 255 * 2^248, is below n, so no two distinct table scalars coincide mod n", maxWindowScalar < N],
  ["S < 2^(8i) <= w * 2^(8i) <= 255 * 2^248 < n, so S = w*2^(8i) mod n needs S = w*2^(8i), which S < 2^(8i) forbids", 2n ** 248n <= maxWindowScalar],
  ["S + w*2^(8i) < 2^256 < 2n, so S = -w*2^(8i) mod n needs S + w*2^(8i) = n exactly", 2n ** 256n < 2n * N],
  ["for i <= 30, S + w*2^(8i) < 2^248 < n, so that equality is impossible before the last window", 2n ** 248n < N],
];
// An adder whose output is DISCARDED may see equal points (its output is then free, which is harmless
// because the selection formula ignores it), but must never see a point and its negation, because then
// its constraints are unsatisfiable and an honest key could not be proved. With the dummy D*G those
// adders see S*G against D*G (window i zero), D*G against w*2^8*G (window 0 zero), or D*G against D*G.
if (D !== null) {
  facts.push(
    ["no accumulated S (1 <= S < 2^248) is n - D, so S*G is never the negation of the dummy", N - D >= 2n ** 248n],
    ["no w*2^8 + D (1 <= w <= 255) is a multiple of n, so the dummy is never the negation of a window-1 point", [...Array(255)].every((_, w) => ((BigInt(w + 1) << 8n) + D) % N !== 0n)],
  );
}
for (const [what, ok] of facts) ok ? console.log(`bound: ${what}`) : fail(`bound does not hold: ${what}`);
console.log(
  "so: no used adder ever sees two EQUAL points, for any 256-bit private key, which is the case that would",
  "leave its output free. The one negation, at i = 31 when S + w*2^248 = privkey = n, makes that adder",
  "unsatisfiable, so privkey = n (not a valid key) cannot be proved at all.",
);

// 4. Replay the component's selection formula (ecdsa.circom lines 71 to 115) with points tracked by their
// scalar, classify every adder the circuit instantiates, and compare the result with OpenSSL. This models
// the formula, not the constraint system, so it checks the case analysis above rather than the circuit.
const ZERO = "zero"; // partial[i] is the all-zero limb vector, not a curve point, while no window has been non-zero
function classify(a, b) {
  if (a === ZERO || b === ZERO) return "determined"; // x = 0 is on no table point or the dummy, checked above
  if ((a - b) % N === 0n) return "free";
  if ((a + b) % N === 0n) return "unsatisfiable";
  return "determined";
}
function walk(priv) {
  const win = (i) => (priv >> BigInt(8 * i)) & 0xffn;
  const mux = (i) => (win(i) === 0n ? D : win(i) << BigInt(8 * i));
  let partial = mux(0);
  let hasPrev = win(0) !== 0n;
  const out = { usedBad: [], discardedUnsat: [], discardedFree: 0 };
  for (let i = 1; i < 32; i++) {
    const kind = classify(partial, mux(i));
    const used = hasPrev && win(i) !== 0n;
    if (used && kind !== "determined") out.usedBad.push(`window ${i}: ${kind}`);
    if (!used && kind === "unsatisfiable") out.discardedUnsat.push(`window ${i}`);
    if (!used && kind === "free") out.discardedFree++;
    if (used) partial = (partial + mux(i)) % N;
    else if (!hasPrev) partial = win(i) === 0n ? ZERO : mux(i);
    hasPrev ||= win(i) !== 0n;
  }
  out.pubScalar = partial;
  return out;
}
if (D !== null) {
  const edges = [1n, 2n, 255n, 256n, 257n, 255n + (1n << 16n), 255n + (7n << 200n), 2n ** 248n, 2n ** 255n, N - 1n, N - 2n, N - 255n, N - 2n ** 248n, 2n ** 256n - 2n ** 248n - 1n];
  const keys = [...edges];
  for (let r = 0; r < 2000; r++) keys.push(BigInt("0x" + randomBytes(32).toString("hex")) % (N - 1n) + 1n);
  let freeKeys = 0;
  for (const k of keys) {
    const w = walk(k);
    if (w.usedBad.length) fail(`key ${k}: a used adder is ${w.usedBad.join(", ")}`);
    if (w.discardedUnsat.length) fail(`key ${k}: a discarded adder is unsatisfiable at ${w.discardedUnsat.join(", ")}`);
    if (w.discardedFree) freeKeys++;
    const want = mulG(k);
    if (w.pubScalar === ZERO || (() => { const q = mulG(w.pubScalar); return q.x !== want.x || q.y !== want.y; })()) fail(`key ${k}: the formula does not reach privkey * G`);
  }
  const atN = walk(N);
  if (!atN.usedBad.length) fail("the walk did not flag privkey = n, so it is not detecting what it claims");
  console.log(
    `walk: ${keys.length} keys (${edges.length} edge, the rest random) reach privkey * G with no used adder colliding and no`,
    `unsatisfiable adder. ${freeKeys} of them pass a discarded adder two equal points (a free, ignored output).`,
    `privkey = n is flagged (${atN.usedBad[0]}), the case the caller's bound excludes.`,
  );
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
