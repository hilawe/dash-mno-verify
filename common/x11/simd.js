// SIMD-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core (simd.c and sph_simd.h),
// and checked against vectors generated from that same implementation compiled unmodified
// (test/vectors/x11_round_vectors.json). SIMD is the largest of the eleven by some margin, and the
// place a port silently goes wrong is the message expansion, where a sign convention in the
// transform or a mistaken table exponent still produces a plausible-looking 64-byte digest.
//
// The shape of the compression function, for a reader who has not met SIMD before. A 128-byte block
// is expanded into 256 signed residues modulo 257 by a number theoretic transform, the residues are
// packed pairwise into 64 message words, and those words drive four rounds of eight steps over a
// 32-word state held as four lanes of eight. A final four steps feed the state as it stood BEFORE
// the block back in as message words, which is what makes the block function non-invertible.

// The transform works in the field of integers modulo 257, where 41 has order 256 and so generates
// every nonzero residue. alphaTab[i] is 41^i, the root of unity the transform multiplies by. The
// reference stores these 256 values as a literal table; computing them costs nothing and shows where
// they come from. Verified equal to the reference table element by element.
const ALPHA_TAB = (() => {
  const t = new Int32Array(256);
  let v = 1;
  for (let i = 0; i < 256; i++) {
    t[i] = v;
    v = (v * 41) % 257;
  }
  return t;
})();

// The two constant offset tables added to the transform output, one for an ordinary block and one
// for the final block, which is how the padding block is made to differ from a data block that
// happens to hold the same bytes. The reference documents them as beta^(255*i) and
// beta^(255*i) + beta^(253*i) modulo 257 with beta = 41. Since 41 has order 256, the exponents fold
// to -i and -3i modulo 256, so both tables are just alphaTab read backwards at two strides. Both
// were verified equal to the reference literals.
const YOFF_B_N = new Int32Array(256);
const YOFF_B_F = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  YOFF_B_N[i] = ALPHA_TAB[(255 * i) & 255];
  YOFF_B_F[i] = (ALPHA_TAB[(255 * i) & 255] + ALPHA_TAB[(253 * i) & 255]) % 257;
}

const IV512 = new Uint32Array([
  0x0ba16b95, 0x72f999ad, 0x9fecc2ae, 0xba3264fc, 0x5e894929, 0x8e9f30e5, 0x2f1daa37, 0xf0f2c558,
  0xac506643, 0xa90635a5, 0xe25b878b, 0xaab7878f, 0x88817f7a, 0x0a02892b, 0x559a7550, 0x598f657e,
  0x7eef60a1, 0x6b70e3e8, 0x9c1714d1, 0xb958e2a8, 0xab02675e, 0xed1c014f, 0xcd8d65bb, 0xfdb7a257,
  0x09254899, 0xd699c7bc, 0x9019b6dc, 0x2b9022e4, 0x8fa14956, 0x21bf9bd3, 0xb94d0943, 0x6ffddc22,
]);

const BLOCK_BYTES = 128;

// Where each group of eight message words reads its residues from. The permutation is part of the
// specification and has no derivation to show, so it is transcribed from the reference wbp table,
// scaled by sixteen there and here for the same reason (each entry names a block of sixteen
// residues).
const WBP = new Int32Array(
  [
    4, 6, 0, 2, 7, 5, 3, 1,
    15, 11, 12, 8, 9, 13, 10, 14,
    17, 18, 23, 20, 22, 21, 16, 19,
    30, 24, 25, 31, 27, 29, 28, 26,
  ].map((v) => v * 16),
);

// The permutation applied to the rotated state at each step, one entry per step across the four
// rounds. The reference spells these out as thirty-two PP8_x_y constants, but every one of them is
// an exclusive or of the lane index with a single value, so the tables collapse to these constants.
const PP8K = new Int32Array([1, 6, 2, 3, 5, 7, 4, 1, 6, 2, 3]);

