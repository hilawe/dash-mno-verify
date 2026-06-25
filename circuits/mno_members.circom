pragma circom 2.1.6;

// TWO-TIER OPTIMIZATION PATH, tier 2 of 2. Not wired into the default build.
//
// The cheap recurring proof. After a one-time registration (mno_registration.circom)
// added the member commitment to the members tree, this runs every epoch. It is a
// Poseidon-only membership proof with no secp256k1 and no hash160, so it is fast enough
// to run in a browser. It proves the prover knows the secret behind a commitment in the
// members tree, and emits the epoch-rotating nullifier.
include "circomlib/circuits/poseidon.circom";
include "./merkle.circom";

template MnoMembers(treeDepth) {
    // private witness
    signal input secret;                   // the member secret chosen at registration
    signal input pathElements[treeDepth];  // path in the members tree
    signal input pathIndices[treeDepth];

    // public inputs
    signal input membersRoot;
    signal input epoch;
    signal input contextHash;
    signal input signalHash;               // bound to the per-request challenge nonce

    // public output
    signal output nullifier;

    // commitment = Poseidon(secret), the leaf added at registration
    component c = Poseidon(1);
    c.inputs[0] <== secret;

    component incl = MerkleInclusion(treeDepth);
    incl.leaf <== c.out;
    for (var i = 0; i < treeDepth; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i]  <== pathIndices[i];
    }
    incl.root === membersRoot;

    // nullifier = Poseidon(secret, epoch, contextHash)
    component nf = Poseidon(3);
    nf.inputs[0] <== secret;
    nf.inputs[1] <== epoch;
    nf.inputs[2] <== contextHash;
    nullifier <== nf.out;

    // bind the proof to this challenge (Semaphore's signal trick)
    signal sq;
    sq <== signalHash * signalHash;
}

component main { public [membersRoot, epoch, contextHash, signalHash] } = MnoMembers(16);
