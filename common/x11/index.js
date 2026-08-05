// X11, the hashing method Dash uses to name a block.
//
// WHY THIS EXISTS HERE. The masternode-list commitment check in oracle/dml_commitment.js can prove
// that a list, a coinbase, and a header agree with one another, and it cannot prove that the header
// is a block of the chain, because identifying a Dash block means hashing its header with X11. That
// missing link is what leaves direct node mode a trusted-node read: a node that fabricates a header,
// a coinbase, and a list that agree passes every check. With X11 the header can be named, and naming
// it is what lets the read compare against the block hash the ChainLock declared.
//
// Naming a header is not the whole of it. A header that hashes to the ChainLocked block hash is the
// block the node claimed, and checking the proof of work in that hash is what makes fabricating one
// cost real mining. Those are the callers' checks to make; this module only names the header.
//
// ELEVEN ROUNDS, chained. Each takes the previous 64-byte output, the first takes the header itself,
// and the block hash is the first 32 bytes of the last output, displayed reversed like every other
// hash Dash prints. The order below is not alphabetical and not negotiable, and it was confirmed by
// compiling the reference implementations that ship with Dash Core and reproducing the block hash of
// real mainnet headers from genesis to the current tip before any of this was ported.
//
// Two of the eleven come from a dependency the project already had, and that is checked rather than
// assumed: the BLAKE-512 and Keccak-512 in @noble/hashes reproduce the reference on every vector,
// including the padding cases. The other nine are ported here, each verified against vectors
// generated from the reference compiled unmodified. See test/vectors/x11_round_vectors.json and
// test/x11_rounds.test.js.
import { blake512 } from "@noble/hashes/blake1.js";
import { keccak_512 } from "@noble/hashes/sha3.js";
import { bmw512 } from "./bmw.js";
import { groestl512 } from "./groestl.js";
import { skein512 } from "./skein.js";
import { jh512 } from "./jh.js";
import { luffa512 } from "./luffa.js";
import { cubehash512 } from "./cubehash.js";
import { shavite512 } from "./shavite.js";
import { simd512 } from "./simd.js";
import { echo512 } from "./echo.js";

// Named and exported so a test can drive one round at a time. A failure in the chain says only that
// the answer is wrong, and the whole reason the rounds are separately addressable is that finding out
// WHICH of eleven is at fault is otherwise guesswork.
export const ROUNDS = [
  ["blake", (b) => Buffer.from(blake512(b))],
  ["bmw", bmw512],
  ["groestl", groestl512],
  ["skein", skein512],
  ["jh", jh512],
  ["keccak", (b) => Buffer.from(keccak_512(b))],
  ["luffa", luffa512],
  ["cubehash", cubehash512],
  ["shavite", shavite512],
  ["simd", simd512],
  ["echo", echo512],
];

// The 32-byte block identifier, in internal byte order. Callers comparing against a hash from an RPC
// must reverse it, which is what blockHashFromHeader does.
export function x11(input) {
  let state = Buffer.from(input);
  for (const [, fn] of ROUNDS) state = Buffer.from(fn(state));
  return state.subarray(0, 32);
}

// The block hash as Dash displays it, from an 80-byte header.
//
// The length is checked rather than assumed. A caller that passes a whole block, or a header with a
// transaction count appended, would otherwise get a perfectly well-formed hash of the wrong thing,
// and a wrong hash here reads as "this header is not the ChainLocked block" rather than as a bug.
export function blockHashFromHeader(headerHex) {
  const header = typeof headerHex === "string" ? Buffer.from(headerHex, "hex") : Buffer.from(headerHex);
  if (header.length !== 80) {
    throw new Error(`a block header is 80 bytes, got ${header.length}`);
  }
  return Buffer.from(x11(header)).reverse().toString("hex");
}
