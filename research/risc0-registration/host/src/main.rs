// Host harness: build a synthetic registration witness, run the prover once, and print the numbers
// the Phase 0 gate needs. Peak resident memory is captured externally by scripts/bench.sh, because
// it is a property of the whole process, not something the program can report for itself reliably.
//
// Takes one argument, the statement to measure:
//   derive  (default)  prove P = d*G from the raw private key, then hash160, Merkle, nullifier.
//   sig                verify a wallet signature over a deterministic message, so the private key
//                      never enters the prover, then hash160, Merkle, nullifier.
// Run each in its own process (the bench does) so their peak memory is measured separately.

use k256::ecdsa::signature::hazmat::PrehashSigner;
use k256::ecdsa::{Signature, SigningKey};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use methods::{
    REGISTRATION_ELF, REGISTRATION_ID, REGISTRATION_REC_ELF, REGISTRATION_REC_ID,
    REGISTRATION_SIG_ELF, REGISTRATION_SIG_ID,
};
use rand::rngs::OsRng;
use ripemd::Ripemd160;
use risc0_zkvm::{default_prover, ExecutorEnv, ProveInfo};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

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

// Must mirror the guest's hashing exactly, or the computed root will not match.
fn leaf_node(key_id: &[u8; 20]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(1 + 20);
    buf.push(0x00);
    buf.extend_from_slice(key_id);
    sha256(&buf)
}

fn parent(bit: u8, node: &[u8; 32], sib: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(1 + 64);
    buf.push(0x01);
    if bit == 0 {
        buf.extend_from_slice(node);
        buf.extend_from_slice(sib);
    } else {
        buf.extend_from_slice(sib);
        buf.extend_from_slice(node);
    }
    sha256(&buf)
}

// A SHA-256 Merkle path of TREE_DEPTH with the leaf on the left at every level, deterministic siblings.
fn build_merkle(key_id: &[u8; 20]) -> (Vec<[u8; 32]>, Vec<u8>, [u8; 32]) {
    let mut node = leaf_node(key_id);
    let mut siblings: Vec<[u8; 32]> = Vec::with_capacity(TREE_DEPTH);
    let mut bits: Vec<u8> = Vec::with_capacity(TREE_DEPTH);
    for i in 0..TREE_DEPTH {
        let sib = sha256(&[i as u8; 32]);
        node = parent(0, &node, &sib);
        siblings.push(sib);
        bits.push(0);
    }
    (siblings, bits, node)
}

