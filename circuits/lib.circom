pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/sha256/sha256.circom";
include "circom-ecdsa/circuits/ecdsa.circom";   // ECDSAPrivToPub(n, k)
include "ripemd160/ripemd160.circom";            // community template, must be vetted
include "./merkle.circom";

// Compressed pubkey -> hash160, returned as one field element (matches the oracle leaf
// and common/dml.js leafFromPubkey, which is pinned by test/hash160.test.js).
//
// VALIDATE the bit ordering against one real vector before trusting any proof: the
// generator key 0279be66...f81798 must hash to 0x751e76e8199196d454941c45d1b3a323f1433bd6.
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

    // pack the 160-bit digest big-endian, matching BigInt('0x'+hex)
    component pack = Bits2Num(160);
    for (var j = 0; j < 160; j++) pack.in[j] <== rmd.out[159 - j];
    out <== pack.out;
}
