// JH-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core, and checked against vectors
// generated from that same implementation compiled unmodified (test/vectors/x11_round_vectors.json).
// Porting a hash from memory or from prose is how a subtly wrong round gets written, and a wrong round
// produces an output that is simply different, with nothing to say which of the eleven was at fault.
//
// Two things about JH surprise a reader, and both are load-bearing here.
//
// First the internal representation. JH is specified as a bitslice cipher, so every step of the
// permutation is a pure bitwise operation on a 1024-bit state held as sixteen 64-bit words. Because the
// operations are bitwise, and because the bit-swapping steps W0 through W6 use byte-symmetric masks,
// the whole permutation is invariant under byte-swapping every word. The reference exploits that with
// its C64e macro, byte-swapping the constants on a little-endian host so it can load and store words
// natively. Nothing here needs that trick, so this port uses the big-endian convention throughout,
// which is the reference's own SPH_BIG_ENDIAN branch. The constants are the literals as written in the
// reference, message words are decoded big-endian, and the digest is encoded big-endian.
//
// Second the padding, which is where JH is most often got wrong. A message whose length is already a
// multiple of the 64-byte block gets ONE padding block, not two, so the 0x80 byte is followed by only
// 47 zero bytes before the 128-bit length. Any other length is padded out to the end of the following
// block instead, so it costs two. The 128-bit length is the message length in bits, high half first.

const BLOCK_BYTES = 64;
const ROUNDS = 42;

// Each 64-bit word of the reference is held as a pair of 32-bit words, the top half in `hi` and the
// bottom half in `lo`, both keyed by the reference's own H.wide index 0 through 15. Beware that the
// reference's h0h and h0l names do NOT mean a 32-bit split. They are two different 64-bit words,
// H.wide[0] and H.wide[1], so "wide index" is the only indexing used below.
const IV512 = new Uint32Array([
  0x6fd14b96, 0x3e00aa17, 0x636a2e05, 0x7a15d543, 0x8a225e8d, 0x0c97ef0b, 0xe9341259, 0xf2b3c361,
  0x891da0c1, 0x536f801e, 0x2aa9056b, 0xea2b6d80, 0x588eccdb, 0x2075baa6, 0xa90f3a76, 0xbaf83bf7,
  0x0169e605, 0x41e34a69, 0x46b58a8e, 0x2e6fe65a, 0x1047a7d0, 0xc1843c24, 0x3b6e71b1, 0x2d5ac199,
  0xcf57f6ec, 0x9db1f856, 0xa706887c, 0x5716b156, 0xe3c2fcdf, 0xe68517fb, 0x545a4678, 0xcc8cdd4b,
]);

