// CubeHash-512, one of the eleven rounds X11 chains together.
//
// The parameters Dash uses are CubeHash16/32-512, meaning sixteen rounds per block, a thirty-two byte
// block, and a sixty-four byte output. The state is thirty-two 32-bit words held little-endian.
//
// Ported from the sph reference implementation that ships with Dash Core, and checked against vectors
// generated from that same implementation compiled unmodified (test/vectors/x11_round_vectors.json).
// Porting a hash from memory or from prose is how a subtly wrong round gets written, and a wrong round
// produces an output that is simply different, with nothing to say which of the eleven was at fault.

const ROUNDS = 16;
const BLOCK_BYTES = 32;

// The initial state for CubeHash16/32-512, which the reference stores as a constant rather than
// recomputing the ten-times-sixteen initialisation rounds on every call. Taken from the reference.
const IV = new Uint32Array([
  0x2aea2a61, 0x50f494d4, 0x2d538b8b, 0x4167d83e, 0x3fee2313, 0xc701cf8c, 0xcc39968e, 0x50ac5695,
  0x4d42c787, 0xa647a8b3, 0x97cf0bef, 0x825b4537, 0xeef864d2, 0xf22090c4, 0xd0e5cd33, 0xa23911ae,
  0xfcd398d9, 0x148fe485, 0x1b017bef, 0xb6444532, 0x6a536159, 0x2ff5781c, 0x91fa7934, 0x0dbadea9,
  0xd65c8a2b, 0xa5a70e75, 0xb1c62456, 0xbc796576, 0x1921c8f7, 0xe7989af1, 0x7795d246, 0xd43e3b44,
]);

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

// Sixteen rounds of the CubeHash permutation, written to mirror the reference's SIXTEEN_ROUNDS macro
// rather than to be clever, so the two can be read side by side.
function rounds(x) {
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < 16; i++) x[16 + i] = (x[16 + i] + x[i]) >>> 0;
    for (let i = 0; i < 16; i++) x[i] = rotl(x[i], 7);
    for (let i = 0; i < 8; i++) {
      const t = x[i];
      x[i] = x[i ^ 8];
      x[i ^ 8] = t;
    }
    for (let i = 0; i < 16; i++) x[i] ^= x[16 + i];
    for (let i = 0; i < 16; i += 4) {
      let t = x[16 + i];
      x[16 + i] = x[16 + i + 2];
      x[16 + i + 2] = t;
      t = x[16 + i + 1];
      x[16 + i + 1] = x[16 + i + 3];
      x[16 + i + 3] = t;
    }
    for (let i = 0; i < 16; i++) x[16 + i] = (x[16 + i] + x[i]) >>> 0;
    for (let i = 0; i < 16; i++) x[i] = rotl(x[i], 11);
    for (let i = 0; i < 16; i += 8) {
      for (let j = 0; j < 4; j++) {
        const t = x[i + j];
        x[i + j] = x[i + j + 4];
        x[i + j + 4] = t;
      }
    }
    for (let i = 0; i < 16; i++) x[i] ^= x[16 + i];
    for (let i = 0; i < 16; i += 2) {
      const t = x[16 + i];
      x[16 + i] = x[16 + i + 1];
      x[16 + i + 1] = t;
    }
  }
}

export function cubehash512(input) {
  const data = Buffer.from(input);
  const x = Uint32Array.from(IV);

  // Whole blocks, exclusive-ored into the first eight words little-endian, each followed by the
  // permutation.
  let at = 0;
  for (; at + BLOCK_BYTES <= data.length; at += BLOCK_BYTES) {
    for (let i = 0; i < 8; i++) x[i] ^= data.readUInt32LE(at + i * 4);
    rounds(x);
  }

  // The tail, padded with a single 0x80 byte and then zeroes to the block size. A message that is a
  // whole number of blocks still gets a padding block, which is why this runs unconditionally.
  const tail = Buffer.alloc(BLOCK_BYTES);
  data.copy(tail, 0, at);
  tail[data.length - at] = 0x80;
  for (let i = 0; i < 8; i++) x[i] ^= tail.readUInt32LE(i * 4);
  rounds(x);

  // Finalisation, which flips the low bit of the last word and permutes ten more times.
  x[31] ^= 1;
  for (let i = 0; i < 10; i++) rounds(x);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE(x[i], i * 4);
  return out;
}
