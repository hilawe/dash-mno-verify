pragma circom 2.1.6;

// TWO-TIER OPTIMIZATION PATH, tier 1 of 2. Not wired into the default build.
//
// Use the two-tier path only if a compiled single-tier proof (mno_membership.circom) is
// too slow to run every epoch. This registration proof does the expensive secp256k1 and
// hash160 work ONCE per season. It proves the prover controls some masternode, emits a
// fresh member commitment to add to a members tree, and emits a registration nullifier
// so one masternode registers only once per season and context. The proof itself reveals
// nothing about which node registered.
//
// Trade-off: because member commitments are unlinkable to nodes, a sold node cannot be
// revoked individually. Membership re-anchors to current ownership only at each season
// boundary. See docs/DESIGN.md.
include "circomlib/circuits/poseidon.circom";
include "circom-ecdsa/circuits/ecdsa.circom";   // ECDSAPrivToPub(n, k)
include "circom-ecdsa/circuits/bigint.circom";  // BigLessThan(n, k)
include "./hash160/hash160.circom";              // CompressAndHash160
include "./merkle.circom";                       // MerkleInclusion

template MnoRegistration(treeDepth, n, k) {
    // private witness
    signal input privkey[k];               // voting private key, circom-ecdsa limb layout
    signal input pathElements[treeDepth];  // path in the DML tree
    signal input pathIndices[treeDepth];
    signal input secret;                   // fresh high-entropy member secret, kept by the user

    // public inputs
    signal input root;                     // current DML root from the oracle
    signal input season;
    signal input contextHash;              // scopes registration to one community and role

    // public outputs
    signal output commitment;              // appended to the members tree
    signal output regNullifier;            // one registration per node per (season, context)

    // prove DML membership, same as single-tier minus the per-epoch nullifier
    component p2p = ECDSAPrivToPub(n, k);
    for (var i = 0; i < k; i++) p2p.privkey[i] <== privkey[i];

    component lh = CompressAndHash160(n, k);
    for (var i = 0; i < k; i++) { lh.x[i] <== p2p.pubkey[0][i]; lh.y[i] <== p2p.pubkey[1][i]; }

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

    // constrain the private key d below the secp256k1 group order n, so it is the canonical scalar
    // in [0, n). Without this, d and d + n give the same public key (the same DML leaf) but a
    // different Poseidon(privkey), letting one node register twice per (season, context) with two
    // non-colliding registration nullifiers (review finding M1). The nullifier stays derived from
    // the private key, NOT the public hash160 leaf, so it remains unlinkable to the published leaves.
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

component main { public [root, season, contextHash] } = MnoRegistration(16, 64, 4);
