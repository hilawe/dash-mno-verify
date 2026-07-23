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

// The pinned golden-vector witness for the production (reg) statement: d = 1 (the generator
// key) and secret = 1 in the vectors-crate two-leaf tree, so every journal byte is
// predictable from the circomlibjs-pinned constants.
struct RegWitness {
    d: [u8; 32],
    secret: [u8; 32],
    siblings: Vec<[u8; 32]>,
    bits: Vec<u8>,
    root: [u8; 32],
    season: u64,
    ctx: [u8; 32],
    expected_journal: [u8; 136],
}

fn reg_witness() -> RegWitness {
    use vectors::{golden, leaf_hash, node_hash};
    let g = golden();
    // The witness reproduces the fixture's golden case: d = 1, secret = 1, season and context
    // from the fixture, the generator leaf at index 0 in the two-leaf tree.
    let mut d = [0u8; 32];
    d[31] = 1;
    let mut secret = [0u8; 32];
    secret[31] = 1;
    let season: u64 = g.season.parse().expect("fixture season is a u64");
    let ctx = vectors::dec_to_be32(&g.context_hash);

    let gen_keyid: [u8; 20] = hex::decode(&g.gen_keyid_hex)
        .expect("pinned keyid hex")
        .try_into()
        .expect("keyid is 20 bytes");
    let mut empty = vec![leaf_hash(&[0u8; 20])];
    for i in 1..=TREE_DEPTH {
        let prev = empty[i - 1];
        empty.push(node_hash(&prev, &prev));
    }
    let mut siblings: Vec<[u8; 32]> = vec![leaf_hash(&[0x02u8; 20])];
    siblings.extend(empty.iter().take(TREE_DEPTH).skip(1));
    let bits = vec![0u8; TREE_DEPTH];
    let mut node = leaf_hash(&gen_keyid);
    for sib in siblings.iter() {
        node = node_hash(&node, sib);
    }
    let root = node;
    assert_eq!(hex::encode(root), g.root_two_leaves_hex, "host tree must match the fixture root");

    // The expected journal is the fixture's journal literal, which the JavaScript reference
    // built with independent field encoding. Comparing the guest journal against THIS (not
    // against host-serialized bytes) is what proves the guest agrees with the JS gateway
    // decoder, per the review finding.
    let expected_journal: [u8; 136] = hex::decode(&g.journal_left_hex)
        .expect("fixture journal hex")
        .try_into()
        .expect("journal is 136 bytes");

    RegWitness { d, secret, siblings, bits, root, season, ctx, expected_journal }
}

// Optional segment-size override (MNO_SEGMENT_PO2). Prover peak memory tracks the segment
// size, so forcing smaller segments trades proportionally more segments (time) for a lower
// memory ceiling. Phase 0 ran everything at the default; this knob is the experiment that
// checks whether the 9.6 GB tier was an artifact of the default segment size.
fn apply_segment_po2(b: &mut risc0_zkvm::ExecutorEnvBuilder<'_>) {
    if let Ok(v) = std::env::var("MNO_SEGMENT_PO2") {
        let po2: u32 = v.parse().expect("MNO_SEGMENT_PO2 must be an integer");
        eprintln!("[env] segment_limit_po2 forced to {po2}");
        b.segment_limit_po2(po2);
    }
}

fn reg_env(w: &RegWitness) -> risc0_zkvm::ExecutorEnv<'_> {
    let mut b = ExecutorEnv::builder();
    apply_segment_po2(&mut b);
    b.write(&w.d).unwrap()
        .write(&w.secret).unwrap()
        .write(&w.siblings).unwrap()
        .write(&w.bits).unwrap()
        .write(&w.root).unwrap()
        .write(&w.season).unwrap()
        .write(&w.ctx).unwrap()
        .build()
        .unwrap()
}

// A raw witness for the executor-only guest checks, so a malformed field can be injected
// that the typed RegWitness cannot express (a bad path bit, a wrong path length, a
// non-canonical field element). Executor-only, so each case runs in well under a second,
// unlike a full prove.
struct RawReg {
    d: [u8; 32],
    secret: [u8; 32],
    siblings: Vec<[u8; 32]>,
    bits: Vec<u8>,
    root: [u8; 32],
    season: u64,
    ctx: [u8; 32],
}

fn raw_env(w: &RawReg) -> risc0_zkvm::ExecutorEnv<'_> {
    ExecutorEnv::builder()
        .write(&w.d).unwrap()
        .write(&w.secret).unwrap()
        .write(&w.siblings).unwrap()
        .write(&w.bits).unwrap()
        .write(&w.root).unwrap()
        .write(&w.season).unwrap()
        .write(&w.ctx).unwrap()
        .build()
        .unwrap()
}