// The 168 round constants of E8, four per round, each stored as its top then its bottom 32 bits. Round
// r therefore starts at index 8r, and the four constants are Ceven_hi, Ceven_lo, Codd_hi and Codd_lo
// in that order.
const C = new Uint32Array([
  0x72d5dea2, 0xdf15f867, 0x7b84150a, 0xb7231557, 0x81abd690, 0x4d5a87f6, 0x4e9f4fc5, 0xc3d12b40,
  0xea983ae0, 0x5c45fa9c, 0x03c5d299, 0x66b2999a, 0x660296b4, 0xf2bb538a, 0xb556141a, 0x88dba231,
  0x03a35a5c, 0x9a190edb, 0x403fb20a, 0x87c14410, 0x1c051980, 0x849e951d, 0x6f33ebad, 0x5ee7cddc,
  0x10ba1392, 0x02bf6b41, 0xdc786515, 0xf7bb27d0, 0x0a2c8139, 0x37aa7850, 0x3f1abfd2, 0x410091d3,
  0x422d5a0d, 0xf6cc7e90, 0xdd629f9c, 0x92c097ce, 0x185ca70b, 0xc72b44ac, 0xd1df65d6, 0x63c6fc23,
  0x976e6c03, 0x9ee0b81a, 0x2105457e, 0x446ceca8, 0xeef103bb, 0x5d8e61fa, 0xfd9697b2, 0x94838197,
  0x4a8e8537, 0xdb03302f, 0x2a678d2d, 0xfb9f6a95, 0x8afe7381, 0xf8b8696c, 0x8ac77246, 0xc07f4214,
  0xc5f4158f, 0xbdc75ec4, 0x75446fa7, 0x8f11bb80, 0x52de75b7, 0xaee488bc, 0x82b8001e, 0x98a6a3f4,
  0x8ef48f33, 0xa9a36315, 0xaa5f5624, 0xd5b7f989, 0xb6f1ed20, 0x7c5ae0fd, 0x36cae95a, 0x06422c36,
  0xce293543, 0x4efe983d, 0x533af974, 0x739a4ba7, 0xd0f51f59, 0x6f4e8186, 0x0e9dad81, 0xafd85a9f,
  0xa7050667, 0xee34626a, 0x8b0b28be, 0x6eb91727, 0x47740726, 0xc680103f, 0xe0a07e6f, 0xc67e487b,
  0x0d550aa5, 0x4af8a4c0, 0x91e3e79f, 0x978ef19e, 0x86767281, 0x50608dd4, 0x7e9e5a41, 0xf3e5b062,
  0xfc9f1fec, 0x4054207a, 0xe3e41a00, 0xcef4c984, 0x4fd794f5, 0x9dfa95d8, 0x552e7e11, 0x24c354a5,
  0x5bdf7228, 0xbdfe6e28, 0x78f57fe2, 0x0fa5c4b2, 0x05897cef, 0xee49d32e, 0x447e9385, 0xeb28597f,
  0x705f6937, 0xb324314a, 0x5e8628f1, 0x1dd6e465, 0xc71b7704, 0x51b920e7, 0x74fe43e8, 0x23d4878a,
  0x7d29e8a3, 0x927694f2, 0xddcb7a09, 0x9b30d9c1, 0x1d1b30fb, 0x5bdc1be0, 0xda24494f, 0xf29c82bf,
  0xa4e7ba31, 0xb470bfff, 0x0d324405, 0xdef8bc48, 0x3baefc32, 0x53bbd339, 0x459fc3c1, 0xe0298ba0,
  0xe5c905fd, 0xf7ae090f, 0x94703412, 0x4290f134, 0xa271b701, 0xe344ed95, 0xe93b8e36, 0x4f2f984a,
  0x88401d63, 0xa06cf615, 0x47c1444b, 0x8752afff, 0x7ebb4af1, 0xe20ac630, 0x4670b6c5, 0xcc6e8ce6,
  0xa4d5a456, 0xbd4fca00, 0xda9d844b, 0xc83e18ae, 0x7357ce45, 0x3064d1ad, 0xe8a6ce68, 0x145c2567,
  0xa3da8cf2, 0xcb0ee116, 0x33e90658, 0x9a94999a, 0x1f60b220, 0xc26f847b, 0xd1ceac7f, 0xa0d18518,
  0x32595ba1, 0x8ddd19d3, 0x509a1cc0, 0xaaa5b446, 0x9f3d6367, 0xe4046bba, 0xf6ca19ab, 0x0b56ee7e,
  0x1fb179ea, 0xa9282174, 0xe9bdf735, 0x3b3651ee, 0x1d57ac5a, 0x7550d376, 0x3a46c2fe, 0xa37d7001,
  0xf735c1af, 0x98a4d842, 0x78edec20, 0x9e6b6779, 0x41836315, 0xea3adba8, 0xfac33b4d, 0x32832c83,
  0xa7403b1f, 0x1c2747f3, 0x5940f034, 0xb72d769a, 0xe73e4e6c, 0xd2214ffd, 0xb8fd8d39, 0xdc5759ef,
  0x8d9b0c49, 0x2b49ebda, 0x5ba2d749, 0x68f3700d, 0x7d3baed0, 0x7a8d5584, 0xf5a5e9f0, 0xe4f88e65,
  0xa0b8a2f4, 0x36103b53, 0x0ca8079e, 0x753eec5a, 0x91689492, 0x56e8884f, 0x5bb05c55, 0xf8babc4c,
  0xe3bb3b99, 0xf387947b, 0x75daf4d6, 0x726b1c5d, 0x64aeac28, 0xdc34b36d, 0x6c34a550, 0xb828db71,
  0xf861e2f2, 0x108d512a, 0xe3db6433, 0x59dd75fc, 0x1cacbcf1, 0x43ce3fa2, 0x67bbd13c, 0x02e843b0,
  0x330a5bca, 0x8829a175, 0x7f34194d, 0xb416535c, 0x923b94c3, 0x0e794d1e, 0x797475d7, 0xb6eeaf3f,
  0xeaa8d4f7, 0xbe1a3921, 0x5cf47e09, 0x4c232751, 0x26a32453, 0xba323cd2, 0x44a3174a, 0x6da6d5ad,
  0xb51d3ea6, 0xaff2c908, 0x83593d98, 0x916b3c56, 0x4cf87ca1, 0x7286604d, 0x46e23ecc, 0x086ec7f6,
  0x2f9833b3, 0xb1bc765e, 0x2bd666a5, 0xefc4e62a, 0x06f4b6e8, 0xbec1d436, 0x74ee8215, 0xbcef2163,
  0xfdc14e0d, 0xf453c969, 0xa77d5ac4, 0x06585826, 0x7ec11416, 0x06e0fa16, 0x7e90af3d, 0x28639d3f,
  0xd2c9f2e3, 0x009bd20c, 0x5faace30, 0xb7d40c30, 0x742a5116, 0xf2e03298, 0x0deb30d8, 0xe3cef89a,
  0x4bc59e7b, 0xb5f17992, 0xff51e66e, 0x048668d3, 0x9b234d57, 0xe6966731, 0xcce6a6f3, 0x170a7505,
  0xb17681d9, 0x13326cce, 0x3c175284, 0xf805a262, 0xf42bcbb3, 0x78471547, 0xff465482, 0x23936a48,
  0x38df5807, 0x4e5e6565, 0xf2fc7c89, 0xfc86508e, 0x31702e44, 0xd00bca86, 0xf04009a2, 0x3078474e,
  0x65a0ee39, 0xd1f73883, 0xf75ee937, 0xe42c3abd, 0x2197b226, 0x0113f86f, 0xa344edd1, 0xef9fdee7,
  0x8ba0df15, 0x762592d9, 0x3c85f7f6, 0x12dc42be, 0xd8a7ec7c, 0xab27b07e, 0x538d7dda, 0xaa3ea8de,
  0xaa25ce93, 0xbd0269d8, 0x5af643fd, 0x1a7308f9, 0xc05fefda, 0x174a19a5, 0x974d6633, 0x4cfd216a,
  0x35b49831, 0xdb411570, 0xea1e0fbb, 0xedcd549b, 0x9ad063a1, 0x51974072, 0xf6759dbf, 0x91476fe2,
]);

