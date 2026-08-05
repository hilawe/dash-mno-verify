// Groestl-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core, following its
// sph_groestl512 path, and checked against vectors generated from that same implementation compiled
// unmodified (test/vectors/x11_round_vectors.json). Porting a hash from memory or from prose is how a
// subtly wrong round gets written, and a wrong round produces an output that is simply different, with
// nothing to say which of the eleven was at fault.
//
// The state is a 1024-bit matrix of eight rows by sixteen columns of bytes, held here as sixteen
// 64-bit columns split into a high and a low 32-bit half, since JavaScript has no fast 64-bit integer.
// Column c is message bytes 8c through 8c+7 read big-endian, so row i of column c is byte i of that
// word. The reference can hold the same matrix mirrored (its USE_LE branch reads columns
// little-endian, indexes rows from the least significant byte, and byte-swaps its tables to match),
// which is the same computation seen from the other end. This port takes the big-endian reading
// throughout, which is the branch whose table literals can be compared byte for byte.
//
// A compression step runs two different permutations of the same shape, P over the chaining value
// exclusive-ored with the message block, and Q over the message block alone, then folds both back into
// the chaining value. They differ only in their round constants and in how far each row is shifted,
// which is what keeps the two halves from cancelling.

// Rows are shifted left by these amounts before the columns are mixed. Row 7 jumps by eleven rather
// than seven, which is what makes the 1024-bit variant diffuse across all sixteen columns instead of
// folding back onto the first eight.
const P_SHIFT = [0, 1, 2, 3, 4, 5, 6, 11];
const Q_SHIFT = [1, 3, 5, 11, 0, 2, 4, 6];

const ROUNDS = 14;
const BLOCK_BYTES = 128;

// Multiplication in the AES field, the same one Groestl borrows for both its S-box and its MixBytes
// matrix.
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

// The AES S-box, generated rather than pasted. Every non-zero element has a multiplicative inverse in
// the field, found here through the discrete logarithm to the generator 3, and the S-box is that
// inverse put through the standard affine map.
function buildSbox() {
  const antilog = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    antilog[i] = x;
    log[x] = i;
    x = gmul(x, 3);
  }
  const sbox = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    // Zero has no inverse and the S-box maps it through as zero. The modulo matters for v = 1, whose
    // logarithm is zero, since the antilog table has period 255 rather than 256.
    const inverse = v === 0 ? 0 : antilog[(255 - log[v]) % 255];
    let s = 0x63;
    for (let k = 0; k < 5; k++) s ^= ((inverse << k) | (inverse >>> (8 - k))) & 0xff;
    sbox[v] = s;
  }
  return sbox;
}

// The eight lookup tables fuse SubBytes with one column of the MixBytes matrix, which is the circulant
// of (2, 2, 3, 4, 5, 3, 5, 7). Column zero of that matrix, read down the rows, is the multiplier list
// below, and the remaining seven columns are the same word rotated one byte further each time. So one
// generated table plus a rotation reproduces all eight, which is exactly the identity the reference's
// own small-footprint branch relies on when it substitutes rotations of T0 and T4 for T1 through T7.
//
// These were checked, all 256 entries of each, against the T0, T1, and T4 literals in the reference
// source before this file was written. Nothing here is recalled from the specification.
const MIX_COLUMN = [2, 7, 5, 3, 5, 4, 3, 2];

const TABLE_HI = new Uint32Array(8 * 256);
const TABLE_LO = new Uint32Array(8 * 256);

(function buildTables() {
  const sbox = buildSbox();
  const bytes = new Uint8Array(8);
  for (let v = 0; v < 256; v++) {
    for (let row = 0; row < 8; row++) bytes[row] = gmul(MIX_COLUMN[row], sbox[v]);
    for (let k = 0; k < 8; k++) {
      let hi = 0;
      let lo = 0;
      for (let i = 0; i < 8; i++) {
        // Table k is table zero rotated right by k bytes, the rotation being what selects which
        // output column this contribution lands in.
        const b = bytes[(i - k + 8) & 7];
        if (i < 4) hi = ((hi << 8) | b) >>> 0;
        else lo = ((lo << 8) | b) >>> 0;
      }
      TABLE_HI[(k << 8) + v] = hi;
      TABLE_LO[(k << 8) + v] = lo;
    }
  }
})();

