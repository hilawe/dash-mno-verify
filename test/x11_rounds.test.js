// The X11 rounds, each against ground truth from the reference implementation.
//
// X11 is the hashing method Dash uses to name a block, and it is the last thing standing between the
// masternode-list commitment check and being able to say the block it verified is genuinely the
// chain's. It chains eleven hash functions, so a port has eleven independent chances to be subtly
// wrong, and a wrong round produces an output that is merely different, with nothing to say which one
// was at fault.
//
// So the vectors come from the sph reference implementations that ship with Dash Core, compiled
// unmodified in a container, and the composed chain built from those same sources was checked against
// real mainnet block hashes before any of this was ported. Both artefacts live in
// test/vectors/x11_round_vectors.json. The block-hash cases there are what separate a port whose
// rounds are right from one whose composition is right; passing the rounds and failing the blocks
// means the chain is assembled wrongly, which no single end-to-end test could tell apart.
import { test } from "node:test";
import { meetsProofOfWork, targetFromBits, MAINNET_POW_LIMIT } from "../oracle/proof_of_work.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blake512 } from "@noble/hashes/blake1.js";
import { keccak_512 } from "@noble/hashes/sha3.js";
import { cubehash512 } from "../common/x11/cubehash.js";
import { bmw512 } from "../common/x11/bmw.js";
import { groestl512 } from "../common/x11/groestl.js";
import { skein512 } from "../common/x11/skein.js";
import { jh512 } from "../common/x11/jh.js";
import { luffa512 } from "../common/x11/luffa.js";
import { shavite512 } from "../common/x11/shavite.js";
import { simd512 } from "../common/x11/simd.js";
import { echo512 } from "../common/x11/echo.js";
import { blockHashFromHeader, ROUNDS, x11 } from "../common/x11/index.js";

const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("./vectors/x11_round_vectors.json", import.meta.url)), "utf8"));

// All eleven, listed explicitly rather than derived from the vector file, so a round that is dropped
// or renamed fails here instead of quietly falling out of the suite.
const IMPLEMENTED = {
  blake: (b) => Buffer.from(blake512(b)),
  bmw: bmw512,
  groestl: groestl512,
  skein: skein512,
  jh: jh512,
  keccak: (b) => Buffer.from(keccak_512(b)),
  luffa: luffa512,
  cubehash: cubehash512,
  shavite: shavite512,
  simd: simd512,
  echo: echo512,
};

for (const [name, fn] of Object.entries(IMPLEMENTED)) {
  test(`${name}512 reproduces the reference on every vector`, () => {
    const cases = VECTORS.vectors[name];
    assert.ok(Array.isArray(cases) && cases.length >= 10, `${name} has vectors to check against`);
    for (const { in: input, out } of cases) {
      assert.equal(
        fn(Buffer.from(input, "hex")).toString("hex"),
        out,
        `${name}512 of ${input.length / 2} bytes`,
      );
    }
  });
}

test("the vectors cover the sizes X11 actually feeds a round, plus the padding edges", () => {
  // X11 hands the first round an 80-byte header and every later round a 64-byte digest, so those two
  // sizes are the ones that must be right. The others are there because padding is where a hash port
  // usually breaks, and 111, 112, and 128 bytes sit either side of the block boundaries these
  // functions use.
  const sizes = VECTORS.vectors.blake.map((c) => c.in.length / 2);
  for (const needed of [0, 32, 64, 80, 111, 112, 128]) {
    assert.ok(sizes.includes(needed), `a ${needed}-byte case is present`);
  }
});

test("the block-hash cases are real mainnet headers, kept for the composition check", () => {
  // Not exercised until all eleven rounds exist. Asserting their shape now means the port cannot
  // reach completion against a fixture that was silently truncated or malformed.
  const cases = VECTORS.blockHashes.cases;
  assert.ok(cases.length >= 10, "several heights, spanning the chain rather than one era");
  for (const c of cases) {
    assert.equal(Buffer.from(c.header, "hex").length, 80, `height ${c.height} header is a block header`);
    assert.match(c.hash, /^[0-9a-f]{64}$/, `height ${c.height} hash is a block hash`);
    // Five, not more. The earliest blocks were mined at a far lower difficulty than today's, so an
    // assertion written around the modern tip fails on the genesis era, which is exactly the range
    // these cases are here to cover.
    assert.match(c.hash, /^0{5}/, `height ${c.height} hash has the leading zeroes proof of work implies`);
  }
});

test("the composed chain reproduces the block hash Dash assigns real mainnet headers", () => {
  // THE TEST THE PER-ROUND ONES CANNOT REPLACE. Eleven correct rounds assembled in the wrong order,
  // or fed each other's output in the wrong byte order, satisfies every vector above and still names
  // no block correctly. These cases span genesis to the current tip, so a port that happens to work
  // for one era of headers does not pass by luck.
  const cases = VECTORS.blockHashes.cases;
  for (const c of cases) {
    assert.equal(blockHashFromHeader(c.header), c.hash, `height ${c.height}`);
  }
  assert.ok(cases.length >= 10, "and there are enough of them for that to mean something");
});

