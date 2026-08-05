// ECHO-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core, and checked against vectors
// generated from that same implementation compiled unmodified (test/vectors/x11_round_vectors.json).
// Porting a hash from memory or from prose is how a subtly wrong round gets written, and a wrong round
// produces an output that is simply different, with nothing to say which of the eleven was at fault.
//
// The state is a 4x4 grid of 128-bit words, held here as sixteen groups of four little-endian 32-bit
// words. The upper half of the grid is the 128-byte message block, the lower half is the chaining
// value, and one compression is ten rounds of (two AES rounds per grid word, then SHIFT_ROWS, then
// MIX_COLUMNS over each group of four).

// The AES tables. The reference builds them at compile time from the field arithmetic rather than
// storing a blob, so the same construction is repeated here. These are the little-endian transform
// tables, so aes_tbox_le[0][0] is 0xa56363c6 rather than the 0xc66363a5 a big-endian table would give.
const GF_POW = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 256; i++) {
    GF_POW[i] = x;
    GF_LOG[x] = i;
    x = (x ^ (((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff)) & 0xff;
  }
}

// Multiplication in the AES field, by way of logarithms. Zero has no logarithm, hence the guard.
const gfMul = (a, b) => (a !== 0 && b !== 0 ? GF_POW[(GF_LOG[a] + GF_LOG[b]) % 255] : 0);

const SBOX = new Uint8Array(256);
SBOX[0] = 0x63;
for (let i = 1; i < 256; i++) {
  const inv = GF_POW[255 - GF_LOG[i]];
  const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  let y = inv;
  let v = inv;
  y = rotl8(y, 1); v ^= y;
  y = rotl8(y, 1); v ^= y;
  y = rotl8(y, 1); v ^= y;
  y = rotl8(y, 1); v ^= y ^ 0x63;
  SBOX[i] = v & 0xff;
}

const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const s = SBOX[i];
  let w = ((gfMul(s, 3) << 24) | (s << 16) | (s << 8) | gfMul(s, 2)) >>> 0;
  T0[i] = w;
  w = ((w << 8) | (w >>> 24)) >>> 0;
  T1[i] = w;
  w = ((w << 8) | (w >>> 24)) >>> 0;
  T2[i] = w;
  w = ((w << 8) | (w >>> 24)) >>> 0;
  T3[i] = w;
}

const BLOCK_BYTES = 128;
const ROUNDS = 10;

// Two AES rounds over every 128-bit word of the grid.
//
// The first round is keyed by a 128-bit counter K, which starts each compression at the running count
// of message bits and is incremented by one after every word. That per-word increment is what keeps
// the sixteen otherwise identical AES applications from being the same permutation.
//
// The second round takes the salt as its key. ECHO's salt is zero for the X11 use, so the reference
// folds the exclusive-or away entirely and calls a keyless round. Nothing else in this file mentions
// the salt, which is why it is worth saying here rather than leaving a reader to wonder.
function fullStateRound(W, K) {
  for (let n = 0; n < 16; n++) {
    const o = n * 4;
    const x0 = W[o], x1 = W[o + 1], x2 = W[o + 2], x3 = W[o + 3];

    const y0 = T0[x0 & 0xff] ^ T1[(x1 >>> 8) & 0xff] ^ T2[(x2 >>> 16) & 0xff] ^ T3[x3 >>> 24] ^ K[0];
    const y1 = T0[x1 & 0xff] ^ T1[(x2 >>> 8) & 0xff] ^ T2[(x3 >>> 16) & 0xff] ^ T3[x0 >>> 24] ^ K[1];
    const y2 = T0[x2 & 0xff] ^ T1[(x3 >>> 8) & 0xff] ^ T2[(x0 >>> 16) & 0xff] ^ T3[x1 >>> 24] ^ K[2];
    const y3 = T0[x3 & 0xff] ^ T1[(x0 >>> 8) & 0xff] ^ T2[(x1 >>> 16) & 0xff] ^ T3[x2 >>> 24] ^ K[3];

    W[o] = T0[y0 & 0xff] ^ T1[(y1 >>> 8) & 0xff] ^ T2[(y2 >>> 16) & 0xff] ^ T3[(y3 >>> 24) & 0xff];
    W[o + 1] = T0[y1 & 0xff] ^ T1[(y2 >>> 8) & 0xff] ^ T2[(y3 >>> 16) & 0xff] ^ T3[(y0 >>> 24) & 0xff];
    W[o + 2] = T0[y2 & 0xff] ^ T1[(y3 >>> 8) & 0xff] ^ T2[(y0 >>> 16) & 0xff] ^ T3[(y1 >>> 24) & 0xff];
    W[o + 3] = T0[y3 & 0xff] ^ T1[(y0 >>> 8) & 0xff] ^ T2[(y1 >>> 16) & 0xff] ^ T3[(y2 >>> 24) & 0xff];

    K[0] = K[0] + 1;
    if (K[0] === 0) {
      K[1] = K[1] + 1;
      if (K[1] === 0) {
        K[2] = K[2] + 1;
        if (K[2] === 0) K[3] = K[3] + 1;
      }
    }
  }
}

