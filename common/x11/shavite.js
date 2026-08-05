// SHAvite-3-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core, and checked against vectors
// generated from that same implementation compiled unmodified (test/vectors/x11_round_vectors.json).
// Porting a hash from memory or from prose is how a subtly wrong round gets written, and a wrong round
// produces an output that is simply different, with nothing to say which of the eleven was at fault.
//
// Two things here cannot be inferred by reading the round function, and both are called out where they
// happen. The first is the message-expansion schedule, which grows a 128-byte block into 448 words by
// alternating an AES-driven step with a cheap linear step. The second is that the 64-bit-plus message
// length counter is injected into four specific places inside that expansion, so the schedule (not just
// the padding) depends on how much data has been consumed.
//
// Note the sph header's warning that the SHAvite-3 round-2 reference implementation and its published
// test vectors disagree with the specification over AES table endianness. This port follows sph, which
// follows the specification, because that is what Dash Core hashes with.

const BLOCK_BYTES = 128;
const OUT_WORDS = 16;

// The initial value for the 512-bit variant, taken verbatim from the reference.
const IV512 = new Uint32Array([
  0x72fccdd8, 0x79ca4727, 0x128a077b, 0x40d55aec,
  0xd1901a06, 0x430ae307, 0xb29f5cd1, 0xdf07fbfc,
  0x8e45d73d, 0x681ab538, 0xbde86578, 0xdd577e47,
  0xe275eade, 0x502d9fcd, 0xb9357178, 0x022a4b9a,
]);

// --- AES round, table driven -------------------------------------------------------------------
//
// The tables are generated the same way the reference generates them at compile time, from GF(2^8)
// arithmetic, rather than being pasted in as 1024 magic constants that nobody can check. The four
// values asserted below are the ones the reference asserts on itself, so a mistake in the derivation
// stops the module at load instead of surfacing as a wrong hash much later.

const gf8Mul2 = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0x00)) & 0xff;

const GF_LOG = new Uint8Array(256);
const GF_POW = new Uint8Array(256);
{
  // Walking x -> x*3 enumerates every nonzero element, so this builds a discrete log table base 3.
  let x = 1;
  for (let i = 0; i < 256; i++) {
    GF_LOG[x] = i;
    GF_POW[i] = x;
    x = (x ^ gf8Mul2(x)) & 0xff;
  }
}

function gf8Mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_POW[(GF_LOG[a] + GF_LOG[b]) % 255];
}

const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;
const rotl32 = (x, n) => (((x << n) | (x >>> (32 - n))) >>> 0);

const SBOX = new Uint8Array(256);
SBOX[0] = 0x63;
for (let i = 1; i < 256; i++) {
  // The multiplicative inverse, then the affine map, which is five rotations folded together.
  let x = GF_POW[255 - GF_LOG[i]];
  let y = x;
  for (let k = 0; k < 4; k++) {
    y = rotl8(y, 1);
    x ^= y;
  }
  SBOX[i] = (x ^ 0x63) & 0xff;
}

// One table per byte lane. T0 packs the MixColumns column little-endian and the rest are byte
// rotations of it, which is what makes the round below four lookups and three exclusive ors per word.
const T = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
for (let i = 0; i < 256; i++) {
  const b = SBOX[i];
  let word = (((gf8Mul(b, 3) << 24) | (b << 16) | (b << 8) | gf8Mul(b, 2)) >>> 0);
  for (let j = 0; j < 4; j++) {
    T[j][i] = word;
    word = rotl32(word, 8);
  }
}

if (T[0][0] !== 0xa56363c6 || T[0][255] !== 0x3a16162c ||
    T[3][0] !== 0xc6a56363 || T[3][255] !== 0x2c3a1616) {
  throw new Error('shavite: AES transform table does not match the reference');
}

const T0 = T[0], T1 = T[1], T2 = T[2], T3 = T[3];

// A keyless AES round (SubBytes, ShiftRows, MixColumns) over four little-endian words, in place.
// SHAvite-3 supplies its own key material by exclusive-or before the round rather than inside it.
function aesRoundNoKey(s, o) {
  const x0 = s[o], x1 = s[o + 1], x2 = s[o + 2], x3 = s[o + 3];
  s[o]     = (T0[x0 & 0xff] ^ T1[(x1 >>> 8) & 0xff] ^ T2[(x2 >>> 16) & 0xff] ^ T3[x3 >>> 24]) >>> 0;
  s[o + 1] = (T0[x1 & 0xff] ^ T1[(x2 >>> 8) & 0xff] ^ T2[(x3 >>> 16) & 0xff] ^ T3[x0 >>> 24]) >>> 0;
  s[o + 2] = (T0[x2 & 0xff] ^ T1[(x3 >>> 8) & 0xff] ^ T2[(x0 >>> 16) & 0xff] ^ T3[x1 >>> 24]) >>> 0;
  s[o + 3] = (T0[x3 & 0xff] ^ T1[(x0 >>> 8) & 0xff] ^ T2[(x1 >>> 16) & 0xff] ^ T3[x2 >>> 24]) >>> 0;
}

