// Check that the modular checks inside Secp256k1AddUnequal(64, 4) never overflow the proof system's field.
//
// The adder proves two congruences mod p (the secp256k1 prime) with big-integer arithmetic over 64-bit
// limbs. Each constraint is an equation in the BN254 scalar field, of size r, about 2^253.6. A field
// equation implies the same INTEGER equation only if every value in it stays below r / 2 in absolute value,
// and the carry and quotient range checks only work if the declared overflow parameters (200 for the cubic
// check, 132 for the quadratic one) bound what is actually fed in. The library's comments state these
// bounds. This recomputes them.
//
// It follows secp256k1.circom (AddUnequalCubicConstraint, Secp256k1PointOnLine) and secp256k1_utils.circom
// (the two reductions, CheckCubicModPIsZero, CheckQuadraticModPIsZero) with interval arithmetic: every
// input limb is anywhere in [0, 2^64 - 1], which holds because the adder's inputs are table constants, the
// dummy constant, the all-zero placeholder, or earlier adder outputs that CheckInRangeSecp256k1 range-checks.
// The intervals are conservative, since a repeated expression loses its correlation with itself, so a pass
// is a sufficient condition and a failure would need a closer look before it meant anything.
//
//   node tools/circuit-analysis/ecdsa/check_bounds.mjs            # the real parameters
//   node tools/circuit-analysis/ecdsa/check_bounds.mjs --cubic-m 196   # a deliberately too-small bound
//
// Exits 0 only if every bound holds.

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HALF = (R - 1n) / 2n;
const BASE = 1n << 64n;
const LIMB = [0n, BASE - 1n];
const OFFSET = (1n << 32n) + 977n; // 2^256 = 2^32 + 977 mod p
const OFFSET2 = (1n << 33n) * 977n + 977n ** 2n; // 2^320 reduced the same way
const P_LIMBS = [BASE - OFFSET, BASE - 1n, BASE - 1n, BASE - 1n];
const P = (1n << 256n) - (1n << 32n) - 977n;

const argAfter = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const CUBIC_M = argAfter("--cubic-m", 200);
const QUADRATIC_M = argAfter("--quadratic-m", 132);

const failures = [];
let widest = 0;
const abs = (x) => (x < 0n ? -x : x);
const bits = (x) => abs(x).toString(2).length;
const mag = ([lo, hi]) => (abs(lo) > abs(hi) ? abs(lo) : abs(hi));
const point = (x) => [x, x];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const neg = (a) => [-a[1], -a[0]];
const scale = (a, k) => (k < 0n ? neg(scale(a, -k)) : [a[0] * k, a[1] * k]);
const mul = (a, b) => {
  const c = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [c.reduce((x, y) => (x < y ? x : y)), c.reduce((x, y) => (x > y ? x : y))];
};

// Every value the circuit holds as a field element passes through here.
function inField(name, a) {
  widest = Math.max(widest, bits(mag(a)));
  if (mag(a) >= HALF) failures.push(`${name} can reach 2^${bits(mag(a))}, not below r / 2`);
  return a;
}
const sum = (name, terms) => inField(name, terms.reduce((acc, t, i) => inField(`${name} prefix ${i}`, add(acc, inField(`${name} term ${i}`, t))), point(0n)));

// BigMultNoCarry: the product coefficients, and the evaluations at 0..degree that constrain them.
function multNoCarry(name, a, b) {
  const out = Array.from({ length: a.length + b.length - 1 }, (_, k) =>
    sum(`${name} out[${k}]`, a.flatMap((x, i) => b.flatMap((y, j) => (i + j === k ? [mul(x, y)] : [])))),
  );
  for (let t = 0; t < out.length; t++) {
    const evaluate = (poly, label) => sum(`${name} ${label}(${t})`, poly.map((v, j) => scale(v, BigInt(t) ** BigInt(j))));
    evaluate(out, "out");
    inField(`${name} a(${t})*b(${t})`, mul(evaluate(a, "a"), evaluate(b, "b")));
  }
  return out;
}

const x = Array(4).fill(LIMB);
const square = multNoCarry("x*y", x, x); // every quadratic product has this shape
const cube = multNoCarry("x*y*z", square, x); // every cubic product has this shape

// The registers fed to each zero check, as the templates combine them.
const cubicIn = cube.map((v, i) =>
  sum(`cubic zeroCheck.in[${i}]`, [v, v, neg(v), neg(v), v, v, scale(v, -2n), ...(i < 7 ? [neg(square[i]), scale(square[i], 2n), neg(square[i])] : [])]),
);
const quadraticIn = square.map((v, i) => sum(`quadratic zeroCheck.in[${i}]`, [v, v, v, neg(v), neg(v), neg(v)]));

