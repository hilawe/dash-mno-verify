// Luffa-512, one of the eleven rounds of the X11 chain.
//
// Ported from the sph_luffa reference implementation carried in Dash Core
// (src/crypto/x11/luffa.c, the sph_luffa512 path with five chaining blocks),
// and verified byte for byte against vectors generated from that same C code.
//
// Two parts of Luffa are worth explaining before the code, because neither is
// obvious from the operations alone.
//
// Message injection. Luffa-512 keeps five 256-bit chaining blocks rather than
// one, and every 32-byte input block has to reach all five. The injection first
// folds the five blocks together, spreads that fold back over each of them, then
// runs a chain of multiplications by the constant M2 so that each block receives
// a different mixture of the others. Finally the message itself is injected five
// times, each time after another M2 step, so block j gets M2^j applied to the
// message. That staggering is what stops the five permutations from running on
// identical inputs, which would collapse the whole construction to one block.
//
// Finalisation. Luffa-512 emits 512 bits from a 256-bit output function, so it
// runs three more rounds after the padded block. The first absorbs the padding,
// then the buffer is wiped to zero and the remaining two rounds absorb that
// all-zero block, each emitting 32 bytes. Squeezing a zero block is what makes
// the second half of the digest depend on the first half's state rather than
// repeating it.
//
// The reference has a "parallel" variant that packs blocks 0 and 1 (and 2 and 3)
// into 64-bit lanes to exploit wider registers. It computes exactly the same
// function as the plain 32-bit variant, so this port follows the 32-bit one,
// which JavaScript's 32-bit bitwise operators express directly.

const BLOCK = 32;

// Initial values for the five chaining blocks.
const V_INIT = [
  [0x6d251e69, 0x44b051e0, 0x4eaa6fb4, 0xdbf78465,
   0x6e292011, 0x90152df4, 0xee058139, 0xdef610bb],
  [0xc3b44b95, 0xd9d2f256, 0x70eee9a0, 0xde099fa3,
   0x5d9b0557, 0x8fc944b3, 0xcf1ccf0e, 0x746cd581],
  [0xf7efc89d, 0x5dba5781, 0x04016ce5, 0xad659c05,
   0x0306194f, 0x666d1836, 0x24aa230a, 0x8b264ae7],
  [0x858075d5, 0x36d79cce, 0xe571f7d7, 0x204b1f67,
   0x35870c6a, 0x57e9e923, 0x14bcb808, 0x7cde72ce],
  [0x6c68e9be, 0x5ec41e22, 0xc825b7c7, 0xaffb4363,
   0xf5df3999, 0x0fc688f1, 0xb07224cc, 0x03e86cea],
];

// Round constants, one pair of eight-entry tables per chaining block. Within a
// round the first table is folded into word 0 and the second into word 4, which
// is what differentiates the five otherwise identical permutations.
const RC0 = [
  [0x303994a6, 0xc0e65299, 0x6cc33a12, 0xdc56983e,
   0x1e00108f, 0x7800423d, 0x8f5b7882, 0x96e1db12],
  [0xb6de10ed, 0x70f47aae, 0x0707a3d4, 0x1c1e8f51,
   0x707a3d45, 0xaeb28562, 0xbaca1589, 0x40a46f3e],
  [0xfc20d9d2, 0x34552e25, 0x7ad8818f, 0x8438764a,
   0xbb6de032, 0xedb780c8, 0xd9847356, 0xa2c78434],
  [0xb213afa5, 0xc84ebe95, 0x4e608a22, 0x56d858fe,
   0x343b138f, 0xd0ec4e3d, 0x2ceb4882, 0xb3ad2208],
  [0xf0d2e9e3, 0xac11d7fa, 0x1bcb66f2, 0x6f2d9bc9,
   0x78602649, 0x8edae952, 0x3b6ba548, 0xedae9520],
];