// --- Compression function ----------------------------------------------------------------------

// Four AES rounds keyed by sixteen consecutive schedule words, folded into the left half.
function compressElement(p, l, r, rk, u) {
  const x = SCRATCH4;
  x[0] = (p[r]     ^ rk[u]) >>> 0;
  x[1] = (p[r + 1] ^ rk[u + 1]) >>> 0;
  x[2] = (p[r + 2] ^ rk[u + 2]) >>> 0;
  x[3] = (p[r + 3] ^ rk[u + 3]) >>> 0;
  for (let k = 4; k <= 12; k += 4) {
    aesRoundNoKey(x, 0);
    x[0] = (x[0] ^ rk[u + k]) >>> 0;
    x[1] = (x[1] ^ rk[u + k + 1]) >>> 0;
    x[2] = (x[2] ^ rk[u + k + 2]) >>> 0;
    x[3] = (x[3] ^ rk[u + k + 3]) >>> 0;
  }
  aesRoundNoKey(x, 0);
  p[l]     = (p[l]     ^ x[0]) >>> 0;
  p[l + 1] = (p[l + 1] ^ x[1]) >>> 0;
  p[l + 2] = (p[l + 2] ^ x[2]) >>> 0;
  p[l + 3] = (p[l + 3] ^ x[3]) >>> 0;
}

const SCRATCH4 = new Uint32Array(4);
const RK = new Uint32Array(448);
const P = new Uint32Array(16);

function compress(h, buf, counts) {
  const rk = RK;

  // The 128-byte block is the first 32 schedule words, read little-endian.
  for (let i = 0; i < 32; i++) rk[i] = buf.readUInt32LE(i << 2);

  // Message expansion. Sixteen words at a time the schedule alternates between two shapes. Four
  // AES-driven steps (each an AES round over a rotated window of the previous 32 words, then folded
  // with the four words immediately behind) and eight purely linear steps. The AES steps are what stop
  // the schedule from being invertible by hand, and the linear steps are cheap diffusion between them.
  //
  // The counter injection is the part a reader cannot infer. At four fixed positions in the expansion
  // the running message-length counter is folded in, each time with the four 32-bit limbs in a
  // different order and the last of the four complemented. Because this lands inside the key schedule
  // rather than only in the padded final block, every compression of a given block depends on how many
  // bits preceded it, which is what binds the block to its position in the stream.
  let u = 32;
  for (;;) {
    for (let s = 0; s < 4; s++) {
      for (let half = 0; half < 2; half++) {
        SCRATCH4[0] = rk[u - 31];
        SCRATCH4[1] = rk[u - 30];
        SCRATCH4[2] = rk[u - 29];
        SCRATCH4[3] = rk[u - 32];
        aesRoundNoKey(SCRATCH4, 0);
        rk[u]     = (SCRATCH4[0] ^ rk[u - 4]) >>> 0;
        rk[u + 1] = (SCRATCH4[1] ^ rk[u - 3]) >>> 0;
        rk[u + 2] = (SCRATCH4[2] ^ rk[u - 2]) >>> 0;
        rk[u + 3] = (SCRATCH4[3] ^ rk[u - 1]) >>> 0;
        if (half === 0) {
          if (u === 32) {
            rk[32] = (rk[32] ^ counts[0]) >>> 0;
            rk[33] = (rk[33] ^ counts[1]) >>> 0;
            rk[34] = (rk[34] ^ counts[2]) >>> 0;
            rk[35] = (rk[35] ^ ~counts[3]) >>> 0;
          } else if (u === 440) {
            rk[440] = (rk[440] ^ counts[1]) >>> 0;
            rk[441] = (rk[441] ^ counts[0]) >>> 0;
            rk[442] = (rk[442] ^ counts[3]) >>> 0;
            rk[443] = (rk[443] ^ ~counts[2]) >>> 0;
          }
        } else {
          if (u === 164) {
            rk[164] = (rk[164] ^ counts[3]) >>> 0;
            rk[165] = (rk[165] ^ counts[2]) >>> 0;
            rk[166] = (rk[166] ^ counts[1]) >>> 0;
            rk[167] = (rk[167] ^ ~counts[0]) >>> 0;
          } else if (u === 316) {
            rk[316] = (rk[316] ^ counts[2]) >>> 0;
            rk[317] = (rk[317] ^ counts[3]) >>> 0;
            rk[318] = (rk[318] ^ counts[0]) >>> 0;
            rk[319] = (rk[319] ^ ~counts[1]) >>> 0;
          }
        }
        u += 4;
      }
    }
    if (u === 448) break;
    for (let s = 0; s < 8; s++) {
      rk[u]     = (rk[u - 32] ^ rk[u - 7]) >>> 0;
      rk[u + 1] = (rk[u - 31] ^ rk[u - 6]) >>> 0;
      rk[u + 2] = (rk[u - 30] ^ rk[u - 5]) >>> 0;
      rk[u + 3] = (rk[u - 29] ^ rk[u - 4]) >>> 0;
      u += 4;
    }
  }

  P.set(h);

  // Fourteen rounds, each consuming 32 schedule words. The two halves are updated in turn, then the
  // four columns are rotated so the halves swap roles on the next round.
  let ku = 0;
  for (let r = 0; r < 14; r++) {
    compressElement(P, 0, 4, rk, ku); ku += 16;
    compressElement(P, 8, 12, rk, ku); ku += 16;
    for (let c = 0; c < 4; c++) {
      const t = P[c + 12];
      P[c + 12] = P[c + 8];
      P[c + 8] = P[c + 4];
      P[c + 4] = P[c];
      P[c] = t;
    }
  }

  for (let i = 0; i < 16; i++) h[i] = (h[i] ^ P[i]) >>> 0;
}

