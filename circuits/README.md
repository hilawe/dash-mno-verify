# Circuit build

`mno_membership.circom` proves knowledge of a voting private key whose `hash160`
is a leaf in the published DML Merkle root, and emits an epoch-rotating nullifier.

## Files

- `merkle.circom` the Poseidon Merkle inclusion template, shared by every circuit so the tree hashing cannot drift.
- `ripemd160/ripemd160.circom` a single-block RIPEMD-160 written from the spec for this repo, validated against a known answer (see Validation below).
- `hash160/hash160.circom` the `CompressAndHash160` template (compressed pubkey to hash160), built on SHA-256 and the RIPEMD-160 above.
- `mno_membership.circom` the single-tier proof, run every epoch. This is the default.
- `mno_registration.circom` and `mno_members.circom` the two-tier optimization path, not wired into the default build. Use only if a compiled single-tier proof is too slow per epoch. The registration proof does the secp256k1 and hash160 work once per season; the members proof is a cheap Poseidon-only membership run every epoch. See `docs/DESIGN.md`.

## Dependencies

Install these under a path your Circom include flags can see (`-l`).

1. `circomlib` (Poseidon, SHA-256, bitify). Well established, a dev dependency in `package.json`.
2. `circom-ecdsa` from 0xPARC (secp256k1, the `ECDSAPrivToPub` template), needed only by the full single-tier `mno_membership.circom`. Not needed for the hash160 or members circuits.

RIPEMD-160 is no longer an external dependency. It is written in-repo and validated, since no vetted Circom template could be found.

## Validation

Both bit-ordering risks that used to be open are now pinned by `scripts/check_circuits.sh`,
which the CI `circuits` job runs on every push. Run it locally with a circom binary:

```bash
CIRCOM=/path/to/circom bash scripts/check_circuits.sh
```

It compiles and witnesses two circuits and asserts the result:

1. `ripemd160/ripemd160.circom` against the known hash160 of the secp256k1 generator, `0x751e76e8199196d454941c45d1b3a323f1433bd6`.
2. `hash160/hash160.circom` (the full SHA-256 plus byte assembly plus RIPEMD-160 path) against the same generator vector, which is also the value `test/hash160.test.js` pins on the JavaScript side. When both pass, the in-circuit hash160 provably equals the off-chain leaf.

One thing still to confirm by hand when you wire the full membership circuit: snarkjs orders
public signals as the circuit's outputs first, then its inputs in declaration order, so for
`mno_membership.circom` that is `[nullifier, root, epoch, contextHash, signalHash]`. Check it
against the generated `public.json` and keep `core/verifier.js` in sync.

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
