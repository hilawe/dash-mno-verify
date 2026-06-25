pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/sha256/sha256.circom";
include "circom-ecdsa/circuits/ecdsa.circom";   // ECDSAPrivToPub(n, k)
include "ripemd160/ripemd160.circom";            // community template, must be vetted

// Poseidon Merkle inclusion, hashing identical to oracle/oracle.js (Poseidon(2) per level).
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

// Compressed pubkey -> hash160, returned as one field element (matches the oracle leaf).
// VALIDATE the bit ordering here against one real vector before trusting any proof:
// take a known voting key, compute its votingAddress with dash-cli, and confirm `out`
// equals BigInt('0x' + hash160hex).
template CompressAndHash160(n, k) {
    signal input x[k];
    signal input y[k];
    signal output out;

    // y parity selects the 0x02 / 0x03 prefix
    component yBits = Num2Bits(n);
    yBits.in <== y[0];
    signal yParity <== yBits.out[0];

    // reassemble x into 256 little-endian bits
    component xBits[k];
    signal xLE[256];
    for (var i = 0; i < k; i++) {
        xBits[i] = Num2Bits(n);
        xBits[i].in <== x[i];
        for (var b = 0; b < n; b++) xLE[i * n + b] <== xBits[i].out[b];
    }

    // 264-bit message, MSB first: prefix byte (0000001 yParity) then x big-endian
    component sha = Sha256(264);
    sha.in[0] <== 0; sha.in[1] <== 0; sha.in[2] <== 0; sha.in[3] <== 0;
    sha.in[4] <== 0; sha.in[5] <== 0; sha.in[6] <== 1; sha.in[7] <== yParity;
    for (var j = 0; j < 256; j++) sha.in[8 + j] <== xLE[255 - j];

    component rmd = Ripemd160(256);
    for (var j = 0; j < 256; j++) rmd.in[j] <== sha.out[j];

    // pack the 160-bit digest big-endian, matching BigInt('0x'+hex) in the oracle
    component pack = Bits2Num(160);
    for (var j = 0; j < 160; j++) pack.in[j] <== rmd.out[159 - j];
    out <== pack.out;
}

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

    // 5) bind the proof to this challenge (Semaphore's signal trick). Forces signalHash
    //    into the constraint system so the proof is non-malleably tied to it.
    signal sq;
    sq <== signalHash * signalHash;
}

component main { public [root, epoch, contextHash, signalHash] } = MnoMembership(16, 64, 4);
