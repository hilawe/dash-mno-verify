// BMW-512 (Blue Midnight Wish), one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core, and checked against vectors
// generated from that same implementation compiled unmodified (test/vectors/x11_round_vectors.json).
// Porting a hash from memory or from prose is how a subtly wrong round gets written, and a wrong round
// produces an output that is simply different, with nothing to say which of the eleven was at fault.
//
// The 512-bit variant works on sixteen 64-bit words with a 128-byte block, everything little-endian.
// The state is BigInt rather than a 32-bit hi/lo split, which is slower per operation but keeps the
// expansion and folding steps readable against the C macros. X11 runs this once per block header, not
// in a hot loop, so the readability is worth more here than the speed.

const BLOCK_BYTES = 128;
const MASK = (1n << 64n) - 1n;

const IV512 = [
  0x8081828384858687n, 0x88898a8b8c8d8e8fn, 0x9091929394959697n, 0x98999a9b9c9d9e9fn,
  0xa0a1a2a3a4a5a6a7n, 0xa8a9aaabacadaeafn, 0xb0b1b2b3b4b5b6b7n, 0xb8b9babbbcbdbebfn,
  0xc0c1c2c3c4c5c6c7n, 0xc8c9cacbcccdcecfn, 0xd0d1d2d3d4d5d6d7n, 0xd8d9dadbdcdddedfn,
  0xe0e1e2e3e4e5e6e7n, 0xe8e9eaebecedeeefn, 0xf0f1f2f3f4f5f6f7n, 0xf8f9fafbfcfdfeffn,
];

// The reference runs one final compression against this fixed "final" state instead of the running
// chaining value. That extra pass is what turns the last chaining value into the digest, so a port
// that stops after the padded block produces a plausible-looking but wrong 64 bytes.
const FINAL_B = [
  0xaaaaaaaaaaaaaaa0n, 0xaaaaaaaaaaaaaaa1n, 0xaaaaaaaaaaaaaaa2n, 0xaaaaaaaaaaaaaaa3n,
  0xaaaaaaaaaaaaaaa4n, 0xaaaaaaaaaaaaaaa5n, 0xaaaaaaaaaaaaaaa6n, 0xaaaaaaaaaaaaaaa7n,
  0xaaaaaaaaaaaaaaa8n, 0xaaaaaaaaaaaaaaa9n, 0xaaaaaaaaaaaaaaaan, 0xaaaaaaaaaaaaaaabn,
  0xaaaaaaaaaaaaaaacn, 0xaaaaaaaaaaaaaaadn, 0xaaaaaaaaaaaaaaaen, 0xaaaaaaaaaaaaaaafn,
];

const t64 = (x) => x & MASK;
const shl = (x, n) => (x << BigInt(n)) & MASK;
const shr = (x, n) => (x & MASK) >> BigInt(n);
const rotl = (x, n) => (((x << BigInt(n)) | ((x & MASK) >> BigInt(64 - n))) & MASK);

// The s-boxes and rotations of the expansion, named as in the reference (sb0..sb5, rb1..rb7).
const sb0 = (x) => shr(x, 1) ^ shl(x, 3) ^ rotl(x, 4) ^ rotl(x, 37);
const sb1 = (x) => shr(x, 1) ^ shl(x, 2) ^ rotl(x, 13) ^ rotl(x, 43);
const sb2 = (x) => shr(x, 2) ^ shl(x, 1) ^ rotl(x, 19) ^ rotl(x, 53);
const sb3 = (x) => shr(x, 2) ^ shl(x, 2) ^ rotl(x, 28) ^ rotl(x, 59);
const sb4 = (x) => shr(x, 1) ^ x;
const sb5 = (x) => shr(x, 2) ^ x;
const rb1 = (x) => rotl(x, 5);
const rb2 = (x) => rotl(x, 11);
const rb3 = (x) => rotl(x, 27);
const rb4 = (x) => rotl(x, 32);
const rb5 = (x) => rotl(x, 37);
const rb6 = (x) => rotl(x, 43);
const rb7 = (x) => rotl(x, 53);

const KB = [];
for (let j = 16; j < 32; j++) KB.push(t64(BigInt(j) * 0x0555555555555555n));

