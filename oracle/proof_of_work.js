// Does a block header meet the proof of work it declares, against a target the network allows?
//
// A header carries a compact encoding of the target it was mined against, in the four bytes at offset
// 72 known as nBits. The block is valid work if the X11 hash of the header, read as a number, is at or
// below that target AND that target is no easier than the network's own limit.
//
// THE SECOND HALF IS NOT OPTIONAL, and leaving it out made the first half worthless. Without it the
// node chooses the target as well as the header, so it can declare a target of almost the whole
// 256-bit range and any header at all satisfies it. Reproduced against this file before it was fixed:
// an all-zero 80-byte header declaring nBits 0x220000ff passed, at a cost of one hash. The check read
// as "real work went into this block" and meant nothing of the kind.
//
// Dash's own CheckProofOfWork (src/pow.cpp) refuses a target above consensus.powLimit for exactly this
// reason, and powLimit is a CONSENSUS CONSTANT rather than an operator's judgement. An earlier version
// of this file said a difficulty floor was a number an operator had to choose against their own view
// of the network, and that was wrong: this floor is fixed by the network's rules and belongs in the
// code.
//
// WHAT THIS STILL DOES NOT ESTABLISH. powLimit is the EASIEST target the network ever allows, not the
// difficulty in force when the block was mined. Mainnet difficulty is many orders of magnitude beyond
// it, so a header mined at powLimit costs real but comparatively modest work and would pass. Ruling
// that out means following the chain of headers to judge what the difficulty should have been, which
// is a light client, or verifying the ChainLock signature against the quorum that signed it. Neither
// is done here. The floor turns "free" into "expensive", not into "as expensive as the real chain".

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

// The easiest target Dash mainnet ever accepts, from consensus.powLimit in Dash Core's chainparams
// (`~uint256(0) >> 20`). A target above this is refused whatever the header claims.
export const MAINNET_POW_LIMIT = 0x00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

export function meetsProofOfWork(headerHex, { powLimit = MAINNET_POW_LIMIT } = {}) {
  const header = typeof headerHex === "string" ? Buffer.from(headerHex, "hex") : Buffer.from(headerHex);
  if (header.length !== 80) throw new Error(`a block header is 80 bytes, got ${header.length}`);
  const target = targetFromBits(header.readUInt32LE(72));
  if (target === 0n) return false;
  // The order matters only for clarity, since both must hold, but refusing the target first says which
  // of the two failed when a header is rejected.
  if (target > powLimit) return false;
  return hashToNumber(Buffer.from(x11(header))) <= target;
}
