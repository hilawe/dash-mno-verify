pragma circom 2.1.6;

// Test harness for CompressAndHash160. Feeds the secp256k1 coordinates directly (no
// circom-ecdsa needed), so the SHA256, byte assembly, and RIPEMD160 path is validated
// in isolation against the generator vector. See make_input.mjs.
include "../../circuits/hash160/hash160.circom";

template H160Test() {
    signal input x[4];
    signal input y[4];
    signal output out;

    component h = CompressAndHash160(64, 4);
    for (var i = 0; i < 4; i++) { h.x[i] <== x[i]; h.y[i] <== y[i]; }
    out <== h.out;
}

component main = H160Test();