const RC4 = [
  [0xe0337818, 0x441ba90d, 0x7f34d442, 0x9389217f,
   0xe5a8bce6, 0x5274baf4, 0x26889ba7, 0x9a226e9d],
  [0x01685f3d, 0x05a17cf4, 0xbd09caca, 0xf4272b28,
   0x144ae5cc, 0xfaa7ae2b, 0x2e48f1c1, 0xb923c704],
  [0xe25e72c1, 0xe623bb72, 0x5c58a4a4, 0x1e38e2e7,
   0x78e38b9d, 0x27586719, 0x36eda57f, 0x703aace7],
  [0xe028c9bf, 0x44756f91, 0x7e8fce32, 0x956548be,
   0xfe191be2, 0x3cb226e5, 0x5944a28e, 0xa1c4c355],
  [0x5090d577, 0x2d1925ab, 0xb46496ac, 0xd1925ab0,
   0x29131ab6, 0x0fc053c3, 0x3f014f0c, 0xfc053c31],
];

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// Multiplication by the constant M2 in GF(2^8)[x]/(x^8 + 1), the map that makes
// each of the five message injections distinct. Written descending so it can be
// applied in place, since every source word is read before it is overwritten.
function m2(d, ds, s, ss) {
  const tmp = s[ss + 7];
  d[ds + 7] = s[ss + 6];
  d[ds + 6] = s[ss + 5];
  d[ds + 5] = s[ss + 4];
  d[ds + 4] = (s[ss + 3] ^ tmp) >>> 0;
  d[ds + 3] = (s[ss + 2] ^ tmp) >>> 0;
  d[ds + 2] = s[ss + 1];
  d[ds + 1] = (s[ss + 0] ^ tmp) >>> 0;
  d[ds + 0] = tmp;
}

function xor8(d, ds, a, as, b, bs) {
  for (let i = 0; i < 8; i++) d[ds + i] = (a[as + i] ^ b[bs + i]) >>> 0;
}

// The 4-bit S-box, applied bitsliced across four words at once.
function subCrumb(s, i0, i1, i2, i3) {
  let a0 = s[i0], a1 = s[i1], a2 = s[i2], a3 = s[i3];
  let tmp = a0;
  a0 = (a0 | a1) >>> 0;
  a2 = (a2 ^ a3) >>> 0;
  a1 = (~a1) >>> 0;
  a0 = (a0 ^ a3) >>> 0;
  a3 = (a3 & tmp) >>> 0;
  a1 = (a1 ^ a3) >>> 0;
  a3 = (a3 ^ a2) >>> 0;
  a2 = (a2 & a0) >>> 0;
  a0 = (~a0) >>> 0;
  a2 = (a2 ^ a1) >>> 0;
  a1 = (a1 | a3) >>> 0;
  tmp = (tmp ^ a1) >>> 0;
  a3 = (a3 ^ a2) >>> 0;
  a2 = (a2 & a1) >>> 0;
  a1 = (a1 ^ a0) >>> 0;
  s[i0] = tmp;
  s[i1] = a1;
  s[i2] = a2;
  s[i3] = a3;
}

// The linear mixing step, an MDS-style pair mix over two words.
function mixWord(s, iu, iv) {
  let u = s[iu], v = s[iv];
  v = (v ^ u) >>> 0;
  u = (rotl32(u, 2) ^ v) >>> 0;
  v = (rotl32(v, 14) ^ u) >>> 0;
  u = (rotl32(u, 10) ^ v) >>> 0;
  v = rotl32(v, 1);
  s[iu] = u;
  s[iv] = v;
}

