// Canonical leaf and key encodings shared by the oracle, the prover, and the tests.
//
// The oracle derives a leaf from a published votingAddress. The prover derives the same
// leaf from the voting private key. They must agree, or a real owner's proof will not
// match the published tree. Keeping both derivations here, and pinning them in
// test/hash160.test.js, is what guarantees they agree. The Circom circuit must
// reproduce these same leaf values; that side is validated when the circuit compiles.
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import bs58check from "bs58check";

// hash160(compressed pubkey) as a big-endian BigInt, the Merkle leaf value.
export function leafFromPubkey(compressedPubkey) {
  const h = ripemd160(sha256(compressedPubkey));
  return BigInt("0x" + Buffer.from(h).toString("hex"));
}

// Derive the leaf from a voting private key (32-byte Uint8Array).
export function leafFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, true); // 33-byte compressed
  return leafFromPubkey(pub);
}

// Decode a Dash votingAddress (base58check) to its leaf value. Drop the 1-byte
// version prefix, keep the 20-byte hash160, read big-endian.
export function votingAddressToLeaf(address) {
  const hash160 = bs58check.decode(address).slice(1);
  return BigInt("0x" + Buffer.from(hash160).toString("hex"));
}

// Decode a Dash votingAddress to its raw 20-byte keyID (the hash160), the leaf the
// SHA-256 DML tree hashes directly (the Poseidon tree instead reads it big-endian as a
// field element via votingAddressToLeaf). Same 20 bytes, two encodings.
export function votingAddressToKeyId(address) {
  const keyId = Buffer.from(bs58check.decode(address).slice(1));
  if (keyId.length !== 20) throw new Error(`votingAddress decoded to ${keyId.length} bytes, expected 20`);
  return keyId;
}

// Dash wallet import format (WIF) to a 32-byte private key. Drop the version byte,
// drop the trailing compression flag if present.
export function wifToPriv(wif) {
  const payload = bs58check.decode(wif).slice(1);
  return Uint8Array.from(payload.slice(0, 32));
}

// Encode a 20-byte hash160 as a Dash P2PKH-style address. Mainnet pubkey version is
// 0x4c, which yields an "X" prefix. Used by tooling and tests; the pipeline only decodes.
export function hash160ToAddress(hash160, version = 0x4c) {
  return bs58check.encode(Buffer.concat([Buffer.from([version]), Buffer.from(hash160)]));
}
