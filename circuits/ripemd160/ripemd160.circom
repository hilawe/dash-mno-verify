pragma circom 2.1.6;

// Single-block RIPEMD-160, written from the RIPEMD-160 specification for this repo.
//
// It implements the one case the pipeline needs: a fixed 256-bit input, which is exactly
// one padded 512-bit block. That is the inner call of hash160, RIPEMD160(SHA256(pubkey)).
// Input and output bits are big-endian (bit b of byte i at index 8*i+b, b=0 the MSB),
// matching circomlib's Sha256 output, so it drops straight into CompressAndHash160.
//
// NOT a general-purpose RIPEMD-160 (no multi-block, no variable length). It is validated
// against a known-answer test in test/ripemd160 before any proof is trusted.
include "circomlib/circuits/bitify.circom";

// Rotate a 32-bit value left by s bits (1 <= s <= 31).
template RotL32(s) {
    signal input in;
    signal output out;
    component b = Num2Bits(32);
    b.in <== in;
    component nb = Bits2Num(32);
    for (var i = 0; i < 32; i++) nb.in[i] <== b.out[(i + 32 - s) % 32];
    out <== nb.out;
}

// Low 32 bits of a value known to fit in `width` bits.
template Low32(width) {
    signal input in;
    signal output out;
    component b = Num2Bits(width);
    b.in <== in;
    component nb = Bits2Num(32);
    for (var i = 0; i < 32; i++) nb.in[i] <== b.out[i];
    out <== nb.out;
}

// One RIPEMD-160 step. roundType picks the nonlinear function, s the rotation, K the
// additive constant. Returns T, the new B word: rol_s(A + f(B,C,D) + X + K) + E mod 2^32.
template RipeRound(roundType, s, K) {
    signal input a;
    signal input b;
    signal input c;
    signal input d;
    signal input e;
    signal input x;
    signal output tout;

    component bb = Num2Bits(32); bb.in <== b;
    component cc = Num2Bits(32); cc.in <== c;
    component dd = Num2Bits(32); dd.in <== d;

    signal ftmp[32];
    signal fbit[32];
    for (var i = 0; i < 32; i++) {
        if (roundType == 0) {            // b xor c xor d
            ftmp[i] <== bb.out[i] + cc.out[i] - 2 * bb.out[i] * cc.out[i];
            fbit[i] <== ftmp[i] + dd.out[i] - 2 * ftmp[i] * dd.out[i];
        } else if (roundType == 1) {     // (b and c) or (not b and d) = b ? c : d
            ftmp[i] <== 0;
            fbit[i] <== bb.out[i] * (cc.out[i] - dd.out[i]) + dd.out[i];
        } else if (roundType == 2) {     // (b or not c) xor d
            ftmp[i] <== 1 - cc.out[i] + bb.out[i] * cc.out[i];
            fbit[i] <== ftmp[i] + dd.out[i] - 2 * ftmp[i] * dd.out[i];
        } else if (roundType == 3) {     // (b and d) or (c and not d) = d ? b : c
            ftmp[i] <== 0;
            fbit[i] <== dd.out[i] * (bb.out[i] - cc.out[i]) + cc.out[i];
        } else {                         // b xor (c or not d)
            ftmp[i] <== 1 - dd.out[i] + cc.out[i] * dd.out[i];
            fbit[i] <== bb.out[i] + ftmp[i] - 2 * bb.out[i] * ftmp[i];
        }
    }
    component fval = Bits2Num(32);
    for (var i = 0; i < 32; i++) fval.in[i] <== fbit[i];

    // low32(a + f + x + K) is at most 4 * (2^32 - 1) < 2^34
    component s1low = Low32(34);
    s1low.in <== a + fval.out + x + K;

    component rot = RotL32(s);
    rot.in <== s1low.out;

    // T = rol + e is at most 2 * (2^32 - 1) < 2^33
    component s2low = Low32(33);
    s2low.in <== rot.out + e;
    tout <== s2low.out;
}

