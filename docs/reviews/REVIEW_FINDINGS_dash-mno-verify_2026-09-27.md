# Project review and proving-cost assessment

Reviewed 2026-09-27 against `53f636a8d871bfd26e4bc914ab8b3b498d7fb3a4`.

The two-tier design remains a reasonable fit for a private Discord community, but the current default onboarding flow does not fit the measured registration time. A separate expiry defect lets access survive a season boundary without re-registration. Fix those behaviors before calling the private-chat flow ready.

The 2.28 GB proving key is a consequence of the selected proof system and circuit representation, not an inherent cost of proving voting-key control. A benchmark of the existing registration circuit with Groth16 produced a 121.7 MB key and a valid proof in 25.31 seconds on the review machine. That experiment changes setup assumptions and is not a deployable replacement. It gives the owner a much more concrete choice than another open-ended backend investigation.

## Scope and evidence

The review covered the circuits and proving commands, gateway admission and persistence, oracle trust boundaries, adapter instructions and proof intake, key distribution, dependencies, build evidence, and working method. It combined source inspection with the existing suite and targeted executable probes. It was not a formal cryptographic audit or an exhaustive proof that the application has no further defects.

- The full local suite passed all 722 tests with optional dependencies installed. The initial sandbox run could not bind sockets. An unrestricted rerun passed in 140.5 seconds. Local Node was version 26.0.0.
- The existing continuous integration (CI) run for this exact revision had successful `full`, `checks`, and `circuits` jobs. The workflow uses Node 22.13. The user's reported smaller-install result was 643 passes and 79 skips. This review independently checked the job conclusions and locally executed the full suite. [Revision run](https://github.com/hilawe/dash-mno-verify/actions/runs/36291336799).
- A real members proof reproduced the season-expiry defect through the gateway's challenge and verification endpoints. An independent reviewer confirmed the defect and the proposed working-method changes.
- Circuit headers, isolated component compilations, a tree-path comparison, and a Groth16 proof supplied measurements beyond the existing tests.
- Runtime code, deployed services, committed keys, and Git state were not changed. This review's project changes are documentation under `docs/`.

## Findings requiring action

### F1 [P1] A two-tier grant can outlive its authorizing season

At `core/gateway.js:1377`, access expires at the end of the epoch. The calculation does not cap a two-tier grant at the end of its season. Discord stores this expiry directly at `adapters/discord/bot.js:584-585`. Clearing the members tree at rollover therefore stops new proofs from the old season but does not revoke already granted access.

The default epoch is seven days and the default season is ninety days. Their boundaries do not generally coincide. A reproduction minted a valid grant 120 seconds before timestamp 1788480000, the end of season 229. The gateway returned `expiresAt = 1788998400`, six days later. Immediately after rollover, the members endpoint reported an empty tree, while the grant still had those six days remaining.

The probe used a real Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge (PLONK) members proof and real gateway requests. It seeded the durable registration fixture rather than generating a heavy registration proof. It did not contact Discord. The downstream effect follows from the adapter persisting the returned expiry, independently confirmed by source inspection.

- Cap two-tier access at the earlier of epoch end and the challenged season's end. Preserve single-tier behavior.
- Test a nonaligned season boundary and the adapter ledger's resulting expiry and revocation behavior.
- Check already persisted grants when deploying the repair. A change to future responses alone does not shorten old ledger entries.

### F2 [P1] The default challenge expires during the documented onboarding sequence

`core/config.js:65` sets the challenge lifetime to 600 seconds. Discord mints the challenge before displaying the proving instructions at `adapters/discord/bot.js:528-548`. Those instructions tell a first-time two-tier member to register before making the epoch proof in `common/prover_instructions.js:29-31`.

The recorded real testnet registration took 782 seconds, before the roughly 29-second recurring proof. Thus an otherwise successful new member following these instructions reaches verification with an expired challenge under defaults. The recorded single-tier proof, about thirteen minutes, also exceeds the default challenge lifetime. A direct `ChallengeStore` probe confirmed that a challenge cannot be taken after advancing the clock by 782 seconds.

The separate default registration-root age is 900 seconds. A 782-second registration leaves little margin for the root's initial age, transfer, and scheduling. Root refresh behavior can affect eligibility, so this is a margin problem rather than proof that every registration will expire. Earlier live runs with extended freshness settings establish cryptographic interoperability, not default-production usability.

- Complete seasonal registration before minting the short-lived admission challenge. Then obtain a fresh challenge and make the cheap proof.
- Display the actual expiry and give the user a clear way to refresh an expired challenge without repeating registration.
- Test default settings on the declared minimum hardware. If single-tier remains supported, give it an explicit measured timing policy. Do not solve both modes by indiscriminately extending every freshness window.