// Rotate one whole 128-bit grid word into another slot. SHIFT_ROWS moves entire words, not bytes,
// because in ECHO a grid cell IS a 128-bit word.
function swapWords(W, a, b) {
  for (let j = 0; j < 4; j++) {
    const t = W[a * 4 + j];
    W[a * 4 + j] = W[b * 4 + j];
    W[b * 4 + j] = t;
  }
}

function shiftRows(W) {
  // Row 1 left by one, row 2 by two, row 3 by three, each written as the same rotate the reference
  // spells out with its SHIFT_ROW macros.
  swapWords(W, 1, 5); swapWords(W, 5, 9); swapWords(W, 9, 13);
  swapWords(W, 2, 10); swapWords(W, 6, 14);
  swapWords(W, 15, 11); swapWords(W, 11, 7); swapWords(W, 7, 3);
}

// The MDS mix over one column of four grid words. The reference works on 64-bit lanes, but every
// operation here is bytewise (the 0x80 mask picks out the bits that would overflow the field, and the
// shifted value is masked so no carry ever crosses a byte), so splitting each lane into two 32-bit
// halves gives identical results.
function mixColumn(W, ia, ib, ic, id) {
  for (let j = 0; j < 4; j++) {
    const a = W[ia * 4 + j], b = W[ib * 4 + j], c = W[ic * 4 + j], d = W[id * 4 + j];
    const ab = a ^ b, bc = b ^ c, cd = c ^ d;
    const abx = (((ab & 0x80808080) >>> 7) * 27) ^ ((ab & 0x7f7f7f7f) << 1);
    const bcx = (((bc & 0x80808080) >>> 7) * 27) ^ ((bc & 0x7f7f7f7f) << 1);
    const cdx = (((cd & 0x80808080) >>> 7) * 27) ^ ((cd & 0x7f7f7f7f) << 1);
    W[ia * 4 + j] = abx ^ bc ^ d;
    W[ib * 4 + j] = bcx ^ a ^ cd;
    W[ic * 4 + j] = cdx ^ ab ^ d;
    W[id * 4 + j] = abx ^ bcx ^ cdx ^ ab ^ c;
  }
}

// One compression of the 128-byte buffer into the chaining value V.
function compress(V, buf, C) {
  const W = new Uint32Array(64);
  W.set(V, 0);
  for (let i = 0; i < 32; i++) W[32 + i] = buf.readUInt32LE(i * 4);

  const K = Uint32Array.from(C);
  for (let r = 0; r < ROUNDS; r++) {
    fullStateRound(W, K);
    shiftRows(W);
    mixColumn(W, 0, 1, 2, 3);
    mixColumn(W, 4, 5, 6, 7);
    mixColumn(W, 8, 9, 10, 11);
    mixColumn(W, 12, 13, 14, 15);
  }

  // BIG_FINAL, the fold back into the chaining value. The permuted grid is 512 bits wider than V, so
  // both halves are exclusive-ored in, together with the raw message block. Without this feedforward
  // the compression would be invertible, since the round function alone is a permutation.
  for (let i = 0; i < 32; i++) V[i] ^= buf.readUInt32LE(i * 4) ^ W[i] ^ W[i + 32];
}

// The counter C is the number of message bits processed so far, held as four 32-bit words. It keys the
// AES rounds and is also written into the final padded block, which is what binds the length into the
// digest.
function incrCounter(C, val) {
  C[0] = C[0] + val;
  if (C[0] < val) {
    C[1] = C[1] + 1;
    if (C[1] === 0) {
      C[2] = C[2] + 1;
      if (C[2] === 0) C[3] = C[3] + 1;
    }
  }
}

export function echo512(input) {
  const data = Buffer.from(input);

  // Every one of the eight chaining words starts at the output length in bits, which is how ECHO
  // separates its 224, 256, 384, and 512-bit variants without a distinct initial value table.
  const V = new Uint32Array(32);
  for (let i = 0; i < 8; i++) V[i * 4] = 512;

  const C = new Uint32Array(4);
  const buf = Buffer.alloc(BLOCK_BYTES);
  let ptr = 0;

  for (let at = 0; at < data.length; ) {
    const clen = Math.min(BLOCK_BYTES - ptr, data.length - at);
    data.copy(buf, ptr, at, at + clen);
    ptr += clen;
    at += clen;
    if (ptr === BLOCK_BYTES) {
      incrCounter(C, BLOCK_BYTES * 8);
      compress(V, buf, C);
      ptr = 0;
    }
  }

  // Padding. The counter first takes the bits held in the partial block, then is captured, because the
  // value written into the last block is the message length and must not count the padding itself.
  const elen = ptr << 3;
  incrCounter(C, elen);
  const tail = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) tail.writeUInt32LE(C[i], i * 4);

  // A final block holding no message bits, only the padding marker, carries a zero counter rather than
  // the count that led up to it.
  if (elen === 0) C.fill(0);

  buf[ptr++] = 0x80;
  buf.fill(0, ptr);
  if (ptr > BLOCK_BYTES - 18) {
    // No room left for the length and counter fields, so this block goes out as padding alone and the
    // counter resets, since the extra block contributes no message bits.
    compress(V, buf, C);
    C.fill(0);
    buf.fill(0);
  }
  buf.writeUInt16LE(512, BLOCK_BYTES - 18);
  tail.copy(buf, BLOCK_BYTES - 16);
  compress(V, buf, C);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(V[i], i * 4);
  return out;
}
