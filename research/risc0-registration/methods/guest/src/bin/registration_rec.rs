// Registration statement, efficient-ECDSA (recovery/hinted) form, for the RISC Zero prover-memory
// measurement. This is the third variant, meant to answer whether the wallet-custody path, where the
// voting key never enters the prover, can be as cheap as the derive path.
//
// The member signs a message in the wallet, producing an ECDSA signature. Outside the circuit, in the
// host, that signature is reformulated into the "efficient ECDSA" hint T and U, so the single
// in-circuit check is Q = s*T + U. That is ONE secp256k1 scalar multiplication, versus the two of a
// full signature verification, and the raw private key never enters the prover while the public key Q
// stays private.
//
// COST NOTE: this measures the cost of the one-scalar-mult relation, which is the dominant cost of the
// efficient-ECDSA approach. Computing T and U from a real RFC 6979 signature, binding them to the
// message so the prover cannot choose them freely, and the nullifier soundness, are production items,
// the same class of caveat as the other two prototypes. The scalar-multiplication cost is identical
// with real or synthetic hints, which is what makes this a faithful cost measurement.

#![no_main]

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::{ProjectivePoint, PublicKey, Scalar, SecretKey};
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

fn parse_point(bytes: &[u8]) -> ProjectivePoint {
    PublicKey::from_sec1_bytes(bytes)
        .expect("bad point encoding")
        .to_projective()
}

pub fn main() {
    // --- private witness ---
    let q_bytes: Vec<u8> = env::read(); // compressed public key Q, 33 bytes
    let s_bytes: Vec<u8> = env::read(); // signature scalar s, 32 bytes
    let t_bytes: Vec<u8> = env::read(); // hint point T, 33 bytes
    let u_bytes: Vec<u8> = env::read(); // hint point U, 33 bytes
    let path_siblings: Vec<[u8; 32]> = env::read();
    let path_bits: Vec<u8> = env::read();

    // --- public inputs ---
    let root: [u8; 32] = env::read();
    let epoch: u64 = env::read();
    let context_hash: [u8; 32] = env::read();
    let signal_hash: [u8; 32] = env::read();

    // 1) parse the hint points and the scalar. The scalar s is in [1, n), so it parses as a secret
    //    scalar; this reuses the same key-parsing path as the derive guest.
    let q = parse_point(&q_bytes);
    let t = parse_point(&t_bytes);
    let u = parse_point(&u_bytes);
    let s: Scalar = *SecretKey::from_slice(&s_bytes)
        .expect("bad scalar")
        .to_nonzero_scalar();

    // 2) the efficient-ECDSA relation Q = s*T + U, the one scalar multiplication that proves key
    //    control without the raw private key and without a second scalar mult.
    let recomputed = t * s + u;
    let recomputed_compressed = recomputed.to_affine().to_encoded_point(true);
    assert!(
        recomputed_compressed.as_bytes() == q_bytes.as_slice(),
        "efficient-ECDSA relation Q = s*T + U failed"
    );

    // 3) keyID = hash160(compressed Q).
    let key_id = hash160(&q_bytes);

    // 4) Merkle inclusion, identical to the other guests.
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

    // 5) nullifier = SHA-256(0x03 || s || contextHash). Same soundness caveat as the signature guest.
    let nullifier = {
        let mut buf = Vec::with_capacity(1 + 32 + 32);
        buf.push(0x03);
        buf.extend_from_slice(&s_bytes);
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
