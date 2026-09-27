# Groth16 setup ceremony for the two heavy circuits

The single-tier admission circuit (`circuits/mno_membership.circom`) and the seasonal registration
circuit (`circuits/mno_registration.circom`) are proved under Groth16. Groth16 needs a phase-two setup
specific to each circuit, on top of a universal phase one. Soundness then rests on one condition. If at
least one contributor to a circuit's phase two generated their contribution privately and discarded it,
nobody can produce a proof that key accepts without a real witness. If every contributor kept theirs, or
one person made every contribution, that person could.

This document is the procedure for one coordinated ceremony event holding two separate setups, one per
circuit. It is run once, against circuits frozen in `circuits/ceremony/FREEZE.json`, and only after that
freeze has been reviewed. The recurring two-tier members circuit (`circuits/mno_members.circom`) is not
part of it. It stays on PLONK under the universal setup and needs no ceremony.

Production publication (hosting the final proving keys, committing the verification keys, updating
`keys.manifest.json`) and deployment are separate steps after the ceremony, listed at the end.

## What is fixed before anyone contributes

Everything a contribution depends on is named in `circuits/ceremony/FREEZE.json` and does not change for
the duration of the event. A change to any of it voids every contribution made so far, for both setups.

- The source, as one git commit of this repository.
- The compiler, circom 2.2.3, with the sha256 of the official release binary used.
- The dependencies that enter the constraint system: circomlib 2.0.5 (from `package-lock.json`),
  circom-ecdsa at commit d87eb7068cb35c951187093abe966275c1839ead (`scripts/setup_circom_ecdsa.sh`).
- The compiled circuits, as the sha256 of each `.r1cs`, with its constraint and public-signal counts.
- The public-signal definitions, in the order snarkjs lays them out (outputs, then public inputs):
  - single-tier admission: `nullifier`, `root`, `epoch`, `contextHash`, `signalHash`
  - seasonal registration: `commitment`, `regNullifier`, `root`, `season`, `contextHash`
- The phase-one input, the Hermez Powers of Tau `powersOfTau28_hez_final_20.ptau`, checked against the
  blake2b-512 the snarkjs README publishes (`scripts/fetch_ptau.sh 20`).
- The snarkjs version that runs the setup, 0.7.6.
- The purpose tags inside the two nullifiers (`circuits/purpose_tags.circom`), which are constants of
  the circuits and so already covered by the r1cs hashes.

Anyone can check the freeze independently: check out the commit, fetch the pinned dependencies, compile
with the pinned compiler, and compare the r1cs hashes.

## Roles

- The coordinator prepares the freeze, computes the initial phase-two files, passes files between
  contributors, applies the beacon, and publishes the transcript. The coordinator may also contribute,
  but a setup whose only contributor is the coordinator does not meet the bar below.
- Contributors. Each setup needs at least one contributor who is not the coordinator and who does not
  share a machine, an account, or a secret with the coordinator. More contributors raise assurance,
  because any one honest contributor is enough. A contributor contributes to both setups in the same
  sitting, with independent randomness for each.
- The public beacon, a value nobody can know or choose before a stated moment, applied after the last
  contribution. It makes the final key independent of the last contributor's timing. It does not replace
  a contributor, because anyone can recompute it.

The beacon is the hash of the Dash mainnet block at a height announced before the first contribution,
far enough ahead that the last contribution lands before that block is mined.

## The procedure, per circuit

Run the same steps for `mno_membership` and `mno_registration`, each as its own chain. `C` below is the
circuit name. Every command is snarkjs 0.7.6 from this repository's `node_modules/.bin/snarkjs`.

1. The coordinator compiles `C` at the frozen commit with the frozen compiler, confirms the r1cs sha256
   equals the freeze, and computes the initial file:

       snarkjs groth16 setup C.r1cs powersOfTau28_hez_final_20.ptau C_0000.zkey

   This step is deterministic, so any participant can recompute `C_0000.zkey` and compare its hash.

2. Each contributor in turn, for contribution number i, receives `C_{i-1}.zkey` and first checks it
   against the frozen circuit and phase one:

       snarkjs zkey verify C.r1cs powersOfTau28_hez_final_20.ptau C_{i-1}.zkey

   Then contributes, supplying their own randomness when prompted, on a machine they control and
   preferably offline for the duration:

       snarkjs zkey contribute C_{i-1}.zkey C_i.zkey --name="<contributor's chosen name>"

   snarkjs prints a contribution hash. The contributor records it and publishes it through a channel
   they control (a signed message or a post under their own account), separately from the file. They
   send `C_i.zkey` to the coordinator, then destroy whatever could reconstruct their randomness: the
   typed entropy, shell history, and any scratch copy of the files.

3. After the last contribution and once the announced block exists, the coordinator applies the beacon:

       snarkjs zkey beacon C_last.zkey C_final.zkey <block hash as hex> 10 -n="Dash block <height>"

4. Anyone verifies the final key:

       snarkjs zkey verify C.r1cs powersOfTau28_hez_final_20.ptau C_final.zkey

   The output lists every contribution with its hash and the beacon. Each contributor confirms their own
   hash appears in the chain as they published it. A missing or different hash voids the setup.

5. The coordinator exports the verification key:

       snarkjs zkey export verificationkey C_final.zkey C_vkey.json

   and records the sha256 of `C_final.zkey` and `C_vkey.json` in the transcript.

## The transcript

Published together once both setups are verified:

- `FREEZE.json` and the commit it names.
- For each circuit, the full `zkey verify` output for the final key, the sha256 of every intermediate
  zkey, the sha256 of the final zkey and verification key, and the beacon height and hash.
- Each contributor's published contribution hashes, linked to where they published them.

The intermediate zkeys are about 120 MB each. Keeping them available lets anyone re-verify each step, so
they are hosted with the transcript rather than discarded.

## What this does and does not establish

A verified chain with at least one contributor independent of the coordinator means that, unless every
contributor to that setup kept or leaked their randomness, no one can produce a proof its key accepts
without a witness satisfying the frozen circuit. It says nothing about whether the circuit expresses the
intended statement, which is what `tools/circuit-analysis/RESULTS.md` covers, and it inherits the trust
the Hermez Powers of Tau already carries for phase one.

## After the ceremony, separate from it

1. Commit the two verification keys at the gateway's default paths (`circuits/build/verification_key.json`
   and `circuits/build/mno_registration_vkey.json`), replacing the PLONK keys of the pre-ceremony
   circuits.
2. Host the two final proving keys and the rebuilt wasm files, and update `keys.manifest.json` with
   their sha256 and sizes.
3. Deploy, starting with the small Discord pilot.

## Rehearsal with development keys

`scripts/groth16_dev_keys.sh` runs steps 1, 2 (with one local contribution), and 5 to produce
development keys in `circuits/build/dev/`, so the candidate can be exercised before the ceremony. Those
keys have a single contribution from the machine that built them and must never be published or deployed.