// --- Public entry point ------------------------------------------------------------------------

/**
 * SHAvite-3-512 over a whole message.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} the 64-byte digest
 */
export function shavite512(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const h = Uint32Array.from(IV512);
  const buf = Buffer.alloc(BLOCK_BYTES);
  // A 128-bit bit counter held as four 32-bit limbs, little-endian across the limbs.
  const counts = new Uint32Array(4);

  let ptr = 0;
  let off = 0;
  while (off < data.length) {
    const clen = Math.min(BLOCK_BYTES - ptr, data.length - off);
    data.copy(buf, ptr, off, off + clen);
    off += clen;
    ptr += clen;
    if (ptr === BLOCK_BYTES) {
      // One full block is 1024 bits, and the carry walks up the limbs by hand.
      counts[0] = (counts[0] + 1024) >>> 0;
      if (counts[0] === 0) {
        counts[1] = (counts[1] + 1) >>> 0;
        if (counts[1] === 0) {
          counts[2] = (counts[2] + 1) >>> 0;
          if (counts[2] === 0) counts[3] = (counts[3] + 1) >>> 0;
        }
      }
      compress(h, buf, counts);
      ptr = 0;
    }
  }

  // Padding. The length written into the tail is the count as it stands after the trailing partial
  // block is charged to it, captured before the branches below may reset the live counter.
  counts[0] = (counts[0] + (ptr << 3)) >>> 0;
  const tail = Uint32Array.from(counts);

  if (ptr === 0) {
    // An exactly-full (or empty) message pads into a block of its own, and the counter is zeroed so
    // that final compression sees a zero schedule injection while the tail still carries the length.
    buf.fill(0, 0, 110);
    buf[0] = 0x80;
    counts.fill(0);
  } else if (ptr < 110) {
    buf[ptr++] = 0x80;
    buf.fill(0, ptr, 110);
  } else {
    // No room for the 18-byte tail, so the padding byte closes this block and the length goes into an
    // extra all-zero block, again with the live counter reset first.
    buf[ptr++] = 0x80;
    buf.fill(0, ptr, BLOCK_BYTES);
    compress(h, buf, counts);
    buf.fill(0, 0, 110);
    counts.fill(0);
  }

  buf.writeUInt32LE(tail[0], 110);
  buf.writeUInt32LE(tail[1], 114);
  buf.writeUInt32LE(tail[2], 118);
  buf.writeUInt32LE(tail[3], 122);
  // The output size in bits, little-endian, over the last two bytes.
  buf[126] = (OUT_WORDS << 5) & 0xff;
  buf[127] = OUT_WORDS >>> 3;
  compress(h, buf, counts);

  const out = Buffer.alloc(OUT_WORDS * 4);
  for (let i = 0; i < OUT_WORDS; i++) out.writeUInt32LE(h[i], i << 2);
  return out;
}

export default shavite512;
