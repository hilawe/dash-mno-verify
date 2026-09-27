pragma circom 2.1.6;

// A one-constraint circuit for the proof-system dispatch tests (test/proof_protocol.test.js). It has
// no security meaning. make_vectors.sh proves it under both Groth16 and PLONK so the verifier's
// protocol handling can be tested on real proofs without the heavy circuits.
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = Multiplier();
