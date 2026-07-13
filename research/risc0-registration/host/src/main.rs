// Host harness: build a synthetic registration witness, run the prover once, and print the numbers
// the Phase 0 gate needs. Peak resident memory is captured externally by scripts/bench.sh, because
// it is a property of the whole process, not something the program can report for itself reliably.

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use methods::{REGISTRATION_ELF, REGISTRATION_ID};
use rand::rngs::OsRng;
use ripemd::Ripemd160;
use risc0_zkvm::{default_prover, ExecutorEnv};
use sha2::{Digest, Sha256};
use std::time::Instant;

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

fn main() {
    // --- synthetic witness ---
    let sk = SecretKey::random(&mut OsRng);
    let d: [u8; 32] = sk.to_bytes().into();
    let pk = sk.public_key();
    let compressed = pk.to_encoded_point(true);
    let key_id = hash160(compressed.as_bytes());

    // A SHA-256 Merkle path of TREE_DEPTH, our leaf on the left at every level, deterministic siblings.
    let mut node = leaf_node(&key_id);
    let mut siblings: Vec<[u8; 32]> = Vec::with_capacity(TREE_DEPTH);
    let mut bits: Vec<u8> = Vec::with_capacity(TREE_DEPTH);
    for i in 0..TREE_DEPTH {
        let sib = sha256(&[i as u8; 32]);
        let bit = 0u8;
        node = parent(bit, &node, &sib);
        siblings.push(sib);
        bits.push(bit);
    }
    let root = node;

    let epoch: u64 = 42;
    let context_hash = sha256(b"dash-mno-verify:v1:discord:example:member");
    let signal_hash = sha256(b"one-time-challenge-nonce-bound-to-account");

    // --- environment, same order the guest reads ---
    let env = ExecutorEnv::builder()
        .write(&d)
        .unwrap()
        .write(&siblings)
        .unwrap()
        .write(&bits)
        .unwrap()
        .write(&root)
        .unwrap()
        .write(&epoch)
        .unwrap()
        .write(&context_hash)
        .unwrap()
        .write(&signal_hash)
        .unwrap()
        .build()
        .unwrap();

    // --- prove ---
    eprintln!("proving the registration statement (tree depth {TREE_DEPTH}) ...");
    let start = Instant::now();
    let info = default_prover()
        .prove(env, REGISTRATION_ELF)
        .expect("proving failed");
    let elapsed = start.elapsed();

    let receipt = info.receipt;
    receipt
        .verify(REGISTRATION_ID)
        .expect("receipt failed to verify");

    let receipt_bytes = bincode::serialize(&receipt).map(|b| b.len()).unwrap_or(0);

    // Machine-readable metrics, one per line, for the bench harness to grep.
    // guest_elf_bytes is the per-statement artifact, the closest analogue to a proving key.
    println!("guest_elf_bytes: {}", REGISTRATION_ELF.len());
    println!("proving_time_s: {:.2}", elapsed.as_secs_f64());
    println!("receipt_bytes: {receipt_bytes}");
    println!("journal_bytes: {}", receipt.journal.bytes.len());
    // Cycle counts. Field names can vary slightly across RISC Zero releases; adjust if the build
    // reports an unknown field on info.stats.
    println!("total_cycles: {}", info.stats.total_cycles);
    println!("user_cycles: {}", info.stats.user_cycles);
    eprintln!("done. peak memory is reported by scripts/bench.sh via the system time utility.");
}