// The sixteen W values, each a signed sum of five (M[i] XOR H[i]) terms. The reference spells these
// out as Wb0..Wb15 through a macro that takes the operators as arguments, so the table below carries
// the same index-and-sign pairs in the same order. Everything wraps at 64 bits, so the subtractions
// are modular and the order within a row does not matter.
const W_TERMS = [
  [[5, 1], [7, -1], [10, 1], [13, 1], [14, 1]],
  [[6, 1], [8, -1], [11, 1], [14, 1], [15, -1]],
  [[0, 1], [7, 1], [9, 1], [12, -1], [15, 1]],
  [[0, 1], [1, -1], [8, 1], [10, -1], [13, 1]],
  [[1, 1], [2, 1], [9, 1], [11, -1], [14, -1]],
  [[3, 1], [2, -1], [10, 1], [12, -1], [15, 1]],
  [[4, 1], [0, -1], [3, -1], [11, -1], [13, 1]],
  [[1, 1], [4, -1], [5, -1], [12, -1], [14, -1]],
  [[2, 1], [5, -1], [6, -1], [13, 1], [15, -1]],
  [[0, 1], [3, -1], [6, 1], [7, -1], [14, 1]],
  [[8, 1], [1, -1], [4, -1], [7, -1], [15, 1]],
  [[8, 1], [0, -1], [2, -1], [5, -1], [9, 1]],
  [[1, 1], [3, 1], [6, -1], [9, -1], [10, 1]],
  [[2, 1], [4, 1], [7, 1], [10, 1], [11, 1]],
  [[3, 1], [5, -1], [8, 1], [11, -1], [12, -1]],
  [[12, 1], [4, -1], [6, -1], [9, -1], [13, 1]],
];

// Which s-box each of the first sixteen q words uses, and which H word is added to it. The H index is
// (i + 1) except for the last, which wraps to H[0].
const QA_SBOX = [sb0, sb1, sb2, sb3, sb4, sb0, sb1, sb2, sb3, sb4, sb0, sb1, sb2, sb3, sb4, sb0];

