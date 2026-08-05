// Skein-512-512, one of the eleven rounds X11 chains together.
//
// Ported from the sph reference implementation that ships with Dash Core (skein.c, the sph_skein512
// path with the small-footprint variant disabled), and checked against vectors generated from that
// same implementation compiled unmodified (test/vectors/x11_round_vectors.json). The sph framing and
// the Skein paper's framing describe the same function but organise the initial chaining value and
// the tweak differently, so the reference is what this follows, never a recollection of the paper.
//
// Skein is built on Threefish-512, a block cipher over eight 64-bit words. The words are held as
// BigInt here. That is slower than a hi/lo split, but these run once per block read rather than in a
// mining loop, and BigInt keeps the arithmetic close enough to the C to be checked by eye.

const MASK = (1n << 64n) - 1n;
const BLOCK_BYTES = 64;

// Skein-512-512's chaining value, which the reference stores as a constant rather than deriving it
// from a configuration block on every call. Taken verbatim from IV512 in the reference.
const IV512 = [
  0x4903adff749c51cen, 0x0d95de399746df03n, 0x8fd1934127c79bcen, 0x9a255629ff352cb1n,
  0x5db62599df6ca7b0n, 0xeabe394ca9d5c3f4n, 0x991112c71a75b523n, 0xae18a40b660fcc33n,
];

// The Threefish key-schedule parity constant, which makes the ninth key word depend on all eight.
const KEY_PARITY = 0x1bd11bdaa9fc1a22n;

const rotl = (x, n) => (((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

// The four mixing groups of an even round quadruple and of an odd one, each entry naming the two word
// positions to mix and the rotation constant. Transcribed from the TFBIG_4e and TFBIG_4o macros,
// where the word permutation is expressed by which p variables are handed to TFBIG_MIX8 rather than
// by a separate permutation step.
const MIX_EVEN = [
  [0, 1, 46], [2, 3, 36], [4, 5, 19], [6, 7, 37],
  [2, 1, 33], [4, 7, 27], [6, 5, 14], [0, 3, 42],
  [4, 1, 17], [6, 3, 49], [0, 5, 36], [2, 7, 39],
  [6, 1, 44], [0, 7, 9], [2, 5, 54], [4, 3, 56],
];
const MIX_ODD = [
  [0, 1, 39], [2, 3, 30], [4, 5, 34], [6, 7, 24],
  [2, 1, 13], [4, 7, 50], [6, 5, 10], [0, 3, 17],
  [4, 1, 25], [6, 3, 29], [0, 5, 39], [2, 7, 43],
  [6, 1, 8], [0, 7, 35], [2, 5, 56], [4, 3, 22],
];

// One subkey injection. The reference reaches this through the M9 and M3 lookup tables, which are
// nothing more than (s + i) mod 9 for the key words and (s + v) mod 3 for the tweak words. Writing
// the modulus directly is the same schedule, and it is why the reference never has to rotate its
// t0/t1/t2 variables between rounds the way the small-footprint variant does.
function addKey(p, k, t, s) {
  for (let i = 0; i < 8; i++) p[i] = (p[i] + k[(s + i) % 9]) & MASK;
  p[5] = (p[5] + t[s % 3]) & MASK;
  p[6] = (p[6] + t[(s + 1) % 3]) & MASK;
  p[7] = (p[7] + BigInt(s)) & MASK;
}

// One UBI (Unique Block Iteration) compression, which is Threefish-512 keyed by the current chaining
// value, encrypting the message block, with the block fed back by exclusive-or.
//
// The two tweak words are where an implementation most easily goes wrong. t0 is the number of message
// bytes processed through the END of this block, so it is the count of whole blocks already absorbed
// shifted left six (times 64) plus `extra`, the bytes contributed by this block. t1 carries the
// overflow of that byte count above 2^64 in its low bits, plus the block type and the first/final
// flags packed into the high bits by `etype << 55`. The callers pass etype as a small integer whose
// bit 8 is the final flag, bit 7 the first flag, and bits 1 through 6 twice the six-bit type code, so
// a message block is 96, a first message block 224, and the output block 510.
function ubi(h, buf, etype, extra, bcount) {
  const m = new Array(8);
  for (let i = 0; i < 8; i++) m[i] = buf.readBigUInt64LE(i * 8);
  const p = m.slice();

  const k = h.slice(0, 8);
  k.push((k[0] ^ k[1] ^ k[2] ^ k[3] ^ k[4] ^ k[5] ^ k[6] ^ k[7]) ^ KEY_PARITY);

  const t0 = ((bcount << 6n) + extra) & MASK;
  const t1 = ((bcount >> 58n) + (BigInt(etype) << 55n)) & MASK;
  const t = [t0, t1, t0 ^ t1];

  // Eighteen quadruples of rounds, seventy-two rounds in all, each quadruple preceded by a subkey.
  for (let s = 0; s <= 17; s++) {
    addKey(p, k, t, s);
    const mixes = s % 2 === 0 ? MIX_EVEN : MIX_ODD;
    for (const [a, b, rc] of mixes) {
      p[a] = (p[a] + p[b]) & MASK;
      p[b] = rotl(p[b], rc) ^ p[a];
    }
  }
  addKey(p, k, t, 18);

  for (let i = 0; i < 8; i++) h[i] = m[i] ^ p[i];
}

export function skein512(input) {
  const data = Buffer.from(input);
  const h = IV512.slice();
  const buf = Buffer.alloc(BLOCK_BYTES);
  let ptr = 0;
  let bcount = 0n;

  // Absorption deliberately leaves a full block sitting unprocessed. Skein sets a final flag in the
  // tweak of the last block, and a message whose length is an exact multiple of the block size has no
  // padding to distinguish that block, so a block is only compressed once more input has arrived to
  // prove it was not the last one.
  if (data.length > BLOCK_BYTES) {
    let at = 0;
    let len = data.length;
    let first = bcount === 0n ? 128 : 0;
    do {
      if (ptr === BLOCK_BYTES) {
        bcount += 1n;
        ubi(h, buf, 96 + first, 0n, bcount);
        first = 0;
        ptr = 0;
      }
      const clen = Math.min(BLOCK_BYTES - ptr, len);
      data.copy(buf, ptr, at, at + clen);
      ptr += clen;
      at += clen;
      len -= clen;
    } while (len > 0);
  } else {
    data.copy(buf, 0);
    ptr = data.length;
  }

  // The final message block, zero-filled past the real bytes. Type 48 (message) with the final flag
  // set is 352, and the first flag is still on when the whole message fit in one block.
  buf.fill(0, ptr);
  ubi(h, buf, 352 + (bcount === 0n ? 128 : 0), BigInt(ptr), bcount);

  // The output transform, which is a second UBI over a block holding the eight-byte little-endian
  // counter zero padded with zeroes. It is what turns the chaining value into the digest, and it is
  // keyed by the chaining value just produced, so skipping it does not merely reorder bytes, it
  // returns a different function. Type 63 (output) with both the first and final flags is 510, and
  // the tweak's byte count is 8 because only the counter counts as input.
  buf.fill(0);
  ubi(h, buf, 510, 8n, 0n);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out;
}