// Run the guest under the executor (no proof) and return the committed journal bytes if it
// completed, or None if a guest assertion aborted execution (a rejected witness). Returning
// the journal, not just a bool, lets an accepted case assert the journal is CORRECT, not
// merely that execution succeeded (review finding: a bool-only check passes a guest that
// runs but commits the wrong root, season, or context).
fn guest_journal(elf: &[u8], w: &RawReg) -> Option<Vec<u8>> {
    match risc0_zkvm::default_executor().execute(raw_env(w), elf) {
        Ok(session) => Some(session.journal.bytes),
        Err(_) => None,
    }
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
            let mut b = ExecutorEnv::builder();
            apply_segment_po2(&mut b);
            let env = b
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
        "reg" => {
            // Guest v2, the production five-claim statement (docs/ZKVM_INTEGRATION.md, work-plan
            // step 2), on the pinned golden-vector witness, so the whole 136-byte journal is
            // asserted and the cross-implementation check rides along with the measurement. The
            // verified receipt is also written to disk, so the `verify` mode can time the
            // unwrapped candidate's gateway-side cost on a real receipt.
            use methods::{REGISTRATION_REG_ELF, REGISTRATION_REG_ID};
            let w = reg_witness();
            let env = reg_env(&w);
            eprintln!("[reg] proving (tree depth {TREE_DEPTH}) ...");
            let start = Instant::now();
            let info = default_prover().prove(env, REGISTRATION_REG_ELF).expect("proving failed");
            let elapsed = start.elapsed();
            info.receipt.verify(REGISTRATION_REG_ID).expect("receipt failed to verify");
            assert_eq!(
                info.receipt.journal.bytes, w.expected_journal,
                "journal must equal the circomlibjs-pinned 136-byte expected set"
            );
            eprintln!("[reg] journal matches the circomlibjs-pinned expected bytes");
            let bytes = bincode::serialize(&info.receipt).expect("receipt serialization");
            std::fs::write("receipt_reg.bin", &bytes).expect("writing receipt_reg.bin");
            eprintln!("[reg] receipt written to receipt_reg.bin ({} bytes)", bytes.len());
            report("reg", REGISTRATION_REG_ELF, &info, elapsed);
        }
        "wrap" => {
            // Work-plan step 3, the wrapped-receipt candidate: the same reg statement proved
            // with the STARK-to-SNARK wrap (Groth16 over BN254). Needs docker, which is how
            // RISC Zero runs its Groth16 prover locally, itself a data point: the member's
            // machine needs docker too on this path. Reports combined prove-and-wrap time,
            // receipt and seal sizes, repeated verification timings for the wrapped receipt,
            // and dumps the seal, journal, and claim digest as hex for the Node-side
            // verification experiment.
            use methods::{REGISTRATION_REG_ELF, REGISTRATION_REG_ID};
            use risc0_zkvm::sha::Digestible;
            use risc0_zkvm::ProverOpts;
            let w = reg_witness();
            let env = reg_env(&w);
            eprintln!("[wrap] proving with the Groth16 wrap (docker required) ...");
            let start = Instant::now();
            let info = default_prover()
                .prove_with_opts(env, REGISTRATION_REG_ELF, &ProverOpts::groth16())
                .expect("groth16 proving failed");
            let elapsed = start.elapsed();
            info.receipt.verify(REGISTRATION_REG_ID).expect("wrapped receipt failed to verify");
            assert_eq!(
                info.receipt.journal.bytes, w.expected_journal,
                "journal must equal the circomlibjs-pinned 136-byte expected set"
            );
            let g = info.receipt.inner.groth16().expect("receipt is not groth16");
            println!("[wrap] seal_bytes: {}", g.seal.len());
            println!("[wrap] claim_digest: {}", hex::encode(g.claim.digest().as_bytes()));
            let vstart = Instant::now();
            for _ in 0..10 {
                info.receipt.verify(REGISTRATION_REG_ID).expect("re-verify failed");
            }
            println!(
                "[wrap] verify_ms_avg_of_10: {:.2}",
                vstart.elapsed().as_secs_f64() * 100.0
            );
            std::fs::write("wrap_seal.hex", hex::encode(&g.seal)).expect("writing seal");
            std::fs::write("wrap_journal.hex", hex::encode(&info.receipt.journal.bytes))
                .expect("writing journal");
            let wbytes = bincode::serialize(&info.receipt).expect("wrap receipt serialization");
            std::fs::write("wrap_receipt.bin", &wbytes).expect("writing wrap_receipt.bin");
            eprintln!("[wrap] seal, journal, and receipt written for the Node-side step");
            report("wrap", REGISTRATION_REG_ELF, &info, elapsed);
        }
        "check" => {
            // Executor-only soundness checks for the production guest, the coverage the
            // design promised (docs/ZKVM_INTEGRATION.md): the pinned witness executes, a
            // valid right-hand path executes, and every malformed or out-of-range witness
            // is rejected. No proving, so the whole set runs in seconds. A CI gate.
            use methods::REGISTRATION_REG_ELF;
            use vectors::golden;
            let elf = REGISTRATION_REG_ELF;
            let g = golden();

            // secp256k1 order n and the empty-leaf value, big-endian.
            let n: [u8; 32] =
                hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
                    .unwrap()
                    .try_into()
                    .unwrap();
            let mut n_plus_1 = n;
            n_plus_1[31] = n_plus_1[31].wrapping_add(1);
            // A field element one above the BN254 modulus is non-canonical: p in big-endian.
            let p_be: [u8; 32] =
                hex::decode("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")
                    .unwrap()
                    .try_into()
                    .unwrap();

            let base = reg_witness();
            let valid_left = RawReg {
                d: base.d,
                secret: base.secret,
                siblings: base.siblings.clone(),
                bits: base.bits.clone(),
                root: base.root,
                season: base.season,
                ctx: base.ctx,
            };

            // The fully-varied valid witness (fixture "varied"): d = n-2, a nontrivial secret,
            // a season above 2^32, a different context, and the generator... no, its own keyID
            // at index 1 (right child) with a 0x03 sibling leaf. Its journal differs in every
            // field from the base case, so validating it against the JS-authored journal
            // catches a guest that ignores upper key bits or hardcodes season, context, or root.
            let varied = {
                use vectors::{leaf_hash, node_hash};
                let dv: [u8; 32] = hex::decode(&g.varied.d_hex).unwrap().try_into().unwrap();
                let keyid: [u8; 20] = hex::decode(&g.varied.keyid_hex).unwrap().try_into().unwrap();
                let sib0: [u8; 32] = hex::decode(&g.varied.sibling0_hex).unwrap().try_into().unwrap();
                let secret = vectors::dec_to_be32(&g.varied.secret);
                let ctx = vectors::dec_to_be32(&g.varied.context_hash);
                let season: u64 = g.varied.season.parse().unwrap();
                let mut empty = vec![leaf_hash(&[0u8; 20])];
                for i in 1..=TREE_DEPTH {
                    let prev = empty[i - 1];
                    empty.push(node_hash(&prev, &prev));
                }
                let mut siblings: Vec<[u8; 32]> = vec![sib0];
                siblings.extend(empty.iter().take(TREE_DEPTH).skip(1));
                let mut bits = vec![0u8; TREE_DEPTH];
                bits[0] = 1;
                let mut node = node_hash(&sib0, &leaf_hash(&keyid));
                for sib in siblings.iter().take(TREE_DEPTH).skip(1) {
                    node = node_hash(&node, sib);
                }
                assert_eq!(hex::encode(node), g.varied.root_hex, "varied host tree must match fixture");
                RawReg { d: dv, secret, siblings, bits, root: node, season, ctx }
            };

            let bad = |mutate: &dyn Fn(&mut RawReg)| {
                let mut w = RawReg {
                    d: base.d,
                    secret: base.secret,
                    siblings: base.siblings.clone(),
                    bits: base.bits.clone(),
                    root: base.root,
                    season: base.season,
                    ctx: base.ctx,
                };
                mutate(&mut w);
                w
            };

            let left_journal = hex::decode(&g.journal_left_hex).unwrap();
            let varied_journal = hex::decode(&g.varied.journal_hex).unwrap();

            // Each case: name, witness, and either the exact expected journal (accept) or None
            // (reject). An accepted case must produce EXACTLY that journal, not merely execute.
            let cases: Vec<(&str, RawReg, Option<Vec<u8>>)> = vec![
                ("pinned-left-path", valid_left, Some(left_journal)),
                ("fully-varied-right-path", varied, Some(varied_journal)),
                ("d = 0", bad(&|w| w.d = [0u8; 32]), None),
                ("d = n", bad(&|w| w.d = n), None),
                ("d = n + 1", bad(&|w| w.d = n_plus_1), None),
                ("non-canonical secret (p)", bad(&|w| w.secret = p_be), None),
                ("non-canonical contextHash (p)", bad(&|w| w.ctx = p_be), None),
                ("path bit = 2", bad(&|w| w.bits[0] = 2), None),
                ("short siblings only", bad(&|w| { w.siblings.pop(); }), None),
                ("short bits only", bad(&|w| { w.bits.pop(); }), None),
                ("extra sibling", bad(&|w| { w.siblings.push([0u8; 32]); w.bits.push(0); }), None),
                ("wrong root", bad(&|w| w.root[0] ^= 0xff), None),
            ];

            let mut failures = 0;
            for (name, w, want_journal) in &cases {
                let got = guest_journal(elf, w);
                let pass = match (want_journal, &got) {
                    // accept: must execute AND commit exactly the expected journal
                    (Some(exp), Some(j)) => j == exp,
                    // accept expected but rejected, or a wrong journal committed
                    (Some(_), None) => false,
                    // reject expected: must NOT execute
                    (None, None) => true,
                    (None, Some(_)) => false,
                };
                if !pass {
                    failures += 1;
                }
                let outcome = match &got {
                    Some(j) if want_journal.as_ref() == Some(j) => "accept+journal-ok".to_string(),
                    Some(_) => "accept (journal MISMATCH)".to_string(),
                    None => "reject".to_string(),
                };
                println!(
                    "[check] {:<28} expect {:<20} got {:<26} {}",
                    name,
                    if want_journal.is_some() { "accept+journal" } else { "reject" },
                    outcome,
                    if pass { "ok" } else { "FAIL" }
                );
            }
            if failures > 0 {
                eprintln!("[check] {failures} case(s) failed");
                std::process::exit(1);
            }
            eprintln!("[check] all {} guest soundness cases passed", cases.len());
        }
        "verify" => {
            // Work-plan step 3, the unwrapped candidate's gateway-side cost: read the receipt
            // the reg mode wrote and time repeated verifications, which is what a gateway
            // sidecar would do per registration.
            // It also prints image_id and journal_hex so the Node harness
            // (scripts/verify_receipt.mjs) can drive it as the gateway verifier and confirm
            // the image-id binding by rejecting a wrong id.
            // Args: verify <receipt-path> [expect-image-id-hex] [--repeat N]
            // By default it verifies ONCE and reports single-request latency, the real
            // gateway per-request cost. --repeat N averages N for a stable microbenchmark
            // (review finding: a fixed 10x loop conflated the two). It also flips a journal
            // byte and confirms verification rejects the tampered receipt, the binding check.
            use methods::REGISTRATION_REG_ID;
            use risc0_zkvm::sha::Digest;
            let args: Vec<String> = std::env::args().collect();
            let path = args.get(2).cloned().unwrap_or_else(|| "receipt_reg.bin".to_string());
            let expect_id = args.get(3).filter(|a| !a.starts_with("--")).cloned();
            let repeat: u32 = args
                .iter()
                .position(|a| a == "--repeat")
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            let bytes = std::fs::read(&path).expect("reading the receipt file (run 'reg' first)");
            let receipt: risc0_zkvm::Receipt =
                bincode::deserialize(&bytes).expect("receipt deserialization");
            let image_id_hex = hex::encode(Digest::from(REGISTRATION_REG_ID).as_bytes());
            if let Some(want) = &expect_id {
                if *want != image_id_hex {
                    eprintln!("[verify] image id mismatch: want {want}, have {image_id_hex}");
                    std::process::exit(1);
                }
            }
            println!("[verify] receipt_bytes: {}", bytes.len());
            println!("[verify] image_id: {image_id_hex}");
            // Single-request latency (repeat=1 by default), the gateway's real per-request cost.
            let start = Instant::now();
            for _ in 0..repeat {
                receipt.verify(REGISTRATION_REG_ID).expect("verification failed");
            }
            let per = start.elapsed().as_secs_f64() * 1000.0 / (repeat as f64);
            println!("[verify] verify_ms_single: {per:.2} (avg of {repeat})");
            println!("[verify] journal_hex: {}", hex::encode(&receipt.journal.bytes));

            // Binding check: a tampered journal must fail verification, because the journal is
            // part of the receipt claim. Flip one byte on a clone and confirm rejection.
            let mut tampered = receipt.clone();
            tampered.journal.bytes[0] ^= 0xff;
            match tampered.verify(REGISTRATION_REG_ID) {
                Ok(_) => {
                    eprintln!("[verify] SECURITY: tampered journal verified, receipt is not bound");
                    std::process::exit(1);
                }
                Err(_) => println!("[verify] rejects_tampered_journal: true"),
            }
        }
        other => {
            eprintln!("unknown mode '{other}', use 'derive', 'sig', 'rec', 'reg', 'check', 'wrap', or 'verify'");
            std::process::exit(2);
        }
    }
    eprintln!("done. peak memory is reported externally via the system time utility.");
}