function zeroCheck(name, input, m, quotientLimbs) {
  if (!input.every((v) => mag(v) < 1n << BigInt(m))) failures.push(`${name}: an input register reaches 2^${Math.max(...input.map((v) => bits(mag(v))))}, over the declared m = ${m}`);
  const cubic = quotientLimbs === 3;
  const terms = cubic
    ? [
        [scale(input[8], OFFSET2), scale(input[4], OFFSET), input[0]],
        [scale(input[9], OFFSET2), scale(input[5], OFFSET), input[1], input[8]],
        [scale(input[6], OFFSET), input[2], input[9]],
        [scale(input[7], OFFSET), input[3]],
      ]
    : [[scale(input[4], OFFSET), input[0]], [scale(input[5], OFFSET), input[1]], [scale(input[6], OFFSET), input[2]], [input[3]]];
  const reducedOut = terms.map((t, i) => sum(`${name} reduce out[${i}]`, t));
  const shift = BigInt(m - (cubic ? 20 : 30));
  const reduced = reducedOut.map((v, i) => inField(`${name} reduced[${i}]`, add(v, point(P_LIMBS[i] * (1n << shift)))));

  // The number the quotient divides. Not a circuit value, so it may exceed the field. An honest witness
  // needs it non-negative and its quotient to fit the range-checked limbs.
  const whole = reduced.reduce((s, v, i) => add(s, scale(v, BASE ** BigInt(i))), point(0n));
  if (whole[0] < 0n) failures.push(`${name}: the dividend can be negative, so an honest quotient may not exist`);
  if (whole[1] / P >= BASE ** BigInt(quotientLimbs)) failures.push(`${name}: the honest quotient can exceed ${quotientLimbs} limbs`);

  const qp = multNoCarry(`${name} q*p`, Array(quotientLimbs).fill(LIMB), P_LIMBS.map(point));
  const carryIn = qp.map((v, i) => inField(`${name} carry in[${i}]`, i < 4 ? add(v, neg(reduced[i])) : v));

  // CheckCarryToZero(64, cm, k) range-checks each carry to [-2^(cm+2-64), 2^(cm+2-64) - 1].
  const cm = m + (cubic ? 46 : 36);
  const bound = 1n << BigInt(cm + 2 - 64);
  const allowed = [-bound, bound - 1n];
  const floorDiv = (v) => (v >= 0n ? v / BASE : -((-v + BASE - 1n) / BASE));
  let honest = point(0n);
  let honestMax = 0n;
  let residualMax = 0n;
  for (let i = 0; i < carryIn.length - 1; i++) {
    const numerator = add(carryIn[i], honest);
    honest = [-floorDiv(-numerator[0]), floorDiv(numerator[1])];
    if (honest[0] < allowed[0] || honest[1] > allowed[1]) failures.push(`${name}: honest carry ${i} can leave its range check`);
    honestMax = mag(honest) > honestMax ? mag(honest) : honestMax;
    // Any carry the range check admits, in the equation in[i] + carry[i-1] = carry[i] * 2^64.
    const residual = inField(`${name} carry equation ${i}`, add(add(carryIn[i], i === 0 ? point(0n) : allowed), neg(scale(allowed, BASE))));
    residualMax = mag(residual) > residualMax ? mag(residual) : residualMax;
  }
  inField(`${name} final carry equation`, add(carryIn.at(-1), allowed));
  const widestOf = (vs) => Math.max(...vs.map((v) => bits(mag(v))));
  console.log(
    `${name}: input registers < 2^${widestOf(input)} against m = ${m}; reduced < 2^${widestOf(reduced)};`,
    `honest carries < 2^${bits(honestMax)} against a range of 2^${cm + 2 - 64}; carry equations < 2^${bits(residualMax)};`,
    `honest quotient < 2^${bits(whole[1] / P)} against ${quotientLimbs * 64} bits`,
  );
}

zeroCheck("cubic", cubicIn, CUBIC_M, 3);
zeroCheck("quadratic", quadraticIn, QUADRATIC_M, 2);
console.log(`widest value held in the field: 2^${widest}, against r / 2 of about 2^252.6`);
for (const f of failures) console.error(`FAIL ${f}`);
if (failures.length) {
  console.error(`${failures.length} bound(s) do not hold`);
  process.exit(1);
}
console.log("all bounds hold");
