// Guest v2, the production registration statement of docs/ZKVM_INTEGRATION.md (work-plan
// step 2). This is the five-claim statement, unlike the benchmark variants in the other
// bins, which keep the older epoch-and-signal shape for comparability of the Phase 0 rows.
//
// Private witness (read from the environment, never committed):
//   d               the voting secp256k1 private key, 32 big-endian bytes
//   secret          the fresh member secret, 32 big-endian bytes, a canonical BN254 element
//   path_siblings   the Merkle authentication path, one 32-byte sibling per level
//   path_bits       the position bit per level, MUST be 0 (node on the left) or 1 (right)
//
// Public inputs: root (SHA-256 tree root), season (u64), contextHash (32 bytes, canonical
// BN254 element).
//
// Journal: exactly 136 bytes committed as one slice, per the frozen appendix layout:
// commitment (32, big-endian), regNullifier (32, big-endian), root (32), season (8,
// big-endian), contextHash (32).
//
// The Poseidon forms match circomlibjs bit for bit, pinned by the vectors crate and
// test/zkvm_vectors.test.js: commitment = Poseidon(secret), regNullifier =
// Poseidon(Poseidon(d as 4 little-endian 64-bit limbs), season, contextHash).

#![no_main]

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use light_poseidon::{Poseidon, PoseidonHasher};
use ripemd::Ripemd160;
use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

risc0_zkvm::guest::entry!(main);

const TREE_DEPTH: usize = 16;

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

// A canonical big-endian field element. Reduction would silently accept a non-canonical
// input, so parse-and-reserialize and require the round trip to be exact.
fn fr_from_be_canonical(bytes: &[u8; 32], what: &str) -> Fr {
    let v = Fr::from_be_bytes_mod_order(bytes);
    assert_eq!(&fr_to_be32(v), bytes, "{what} must be a canonical field element");
    v
}

fn fr_to_be32(v: Fr) -> [u8; 32] {
    let b = v.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

pub fn main() {
    // --- private witness ---
    let d: [u8; 32] = env::read();
    let secret: [u8; 32] = env::read();
    let path_siblings: Vec<[u8; 32]> = env::read();
    let path_bits: Vec<u8> = env::read();

    // --- public inputs ---
    let root: [u8; 32] = env::read();
    let season: u64 = env::read();
    let context_hash: [u8; 32] = env::read();

    // 1) P = d * G, then keyID = hash160(compressed P). k256 accepts exactly [1, n), the
    //    strict side of the circuit's M1 range, so zero and non-canonical scalars fail here.
    let sk = SecretKey::from_slice(&d).expect("private key must be a canonical scalar in [1, n)");
    let compressed = sk.public_key().to_encoded_point(true);
    let key_id = hash160(compressed.as_bytes());

    // 2) Merkle inclusion under the pinned spec: depth exactly 16, strict direction bits.
    assert_eq!(path_siblings.len(), TREE_DEPTH, "path must have exactly {TREE_DEPTH} siblings");
    assert_eq!(path_bits.len(), TREE_DEPTH, "path must have exactly {TREE_DEPTH} bits");
    let mut node = {
        let mut buf = [0u8; 21];
        buf[1..].copy_from_slice(&key_id);
        sha256(&buf)
    };
    for (sib, bit) in path_siblings.iter().zip(path_bits.iter()) {
        assert!(*bit == 0 || *bit == 1, "path bit must be 0 or 1");
        let mut buf = [0u8; 65];
        buf[0] = 0x01;
        if *bit == 0 {
            buf[1..33].copy_from_slice(&node);
            buf[33..].copy_from_slice(sib);
        } else {
            buf[1..33].copy_from_slice(sib);
            buf[33..].copy_from_slice(&node);
        }
        node = sha256(&buf);
    }
    assert_eq!(node, root, "Merkle inclusion failed, keyID is not under the published root");

    // 3) commitment and registration nullifier, circomlib-parameterized Poseidon.
    let secret_fr = fr_from_be_canonical(&secret, "secret");
    let ctx_fr = fr_from_be_canonical(&context_hash, "contextHash");
    let mut h1 = Poseidon::<Fr>::new_circom(1).expect("poseidon width 1");
    let mut h3 = Poseidon::<Fr>::new_circom(3).expect("poseidon width 3");
    let mut h4 = Poseidon::<Fr>::new_circom(4).expect("poseidon width 4");

    let commitment = h1.hash(&[secret_fr]).expect("poseidon commitment");

    // d as 4 little-endian 64-bit limbs, the prover/two_tier.js privToLimbs layout.
    let limb = |i: usize| u64::from_be_bytes(d[32 - 8 * (i + 1)..32 - 8 * i].try_into().unwrap());
    let kh = h4
        .hash(&[Fr::from(limb(0)), Fr::from(limb(1)), Fr::from(limb(2)), Fr::from(limb(3))])
        .expect("poseidon key hash");
    let reg_nullifier = h3
        .hash(&[kh, Fr::from(season), ctx_fr])
        .expect("poseidon nullifier");

    // 4) the frozen 136-byte journal, one slice.
    let mut journal = [0u8; 136];
    journal[0..32].copy_from_slice(&fr_to_be32(commitment));
    journal[32..64].copy_from_slice(&fr_to_be32(reg_nullifier));
    journal[64..96].copy_from_slice(&root);
    journal[96..104].copy_from_slice(&season.to_be_bytes());
    journal[104..136].copy_from_slice(&context_hash);
    env::commit_slice(&journal);
}
