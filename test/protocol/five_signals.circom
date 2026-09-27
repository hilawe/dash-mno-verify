pragma circom 2.1.6;

// A tiny circuit with the registration circuit's public-signal shape, two outputs then three public
// inputs (commitment, regNullifier, root, season, contextHash), for test/proof_protocol.test.js. It lets
// a real proof pass the registration policy checks, so a test can show which guard refuses it. No
// security meaning.
template FiveSignals() {
    signal input x;
    signal input root;
    signal input season;
    signal input contextHash;
    signal output commitment;
    signal output regNullifier;
    commitment <== x * x;
    regNullifier <== x * root;
}

component main { public [root, season, contextHash] } = FiveSignals();
