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
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blake512 } from "@noble/hashes/blake1.js";
import { keccak_512 } from "@noble/hashes/sha3.js";
import { cubehash512 } from "../common/x11/cubehash.js";

const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("./vectors/x11_round_vectors.json", import.meta.url)), "utf8"));

// The rounds this build has. The remaining eight are being ported, and the list is deliberately
// explicit rather than derived from the vector file, so a round that is dropped or renamed fails here
// instead of quietly falling out of the suite.
const IMPLEMENTED = {
  blake: (b) => Buffer.from(blake512(b)),
  keccak: (b) => Buffer.from(keccak_512(b)),
  cubehash: cubehash512,
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
