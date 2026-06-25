pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// Poseidon Merkle inclusion, hashing identical to oracle/oracle.js (Poseidon(2) per
// level). Shared by every circuit in this repo so the tree hashing can never drift.
template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];   // 0 = current node is left child, 1 = right child
    signal output root;

    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    component h[depth];

    cur[0] <== leaf;
    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;                  // boolean
        left[i]  <== cur[i]          + pathIndices[i] * (pathElements[i] - cur[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (cur[i] - pathElements[i]);
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}