### F3 [P2] Local Merkle-path construction performs thousands of unnecessary hashes

`prover/two_tier.js:91-107` builds padded levels for the entire depth-sixteen tree. The single-tier path and `MembersTree.pathFor()` use the same broad approach. This is especially wasteful when the community has very few members. The gateway's incremental root optimization does not remove work inside the member's proving command.

With one real leaf, the existing `MembersTree.pathFor()` implementation took 8,047.98 milliseconds and the probe counted 65,567 hashes including initialization. A comparison using cached zero-subtree roots required 32 hashes, including the final root, and 3.48 milliseconds. Both root and path matched exactly. This is a synthetic local comparison, not a universal speedup claim or a complete prover replacement.

- Build local paths with cached empty-subtree roots and only the occupied branches.
- Preserve the existing depth, leaf order, padding, and circuit inputs. Check several indices, odd sizes, and boundary cases.
- Keep path construction local. Asking a server for the path of a particular member or masternode can disclose the identity the proof is meant to hide.

### F4 [P2] The download helper fetches both heavy keys for a one-mode user

`scripts/fetch_keys.sh` iterates both large files when given `--large`. A two-tier member needs the registration key, but receives approximately 4.57 GB of heavy keys instead of 2.28 GB. The helper also fetches entries again rather than skipping files whose existing checksum already matches. Its temporary-file and checksum protections are valuable and should stay.

- Add circuit-specific selection, such as registration versus single-tier membership.
- Verify existing cached artifacts and skip matching files. Support bounded retries and resumable temporary downloads with a final full checksum before promotion.
- Show required download size and free-disk requirements before starting. Distinguish downloaded keys from much smaller transmitted proofs.

### F5 [P2] Adapter downloads happen before gateway body limits can protect them

Discord calls `fetch(attachment.url).json()` at `adapters/discord/bot.js:563`. Telegram similarly downloads and parses the submitted document at `adapters/telegram/bot.js:138`. These paths lack an adapter-side streamed byte cap and deadline before parsing. A gateway request-size limit cannot bound memory already consumed by a bot retrieving and parsing an attachment.

This is a source-confirmed resource-exhaustion risk, not a demonstrated live attack. Platform upload limits provide an outer bound but are much larger than a proof and do not prevent repeated expensive submissions.

- Reject excessive advertised attachment sizes, then enforce an independent streamed byte limit because metadata alone is insufficient.
- Apply a fetch deadline and a per-account submission limit before download and parse.
- Test oversized and stalled responses while confirming that a subsequent legitimate submission still works.

### F6 [P2] Runtime guidance contradicts the implemented permission and secret-handling boundaries

The Discord diagnostic at `adapters/discord/bot.js:346` still recommends a role-level deny as an exclusion mechanism. The project's documented invariant correctly explains that the bot's member-level allow overrides that deny. Leaving the diagnostic in place invites an operator to rely on an ineffective exclusion.

The shared proving instructions also print `--voting-key <WIF>`, where WIF means Wallet Import Format. The prover supports safer file or standard-input handling, but the user-facing flow still encourages putting a secret in a command argument, where shell history and local process inspection can expose it.

- Remove the ineffective exclusion recommendation wherever it remains. If individual exclusion is a product requirement, implement a bot-owned admission denylist and reconcile existing grants.
- Make the adapter's actual instructions use the existing file or standard-input path. Verify the displayed command through the real command-line interface, not only a string assertion.
- Describe this as voting-key control. It neither proves exclusive collateral ownership nor makes a voting key harmless to disclose.

## Why the keys are large

A rank-one constraint system (R1CS) is not the final proving-system representation. The local registration artifact contains 254,259 R1CS constraints. Conversion to PLONK produces 636,508 constraints and 382,244 auxiliary additions, requiring a power-of-two domain of 1,048,576. The precomputed polynomial tables for this padded domain dominate the key.

| Circuit | R1CS constraints | PLONK constraints | Domain | Proving-key bytes |
| --- | ---: | ---: | ---: | ---: |
| Single-tier membership | 253,845 | 636,094 | 1,048,576 | 2,283,303,004 |
| Seasonal registration | 254,259 | 636,508 | 1,048,576 | 2,283,307,972 |
| Recurring membership | 9,341 | 10,844 | 16,384 | 35,366,644 |

These are readings of the available artifacts, with the conversion count independently reproduced from their R1CS representation and checked against the key headers. They are not a claim that the entire heavy build was freshly reproduced from source. Older approximate constraint counts should not substitute for these measured artifact counts.

