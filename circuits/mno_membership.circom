pragma circom 2.1.6;

// Single-tier membership proof. The full proof runs every epoch. This is the simplest
// correct design, and a sold node is evicted within one epoch. If per-epoch proving is
// too slow, see mno_registration.circom and mno_members.circom for the two-tier path.
include "circomlib/circuits/poseidon.circom";
include "circom-ecdsa/circuits/ecdsa.circom";   // ECDSAPrivToPub(n, k)
include "./hash160/hash160.circom";              // CompressAndHash160
include "./merkle.circom";                       // MerkleInclusion

template MnoMembership(treeDepth, n, k) {
    // private witness
    signal input privkey[k];               // voting private key, circom-ecdsa limb layout
    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];

    // public inputs
    signal input root;                     // current DML root from the oracle
    signal input epoch;
    signal input contextHash;              // hash("dash-mno-verify:v1:platform:community:role")
    signal input signalHash;               // bound to the per-request challenge nonce

    // public output
    signal output nullifier;

    // 1) Q = privkey * G
    component p2p = ECDSAPrivToPub(n, k);
    for (var i = 0; i < k; i++) p2p.privkey[i] <== privkey[i];

    // 2) leaf = RIPEMD160(SHA256(compressed Q))
    component lh = CompressAndHash160(n, k);
    for (var i = 0; i < k; i++) { lh.x[i] <== p2p.pubkey[0][i]; lh.y[i] <== p2p.pubkey[1][i]; }

    // 3) membership against the published root
    component incl = MerkleInclusion(treeDepth);
    incl.leaf <== lh.out;
    for (var i = 0; i < treeDepth; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i]  <== pathIndices[i];
    }
    incl.root === root;

    // 4) nullifier = Poseidon( Poseidon(privkey), epoch, contextHash )
    component kh = Poseidon(k);
    for (var i = 0; i < k; i++) kh.inputs[i] <== privkey[i];
    component nf = Poseidon(3);
    nf.inputs[0] <== kh.out;
    nf.inputs[1] <== epoch;
    nf.inputs[2] <== contextHash;
    nullifier <== nf.out;

    // 5) bind the proof to this challenge (Semaphore's signal trick)
    signal sq;
    sq <== signalHash * signalHash;
}

component main { public [root, epoch, contextHash, signalHash] } = MnoMembership(16, 64, 4);