// One permutation, fourteen rounds of AddRoundConstant then the fused SubBytes, ShiftBytes, MixBytes
// lookup. P and Q run the same code and differ in the two arguments.
//
// P adds the round constant to row 0 only, byte (16c + r) into column c. Q adds its constant to row 7,
// (0xff ^ 16c ^ r), and sets every other row to all ones. Two permutations with the same constants
// would let the P and Q halves of a compression cancel, so the asymmetry is load bearing.
function permute(hi, lo, shift, isQ) {
  const outHi = new Uint32Array(16);
  const outLo = new Uint32Array(16);
  for (let r = 0; r < ROUNDS; r++) {
    for (let c = 0; c < 16; c++) {
      if (isQ) {
        hi[c] ^= 0xffffffff;
        lo[c] ^= (0xffffff00 | (0xff ^ (c << 4) ^ r)) >>> 0;
      } else {
        hi[c] ^= (((c << 4) + r) << 24) >>> 0;
      }
    }
    for (let d = 0; d < 16; d++) {
      let ah = 0;
      let al = 0;
      for (let i = 0; i < 8; i++) {
        // Row i of the output column d is taken from the column that row's shift brings here.
        const c = (d + shift[i]) & 15;
        const word = i < 4 ? hi[c] : lo[c];
        const b = (word >>> (24 - ((i & 3) << 3))) & 0xff;
        const k = (i << 8) + b;
        ah ^= TABLE_HI[k];
        al ^= TABLE_LO[k];
      }
      outHi[d] = ah;
      outLo[d] = al;
    }
    hi.set(outHi);
    lo.set(outLo);
  }
}

// One 128-byte block folded into the chaining value, H = H xor P(H xor m) xor Q(m).
function compress(stateHi, stateLo, data, at) {
  const gHi = new Uint32Array(16);
  const gLo = new Uint32Array(16);
  const mHi = new Uint32Array(16);
  const mLo = new Uint32Array(16);
  for (let u = 0; u < 16; u++) {
    mHi[u] = data.readUInt32BE(at + u * 8);
    mLo[u] = data.readUInt32BE(at + u * 8 + 4);
    gHi[u] = (mHi[u] ^ stateHi[u]) >>> 0;
    gLo[u] = (mLo[u] ^ stateLo[u]) >>> 0;
  }
  permute(gHi, gLo, P_SHIFT, false);
  permute(mHi, mLo, Q_SHIFT, true);
  for (let u = 0; u < 16; u++) {
    stateHi[u] ^= gHi[u] ^ mHi[u];
    stateLo[u] ^= gLo[u] ^ mLo[u];
  }
}

export function groestl512(input) {
  const data = Buffer.from(input);

  // The initial chaining value is zero except for the output length in bits, sitting in the last
  // column. That is what distinguishes Groestl-512 from Groestl-384, which shares this whole code
  // path and differs only here and in how much of the final state it keeps.
  const stateHi = new Uint32Array(16);
  const stateLo = new Uint32Array(16);
  stateLo[15] = 512;

  let at = 0;
  for (; at + BLOCK_BYTES <= data.length; at += BLOCK_BYTES) compress(stateHi, stateLo, data, at);

  // Padding is a single 0x80 byte, then zeroes, then the block count big-endian in the last eight
  // bytes. The count includes the padding blocks themselves, so a tail with no room for the length
  // field takes a second block and counts two.
  const rest = data.length - at;
  const padLen = rest < BLOCK_BYTES - 8 ? BLOCK_BYTES - rest : 2 * BLOCK_BYTES - rest;
  const blocks = at / BLOCK_BYTES + (rest < BLOCK_BYTES - 8 ? 1 : 2);
  const tail = Buffer.alloc(rest + padLen);
  data.copy(tail, 0, at);
  tail[rest] = 0x80;
  tail.writeUInt32BE(Math.floor(blocks / 0x100000000), tail.length - 8);
  tail.writeUInt32BE(blocks >>> 0, tail.length - 4);
  for (let off = 0; off < tail.length; off += BLOCK_BYTES) compress(stateHi, stateLo, tail, off);

  // Output transformation, H xor P(H). Only the bottom half of the result is kept, columns 8 through
  // 15, which is the truncation that takes the 1024-bit state down to the 512-bit digest.
  const xHi = Uint32Array.from(stateHi);
  const xLo = Uint32Array.from(stateLo);
  permute(xHi, xLo, P_SHIFT, false);

  const out = Buffer.alloc(64);
  for (let u = 0; u < 8; u++) {
    out.writeUInt32BE((stateHi[u + 8] ^ xHi[u + 8]) >>> 0, u * 8);
    out.writeUInt32BE((stateLo[u + 8] ^ xLo[u + 8]) >>> 0, u * 8 + 4);
  }
  return out;
}