test("the chain is the eleven rounds in the order Dash applies them", () => {
  // Recorded as a property rather than left implicit in the imports, because the order is the thing
  // the block-hash cases above would catch and nothing else would explain.
  assert.deepEqual(
    ROUNDS.map(([name]) => name),
    ["blake", "bmw", "groestl", "skein", "jh", "keccak", "luffa", "cubehash", "shavite", "simd", "echo"],
  );
  // Every round in the chain is one the vectors cover, so none of them is unverified.
  for (const [name] of ROUNDS) assert.ok(VECTORS.vectors[name], `${name} has reference vectors`);
});

test("a header of the wrong length is refused rather than hashed anyway", () => {
  // A caller passing a whole block, or a header with the transaction count appended, would otherwise
  // get a perfectly well-formed hash of the wrong bytes, and a wrong hash here reads as "this is not
  // the ChainLocked block" rather than as a mistake in the call.
  const good = VECTORS.blockHashes.cases[0].header;
  assert.throws(() => blockHashFromHeader(good + "00"), /80 bytes/);
  assert.throws(() => blockHashFromHeader(good.slice(0, 100)), /80 bytes/);
  assert.equal(blockHashFromHeader(Buffer.from(good, "hex")).length, 64, "a Buffer is accepted as well as hex");
});

test("x11 returns the internal byte order, and the block hash is its reverse", () => {
  // The two differ by a reversal and confusing them produces a hash that looks right and matches
  // nothing. Pinned so the distinction survives a refactor.
  const c = VECTORS.blockHashes.cases[0];
  const internal = Buffer.from(x11(Buffer.from(c.header, "hex")));
  assert.equal(internal.length, 32);
  assert.equal(Buffer.from(internal).reverse().toString("hex"), c.hash);
});

test("the proof of work floor is the network's, not the header's, so a self-chosen target is refused", () => {
  // THE BLOCKER AN AUTHOR-SIDE REVIEW FOUND, reproduced here. Checking the hash against the target the
  // header declares, with no floor, lets the node choose the target as well as the header. It declares
  // an almost-maximal target and any header at all satisfies it, for the cost of one hash. The check
  // read as "real work went into this block" and meant nothing of the kind.
  //
  // Dash's own CheckProofOfWork refuses a target above consensus.powLimit for this reason, and
  // powLimit is a consensus constant rather than a number an operator picks.
  const free = Buffer.alloc(80);
  free.writeUInt32LE(0x220000ff, 72); // a target the node chose for itself, near the whole range
  assert.equal(meetsProofOfWork(free), false, "an all-zero header with a self-chosen target is refused");

  // The floor is where the network puts it. A target exactly at powLimit is allowed, one past it is
  // not, so the guard has an exit rather than being a wall.
  assert.equal(targetFromBits(0x1e0ffff0) <= MAINNET_POW_LIMIT, true, "powLimit's own compact form sits at the floor");
  // A bigger EXPONENT is what makes a target easier here. Raising the mantissa's low nibble makes it
  // smaller, which the first version of this assertion had backwards.
  assert.equal(targetFromBits(0x1f0ffff0) > MAINNET_POW_LIMIT, true, "and one exponent easier is over the floor");

  // And every real header still passes, which is the half that matters more: a floor set wrong in the
  // other direction refuses the entire chain.
  for (const c of VECTORS.blockHashes.cases) {
    assert.equal(meetsProofOfWork(c.header), true, `real header at height ${c.height}`);
  }
});

test("groestl absorbs every block of a long input, not just the first", () => {
  // A mutation an author-side review found surviving: replacing the multi-block absorb loop with a
  // single-block branch left the whole suite green, while groestl512 returned ONE CONSTANT digest for
  // every input from 384 bytes upward. No committed vector exceeds 128 bytes and X11 hands each round
  // at most 80, so nothing reached it.
  //
  // This needs no reference to state, because a hash that maps every long input to the same value is
  // wrong under any convention. Distinct inputs must produce distinct digests.
  const sizes = [384, 400, 500, 1024];
  const digests = sizes.map((n) => Buffer.from(groestl512(Buffer.alloc(n, 0xab))).toString("hex"));
  assert.equal(new Set(digests).size, sizes.length, `long inputs must not collide, got ${new Set(digests).size} distinct of ${sizes.length}`);

  // And content matters at those sizes too, not only length.
  const a = Buffer.alloc(512, 1);
  const b = Buffer.alloc(512, 1);
  b[500] ^= 0xff;
  assert.notEqual(Buffer.from(groestl512(a)).toString("hex"), Buffer.from(groestl512(b)).toString("hex"));
});