template Ripemd160(nBits) {
    assert(nBits == 256);
    signal input in[nBits];
    signal output out[160];

    var nbytes = nBits / 8;     // 32
    var W8[8] = [128, 64, 32, 16, 8, 4, 2, 1];

    // message bytes as values (b = 0 is the MSB of each byte)
    signal mbyte[nbytes];
    signal bacc[nbytes][9];
    for (var i = 0; i < nbytes; i++) {
        bacc[i][0] <== 0;
        for (var bt = 0; bt < 8; bt++)
            bacc[i][bt + 1] <== bacc[i][bt] + in[8 * i + bt] * W8[bt];
        mbyte[i] <== bacc[i][8];
    }

    // 16 little-endian 32-bit words: X[0..7] message, X[8..15] constant padding.
    signal X[16];
    for (var w = 0; w < 8; w++)
        X[w] <== mbyte[4 * w] + mbyte[4 * w + 1] * 256 + mbyte[4 * w + 2] * 65536 + mbyte[4 * w + 3] * 16777216;
    X[8]  <== 128;     // 0x80 padding byte
    X[9]  <== 0; X[10] <== 0; X[11] <== 0; X[12] <== 0; X[13] <== 0;
    X[14] <== 256;     // bit length, little-endian
    X[15] <== 0;

    var RL[80] = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
                  7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
                  3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,
                  1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,
                  4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    var RR[80] = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,
                  6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
                  15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,
                  8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,
                  12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    var SL[80] = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,
                  7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
                  11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,
                  11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,
                  9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    var SR[80] = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,
                  9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
                  9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,
                  15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,
                  8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
    var KL[5] = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
    var KR[5] = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];

    var H0 = 0x67452301; var H1 = 0xEFCDAB89; var H2 = 0x98BADCFE;
    var H3 = 0x10325476; var H4 = 0xC3D2E1F0;

    // left line
    signal al[81]; signal bl[81]; signal cl[81]; signal dl[81]; signal el[81];
    al[0] <== H0; bl[0] <== H1; cl[0] <== H2; dl[0] <== H3; el[0] <== H4;
    component lrnd[80]; component lrot[80];
    for (var j = 0; j < 80; j++) {
        var g = j \ 16;
        lrnd[j] = RipeRound(g, SL[j], KL[g]);
        lrnd[j].a <== al[j]; lrnd[j].b <== bl[j]; lrnd[j].c <== cl[j];
        lrnd[j].d <== dl[j]; lrnd[j].e <== el[j]; lrnd[j].x <== X[RL[j]];
        lrot[j] = RotL32(10); lrot[j].in <== cl[j];
        al[j + 1] <== el[j];
        bl[j + 1] <== lrnd[j].tout;
        cl[j + 1] <== bl[j];
        dl[j + 1] <== lrot[j].out;
        el[j + 1] <== dl[j];
    }

    // right line
    signal ar[81]; signal br[81]; signal cr[81]; signal dr[81]; signal er[81];
    ar[0] <== H0; br[0] <== H1; cr[0] <== H2; dr[0] <== H3; er[0] <== H4;
    component rrnd[80]; component rrot[80];
    for (var j = 0; j < 80; j++) {
        var g = j \ 16;
        var ft = (79 - j) \ 16;
        rrnd[j] = RipeRound(ft, SR[j], KR[g]);
        rrnd[j].a <== ar[j]; rrnd[j].b <== br[j]; rrnd[j].c <== cr[j];
        rrnd[j].d <== dr[j]; rrnd[j].e <== er[j]; rrnd[j].x <== X[RR[j]];
        rrot[j] = RotL32(10); rrot[j].in <== cr[j];
        ar[j + 1] <== er[j];
        br[j + 1] <== rrnd[j].tout;
        cr[j + 1] <== br[j];
        dr[j + 1] <== rrot[j].out;
        er[j + 1] <== dr[j];
    }

    // combine the two lines, each result reduced mod 2^32
    signal hword[5];
    component oc[5];
    oc[0] = Low32(34); oc[0].in <== H1 + cl[80] + dr[80]; hword[0] <== oc[0].out;
    oc[1] = Low32(34); oc[1].in <== H2 + dl[80] + er[80]; hword[1] <== oc[1].out;
    oc[2] = Low32(34); oc[2].in <== H3 + el[80] + ar[80]; hword[2] <== oc[2].out;
    oc[3] = Low32(34); oc[3].in <== H4 + al[80] + br[80]; hword[3] <== oc[3].out;
    oc[4] = Low32(34); oc[4].in <== H0 + bl[80] + cr[80]; hword[4] <== oc[4].out;

    // serialize h0..h4 little-endian bytes, MSB-first bits within each byte
    component hb[5];
    for (var hh = 0; hh < 5; hh++) { hb[hh] = Num2Bits(32); hb[hh].in <== hword[hh]; }
    for (var hh = 0; hh < 5; hh++)
        for (var k = 0; k < 4; k++)
            for (var b = 0; b < 8; b++)
                out[8 * (hh * 4 + k) + b] <== hb[hh].out[8 * k + (7 - b)];
}