// Masks and shift counts for W0 through W4. Each mask repeats within every 32-bit half of the 64-bit
// word and every shift stays under 32, so the two halves of a word never exchange bits and the swap
// can be done on `hi` and `lo` independently. W5 and W6 are the two that do move bits across a
// boundary, and they are handled as the plain swaps they reduce to.
const W_MASK = [0x55555555, 0x33333333, 0x0f0f0f0f, 0x00ff00ff, 0x0000ffff];
const W_SHIFT = [1, 2, 4, 8, 16];

// One 32-bit lane of the JH S-box, the reference's Sb macro. Every operation is bitwise, so a lane
// carries no information into or out of its neighbour and the constant is that lane's half of c.
function sbLane(w, i0, i1, i2, i3, c) {
  let x0 = w[i0];
  let x1 = w[i1];
  let x2 = w[i2];
  let x3 = w[i3];
  x3 = ~x3;
  x0 ^= c & ~x2;
  const tmp = c ^ (x0 & x1);
  x0 ^= x2 & x3;
  x3 ^= ~x1 & x2;
  x1 ^= x0 & x2;
  x2 ^= x0 & ~x3;
  x0 ^= x1 | x3;
  x3 ^= x1 & x2;
  x1 ^= tmp & x0;
  x2 ^= tmp;
  w[i0] = x0;
  w[i1] = x1;
  w[i2] = x2;
  w[i3] = x3;
}

// One 32-bit lane of the linear layer, the reference's Lb macro, a pair of MDS-style mixes over the
// eight words handed to it.
function lbLane(w, i0, i1, i2, i3, i4, i5, i6, i7) {
  w[i4] ^= w[i1];
  w[i5] ^= w[i2];
  w[i6] ^= w[i3] ^ w[i0];
  w[i7] ^= w[i0];
  w[i0] ^= w[i5];
  w[i1] ^= w[i6];
  w[i2] ^= w[i7] ^ w[i4];
  w[i3] ^= w[i4];
}