// Message injection, MI5 in the reference. See the note at the top of the file
// for why the message is fed in five times through successive M2 steps.
function inject(V, buf) {
  const M = new Uint32Array(8);
  const a = new Uint32Array(8);
  const b = new Uint32Array(8);

  for (let i = 0; i < 8; i++) M[i] = buf.readUInt32BE(i * 4);

  // a becomes the XOR fold of all five blocks, then M2 of it.
  xor8(a, 0, V, 0, V, 8);
  xor8(b, 0, V, 16, V, 24);
  xor8(a, 0, a, 0, b, 0);
  xor8(a, 0, a, 0, V, 32);
  m2(a, 0, a, 0);
  for (let k = 0; k < 5; k++) xor8(V, k * 8, a, 0, V, k * 8);

  // Two passes of the M2 chain, forward then backward, so every block ends up
  // carrying material from every other block.
  m2(b, 0, V, 0);
  xor8(b, 0, b, 0, V, 8);
  for (let k = 1; k <= 4; k++) {
    m2(V, k * 8, V, k * 8);
    xor8(V, k * 8, V, k * 8, V, (k % 5 === 4 ? 0 : (k + 1) * 8));
  }
  m2(V, 0, b, 0);
  xor8(V, 0, V, 0, V, 32);
  for (let k = 4; k >= 2; k--) {
    m2(V, k * 8, V, k * 8);
    xor8(V, k * 8, V, k * 8, V, (k - 1) * 8);
  }
  m2(V, 8, V, 8);
  xor8(V, 8, V, 8, b, 0);

  // Block j receives M2^j applied to the message word.
  for (let k = 0; k < 5; k++) {
    xor8(V, k * 8, V, k * 8, M, 0);
    if (k < 4) m2(M, 0, M, 0);
  }
}

// The permutation P5. The tweak rotates the upper half of blocks 1 through 4 by
// the block index, which is the only asymmetry between them apart from the round
// constants, and it is what keeps the four permutations from being identical.
function permute(V) {
  for (let k = 1; k <= 4; k++) {
    for (let i = 4; i < 8; i++) V[k * 8 + i] = rotl32(V[k * 8 + i], k);
  }
  for (let k = 0; k < 5; k++) {
    const o = k * 8;
    const rc0 = RC0[k];
    const rc4 = RC4[k];
    for (let r = 0; r < 8; r++) {
      subCrumb(V, o + 0, o + 1, o + 2, o + 3);
      subCrumb(V, o + 5, o + 6, o + 7, o + 4);
      mixWord(V, o + 0, o + 4);
      mixWord(V, o + 1, o + 5);
      mixWord(V, o + 2, o + 6);
      mixWord(V, o + 3, o + 7);
      V[o + 0] = (V[o + 0] ^ rc0[r]) >>> 0;
      V[o + 4] = (V[o + 4] ^ rc4[r]) >>> 0;
    }
  }
}

/**
 * Luffa-512 of a byte string.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} the 64-byte digest
 */
export function luffa512(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const V = new Uint32Array(40);
  for (let k = 0; k < 5; k++) {
    for (let i = 0; i < 8; i++) V[k * 8 + i] = V_INIT[k][i];
  }

  const buf = Buffer.alloc(BLOCK);
  let ptr = 0;
  let off = 0;
  while (off < data.length) {
    const clen = Math.min(BLOCK - ptr, data.length - off);
    data.copy(buf, ptr, off, off + clen);
    ptr += clen;
    off += clen;
    if (ptr === BLOCK) {
      inject(V, buf);
      permute(V);
      ptr = 0;
    }
  }

  // Padding is a single 0x80 bit followed by zeros, with no length encoding,
  // because Luffa's block counter is implicit in the chaining structure.
  buf[ptr++] = 0x80;
  buf.fill(0, ptr);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 3; i++) {
    inject(V, buf);
    permute(V);
    if (i === 0) {
      buf.fill(0);
    } else {
      // Output is the XOR of all five blocks, big endian, 32 bytes per squeeze.
      const base = (i - 1) * 32;
      for (let j = 0; j < 8; j++) {
        const w = (V[j] ^ V[8 + j] ^ V[16 + j] ^ V[24 + j] ^ V[32 + j]) >>> 0;
        out.writeUInt32BE(w, base + j * 4);
      }
    }
  }
  return out;
}

export default luffa512;