// Lazy reductions towards the field. Neither lands the value in 0..256 on its own, which is why the
// reference applies them in a fixed sequence and only then folds to a signed residue.
const reds1 = (x) => (x & 0xff) - (x >> 8);
const reds2 = (x) => (x & 0xffff) + (x >> 16);

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

const IF = (x, y, z) => (((y ^ z) & x) ^ z) >>> 0;
const MAJ = (x, y, z) => ((x & y) | ((x | y) & z)) >>> 0;

// Scratch for the two half-transforms feeding each length-16 stage. Held here rather than allocated
// per call because the transform runs 128 times per block and never nests these two.
const d1 = new Int32Array(8);
const d2 = new Int32Array(8);

// The length-8 base case. It takes four inputs and yields eight outputs because the second half of
// every input vector is zero by construction, which is what lets a 128-byte block expand to 256
// residues. Multiplication by the root of unity is a shift here, since at this size the root is a
// power of two.
function fft8(x, xb, xs, d) {
  const x0 = x[xb];
  const x1 = x[xb + xs];
  const x2 = x[xb + 2 * xs];
  const x3 = x[xb + 3 * xs];
  const a0 = x0 + x2;
  const a1 = x0 + (x2 << 4);
  const a2 = x0 - x2;
  const a3 = x0 - (x2 << 4);
  const b0 = x1 + x3;
  const b1 = reds1((x1 << 2) + (x3 << 6));
  const b2 = (x1 << 4) - (x3 << 4);
  const b3 = reds1((x1 << 6) + (x3 << 2));
  d[0] = a0 + b0;
  d[1] = a1 + b1;
  d[2] = a2 + b2;
  d[3] = a3 + b3;
  d[4] = a0 - b0;
  d[5] = a1 - b1;
  d[6] = a2 - b2;
  d[7] = a3 - b3;
}

// At length 16 the root of unity is 2, so the twist that combines the two half-transforms is a shift
// by the output index rather than a table lookup.
function fft16(x, xb, xs, q, rb) {
  fft8(x, xb, xs << 1, d1);
  fft8(x, xb + xs, xs << 1, d2);
  for (let i = 0; i < 8; i++) {
    const t = d2[i] << i;
    q[rb + i] = d1[i] + t;
    q[rb + 8 + i] = d1[i] - t;
  }
}

// The butterfly stage that joins two already-transformed halves of length hk, twisting the upper
// half by alpha^(v) as it goes. The reference writes this as a loop whose first pass jumps into the
// middle of the body, because alpha^0 is 1 and so the very first pair needs no multiplication at
// all. That entry pair is done before the loop and the first pass then starts at offset 1, which is
// exactly what the reference's jump achieves. Getting this wrong costs one multiplication by one and
// is invisible until the digest disagrees.
function fftLoop(q, rb, hk, as) {
  const m0 = q[rb];
  const n0 = q[rb + hk];
  q[rb] = m0 + n0;
  q[rb + hk] = m0 - n0;
  for (let u = 0, v = 0; u < hk; u += 4, v += 4 * as) {
    for (let j = u === 0 ? 1 : 0; j < 4; j++) {
      const m = q[rb + u + j];
      const n = q[rb + u + j + hk];
      // The product stays inside a signed 32-bit word because the residues are bounded above by the
      // reference's stated ranges and alpha never exceeds 256. Math.imul keeps the same wrapping the
      // C has.
      const t = reds2(Math.imul(n, ALPHA_TAB[v + j * as]));
      q[rb + u + j] = m + t;
      q[rb + u + j + hk] = m - t;
    }
  }
}

function fft32(x, xb, xs, q, rb) {
  fft16(x, xb, xs << 1, q, rb);
  fft16(x, xb + xs, xs << 1, q, rb + 16);
  fftLoop(q, rb, 16, 8);
}

function fft64(x, xb, xs, q, rb) {
  const xd = xs << 1;
  fft32(x, xb, xd, q, rb);
  fft32(x, xb + xs, xd, q, rb + 32);
  fftLoop(q, rb, 32, 4);
}

