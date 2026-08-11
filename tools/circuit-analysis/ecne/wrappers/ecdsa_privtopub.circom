pragma circom 2.1.6;
// The circom-ecdsa private-to-public component in isolation, at the same parameters mno_membership and
// mno_registration instantiate it (n=64, k=4). Compiled to R1CS and passed to Ecne as a TRUSTED function
// so Ecne verifies the REST of those circuits (the hash160, Merkle, Poseidon, and signal binding around
// this component) without having to solve the large secp256k1 scalar multiplication, which isolates the
// residual soundness question to exactly this well-known dependency.
include "circom-ecdsa/circuits/ecdsa.circom";
component main = ECDSAPrivToPub(64, 4);
