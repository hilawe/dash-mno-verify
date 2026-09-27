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

Anyone can check the freeze independently by checking out the commit, fetching the pinned dependencies,
compiling with the pinned compiler, and comparing the r1cs hashes. `node scripts/freeze_candidate.mjs
--check` does exactly that. A later commit that touches none of the frozen inputs (the two circuits,
their includes, and the pinned dependencies) does not void the freeze, and that check is the test.

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

THE BEACON POLICY IS ANNOUNCED BEFORE THE FIRST CONTRIBUTION, and fixed from then on:

- the source, the Dash mainnet block hash at a height H chosen by the rule below;
- the initial height H0, and the contribution deadline, a stated UTC time well before block H0 is
  expected (Dash targets one block per 2.5 minutes, 576 blocks a day);
- the finality rule, that the value is taken only once block H carries a ChainLock;
- the iteration exponent, 10;
- where the closing statement below will be published.

A contribution arriving after the deadline is not used.

CLOSING THE CHAINS BEFORE THE BEACON EXISTS. After the last contribution to BOTH setups, the coordinator
publishes a closing statement, before the beacon block is mined. For each circuit it gives the ordered
contribution names and hashes, and the sha256 of the last contributed file, the one the beacon will be
applied to. It is published in the announced public place, which records its own time (for example a
comment on a public GitHub issue), and nothing is added to either chain after it.

THE BEACON HEIGHT IS FIXED BY RULE, with no choice left to anyone. H is the smallest of H0, H0 + 576,
H0 + 2 x 576, and so on, whose block was mined after the closing statement was published. So a late
closing moves the beacon one day at a time, and the height follows from public timestamps alone, the
closing statement's and the block times of the candidate heights.

Contributors follow `docs/ceremony/CONTRIBUTOR_GUIDE.md`, which has every command. The coordinator's
public messages (the announcement, each hand-off, the closing statement, the transcript) are templated in
`docs/ceremony/COORDINATOR_TEMPLATES.md`.

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

3. After the last contribution and once block H carries a ChainLock, the coordinator applies the beacon:

       snarkjs zkey beacon C_last.zkey C_final.zkey <hash of block H as hex> 10 -n="Dash block H"

4. Anyone verifies the final key:

       snarkjs zkey verify C.r1cs powersOfTau28_hez_final_20.ptau C_final.zkey

   `ZKey Ok!` ALONE IS NOT ENOUGH. It confirms the key is derived from the frozen circuit and phase one,
   and it prints the chain, but it accepts a key with no beacon and a beacon of any value. The verifier
   also checks, in the printed chain:

   - H is the height the rule gives, from the closing statement's published time and the block times;
   - the chain before the beacon is the one the closing statement lists, contribution for contribution,
     and the beacon was applied to the file whose sha256 it gives;
   - the newest entry is the beacon, named "Dash block H", with `Beacon generator` equal to the hash of
     block H and `Beacon iterations Exp: 10`, and nothing follows it;
   - the hash of block H was obtained independently of the coordinator, from the verifier's own Dash
     node (`dash-cli getblockhash H`, with the block's ChainLock confirmed) or from two unrelated block
     explorers that agree;
   - every contributor's published contribution hash appears in the chain, and each contributor confirms
     their own.

   A missing beacon, a different beacon value or exponent, an entry after the beacon, or a missing or
   different contribution hash voids that setup.

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