// The full expansion of a 128-byte block into 256 residues. The four length-64 transforms read the
// block at stride four from four different starting bytes, and the interleaving order below (0 and
// 2, then 1 and 3) is the reference's, not an arbitrary one, since each pair is joined before the
// next pair is computed.
function fft256(x, q) {
  fft64(x, 0, 4, q, 0);
  fft64(x, 2, 4, q, 64);
  fftLoop(q, 0, 64, 2);
  fft64(x, 1, 4, q, 128);
  fft64(x, 3, 4, q, 192);
  fftLoop(q, 128, 64, 2);
  fftLoop(q, 0, 128, 1);
}

// Two residues packed into the halves of one message word, each scaled by a round constant. The low
// half is truncated to sixteen bits and the high half is shifted up, so a negative residue lands as
// a two's complement 16-bit pattern exactly as the C cast does.
const inner = (l, h, mm) => ((Math.imul(l, mm) & 0xffff) + (Math.imul(h, mm) << 16)) >>> 0;

// Fill the 64 message words for one round from the residues. The two offsets pick which pair of
// residues share a word, and they go negative for the later rounds because those groups read a
// window that starts below their own base.
function wbread(w, q, sb, o1, o2, mm) {
  for (let u = 0; u < 64; u += 8) {
    const v = WBP[(u >> 3) + sb];
    for (let k = 0; k < 8; k++) {
      w[u + k] = inner(q[v + 2 * k + o1], q[v + 2 * k + o2], mm);
    }
  }
}

// One step over all eight lanes. Every lane reads the rotated A values of all eight lanes, so those
// are snapshotted before any lane is updated.
const tA = new Uint32Array(8);
function stepBig(state, w, wOff, useMaj, r, s, ppb) {
  for (let n = 0; n < 8; n++) tA[n] = rotl(state[n], r);
  for (let n = 0; n < 8; n++) {
    const a = state[n];
    const b = state[8 + n];
    const c = state[16 + n];
    const d = state[24 + n];
    const f = useMaj ? MAJ(a, b, c) : IF(a, b, c);
    const tt = (d + w[wOff + n] + f) >>> 0;
    state[n] = (rotl(tt, s) + tA[ppb ^ n]) >>> 0;
    state[24 + n] = c;
    state[16 + n] = b;
    state[8 + n] = tA[n];
  }
}

// Eight steps, four with the choice function and four with majority, rotating through four rotation
// amounts. isp selects this round's window into the step permutation constants.
function oneRoundBig(state, w, isp, p0, p1, p2, p3) {
  stepBig(state, w, 0, false, p0, p1, PP8K[isp + 0]);
  stepBig(state, w, 8, false, p1, p2, PP8K[isp + 1]);
  stepBig(state, w, 16, false, p2, p3, PP8K[isp + 2]);
  stepBig(state, w, 24, false, p3, p0, PP8K[isp + 3]);
  stepBig(state, w, 32, true, p0, p1, PP8K[isp + 4]);
  stepBig(state, w, 40, true, p1, p2, PP8K[isp + 5]);
  stepBig(state, w, 48, true, p2, p3, PP8K[isp + 6]);
  stepBig(state, w, 56, true, p3, p0, PP8K[isp + 7]);
}