// The bit-swap applied after the linear layer, to the wide-word pair starting at index i. `ro` selects
// which of W0 through W6 runs, and it cycles with period seven across the 42 rounds.
function wSwap(hi, lo, i, ro) {
  if (ro < 5) {
    const m = W_MASK[ro];
    const n = W_SHIFT[ro];
    for (let j = i; j <= i + 1; j++) {
      hi[j] = ((hi[j] >>> n) & m) | ((hi[j] & m) << n);
      lo[j] = ((lo[j] >>> n) & m) | ((lo[j] & m) << n);
    }
  } else if (ro === 5) {
    // W5 swaps the two 32-bit halves of each word, which in this representation is a swap of hi and lo.
    for (let j = i; j <= i + 1; j++) {
      const t = hi[j];
      hi[j] = lo[j];
      lo[j] = t;
    }
  } else {
    // W6 exchanges the two whole 64-bit words of the pair.
    let t = hi[i];
    hi[i] = hi[i + 1];
    hi[i + 1] = t;
    t = lo[i];
    lo[i] = lo[i + 1];
    lo[i + 1] = t;
  }
}

// E8, the 42-round bijective permutation at the heart of JH. Ceven drives the even wide indices and
// Codd the odd ones, matching the reference's S(h0,h2,h4,h6,Ceven_,r) and S(h1,h3,h5,h7,Codd_,r).
function e8(hi, lo) {
  for (let r = 0; r < ROUNDS; r++) {
    const c = r << 3;
    sbLane(hi, 0, 4, 8, 12, C[c]);
    sbLane(lo, 0, 4, 8, 12, C[c + 1]);
    sbLane(hi, 1, 5, 9, 13, C[c + 2]);
    sbLane(lo, 1, 5, 9, 13, C[c + 3]);
    sbLane(hi, 2, 6, 10, 14, C[c + 4]);
    sbLane(lo, 2, 6, 10, 14, C[c + 5]);
    sbLane(hi, 3, 7, 11, 15, C[c + 6]);
    sbLane(lo, 3, 7, 11, 15, C[c + 7]);

    lbLane(hi, 0, 4, 8, 12, 2, 6, 10, 14);
    lbLane(lo, 0, 4, 8, 12, 2, 6, 10, 14);
    lbLane(hi, 1, 5, 9, 13, 3, 7, 11, 15);
    lbLane(lo, 1, 5, 9, 13, 3, 7, 11, 15);

    const ro = r % 7;
    wSwap(hi, lo, 2, ro);
    wSwap(hi, lo, 6, ro);
    wSwap(hi, lo, 10, ro);
    wSwap(hi, lo, 14, ro);
  }
}

const readBE32 = (b, i) => (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);

// JH's compression function xors the message block into the top half of the state, permutes, then xors
// the same block into the bottom half. That second xor is what makes the round non-invertible.
function compress(hi, lo, mHi, mLo, data, off) {
  for (let j = 0; j < 8; j++) {
    const wh = readBE32(data, off + 8 * j);
    const wl = readBE32(data, off + 8 * j + 4);
    mHi[j] = wh;
    mLo[j] = wl;
    hi[j] ^= wh;
    lo[j] ^= wl;
  }
  e8(hi, lo);
  for (let j = 0; j < 8; j++) {
    hi[8 + j] ^= mHi[j];
    lo[8 + j] ^= mLo[j];
  }
}

function writeBE64(out, off, v) {
  for (let i = 7; i >= 0; i--) {
    out[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export function jh512(input) {
  const len = input.length;
  const ptr = len % BLOCK_BYTES;

  // The reference's numz, the count of zero bytes between the 0x80 and the 128-bit length. A message
  // that already ends on a block boundary takes 47 of them and one extra block, anything else takes
  // 111 minus the tail length and runs to the end of the block after the tail.
  const numz = ptr === 0 ? 47 : 111 - ptr;
  const padded = new Uint8Array(len + numz + 17);
  padded.set(input, 0);
  padded[len] = 0x80;
  const bits = BigInt(len) * 8n;
  writeBE64(padded, len + numz + 1, bits >> 64n);
  writeBE64(padded, len + numz + 9, bits & 0xffffffffffffffffn);

  const hi = new Uint32Array(16);
  const lo = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    hi[i] = IV512[2 * i];
    lo[i] = IV512[2 * i + 1];
  }

  const mHi = new Uint32Array(8);
  const mLo = new Uint32Array(8);
  for (let off = 0; off < padded.length; off += BLOCK_BYTES) {
    compress(hi, lo, mHi, mLo, padded, off);
  }

  // JH-512 takes the whole bottom half of the state as its digest, wide words 8 through 15.
  const out = Buffer.allocUnsafe(64);
  for (let j = 0; j < 8; j++) {
    out.writeUInt32BE(hi[8 + j], j * 8);
    out.writeUInt32BE(lo[8 + j], j * 8 + 4);
  }
  return out;
}