Standalone components compiled with circom 2.2.3 and `--O1` show where the work lies.

| Component | R1CS constraints | Converted PLONK constraints |
| --- | ---: | ---: |
| Private-to-public elliptic-curve calculation | 164,934 | 393,662 |
| HASH160 calculation | 78,956 | 230,438 |
| Depth-sixteen Merkle inclusion | 8,320 | 9,649 |

Standalone outputs change wiring, so these rows are diagnostic rather than perfectly additive. They nevertheless show that HASH160, the composition of SHA-256 and RIPEMD-160, accounts for a substantial share of the converted work. Here SHA means Secure Hash Algorithm and RIPEMD means RACE Integrity Primitives Evaluation Message Digest, with RACE referring to the Research and Development in Advanced Communications Technologies in Europe program. It is not just an elliptic-curve problem.

Reducing registration below 524,288 converted constraints would cross the next domain boundary, requiring roughly 17.6% reduction. Shortening the tree by a few levels cannot achieve that. A circuit optimization that stays above that boundary may improve runtime without halving the dominant key tables. More aggressive compiler simplification should be measured through PLONK conversion rather than judged on R1CS counts alone. The [circom simplification documentation](https://docs.circom.io/circom-language/circom-insight/simplification/) discusses this distinction.

## A missing baseline is now measured

Groth16 can use the existing registration R1CS and witness generator. This review benchmarked that route without changing the ownership statement, switching to a signature that cannot supply the same nullifier, or exposing the witness to an external prover.

| Measurement | Experimental Groth16 registration |
| --- | ---: |
| Proving key | 121,709,176 bytes, or 121.7 MB |
| Key reduction against current PLONK | 18.76 times smaller |
| Full proving elapsed time | 25.31 seconds |
| Maximum resident set size | 1,341,210,624 bytes, or 1.25 GiB |
| Peak memory footprint | 2,774,193,776 bytes, or 2.58 GiB |
| Proof as JavaScript Object Notation (JSON) | 806 bytes |
| Verification key | 3,659 bytes |
| First verification elapsed time | 386.48 milliseconds |

Both memory measures are reported because macOS resident memory alone can understate the process's footprint. This was one synthetic run on the local Mac, not a controlled comparison on the testnet server, a mobile benchmark, or a capacity guarantee. No same-run PLONK timing baseline was repeated, so the 782-second server result must not be used to claim an exact runtime speedup.

The proof verified. All five public signals matched independent commitment, nullifier, root, season, and context derivations. Changing the public root caused verification to fail. The experiment used the repository's registration witness generator with a synthetic voting key and synthetic tree.

The generated key had **zero phase-two contributions and must never be deployed**. It is adequate for a performance experiment, not sound production setup. Groth16 requires circuit-specific phase-two setup, whereas the current PLONK route uses a universal setup. Production would require a reviewed frozen circuit, a properly conducted multiparty ceremony, verified artifacts, and coordinated engine integration. [snarkjs setup documentation](https://github.com/iden3/snarkjs).

This is not a flag that can be turned on in the existing gateway. Verification, engine identifiers, manifests, operational records, and migration assumptions need coordinated changes. A backend switch also does not make the unaudited circuit dependency audited. Its maintainers explicitly warn against production use without review. [circom-ecdsa upstream](https://github.com/0xPARC/circom-ecdsa).

The next decision is whether a per-circuit ceremony is acceptable for this community. If it is, run one capped experiment on the intended minimum member machine using the complete registration statement and compare it with the existing PLONK baseline. If it is not, record that requirement and stop treating Groth16 as an available production option.

## What the other routes do and do not solve

The existing zero-knowledge virtual machine (zkVM) study is valuable but does not yet justify migration. The complete compatible registration statement took approximately 84 minutes at the larger setting and 86 minutes at the reduced-memory setting, with the latter fitting an 8 GB cap. The faster Poseidon-free experiment was a different statement. These are historical measurements from `docs/REDUCING_PROVING_COST.md`, not fresh runs in this review.

If a transparent setup is mandatory, the next bounded research question is whether compatible field arithmetic and Poseidon can remove the measured bottleneck while preserving the complete public statement. Set a time and memory target before integrating another engine. The gateway currently refuses the unwired zkVM mode, which is the correct behavior.

Generic ring signatures are not a drop-in solution because the deterministic masternode list (DML) contains voting-key hashes, not all corresponding public curve points. Restricting eligibility to a subset with known keys changes the membership claim. Operator-key proofs change which authority is being proved. Wallet-assisted nullifier schemes may be worth later study, but require both wallet support and a reviewed uniqueness argument.

A remote proving service that receives the voting key or complete witness gives that service the identity and custody information the local design protects. Treat that as an explicit trust-model change, not a free resource optimization.

## Other review conclusions and limits

The dependency audit returned nineteen production-profile warnings, including five high, two moderate, and twelve low. This counts dependency records, not nineteen independently exploitable gateway vulnerabilities. High records include WebSocket handling, recursive utilities, and pattern expansion in transitive dependencies. Static inspection did not establish that the gateway's ordinary proof verification invokes the affected WebSocket server, JSON-path matching, or recursive utility paths. That is not evidence that every installed mode is unreachable.

Triage each advisory against the enabled gateway and adapter paths, then update the nearest supported dependency and test that path. Do not run an indiscriminate forced dependency upgrade. The audit was checked on the review date and is time-sensitive.

The review did not find evidence requiring replacement of the durable registration commit point or serialized season update queue. Account binding and context-specific members trees are implemented. They should not be reopened as if still missing. The new expiry finding concerns the lifetime of a grant after successful verification, outside those protections.

The oracle still needs an explicit trust assumption about the canonical chain. Checking a block's internal commitments and proof of work does not alone authenticate the latest canonical head. For the immediate private-chat pilot, name and trust the data source. Reopening the stopped full light-client project is not a prerequisite if that operational trust is accepted.

The Platform backend's shared schedule and incomplete two-tier support remain known limitations. Keep the pilot on one gateway with durable local state. The individual-exclusion limitation matters only if the operator expects the product to enforce exclusions, but its misleading runtime guidance needs correction regardless.

This review did not run a live Discord admission and revocation, a fresh mainnet encoding comparison, the container-based X11 differential fuzz suite, or an independent cryptographic audit. It did not establish an upstream compiler-binary fingerprint or complete a dependency-license determination. These are limits on the conclusions, not an invitation to restart every historical workstream before a narrow pilot.

## Working-method changes

`docs/WORKING_METHOD.md` now defines one runnable outcome, one independent execution review, and at most one focused repair confirmation per unit. A remaining consequential failure stays open and requires a narrowed or redesigned repair unit. Passing a round count never means accepting a defect.

The older adoption and assurance documents now point to that policy. Required test gates and security invariants remain. Historical review records remain available. No new review-counting mechanism or suspended loop hook was enabled. Root instruction files were left untouched under the repository-root write restriction.

Applying the analogous policy to both global instruction files requires separate approval after automatic approval review rejected the cross-project edit. The project documentation changes do not imply that those global files have changed. Existing global medium reasoning settings were already present and were not altered.

## Recommended delivery sequence

1. Repair season-bounded expiry and the registration-before-challenge flow as one Discord admission outcome. Include an expired challenge, a season transition, and the resulting revocation in the evidence.
2. Improve local path construction and circuit-specific key retrieval. Measure the recurring proof and first-run download experience again.
3. Decide whether circuit-specific setup is acceptable. If yes, run the bounded Groth16 feasibility comparison before planning an engine migration. If no, retain current PLONK for a small pilot and bound the complete-statement zkVM experiment.
4. Run one small end-to-end Discord pilot on default intended settings and minimum hardware. Record successful admission, expiry, restart recovery, and the agreed moderation limits. Treat specialist circuit assurance as a separate decision before protecting anything of value.

Do not launch all four as parallel architectural projects. The first acceptance claim should be that a member can register, join, and lose access at the correct boundary with an understood local cost.

## Reproduction record

Targeted work ran in `/tmp/mno-review-20260927-ifnp8qiu`, a scratch copy of tracked source with local dependencies linked. It did not change committed circuit artifacts. Temporary evidence remains local and is not a published release artifact.

| Evidence | Local location |
| --- | --- |
| Full passing suite | `/tmp/mno-review-tests-unrestricted.log` |
| CI conclusions | `/tmp/mno-review-ci.json` |
| Dependency audit | `/tmp/mno-review-audit-live.json` |
| Season probe and output | Scratch `review_season_probe.mjs`, `/tmp/mno-review-season.log` |
| Challenge and tree probes | Scratch `review_cost_probes.mjs`, `/tmp/mno-cost-probes.json` |
| Component sources and conversion counter | Scratch `ablation/`, `/tmp/mno-ablation-counts.json` |
| Groth16 input and verification checks | Scratch `groth16-bench/make_input.mjs` and `check.mjs` |
| Proving resource output | `/tmp/mno-groth16-prove.log` |
| Verified benchmark result | `/tmp/mno-groth16-result.json` |

The local compiler was circom 2.2.3 with SHA-256 fingerprint `e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb`. This fingerprint is a local observation, not an upstream attestation. The same fingerprint and the measured circuit fingerprints are recorded in `/tmp/mno-review-build-fingerprints.json`.

The benchmark used the installed snarkjs command-line entry point with `groth16 setup`, the existing `mno_registration.r1cs` and `pot20.ptau`, followed by `groth16 fullprove` using `mno_registration_js/mno_registration.wasm`. `/usr/bin/time -l` measured the fullprove process. A separate check exported the verification key, verified the proof, compared every public signal to independent derivations, and rejected a mutated public root. Setup was deliberately uncontributed. Do not copy its experimental key into a release or production build.

### Repeating the experimental registration benchmark

Use a scratch directory and the installed dependency versions from the reviewed revision. The
following command sequence assumes the synthetic input and the independently checked public
signals described above. Paths are relative to that scratch checkout. The last command must reject
a copy of the public signals whose root has been incremented by one. Never promote the setup output.

```sh
node groth16-bench/make_input.mjs
node node_modules/snarkjs/build/cli.cjs groth16 setup \
  circuits/build/mno_registration.r1cs circuits/build/pot20.ptau \
  groth16-bench/benchmark-only-uncontributed.zkey
/usr/bin/time -l node node_modules/snarkjs/build/cli.cjs groth16 fullprove \
  groth16-bench/input.json \
  circuits/build/mno_registration_js/mno_registration.wasm \
  groth16-bench/benchmark-only-uncontributed.zkey \
  groth16-bench/proof.json groth16-bench/public.json
node node_modules/snarkjs/build/cli.cjs zkey export verificationkey \
  groth16-bench/benchmark-only-uncontributed.zkey \
  groth16-bench/verification_key.json
node groth16-bench/check.mjs
```

The small input generator and acceptance checker are preserved below so that the benchmark does
not depend on retaining temporary files. The existing circuit artifacts must be made available at
the paths in the commands before rerunning. The original run referenced them by absolute path.

#### make_input.mjs

```javascript
import {buildPoseidon} from 'circomlibjs';
import {leafFromPriv} from '../common/dml.js';
import {contextHash} from '../common/index.js';
import {writeFileSync} from 'node:fs';
const p=await buildPoseidon(),F=p.F,z=[F.e(0n)];for(let i=0;i<16;i++)z.push(p([z[i],z[i]]));
let r=F.e(leafFromPriv(Uint8Array.from(Buffer.from('00'.repeat(31)+'01','hex'))));
for(let i=0;i<16;i++)r=p([r,z[i]]);
writeFileSync('groth16-bench/input.json',JSON.stringify({privkey:['1','0','0','0'],pathElements:z.slice(0,16).map(x=>F.toObject(x).toString()),pathIndices:Array(16).fill(0),secret:'12345',root:F.toObject(r).toString(),season:'1',contextHash:contextHash({platform:'test',communityId:'test',roleId:'test'}).toString()}));

```

#### check.mjs

```javascript
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import * as snarkjs from 'snarkjs';
import {buildPoseidon} from 'circomlibjs';
import {keyNullifier,commitment} from '../test/derivations.mjs';
import {releaseProvingThreads} from '../prover/proving_threads.js';
import assert from 'node:assert/strict';
const read=n=>JSON.parse(readFileSync('groth16-bench/'+n+'.json'));
const vk=read('verification_key'),proof=read('proof'),ps=read('public'),input=read('input');
const poseidon=await buildPoseidon();
const expected=[commitment(poseidon,BigInt(input.secret)),keyNullifier(poseidon,input.privkey,BigInt(input.season),BigInt(input.contextHash)),input.root,input.season,input.contextHash].map(String);
assert.deepEqual(ps,expected);
const start=performance.now();const valid=await snarkjs.groth16.verify(vk,ps,proof);const verifyMs=performance.now()-start;
const wrongRoot=[...ps];wrongRoot[2]=(BigInt(ps[2])+1n).toString();
const invalid=await snarkjs.groth16.verify(vk,wrongRoot,proof);
assert.equal(valid,true);assert.equal(invalid,false);
await releaseProvingThreads();
const result={validProofAccepted:valid,modifiedRootAccepted:invalid,publicSignalsMatchIndependentDerivations:true,verifyMs,keyBytes:statSync('groth16-bench/benchmark-only-uncontributed.zkey').size,proofJsonBytes:statSync('groth16-bench/proof.json').size,verificationKeyBytes:statSync('groth16-bench/verification_key.json').size,benchmarkOnly:true,phase2Contributions:0};
writeFileSync('/tmp/mno-groth16-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));

```
