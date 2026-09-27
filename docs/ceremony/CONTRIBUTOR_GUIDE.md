# Contributing to the dash-mno-verify setup ceremony

Thank you for contributing. This guide is everything you need, start to finish, and takes about half an
hour on a laptop, most of it downloads. The procedure behind it is `docs/CEREMONY.md`.

## What you are doing, and why it matters

dash-mno-verify lets a Dash masternode owner prove membership in a community without revealing which
masternode they control. Two of its circuits are proved under Groth16, which needs a one-time setup per
circuit. Each contributor mixes private randomness into that setup and then discards it. The setup is
secure if at least ONE contributor really discarded theirs, so your contribution protects everyone as long
as you do not keep or share your randomness.

You contribute to two setups in one sitting, one per circuit, with separate randomness for each. You end
up holding no key and no secret, and the ceremony gives you no view of who uses the system later.

## What you need

- A machine you control, macOS or Linux, with about 4 GB of free memory and 2 GB of free disk.
- Node.js 22.13 or later, git, and curl.
- The two files the coordinator sends you for your turn, and the sha256 of each, announced publicly.

## 1. Get the frozen source and check it

    git clone https://github.com/hilawe/dash-mno-verify.git
    cd dash-mno-verify
    git checkout <the ceremony tag from the announcement>
    npm ci --omit=optional

Fetch the official circom 2.2.3 release binary for your platform. The macOS asset is named
`circom-macos-amd64` but runs natively on Apple silicon.

    curl -fsSL -o circom https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64
    chmod +x circom

Confirm the circuits are the frozen ones. This compiles both from source and compares them with
`circuits/ceremony/FREEZE.json`, and checks the compiler is one of the frozen release binaries.

    CIRCOM=./circom node scripts/freeze_candidate.mjs --check

It must print `the fresh compile matches circuits/ceremony/FREEZE.json`. If it does not, stop and tell
the coordinator.

## 2. Prepare the working files

    mkdir -p ceremony-work
    for c in mno_membership mno_registration; do
      ./circom circuits/$c.circom --r1cs -o ceremony-work -l node_modules -l circuits/.deps >/dev/null
    done
    bash scripts/fetch_ptau.sh 20 ceremony-work/pot20.ptau

The last command downloads the public Powers of Tau (about 1.15 GB) and checks it against its published
blake2b-512 hash.

## 3. Contribute, once per circuit

Do the following for `mno_membership`, then again for `mno_registration`. Put the file the coordinator
sent you for that circuit at `ceremony-work/<circuit>_in.zkey`.

    C=mno_membership   # then repeat with C=mno_registration

    # a. The file is the one the coordinator announced.
    shasum -a 256 ceremony-work/${C}_in.zkey

    # b. It derives from the frozen circuit and the public Powers of Tau, through the contributions so far.
    npx snarkjs zkey verify ceremony-work/$C.r1cs ceremony-work/pot20.ptau ceremony-work/${C}_in.zkey

    # c. Contribute. Type a long random line when asked. It is mixed with your system's own randomness.
    npx snarkjs zkey contribute ceremony-work/${C}_in.zkey ceremony-work/${C}_out.zkey --name="<your name>"

Check before contributing:

- (a) prints exactly the sha256 the coordinator announced for that file;
- (b) ends with `ZKey Ok!`, and the contributions it lists are the ones announced so far, with the same
  names and hashes;
- neither shows a beacon entry, since the beacon only comes after every contribution.

If any check fails, stop and tell the coordinator. Do not contribute on a file you have not verified.

Step (c) prints a contribution hash, four lines of hex. Copy it exactly. Enter your randomness at the
prompt, never with `-e` on the command line, which would leave it in your shell history.

## 4. Publish, send, and discard

1. Publish both contribution hashes, labeled by circuit, in one public post under an account people know
   is yours (for example a comment on the ceremony's GitHub issue, or a signed message). This is what lets
   anyone confirm later that your contribution is in the final keys.
2. Send `ceremony-work/mno_membership_out.zkey` and `ceremony-work/mno_registration_out.zkey` to the
   coordinator by the agreed channel. The files hold no secret, and the published hashes protect them in
   transit.
3. Close the terminal you contributed in. Your randomness existed only in that session's memory and at
   the prompt. Do not write it down or reuse it.

## 5. After the ceremony

The coordinator publishes a transcript. Run `snarkjs zkey verify` on each final key, as `docs/CEREMONY.md`
step 4 describes, and confirm your two contribution hashes appear in the chains exactly as you published
them. If either is missing or different, say so publicly.
