pragma circom 2.1.6;

// Two-tier mno_registration with the ECDSA scalar multiplication removed and the public key supplied
// as an input, the same trusted-function decomposition as mno_membership_nonecdsa.circom. Ecne solves
// this in minutes and checks that every retained component of the registration path uniquely
// determines both outputs: the M1 canonical-scalar bound, hash160, the Merkle inclusion, the
// secret-derived member commitment, and the privkey-derived registration nullifier. It mirrors the
// body of circuits/mno_registration.circom verbatim, at the same (treeDepth, n, k) = (16, 64, 4).
// The ECDSAPrivToPub call is replaced by the trusted pubkey input PLUS the per-limb Num2Bits range
// checks that component applies to privkey internally (its n2b loop), so the privkey constraint
// environment here matches the production circuit's and the only thing removed is the scalar
// multiplication itself. That isolates the residual determinism question to exactly ECDSAPrivToPub,
// the one component the audit-scope document already names.
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";             // Num2Bits(n)
include "circom-ecdsa/circuits/bigint.circom";          // BigLessThan(n, k)
include "circom-ecdsa/circuits/secp256k1_func.circom";  // get_secp256k1_order(n, k)
include "../../../../circuits/hash160/hash160.circom";  // CompressAndHash160(n, k)
include "../../../../circuits/merkle.circom";           // MerkleInclusion(depth)

template MnoRegistrationNoEcdsa(treeDepth, n, k) {
    // private witness
    signal input privkey[k];               // voting private key, circom-ecdsa limb layout
    signal input pubkey[2][k];             // trusted output of ECDSAPrivToPub(n, k): [x limbs, y limbs]
    signal input pathElements[treeDepth];
    signal input pathIndices[treeDepth];
    signal input secret;                   // fresh high-entropy member secret, kept by the user

    // public inputs
    signal input root;
    signal input season;
    signal input contextHash;

    // public outputs
    signal output commitment;
    signal output regNullifier;

    // in place of Q = privkey * G: the per-limb range checks ECDSAPrivToPub applies to privkey
    // internally (component n2b in circom-ecdsa's ecdsa.circom), reproduced so removing the component
    // does not also remove them. BigLessThan alone does not range-bound its inputs.
    component n2b[k];
    for (var i = 0; i < k; i++) {
        n2b[i] = Num2Bits(n);
        n2b[i].in <== privkey[i];
    }

    // leaf = RIPEMD160(SHA256(compressed Q)), Q taken as the trusted pubkey input
    component lh = CompressAndHash160(n, k);
    for (var i = 0; i < k; i++) { lh.x[i] <== pubkey[0][i]; lh.y[i] <== pubkey[1][i]; }

    // membership against the published root
    component incl = MerkleInclusion(treeDepth);
    incl.leaf <== lh.out;
    for (var i = 0; i < treeDepth; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i]  <== pathIndices[i];
    }
    incl.root === root;

    // member commitment, hiding because secret is high-entropy
    component c = Poseidon(1);
    c.inputs[0] <== secret;
    commitment <== c.out;

    // constrain the private key below the secp256k1 group order (review finding M1)
    var order[100] = get_secp256k1_order(n, k);
    component dlt = BigLessThan(n, k);
    for (var i = 0; i < k; i++) { dlt.a[i] <== privkey[i]; dlt.b[i] <== order[i]; }
    dlt.out === 1;

    // registration nullifier tied to the voting key
    component kh = Poseidon(k);
    for (var i = 0; i < k; i++) kh.inputs[i] <== privkey[i];
    component rn = Poseidon(3);
    rn.inputs[0] <== kh.out;
    rn.inputs[1] <== season;
    rn.inputs[2] <== contextHash;
    regNullifier <== rn.out;
}

component main { public [root, season, contextHash] } = MnoRegistrationNoEcdsa(16, 64, 4);
