// Registration statement, derive-the-key form, for the RISC Zero prover-memory measurement.
//
// Private witness (read from the environment, never committed):
//   d               the voting secp256k1 private key, 32 bytes
//   path_siblings   the Merkle authentication path, one 32-byte sibling per level
//   path_bits       the position bit per level, 0 means the current node is on the left
//
// Public journal (committed): root, epoch, contextHash, signalHash, nullifier.
//
// The dominant cost is step 1, the secp256k1 scalar multiplication. RIPEMD-160 runs unaccelerated
// but hashes only 32 bytes. The tree hash is SHA-256 so it uses the accelerator.

#![no_main]

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use ripemd::Ripemd160;
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

risc0_zkvm::guest::entry!(main);

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
    out
}

fn hash160(data: &[u8]) -> [u8; 20] {
    let sha = Sha256::digest(data);
    let mut out = [0u8; 20];
    out.copy_from_slice(&Ripemd160::digest(sha));
    out
}

pub fn main() {
    // --- private witness ---
    let d: [u8; 32] = env::read();
    let path_siblings: Vec<[u8; 32]> = env::read();
    let path_bits: Vec<u8> = env::read();

    // --- public inputs ---
    let root: [u8; 32] = env::read();
    let epoch: u64 = env::read();
    let context_hash: [u8; 32] = env::read();
    let signal_hash: [u8; 32] = env::read();

    // 1) P = d * G, the dominant cost.
    let sk = SecretKey::from_slice(&d).expect("private key must be a canonical scalar in [1, n)");
    let pk = sk.public_key();
    let compressed = pk.to_encoded_point(true);

    // 2) keyID = hash160(compressed P), the keyIDVoting.
    let key_id = hash160(compressed.as_bytes());

    // 3) Merkle inclusion under the public root.
    //    Domain-separate the leaf (0x00) from internal nodes (0x01) to block cross-level second preimages.
    let mut node = {
        let mut buf = Vec::with_capacity(1 + 20);
        buf.push(0x00);
        buf.extend_from_slice(&key_id);
        sha256(&buf)
    };
    assert_eq!(
        path_siblings.len(),
        path_bits.len(),
        "path siblings and bits must have equal length"
    );
    for (sib, bit) in path_siblings.iter().zip(path_bits.iter()) {
        let mut buf = Vec::with_capacity(1 + 64);
        buf.push(0x01);
        if *bit == 0 {
            buf.extend_from_slice(&node);
            buf.extend_from_slice(sib);
        } else {
            buf.extend_from_slice(sib);
            buf.extend_from_slice(&node);
        }
        node = sha256(&buf);
    }
    assert_eq!(node, root, "Merkle inclusion failed, keyID is not under the published root");

    // 4) nullifier = SHA-256(0x02 || d || epoch || contextHash), keyed on the secret d.
    let nullifier = {
        let mut buf = Vec::with_capacity(1 + 32 + 8 + 32);
        buf.push(0x02);
        buf.extend_from_slice(&d);
        buf.extend_from_slice(&epoch.to_le_bytes());
        buf.extend_from_slice(&context_hash);
        sha256(&buf)
    };

    // 5) signalHash binds the proof to a one-time challenge and account in the full design.
    //    Here it is committed so it is part of the journal and cannot be swapped after the fact.

    // --- commit the public journal only ---
    env::commit(&root);
    env::commit(&epoch);
    env::commit(&context_hash);
    env::commit(&signal_hash);
    env::commit(&nullifier);
}
