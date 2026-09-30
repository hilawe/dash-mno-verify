# Member guide

This guide is for a Dash masternode owner joining a masternode-only channel that uses dash-mno-verify,
for example on Discord. You prove that you hold a masternode's voting key without revealing which
masternode it is. The bot also knows your platform account. The proof hides the voting key and selected node, while
connection metadata and the community's size can affect anonymity.

It covers communities running the two-tier mode, which the deployment guide recommends and which the
bot's `/verify` reply shows as a register step followed by a proof step. A single-tier community's
reply has no register step, and its setup, which needs a local copy of the published masternode list,
is in `prover/README.md`.

Linux testers running their own pilot can use [the Linux pilot walkthrough](LINUX_PILOT.md).
Read [the setup privacy explanation](SETUP_PRIVACY.md) for what the ceremony protects and what it
does not. The current release uses interim single-contributor setup keys.

## How often you do this

Once a season, 90 days by default. Seasons run on fixed dates shared by everyone, so they do not count
from when you join. A member who joins late in a season re-verifies sooner. The bot's `/verify` reply
shows when the current season ends and how long your access will last.

Each time, there are four steps:

1. Register (a heavier proof, 1 to 2 minutes).
2. Type `/verify` in the community to get a challenge file.
3. Make a proof from the challenge (about a minute).
4. Submit only `proof.json` using the platform instructions below.

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
bash scripts/fetch_keys.sh --large registration
```

The last command downloads the proving keys and checks each one against the checksums in
`keys.manifest.json`. The registration key is about 120 MB. Run every command below from this
`dash-mno-verify` folder, because registration saves a secret file here that the proof step looks for.

## Put your voting key in a file

The commands read the key from a file named `voting-key.txt`, so it never appears in your shell
history. If the key is in a Dash Core wallet, this writes it to a new file only you can read. Use a new file and refuse to overwrite an existing one. For a local mainnet wallet, run:

```bash
(umask 077; set -o noclobber; dash-cli dumpprivkey YOUR_VOTING_ADDRESS > voting-key.txt) && echo saved
```

Stop if the command fails. Do not remove an existing key file without understanding what it contains.
For testnet, use `dash-cli -testnet` consistently. A wallet name may also be needed.

Replace `YOUR_VOTING_ADDRESS` with your masternode's voting address. `dash-cli protx info <your protx
hash>` shows it as `votingAddress`. If your key lives in another tool, export the private key from
there and save it in `voting-key.txt` the same way. The prover warns if other users can read the file.

Only registration reads this file. Delete it once you have registered (`rm voting-key.txt`) and
create it again next season.

## Export your own node's masternode list

Registration can build the masternode list itself from your own Dash node, so it does not have to trust
the gateway's copy. Otherwise whoever runs the gateway, or a service in front of it, could serve a
doctored list and narrow down which masternode is yours from whether you go on to register. On the
computer running your node:

```bash
dash-cli masternodelist json > mnlist.json
```

Use `dash-cli -testnet` on testnet, and copy `mnlist.json` into this folder. The register command in the
bot's reply includes `--node-list mnlist.json`. With no node of your own, remove that option. The prover
then uses the gateway's list and warns that it is unchecked. Export a fresh copy each time you register,
because the list changes as masternodes join and leave. If registration is refused as
`stale-or-unknown-root`, your node and the gateway were a block or two apart, so export again and retry.

## Each season

1. **Register.** Copy the register command from the bot's `/verify` reply and run it here. It needs no
   challenge. It finds your masternode in your node's list, proves you hold its key, and saves a
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

## Platform-specific submission

| Platform | Get the challenge | Submit the proof | Successful result |
| --- | --- | --- | --- |
| Discord | `/verify` in the visible verification channel, with a private reply | `/submit` with `proof.json` in its attachment field | Named private channel becomes available |
| Telegram | `/verify` privately to the bot | Send `proof.json` as a document in that private chat, not `/submit` | Follow the join-request link from the same account |
| Matrix | `!verify` in the supported private direct room | Paste the proof file's contents into that room | Accept the invitation to the gated room |
| Web | Get challenge on the gate page | Upload `proof.json` on that page | Open its members area in the same browser session |

Telegram verification works only in a private chat with the bot. In a group, the bot answers `/verify`
with that instruction and ignores uploaded files. Matrix requires
an invite-only two-person room with joined-only history and does not support encrypted room events.
These limits are explained in the moderator guide.

Keep a private backup of the member secret file for the season. Losing it can prevent recovery until
the next season. Moderators cannot recover it from a proof and should never ask you to upload it.

## Keeping which masternode is yours private

The intended proof hides which masternode you control. The network path can identify it. Registration and
the prove step connect to the gateway directly, so the gateway sees the address you connect from. If
you run them on the masternode server itself, that address is in the public masternode list and the
gateway operator could match the two. Prefer a separate computer on a network whose address cannot be tied to your masternode. Tor needs
separately configured and tested routing for the command-line prover. Opening Tor Browser does not
configure it. The prover prints this reminder whenever the gateway is remote.

## If the bot says "Not verified"

The reply explains the problem and ends with a reason code you can give an admin. These are the
common ones:

| Reason code | What happened | What to do |
|---|---|---|
| `unknown-or-expired-challenge` | The challenge ran out or was already used | `/verify` again and prove with the new file |
| `already-used` | Your membership already let a different Discord account in for this period | Use the account that verified first |
| `account-mismatch` | The challenge was issued to a different Discord account | `/verify` from the account that submits |
| `invalid-proof` | The proof did not match the challenge, which is now used up | `/verify` again and prove with the new file |
| `season-rolled-over`, `wrong-season` | A new season started | Register again, then `/verify` |
| `http-401`, `http-5xx`, or another service code | The verification service is misconfigured or down | Tell an admin, since proving again cannot fix it |