fn report(mode: &str, elf: &[u8], info: &ProveInfo, elapsed: Duration) {
    let receipt = &info.receipt;
    let receipt_bytes = bincode::serialize(receipt).map(|b| b.len()).unwrap_or(0);
    println!("[{mode}] guest_elf_bytes: {}", elf.len());
    println!("[{mode}] proving_time_s: {:.2}", elapsed.as_secs_f64());
    println!("[{mode}] receipt_bytes: {receipt_bytes}");
    println!("[{mode}] journal_bytes: {}", receipt.journal.bytes.len());
    println!("[{mode}] total_cycles: {}", info.stats.total_cycles);
    println!("[{mode}] user_cycles: {}", info.stats.user_cycles);
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "derive".to_string());
    let epoch: u64 = 42;
    let context_hash = sha256(b"dash-mno-verify:v1:discord:example:member");
    let signal_hash = sha256(b"one-time-challenge-nonce-bound-to-account");

    match mode.as_str() {
        "derive" => {
            let sk = SecretKey::random(&mut OsRng);
            let d: [u8; 32] = sk.to_bytes().into();
            let compressed = sk.public_key().to_encoded_point(true);
            let key_id = hash160(compressed.as_bytes());
            let (siblings, bits, root) = build_merkle(&key_id);
            let env = ExecutorEnv::builder()
                .write(&d).unwrap()
                .write(&siblings).unwrap()
                .write(&bits).unwrap()
                .write(&root).unwrap()
                .write(&epoch).unwrap()
                .write(&context_hash).unwrap()
                .write(&signal_hash).unwrap()
                .build()
                .unwrap();
            eprintln!("[derive] proving (tree depth {TREE_DEPTH}) ...");
            let start = Instant::now();
            let info = default_prover().prove(env, REGISTRATION_ELF).expect("proving failed");
            let elapsed = start.elapsed();
            info.receipt.verify(REGISTRATION_ID).expect("receipt failed to verify");
            report("derive", REGISTRATION_ELF, &info, elapsed);
        }
        "sig" => {
            let signing = SigningKey::random(&mut OsRng);
            let pubkey_bytes = signing.verifying_key().to_encoded_point(true).as_bytes().to_vec();
            let key_id = hash160(&pubkey_bytes);
            // the message the member signs, derived from the public epoch and context.
            let msg_hash = {
                let mut buf = Vec::new();
                buf.extend_from_slice(b"dash-mno-verify:auth:v1");
                buf.extend_from_slice(&context_hash);
                buf.extend_from_slice(&epoch.to_le_bytes());
                sha256(&buf)
            };
            let sig: Signature = signing.sign_prehash(&msg_hash).expect("signing failed");
            let sig_bytes = sig.to_bytes().to_vec();
            let (siblings, bits, root) = build_merkle(&key_id);
            let env = ExecutorEnv::builder()
                .write(&pubkey_bytes).unwrap()
                .write(&sig_bytes).unwrap()
                .write(&siblings).unwrap()
                .write(&bits).unwrap()
                .write(&root).unwrap()
                .write(&epoch).unwrap()
                .write(&context_hash).unwrap()
                .write(&signal_hash).unwrap()
                .build()
                .unwrap();
            eprintln!("[sig] proving (tree depth {TREE_DEPTH}) ...");
            let start = Instant::now();
            let info = default_prover().prove(env, REGISTRATION_SIG_ELF).expect("proving failed");
            let elapsed = start.elapsed();
            info.receipt.verify(REGISTRATION_SIG_ID).expect("receipt failed to verify");
            report("sig", REGISTRATION_SIG_ELF, &info, elapsed);
        }
        "rec" => {
            // Efficient-ECDSA (recovery/hinted) form. The member signs in the wallet, and the host
            // reformulates the signature into the hint T and U so the in-circuit check is the single
            // scalar multiplication Q = s*T + U. The synthetic hint below satisfies that relation, so
            // the guest incurs the real scalar-mult cost; computing T and U from a real signature is a
            // production item, see the guest's cost note. The raw private key never enters the prover.
            use k256::{ProjectivePoint, Scalar};
            let sk = SecretKey::random(&mut OsRng);
            let q_point: ProjectivePoint = sk.public_key().to_projective();
            let q_bytes = sk.public_key().to_encoded_point(true).as_bytes().to_vec();
            let key_id = hash160(&q_bytes);
            let s: Scalar = *SecretKey::random(&mut OsRng).to_nonzero_scalar();
            let h: Scalar = *SecretKey::random(&mut OsRng).to_nonzero_scalar();
            let t_point: ProjectivePoint = ProjectivePoint::GENERATOR * h;
            let u_point: ProjectivePoint = q_point - (t_point * s);
            let s_bytes: Vec<u8> = {
                let b: [u8; 32] = s.to_bytes().into();
                b.to_vec()
            };
            let t_bytes = t_point.to_affine().to_encoded_point(true).as_bytes().to_vec();
            let u_bytes = u_point.to_affine().to_encoded_point(true).as_bytes().to_vec();
            let (siblings, bits, root) = build_merkle(&key_id);
            let env = ExecutorEnv::builder()
                .write(&q_bytes).unwrap()
                .write(&s_bytes).unwrap()
                .write(&t_bytes).unwrap()
                .write(&u_bytes).unwrap()
                .write(&siblings).unwrap()
                .write(&bits).unwrap()
                .write(&root).unwrap()
                .write(&epoch).unwrap()
                .write(&context_hash).unwrap()
                .write(&signal_hash).unwrap()
                .build()
                .unwrap();
            eprintln!("[rec] proving (tree depth {TREE_DEPTH}) ...");
            let start = Instant::now();
            let info = default_prover().prove(env, REGISTRATION_REC_ELF).expect("proving failed");
            let elapsed = start.elapsed();
            info.receipt.verify(REGISTRATION_REC_ID).expect("receipt failed to verify");
            report("rec", REGISTRATION_REC_ELF, &info, elapsed);
        }
        other => {
            eprintln!("unknown mode '{other}', use 'derive', 'sig', or 'rec'");
            std::process::exit(2);
        }
    }
    eprintln!("done. peak memory is reported externally via the system time utility.");
}
