pragma circom 2.1.6;

// Test harness for the RIPEMD-160 circuit. Hashes a 256-bit input and packs the 160-bit
// digest big-endian into one field element, so a witness can be compared to a known
// answer with a single equality. See make_input.mjs for the vector.
include "../../circuits/ripemd160/ripemd160.circom";
include "circomlib/circuits/bitify.circom";

template RipeTest() {
    signal input in[256];
    signal output out;

    component r = Ripemd160(256);
    for (var i = 0; i < 256; i++) r.in[i] <== in[i];

    component pack = Bits2Num(160);
    for (var j = 0; j < 160; j++) pack.in[j] <== r.out[159 - j];
    out <== pack.out;
}

component main = RipeTest();
