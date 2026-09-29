# Member guide

This guide is for a Dash masternode owner joining a masternode-only channel that uses dash-mno-verify,
for example on Discord. You prove that you hold a masternode's voting key without revealing which
masternode it is. The community's bot learns only that some masternode on the current list vouched for
you.

It covers communities running the two-tier mode, which the deployment guide recommends and which the
bot's `/verify` reply shows as a register step followed by a proof step. A single-tier community's
reply has no register step, and its setup, which needs a local copy of the published masternode list,
is in `prover/README.md`.

## How often you do this

Once a season, 90 days by default. Seasons run on fixed dates shared by everyone, so they do not count
from when you join. A member who joins late in a season re-verifies sooner. The bot's `/verify` reply
shows when the current season ends and how long your access will last.

Each time, there are four steps:

1. Register (a heavier proof, 1 to 2 minutes).
2. Type `/verify` in the community to get a challenge file.
3. Make a proof from the challenge (about a minute).
4. Type `/submit` and attach the proof.

A community can set a shorter access period, in which case steps 2 to 4 repeat within the season and
registration stays once a season.

## What you need

- A computer with Node.js 22.13 or newer and git. Registration needs about 2 GB of free memory. The
  proving keys and circuit files the setup downloads come to about 175 MB, plus the packages npm
  installs.
- Your masternode's voting private key. The voting key can only vote on governance proposals. It
  cannot move funds or change your masternode's registration.
- The gateway address your community uses. The `/verify` reply puts it into the commands for you. If
  the reply shows `<gateway-url>` instead, ask a server admin for it.

## One-time setup

In a terminal, in a folder where you keep tools:

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm ci --omit=optional
bash scripts/fetch_keys.sh
bash scripts/fetch_keys.sh --large registration
```

The last two commands download the proving keys and check each one against the checksums in
`keys.manifest.json`. The registration key is about 120 MB. Run every command below from this
`dash-mno-verify` folder, because registration saves a secret file here that the proof step looks for.

## Put your voting key in a file

The commands read the key from a file named `voting-key.txt`, so it never appears in your shell
history. If the key is in a Dash Core wallet, this writes it to a new file only you can read. It
removes any earlier `voting-key.txt` first, because a file that already exists keeps its old
permissions:

```bash
rm -f voting-key.txt && (umask 077 && dash-cli dumpprivkey YOUR_VOTING_ADDRESS > voting-key.txt) && chmod 600 voting-key.txt && echo saved
```

Replace `YOUR_VOTING_ADDRESS` with your masternode's voting address. `dash-cli protx info <your protx
hash>` shows it as `votingAddress`. If your key lives in another tool, export the private key from
there and save it in `voting-key.txt` the same way. The prover warns if other users can read the file.

Only registration reads this file. Delete it once you have registered (`rm voting-key.txt`) and
create it again next season.

## Each season

1. **Register.** Copy the register command from the bot's `/verify` reply and run it here. It needs no
   challenge. It finds your masternode in the published list, proves you hold its key, and saves a
   file named like `member.discord.<server>.<role>.s<season>.secret.json`. Keep that file for the
   season. It is what lets the next step prove membership without your voting key.
2. **Get a challenge.** Type `/verify` in the community. The reply includes `challenge.json`. Save it
   into this folder. It must be used within about ten minutes, and the reply shows the exact time. If
   it runs out, type `/verify` again.
3. **Prove.** Copy the prove command from the reply and run it here. It writes `proof.json`.
4. **Submit.** Type `/submit`, attach `proof.json`, and press Enter. The bot replies with how long your
   access lasts.

When your access ends, the bot sends you a direct message, if you accept direct messages from server
members. Repeat from step 1 in a new season, or from
step 2 if the community uses a shorter access period and the season has not ended.

## Keeping which masternode is yours private

The proof reveals nothing about which masternode you control. The network path can. Registration and
the prove step connect to the gateway directly, so the gateway sees the address you connect from. If
you run them on the masternode server itself, that address is in the public masternode list and the
gateway operator could match the two. Run them over Tor or from a network whose address cannot be tied
to your masternode. The prover prints this reminder whenever the gateway is remote.

## If the bot says "Not verified"

The reply explains the problem and ends with a reason code you can give an admin. The common ones:

| Reason code | What happened | What to do |
|---|---|---|
| `unknown-or-expired-challenge` | The challenge ran out or was already used | `/verify` again and prove with the new file |
| `already-used` | Your membership already let a different Discord account in for this period | Use the account that verified first |
| `account-mismatch` | The challenge was issued to a different Discord account | `/verify` from the account that submits |
| `invalid-proof` | The proof did not match the challenge | Prove again from the latest challenge |
| `season-rolled-over`, `wrong-season` | A new season started | Register again, then `/verify` |
