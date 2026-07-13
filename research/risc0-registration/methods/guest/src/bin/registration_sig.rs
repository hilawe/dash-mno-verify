// Registration statement, signature-consumption form, for the RISC Zero prover-memory measurement.
//
// The member signs a deterministic message with the voting key in their wallet, and the guest
// verifies that signature rather than deriving the key from a raw private scalar. The private key
// never enters the prover, which fits operators who keep the voting key in a wallet, for example a
// hosted masternode where the owner retains the voting key.
//
// Private witness: the compressed public key, the ECDSA signature (r || s), and the Merkle path.
// Public journal: root, epoch, contextHash, signalHash, nullifier.
//
// SOUNDNESS NOTE: the nullifier is derived from the signature, which is unique per (key, message)
// only if the signature is deterministic (RFC 6979). A production design must rely on deterministic
// signing or bind the nullifier to a stable value, or one key could mint several nullifiers. This
// prototype measures the cost of the signature statement, not that soundness fix.

#![no_main]

use k256::ecdsa::signature::hazmat::PrehashVerifier;
use k256::ecdsa::{Signature, VerifyingKey};
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
    let pubkey_bytes: Vec<u8> = env::read(); // compressed secp256k1 public key, 33 bytes
    let sig_bytes: Vec<u8> = env::read(); // ECDSA signature, r || s, 64 bytes
    let path_siblings: Vec<[u8; 32]> = env::read();
    let path_bits: Vec<u8> = env::read();

    // --- public inputs ---
    let root: [u8; 32] = env::read();
    let epoch: u64 = env::read();
    let context_hash: [u8; 32] = env::read();
    let signal_hash: [u8; 32] = env::read();

    // 1) recompute the message the member must have signed, from the public epoch and context, so
    //    the signature is bound to this epoch and community and cannot be an arbitrary message.
    let msg_hash = {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"dash-mno-verify:auth:v1");
        buf.extend_from_slice(&context_hash);
        buf.extend_from_slice(&epoch.to_le_bytes());
        sha256(&buf)
    };

    // 2) verify the ECDSA signature under the public key, the accelerated path, the proof of key
    //    control that replaces deriving P = d*G.
    let vk = VerifyingKey::from_sec1_bytes(&pubkey_bytes).expect("bad public key");
    let sig = Signature::from_slice(&sig_bytes).expect("bad signature encoding");
    vk.verify_prehash(&msg_hash, &sig)
        .expect("signature did not verify under the public key");

    // 3) keyID = hash160(compressed public key), the keyIDVoting.
    let key_id = hash160(&pubkey_bytes);

    // 4) Merkle inclusion, identical to the derive-key guest.
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
    assert_eq!(node, root, "Merkle inclusion failed");

    // 5) nullifier = SHA-256(0x02 || signature || contextHash). See the soundness note above.
    let nullifier = {
        let mut buf = Vec::with_capacity(1 + 64 + 32);
        buf.push(0x02);
        buf.extend_from_slice(&sig_bytes);
        buf.extend_from_slice(&context_hash);
        sha256(&buf)
    };

    // 6) commit the public journal only.
    env::commit(&root);
    env::commit(&epoch);
    env::commit(&context_hash);
    env::commit(&signal_hash);
    env::commit(&nullifier);
}
