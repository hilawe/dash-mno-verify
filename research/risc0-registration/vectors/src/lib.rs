//! Golden vectors for the zkVM integration, work-plan step 1 of docs/ZKVM_INTEGRATION.md.
//!
//! Every constant here is computed by circomlibjs (the reference the circuits are built
//! against) in test/zkvm_vectors.test.js of the main repository, and pinned identically in
//! both suites. If these tests pass, light-poseidon reproduces circomlibjs for both formula
//! forms the guest needs (`Poseidon(secret)` and `Poseidon(Poseidon(d_limbs), season,
//! contextHash)`), which is the design's hard prerequisite. If they fail, the fallback is
//! porting the circomlib constants, not changing the formula.
//!
//! The SHA-256 tree vectors pin the DML tree spec: leaf = SHA-256(0x00 || keyID20),
//! node = SHA-256(0x01 || left || right), empty leaf = 20 zero bytes, depth 16.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonHasher};
use sha2::{Digest, Sha256};

/// Poseidon(secret) for secret = 1.
pub const POSEIDON1_OF_1: &str =
    "18586133768512220936620570745912940619677854269274689475585506675881198879027";
/// Poseidon(secret) for secret = p - 1, the largest canonical field element.
pub const POSEIDON1_OF_P_MINUS_1: &str =
    "3366645945435192953002076803303112651887535928162668198103357554665518664470";
/// Poseidon over the 4 little-endian 64-bit limbs of d = 1.
pub const KH_D1: &str =
    "12367897091404705650828429310777103242839675713861485408658822466779430954331";
/// Poseidon over the 4 little-endian 64-bit limbs of d = n - 2 (secp256k1 order minus 2).
pub const KH_D2: &str =
    "17733228908332928336250677456484071725019237794152871801635728024063440347582";
/// regNullifier = Poseidon(KH_D1, season = 7, contextHash = 999).
pub const RN_D1: &str =
    "15227301960485994341830905575422680556053229133647037318432828740967973824578";
/// regNullifier = Poseidon(KH_D2, season = 7, contextHash = 999).
pub const RN_D2: &str =
    "5331113805761365827444637754639205013995575527913347682073454633956069601495";

/// hash160 of the compressed secp256k1 generator point (the keyID for d = 1).
pub const GEN_KEYID_HEX: &str = "751e76e8199196d454941c45d1b3a323f1433bd6";
/// SHA-256(0x00 || 20 zero bytes), the empty-leaf hash of the spec.
pub const EMPTY_LEAF_HASH_HEX: &str =
    "c90232586b801f9558a76f2f963eccd831d9fe6775e4c8f1446b2331aa2132f2";
/// The all-empty depth-16 subtree root under the spec.
pub const EMPTY_DEPTH16_HEX: &str =
    "aea2c3f1ca4e45228d7905549472467b418662bf5736df886e474a2aeade070b";
/// Depth-16 root over leaves [GEN_KEYID, 0x02 * 20] at indices 0 and 1, empties elsewhere.
pub const ROOT_TWO_LEAVES_HEX: &str =
    "6c0f8060bd905e707dacb197e739b7915d683842711ce16ffeae4ae6d9e51e66";

/// The 4 little-endian 64-bit limbs of d = n - 2, matching prover/two_tier.js privToLimbs.
pub const D2_LIMBS: [u64; 4] = [
    0xbfd2_5e8c_d036_413f,
    0xbaae_dce6_af48_a03b,
    0xffff_ffff_ffff_fffe,
    0xffff_ffff_ffff_ffff,
];

pub fn fr_dec(x: Fr) -> String {
    x.into_bigint().to_string()
}

/// A pinned decimal field-element constant as 32 big-endian bytes, the journal encoding.
pub fn dec_to_be32(s: &str) -> [u8; 32] {
    use core::str::FromStr;
    let v = Fr::from_str(s).expect("constant must be a canonical decimal field element");
    fr_to_be32(v)
}

/// A field element as 32 big-endian bytes, left-padded, the journal encoding.
pub fn fr_to_be32(v: Fr) -> [u8; 32] {
    let bytes = v.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
    out
}

/// Leaf hash of the pinned spec: SHA-256(0x00 || keyID20).
pub fn leaf_hash(key_id: &[u8; 20]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(21);
    buf.push(0x00);
    buf.extend_from_slice(key_id);
    sha256(&buf)
}

/// Internal node of the pinned spec: SHA-256(0x01 || left || right).
pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(65);
    buf.push(0x01);
    buf.extend_from_slice(left);
    buf.extend_from_slice(right);
    sha256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poseidon_single_input_matches_circomlibjs() {
        let mut h = Poseidon::<Fr>::new_circom(1).expect("poseidon width 1");
        assert_eq!(fr_dec(h.hash(&[Fr::from(1u64)]).unwrap()), POSEIDON1_OF_1);
        let p_minus_1 = Fr::from(0u64) - Fr::from(1u64);
        assert_eq!(fr_dec(h.hash(&[p_minus_1]).unwrap()), POSEIDON1_OF_P_MINUS_1);
    }

    #[test]
    fn poseidon_limb_and_nullifier_forms_match_circomlibjs() {
        let mut h4 = Poseidon::<Fr>::new_circom(4).expect("poseidon width 4");
        let mut h3 = Poseidon::<Fr>::new_circom(3).expect("poseidon width 3");

        let kh1 = h4
            .hash(&[Fr::from(1u64), Fr::from(0u64), Fr::from(0u64), Fr::from(0u64)])
            .unwrap();
        assert_eq!(fr_dec(kh1), KH_D1);

        let d2: Vec<Fr> = D2_LIMBS.iter().map(|&l| Fr::from(l)).collect();
        let kh2 = h4.hash(&d2).unwrap();
        assert_eq!(fr_dec(kh2), KH_D2);

        let season = Fr::from(7u64);
        let ctx = Fr::from(999u64);
        assert_eq!(fr_dec(h3.hash(&[kh1, season, ctx]).unwrap()), RN_D1);
        assert_eq!(fr_dec(h3.hash(&[kh2, season, ctx]).unwrap()), RN_D2);
    }

    #[test]
    fn decimal_to_journal_bytes_round_trips() {
        use core::str::FromStr;
        for c in [POSEIDON1_OF_1, POSEIDON1_OF_P_MINUS_1, KH_D1, KH_D2, RN_D1, RN_D2] {
            let bytes = dec_to_be32(c);
            let back = Fr::from_str(c).unwrap();
            assert_eq!(fr_to_be32(back), bytes);
            assert_eq!(fr_dec(back), c);
        }
    }

    #[test]
    fn sha256_tree_spec_matches_the_pinned_vectors() {
        let empty_leaf = leaf_hash(&[0u8; 20]);
        assert_eq!(hex::encode(empty_leaf), EMPTY_LEAF_HASH_HEX);

        let mut empty = vec![empty_leaf];
        for i in 1..=16 {
            let prev = empty[i - 1];
            empty.push(node_hash(&prev, &prev));
        }
        assert_eq!(hex::encode(empty[16]), EMPTY_DEPTH16_HEX);

        let gen_keyid: [u8; 20] = hex::decode(GEN_KEYID_HEX).unwrap().try_into().unwrap();
        let keyid2 = [0x02u8; 20];
        let mut cur = node_hash(&leaf_hash(&gen_keyid), &leaf_hash(&keyid2));
        for level in empty.iter().take(16).skip(1) {
            cur = node_hash(&cur, level);
        }
        assert_eq!(hex::encode(cur), ROOT_TWO_LEAVES_HEX);
    }
}
