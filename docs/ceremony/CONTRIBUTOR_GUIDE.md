# Contributing to the setup ceremony on Linux

This walkthrough supports Linux on x86-64, reported by `uname -m` as `x86_64`. It uses the exact
compiler binary recorded in the freeze. An ARM Linux machine needs a separately verified build path.
Do not run the Linux binary on macOS. The frozen macOS asset can be checked separately, but its name
does not establish native Apple silicon support.

The two proposed contributors are Hilawe and Pasta, each using a separate machine and independent
randomness. Participation is voluntary and is recorded only after the contributions actually occur.
The interim pilot setup is not this ceremony.

## What you are doing

You add private randomness to two public mathematical setup files, one for single-tier admission and
one for seasonal registration. No voting key, wallet, collateral, node address, or member secret is
needed. The output files are public. Your private contribution randomness must remain secret and be
discarded.

At least one honest, uncompromised contribution in each verified setup prevents reconstruction of its
trapdoor under the proof system's assumptions. This protects against forged membership. Setup secrets
do not decode honest proofs, but forged admission could expose private conversations. Read
[the privacy explanation](../SETUP_PRIVACY.md) and [the full ceremony procedure](../CEREMONY.md).

## What you need before starting

- Your own Linux x86-64 machine, with about 4 GiB available memory and at least 4 GB free disk.
- Node.js 22.13 or newer, Git, curl, and the standard `sha256sum` utility.
- The announced ceremony source reference, a reference containing the approved freeze, and both
  incoming `.zkey` files with their independently announced file hashes.
- The agreed contributor order and complete beacon policy, including the fallback rule.

Download and compilation time depend on your machine and connection. Reserve an uninterrupted session
rather than relying on a fixed half-hour promise. Use a machine without terminal recording or untrusted
software, and avoid creating a snapshot that preserves live contribution secrets.

## 1. Get the announced source

These commands are for a new checkout on your own machine. Ask for the actual announcement reference
before continuing. Do not use a guessed release tag or the latest moving branch.

```bash
git clone https://github.com/hilawe/dash-mno-verify.git dash-mno-ceremony
cd dash-mno-ceremony
read -r -p 'Approved ceremony reference containing FREEZE.json: ' CEREMONY_REF
git checkout --detach "$CEREMONY_REF"
npm ci --omit=optional
mkdir -p data/ceremony/bin data/ceremony/work
```

The announcement should identify the source commit named by the freeze and the reference containing
that freeze. A later commit that adds the freeze can differ from its recorded source commit without
changing the circuits. Verify both identities against the announcement.

## 2. Verify the compiler before running it

```bash
test "$(uname -s)" = Linux && test "$(uname -m)" = x86_64
curl --fail --show-error --location \
  https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64 \
  --output data/ceremony/bin/circom
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const freeze=JSON.parse(readFileSync('circuits/ceremony/FREEZE.json','utf8'));
const expected=freeze.compiler.releaseBinaries['circom-linux-amd64'];
const actual=createHash('sha256').update(readFileSync('data/ceremony/bin/circom')).digest('hex');
if (!expected || actual!==expected) throw Error('Compiler fingerprint mismatch. Stop.');
console.log('Compiler fingerprint matches the freeze');
NODE
```

Stop if any command fails. Only after the fingerprint matches, make the binary executable and check
the compiled circuits. This fetches the pinned circuit dependency as part of the build.

```bash
chmod 700 data/ceremony/bin/circom
CIRCOM="$PWD/data/ceremony/bin/circom" node scripts/freeze_candidate.mjs --check
```

Expect `the fresh compile matches circuits/ceremony/FREEZE.json`. If it does not, stop and report the
error. Do not change a fingerprint to make the check pass.

## 3. Prepare the public working files

```bash
for C in mno_membership mno_registration; do
  data/ceremony/bin/circom "circuits/$C.circom" --r1cs \
    -o data/ceremony/work -l node_modules -l circuits/.deps || break
done
bash scripts/fetch_ptau.sh 20 data/ceremony/work/pot20.ptau
```

Confirm both compiled files exist and compare their hashes against the freeze before using them.

```bash
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync('circuits/ceremony/FREEZE.json','utf8'));
for (const name of ['mno_membership','mno_registration']) {
  const h=createHash('sha256').update(readFileSync(`data/ceremony/work/${name}.r1cs`)).digest('hex');
  if(h!==f.circuits[name].r1csSha256) throw Error(`${name} differs from the frozen circuit`);
  console.log(`${name} matches`);
}
NODE
```

The public Powers of Tau file is about 1.2 GB. The fetch script checks its published hash, including
when a cached file already exists. It contains no member secrets.

## 4. Contribute to the first circuit

Place the coordinator's incoming membership file at
`data/ceremony/work/mno_membership_in.zkey`. Keep each circuit's files separate.

```bash
C=mno_membership
sha256sum "data/ceremony/work/${C}_in.zkey"
node_modules/.bin/snarkjs zkey verify \
  "data/ceremony/work/$C.r1cs" data/ceremony/work/pot20.ptau \
  "data/ceremony/work/${C}_in.zkey"
```

Before continuing, confirm the file hash matches the independent announcement, the verification ends
with `ZKey Ok!`, and the listed contribution hashes match the announced chain. There must be no beacon
entry yet. A name alone is not an authenticated contribution. Stop on any discrepancy.

```bash
node_modules/.bin/snarkjs zkey contribute \
  "data/ceremony/work/${C}_in.zkey" "data/ceremony/work/${C}_out.zkey" \
  --name='Pasta'
```

Supply fresh private randomness at the prompt. Do not pass it with `-e`, publish it, reuse a wallet
secret, or record the terminal session. The software also uses system randomness. Copy the resulting
public contribution hash exactly, labeled with the circuit name. Verify the output before sending it.

```bash
node_modules/.bin/snarkjs zkey verify \
  "data/ceremony/work/$C.r1cs" data/ceremony/work/pot20.ptau \
  "data/ceremony/work/${C}_out.zkey"
sha256sum "data/ceremony/work/${C}_out.zkey"
```

## 5. Repeat for registration

Set `C=mno_registration`. Place the registration input at
`data/ceremony/work/mno_registration_in.zkey`, then repeat every verification, contribution, and output
check in step 4. Generate independent randomness. Do not copy the membership input or its randomness
into the registration setup.

## 6. Publish and complete

Publish both labeled contribution hashes through an account or signed message you control. Send both
public output files and their file hashes through the agreed transfer method. A file hash and a
contribution hash are different values, so label them distinctly.

Keep the public output files and verification logs. Do not retain private entropy. Closing a terminal
is useful housekeeping but is not a guarantee that swap, recordings, malware, or machine snapshots
contain no secret remnants. Use the agreed contribution environment and describe what you actually did.

After the coordinator applies the agreed beacon, verify both final keys against the frozen circuits
and phase-one file. Confirm your contribution hash is present in each chain. Independently check the
beacon source, height, finality, value, and exponent under [CEREMONY.md](../CEREMONY.md). `ZKey Ok!`
alone does not verify that the intended participants and beacon were used.

The final keys become a separately reviewed publication step. Do not replace pilot keys, edit the
release manifest, or deploy as part of your contribution.
