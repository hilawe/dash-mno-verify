# Circuit build

`mno_membership.circom` proves knowledge of a voting private key whose `hash160`
is a leaf in the published DML Merkle root, and emits an epoch-rotating nullifier.

## Dependencies

The circuit pulls in three external sources. Install them under a path your Circom
include flags can see (`-l`).

1. `circomlib` (Poseidon, SHA-256, bitify). Well established.
2. `circom-ecdsa` from 0xPARC (secp256k1, the `ECDSAPrivToPub` template). Well established.
3. A RIPEMD160 Circom template. This is the one piece not from a well-worn library. Source it and test it before trusting any output.

## Two things to validate before trusting a proof

1. Bit ordering in `CompressAndHash160`. The limb and bit endianness of circom-ecdsa, the SHA-256 output order in circomlib, and the RIPEMD160 output order all have to line up. Validate against one real vector: take a test voting key, compute its `votingAddress` with `dash-cli`, and confirm the template output equals `BigInt('0x' + hash160hex)`. If that single vector passes, the assembly is correct.
2. Public-signal order. snarkjs orders public signals as the circuit's public outputs first, then its public inputs in declaration order. For this circuit that is `[nullifier, root, epoch, contextHash, signalHash]`. Confirm against the generated `public.json` and keep `core/verifier.js` in sync.

## Compile and set up

The example below uses Groth16. For a community tool, prefer a transparent setup
(PLONK or halo2) over Groth16 so there is no per-circuit toxic-waste ceremony to run.

```bash
circom mno_membership.circom --r1cs --wasm --sym -o build -l <path-to-includes>

# Groth16 example (universal SRS from the public Powers of Tau, then per-circuit keys)
snarkjs groth16 setup build/mno_membership.r1cs pot_final.ptau build/circuit_0.zkey
snarkjs zkey contribute build/circuit_0.zkey build/circuit_final.zkey -e="text"
snarkjs zkey export verificationkey build/circuit_final.zkey build/verification_key.json
```

The gateway reads `build/verification_key.json`. The prover reads
`build/mno_membership_js/mno_membership.wasm` and `build/circuit_final.zkey`.

## Cost note

`ECDSAPrivToPub` dominates the constraint count. SHA-256 over one block and RIPEMD160
add tens of thousands each. The depth-16 Poseidon Merkle and the nullifier hashes are
negligible. If per-epoch proving turns out too slow, move the secp256k1 and hash160 work
into a one-time registration circuit and keep a cheap Poseidon-only members tree for the
recurring proof. That is the two-tier design described in `docs/DESIGN.md`.
