pragma circom 2.1.6;

// Single-tier mno_membership with the ECDSA scalar multiplication removed and the public key supplied
// as an input, which is the trusted-function decomposition of ECDSAPrivToPub done as a small circuit.
// Ecne solves this in minutes (about a two-minute read and a twelve-minute solve on the 12 GiB VM)
// and checks that every retained component of the single-tier path uniquely determines its output: the
// M1 canonical-scalar bound, hash160, the Merkle inclusion, the privkey-derived nullifier, and the
// Semaphore signal binding. It mirrors steps 2 through 6 of circuits/mno_membership.circom verbatim,
// at the same (treeDepth, n, k) = (16, 64, 4). Step 1 (Q = privkey * G) is replaced by the trusted
// pubkey input PLUS the per-limb Num2Bits range checks ECDSAPrivToPub applies to privkey internally
// (its n2b loop), so the privkey constraint environment here matches the production circuit's and the
// only thing removed is the scalar multiplication itself. That isolates the residual determinism
// question to exactly ECDSAPrivToPub, the one component the audit-scope document already names.
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";             // Num2Bits(n)
include "circom-ecdsa/circuits/bigint.circom";          // BigLessThan(n, k)
include "circom-ecdsa/circuits/secp256k1_func.circom";  // get_secp256k1_order(n, k)
include "../../../../circuits/hash160/hash160.circom";  // CompressAndHash160(n, k)
include "../../../../circuits/merkle.circom";           // MerkleInclusion(depth)

template MnoMembershipNoEcdsa(treeDepth, n, k) {
    // private witness
    signal input privkey[k];               // voting private key, circom-ecdsa limb layout
    signal input pubkey[2][k];             // trusted output of ECDSAPrivToPub(n, k): [x limbs, y limbs]
    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];

    // public inputs
    signal input root;
    signal input epoch;
    signal input contextHash;
    signal input signalHash;

    // public output
    signal output nullifier;

    // 1', in place of Q = privkey * G: the per-limb range checks ECDSAPrivToPub applies to privkey
    // internally (component n2b in circom-ecdsa's ecdsa.circom), reproduced so removing the component
    // does not also remove them. BigLessThan alone does not range-bound its inputs.
    component n2b[k];
    for (var i = 0; i < k; i++) {
        n2b[i] = Num2Bits(n);
        n2b[i].in <== privkey[i];
    }

    // 2) leaf = RIPEMD160(SHA256(compressed Q)), Q taken as the trusted pubkey input
    component lh = CompressAndHash160(n, k);
    for (var i = 0; i < k; i++) { lh.x[i] <== pubkey[0][i]; lh.y[i] <== pubkey[1][i]; }

    // 3) membership against the published root
    component incl = MerkleInclusion(treeDepth);
    incl.leaf <== lh.out;
    for (var i = 0; i < treeDepth; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i]  <== pathIndices[i];
    }
    incl.root === root;

    // 4) constrain the private key below the secp256k1 group order (review finding M1)
    var order[100] = get_secp256k1_order(n, k);
    component dlt = BigLessThan(n, k);
    for (var i = 0; i < k; i++) { dlt.a[i] <== privkey[i]; dlt.b[i] <== order[i]; }
    dlt.out === 1;

    // 5) nullifier = Poseidon( Poseidon(privkey), epoch, contextHash )
    component kh = Poseidon(k);
    for (var i = 0; i < k; i++) kh.inputs[i] <== privkey[i];
    component nf = Poseidon(3);
    nf.inputs[0] <== kh.out;
    nf.inputs[1] <== epoch;
    nf.inputs[2] <== contextHash;
    nullifier <== nf.out;

    // 6) bind the proof to this challenge (Semaphore's signal trick)
    signal sq;
    sq <== signalHash * signalHash;
}

component main { public [root, epoch, contextHash, signalHash] } = MnoMembershipNoEcdsa(16, 64, 4);