function compress(block, h, out) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = block.readBigUInt64LE(i * 8);

  const q = new Array(32);

  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (const [idx, sign] of W_TERMS[i]) {
      const term = m[idx] ^ h[idx];
      w = sign > 0 ? w + term : w - term;
    }
    q[i] = t64(QA_SBOX[i](t64(w)) + h[(i + 1) & 15]);
  }

  // add_elt_b, written in the reference's small-footprint form because the two forms agree and this
  // one shows the structure. The rotation amount for M[k] is always k + 1, and the three message
  // words are taken at offsets 0, 3 and 10 from the expansion index.
  const addElt = (j) => {
    const a = (j + 0) & 15;
    const b = (j + 3) & 15;
    const c = (j + 10) & 15;
    const sum = t64(rotl(m[a], a + 1) + rotl(m[b], b + 1) - rotl(m[c], c + 1) + KB[j]);
    return sum ^ h[(j + 7) & 15];
  };

  // q[16] and q[17] use the wide expansion (sixteen s-box applications), the rest use the cheap one.
  // The reference switches at exactly this point, and the two produce different values, so the
  // boundary matters.
  for (let i = 16; i < 18; i++) {
    let s = 0n;
    const boxes = [sb1, sb2, sb3, sb0];
    for (let k = 0; k < 16; k++) s += boxes[k & 3](q[i - 16 + k]);
    q[i] = t64(s + addElt(i - 16));
  }
  for (let i = 18; i < 32; i++) {
    const p = (k) => q[i - 16 + k];
    let s = p(0) + rb1(p(1)) + p(2) + rb2(p(3)) + p(4) + rb3(p(5)) + p(6) + rb4(p(7));
    s += p(8) + rb5(p(9)) + p(10) + rb6(p(11)) + p(12) + rb7(p(13)) + sb4(p(14)) + sb5(p(15));
    q[i] = t64(s + addElt(i - 16));
  }

  let xl = q[16] ^ q[17] ^ q[18] ^ q[19] ^ q[20] ^ q[21] ^ q[22] ^ q[23];
  const xh = xl ^ q[24] ^ q[25] ^ q[26] ^ q[27] ^ q[28] ^ q[29] ^ q[30] ^ q[31];

  out[0] = t64((shl(xh, 5) ^ shr(q[16], 5) ^ m[0]) + (xl ^ q[24] ^ q[0]));
  out[1] = t64((shr(xh, 7) ^ shl(q[17], 8) ^ m[1]) + (xl ^ q[25] ^ q[1]));
  out[2] = t64((shr(xh, 5) ^ shl(q[18], 5) ^ m[2]) + (xl ^ q[26] ^ q[2]));
  out[3] = t64((shr(xh, 1) ^ shl(q[19], 5) ^ m[3]) + (xl ^ q[27] ^ q[3]));
  out[4] = t64((shr(xh, 3) ^ q[20] ^ m[4]) + (xl ^ q[28] ^ q[4]));
  out[5] = t64((shl(xh, 6) ^ shr(q[21], 6) ^ m[5]) + (xl ^ q[29] ^ q[5]));
  out[6] = t64((shr(xh, 4) ^ shl(q[22], 6) ^ m[6]) + (xl ^ q[30] ^ q[6]));
  out[7] = t64((shr(xh, 11) ^ shl(q[23], 2) ^ m[7]) + (xl ^ q[31] ^ q[7]));

  // The second half reads back the first half of this same output, so out[0..7] must already hold
  // their final values here. Writing into a separate buffer and copying afterwards would change the
  // result, which is why the reference assigns dh[8..15] only after dh[0..7].
  out[8] = t64(rotl(out[4], 9) + (xh ^ q[24] ^ m[8]) + (shl(xl, 8) ^ q[23] ^ q[8]));
  out[9] = t64(rotl(out[5], 10) + (xh ^ q[25] ^ m[9]) + (shr(xl, 6) ^ q[16] ^ q[9]));
  out[10] = t64(rotl(out[6], 11) + (xh ^ q[26] ^ m[10]) + (shl(xl, 6) ^ q[17] ^ q[10]));
  out[11] = t64(rotl(out[7], 12) + (xh ^ q[27] ^ m[11]) + (shl(xl, 4) ^ q[18] ^ q[11]));
  out[12] = t64(rotl(out[0], 13) + (xh ^ q[28] ^ m[12]) + (shr(xl, 3) ^ q[19] ^ q[12]));
  out[13] = t64(rotl(out[1], 14) + (xh ^ q[29] ^ m[13]) + (shr(xl, 4) ^ q[20] ^ q[13]));
  out[14] = t64(rotl(out[2], 15) + (xh ^ q[30] ^ m[14]) + (shr(xl, 7) ^ q[21] ^ q[14]));
  out[15] = t64(rotl(out[3], 16) + (xh ^ q[31] ^ m[15]) + (shr(xl, 2) ^ q[22] ^ q[15]));
}

export function bmw512(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);

  let h = IV512.slice();
  let scratch = new Array(16);

  const full = Math.floor(data.length / BLOCK_BYTES);
  for (let b = 0; b < full; b++) {
    compress(data.subarray(b * BLOCK_BYTES, (b + 1) * BLOCK_BYTES), h, scratch);
    const swap = h;
    h = scratch;
    scratch = swap;
  }

  const buf = Buffer.alloc(BLOCK_BYTES);
  const tailLen = data.length - full * BLOCK_BYTES;
  data.copy(buf, 0, full * BLOCK_BYTES);
  let ptr = tailLen;
  buf[ptr++] = 0x80;

  // If the 0x80 byte lands in the last eight bytes there is no room left for the length, so the block
  // is compressed as-is and the length goes into a fresh one. The threshold is "ptr past 120", not
  // "ptr past 119", because a marker sitting exactly at offset 119 still leaves the length field free.
  if (ptr > BLOCK_BYTES - 8) {
    buf.fill(0, ptr);
    compress(buf, h, scratch);
    const swap = h;
    h = scratch;
    scratch = swap;
    buf.fill(0);
    ptr = 0;
  }
  buf.fill(0, ptr, BLOCK_BYTES - 8);
  buf.writeBigUInt64LE(t64(BigInt(data.length) * 8n), BLOCK_BYTES - 8);
  compress(buf, h, scratch);

  // The final pass compresses the chaining value itself, laid out as a block, against FINAL_B.
  for (let i = 0; i < 16; i++) buf.writeBigUInt64LE(scratch[i], i * 8);
  compress(buf, FINAL_B, h);

  // Only the top half of the state is output, and 512 bits means the last eight words.
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[8 + i], i * 8);
  return out;
}
