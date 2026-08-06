// Does a block header meet the proof of work it declares?
//
// A header carries a compact encoding of the target it was mined against, in the four bytes at offset
// 72 known as nBits. The block is valid work if the X11 hash of the header, read as a number, is at or
// below that target. This is the check that makes inventing a header expensive rather than free: a
// node can assemble a header, a coinbase, and a masternode list that agree with each other in
// microseconds, and it cannot make the resulting hash small without doing the work.
//
// WHAT THIS DOES NOT ESTABLISH. The target comes from the header itself, so what is proven is work
// against the difficulty this header claims, not against the difficulty the network was at. A node
// willing to spend a little mining could offer a low-difficulty header and pass. Closing that means
// following the chain of headers to judge whether the difficulty is the one the network would have
// required, which is a light client, or verifying the ChainLock signature against the quorum that
// signed it. Neither is done here, and the caller's comments say so where it matters.
//
// A difficulty floor would raise the bar cheaply, and it is deliberately NOT invented here. Dash
// retargets on every block, so a floor is a number an operator has to choose against their own view
// of the network, and one set too high refuses legitimate blocks, which is a guard with no exit.

import { x11 } from "../common/x11/index.js";

// The compact form packs an exponent in the top byte and a 23-bit mantissa below it, with the mantissa
// signed. Bitcoin and Dash share this encoding. A negative or overflowing value is not something a
// real header carries, and both are refused rather than being coerced into some other target.
export function targetFromBits(nBits) {
  const exponent = nBits >>> 24;
  const mantissa = nBits & 0x007fffff;
  if (nBits & 0x00800000) throw new Error("nBits carries a negative mantissa, which no real header does");
  if (mantissa === 0) return 0n;
  // Exponents below 3 shift the mantissa DOWN, which is the branch that exists for completeness
  // rather than because mainnet uses it.
  const target = exponent <= 3 ? BigInt(mantissa) >> BigInt(8 * (3 - exponent)) : BigInt(mantissa) << BigInt(8 * (exponent - 3));
  // A target wider than 256 bits is meaningless, since the hash it is compared against is 256 bits.
  if (target >= 1n << 256n) throw new Error("nBits encodes a target larger than any hash can be");
  return target;
}

// The hash as a number. Block hashes are compared as little-endian integers, which is why the display
// form has its leading zeroes at the front while the bytes have them at the end.
function hashToNumber(hash32) {
  let n = 0n;
  for (let i = hash32.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(hash32[i]);
  return n;
}

export function meetsProofOfWork(headerHex) {
  const header = typeof headerHex === "string" ? Buffer.from(headerHex, "hex") : Buffer.from(headerHex);
  if (header.length !== 80) throw new Error(`a block header is 80 bytes, got ${header.length}`);
  const target = targetFromBits(header.readUInt32LE(72));
  if (target === 0n) return false;
  return hashToNumber(Buffer.from(x11(header))) <= target;
}