function compress(state, x, q, w, saved, last) {
  fft256(x, q);

  // Fold each transform output to a signed residue in -128..128. The offset table is what
  // distinguishes the final block from every other block, so the whole padding scheme rests on this
  // one choice of table.
  const yoff = last ? YOFF_B_F : YOFF_B_N;
  for (let i = 0; i < 256; i++) {
    let tq = q[i] + yoff[i];
    tq = reds2(tq);
    tq = reds1(tq);
    tq = reds1(tq);
    q[i] = tq <= 128 ? tq : tq - 257;
  }

  // The block enters the state directly as well as through the message expansion. The pre-block
  // state is kept because the last four steps use it as their message words.
  saved.set(state);
  for (let i = 0; i < 32; i++) {
    const o = 4 * i;
    const word = (x[o] | (x[o + 1] << 8) | (x[o + 2] << 16) | (x[o + 3] << 24)) >>> 0;
    state[i] = (state[i] ^ word) >>> 0;
  }

  wbread(w, q, 0, 0, 1, 185);
  oneRoundBig(state, w, 0, 3, 23, 17, 27);
  wbread(w, q, 8, 0, 1, 185);
  oneRoundBig(state, w, 1, 28, 19, 22, 7);
  wbread(w, q, 16, -256, -128, 233);
  oneRoundBig(state, w, 2, 29, 9, 15, 5);
  wbread(w, q, 24, -383, -255, 233);
  oneRoundBig(state, w, 3, 4, 13, 10, 25);

  // The feed-forward. Four more steps whose message words are the state as it was before this block,
  // which is what stops the block function from being run backwards.
  stepBig(state, saved, 0, false, 4, 13, 5);
  stepBig(state, saved, 8, false, 13, 10, 7);
  stepBig(state, saved, 16, false, 10, 25, 4);
  stepBig(state, saved, 24, false, 25, 4, 1);
}

// The length is encoded in bits, but counted in whole blocks plus a byte remainder, so the block
// count is shifted up by ten (1024 bits to a block) and the remainder shifted up by three. The bits
// that shift off the low word carry into the high word.
function encodeCount(dst, countLow, countHigh, ptr) {
  const low = (countLow << 10) >>> 0;
  // THE CARRY COMES FROM countLow, NOT FROM low. `low` has already been truncated to 32 bits, so
  // `low >>> 22` reads bits 12 to 21 of the count rather than the bits that shifted off the top. The
  // encoding was then both wrong and non-injective, which is wrong under any convention: a 512 MiB
  // message encoded its length identically to an empty one. It bites from 512 KiB of input upward, so
  // no vector here reaches it and X11 never does either, since it hands this function 64 bytes.
  const high = (((countHigh << 10) >>> 0) + (countLow >>> 22)) >>> 0;
  const lowWithPtr = (low + (ptr << 3)) >>> 0;
  for (let i = 0; i < 4; i++) {
    dst[i] = (lowWithPtr >>> (8 * i)) & 0xff;
    dst[4 + i] = (high >>> (8 * i)) & 0xff;
  }
}

export function simd512(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);

  const state = Uint32Array.from(IV512);
  const saved = new Uint32Array(32);
  const buf = new Uint8Array(BLOCK_BYTES);
  const q = new Int32Array(256);
  const w = new Uint32Array(64);

  let countLow = 0;
  let countHigh = 0;
  let off = 0;
  while (data.length - off >= BLOCK_BYTES) {
    buf.set(data.subarray(off, off + BLOCK_BYTES));
    compress(state, buf, q, w, saved, false);
    off += BLOCK_BYTES;
    countLow = (countLow + 1) >>> 0;
    if (countLow === 0) countHigh = (countHigh + 1) >>> 0;
  }

  // The remainder is zero-padded and compressed as an ordinary block, and it is NOT counted, because
  // the count records whole blocks and the remainder is carried separately into the length block
  // below. An input that is an exact multiple of the block size leaves nothing here and skips this
  // compression entirely.
  const ptr = data.length - off;
  buf.fill(0);
  buf.set(data.subarray(off), 0);
  if (ptr > 0) compress(state, buf, q, w, saved, false);

  // The length goes in a block of its own, compressed with the final-block offset table.
  buf.fill(0);
  encodeCount(buf, countLow, countHigh, ptr);
  compress(state, buf, q, w, saved, true);

  const out = Buffer.alloc(64);
  for (let u = 0; u < 16; u++) out.writeUInt32LE(state[u], u * 4);
  return out;
}
