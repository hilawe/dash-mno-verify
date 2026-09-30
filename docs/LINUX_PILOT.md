# Linux pilot walkthrough

The first pass asks for one thing: register a testnet masternode and see a private Discord channel
appear. Stop there, or at the first step that does not work, and send back the step number and the
error. Nobody expects you to troubleshoot it. Recovery checks, a separate proving computer, a public
address, and the setup ceremony are optional follow-ups at the end.

This is a testnet pilot on interim single-contributor keys, so do not gate anything of value on it.

## Where things run

In the first pass everything runs on **one Linux machine**, called the pilot host below. It holds
the testnet node, the gateway, the bot, and the prover, and nothing is exposed to the internet. This
is the arrangement the project's own testnet pilot used on 2026-09-28 and 2026-09-29, and the gateway
and bot use that run's container settings.

This recipe was run as written on 2026-09-30, at commit `8b30487`, on a Linux host with a synced
testnet node reached through dashmate. Three things were done differently there, and nothing
else. Node.js was a portable copy put on the search path. The prompts in steps 2 and 4 were answered
from files, the voting key coming straight from the node's wallet into its file. And the plain
`dash-cli` form of step 3a ran with a stand-in `dash-cli`, since that host had none. The run went from
step 0 through the admission in step 5, saw the bot take the access back within a minute of the
period ending and send its access-ended message, and ended with the stop in step 6. It found and fixed
a bot defect that had stopped admissions from ever opening after a revocation.

The commit pinned in step 1 adds two member-facing changes to `8b30487`, covered by the tests and
continuous integration but not by that run. The prover now writes `proof.json` only once it is
complete, and the bot names a challenge file sent where the proof belongs instead of refusing it as an
incomplete proof.

Each block says where it runs, either **pilot host** or **Discord**. A block for **your desktop** only
moves a file between your Discord client and the pilot host.

## What you need

- A Linux pilot host with Docker, Git, curl, Node.js 22.13 or newer, and about 4 GiB of free memory.
- A synced testnet Dash node on that host that `dash-cli` (or dashmate) can reach, and the voting
  private key of a testnet masternode.
- A disposable Discord server you own, with a private channel that `@everyone` cannot see. Turn on
  Discord's Developer Mode (User Settings, Advanced) so you can right-click to copy IDs.
- A Discord application and bot from the developer portal. Keep its bot token and application ID.
  Invite it with the `bot` and `applications.commands` scopes and the "Manage Roles" permission. It
  needs no privileged intent.
- A second, ordinary Discord account in that server to verify from. A server owner or administrator
  sees every channel already, so their account cannot show the channel appearing.

## 0. Check before you start

**Pilot host.** For a node run by dashmate, replace the last line with `dashmate core cli "getblockchaininfo"`.

```bash
docker --version
git --version
node --version
free -h
dash-cli -testnet getblockchaininfo | grep -E '"chain"|"blocks"|"headers"|initialblockdownload'
```

Continue only if every command works, Node is 22.13 or newer, `"chain"` is `"test"`, `"blocks"` equals
`"headers"`, and `"initialblockdownload"` is `false`. Otherwise stop here and send back what you saw.
That is a useful result too.

## 1. Get the code and keys

**Pilot host.** Use exactly this commit. Its continuous-integration checks passed. Newer commits are
not covered by this walkthrough.

```bash
git clone https://github.com/hilawe/dash-mno-verify.git ~/mno-pilot/repo
cd ~/mno-pilot/repo
git checkout --detach 25ca07c78f1cb93b69577ef4a2ddb1ed749b9be1
npm ci
bash scripts/fetch_keys.sh --large registration
```

`npm ci` installs the Discord library too, which the bot needs. The key fetch prints each file name
and checks it against `keys.manifest.json`. Stop if it prints `CHECKSUM MISMATCH` or fails.

## 2. Private settings

**Pilot host.** Each command refuses to overwrite an existing file. The token prompt does not echo.

```bash
mkdir -p ~/mno-pilot/secrets ~/mno-pilot/data/bot ~/mno-pilot/run ~/mno-pilot/bin
chmod 700 ~/mno-pilot/secrets ~/mno-pilot/data
cd ~/mno-pilot/repo
(umask 077; set -o noclobber; node scripts/gen_oracle_key.mjs > ../secrets/oracle-key.txt)
(umask 077; set -o noclobber; node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' > ../secrets/adapter.secret)
(umask 077; set -o noclobber; read -r -s -p 'Discord bot token: ' T; printf '\n'; printf '%s\n' "$T" > ../secrets/discord.token; unset T)
read -r -p 'Discord application ID: ' APP_ID
read -r -p 'Discord server ID: ' GUILD_ID
read -r -p 'Private channel ID: ' CHANNEL_ID
(umask 077; set -o noclobber; printf 'APP_ID=%s\nGUILD_ID=%s\nCHANNEL_ID=%s\n' "$APP_ID" "$GUILD_ID" "$CHANNEL_ID" > ../pilot.conf)
ls -l ../secrets ../pilot.conf
```

Expect three files in `secrets`, each readable only by you, and `pilot.conf`.

## 3. Start the oracle, gateway, and bot

Run 3a to 3d in one terminal, in order, and stop at the first check that does not show what it should.
The first container start downloads Docker's official `node:22-bookworm` image. The pilot uses
30-minute access periods and one-day seasons so the boundaries can be seen within a day.

### 3a. Point the oracle at the node

**Pilot host.** The oracle finds the node through a program named `dash-cli` in `~/mno-pilot/bin`,
which it puts first on its search path. That wrapper must call the real program by its full path, or it
would find itself and run forever. So resolve the real one first, while `~/mno-pilot/bin` is not on the
path.

```bash
REAL="$(command -v dash-cli)"
case "$REAL" in
  "" | "$HOME/mno-pilot/bin/"*) echo "Stop: no dash-cli found outside ~/mno-pilot/bin" ;;
  *) printf '#!/bin/sh\nexec "%s" -testnet "$@"\n' "$REAL" > ~/mno-pilot/bin/dash-cli && chmod +x ~/mno-pilot/bin/dash-cli && cat ~/mno-pilot/bin/dash-cli ;;
esac
PATH="$HOME/mno-pilot/bin:$PATH" dash-cli getblockcount
```

The wrapper printed should name the real `dash-cli` by its full path, and the last line, which uses the
oracle's exact search path, should print a block height. With dashmate instead of a plain node, use this
block instead. dashmate's `core cli` takes the whole command as one argument.

```bash
REAL="$(command -v dashmate)"
case "$REAL" in
  "" | "$HOME/mno-pilot/bin/"*) echo "Stop: no dashmate found outside ~/mno-pilot/bin" ;;
  *) printf '#!/bin/sh\nexec "%s" core cli "$*"\n' "$REAL" > ~/mno-pilot/bin/dash-cli && chmod +x ~/mno-pilot/bin/dash-cli && cat ~/mno-pilot/bin/dash-cli ;;
esac
PATH="$HOME/mno-pilot/bin:$PATH" dash-cli getblockcount
```

### 3b. Start the oracle

**Pilot host.**

```bash
cd ~/mno-pilot && . ./pilot.conf
setsid bash -c 'echo $$ > "$HOME/mno-pilot/run/oracle.pid"; cd "$HOME/mno-pilot"; export PATH="$HOME/mno-pilot/bin:$PATH" MNO_ORACLE_SIGNING_KEY="$HOME/mno-pilot/secrets/oracle-key.txt"; while true; do node repo/oracle/oracle.js --out data/root.json >> run/oracle.log 2>&1; sleep 120; done' </dev/null >/dev/null 2>&1 &
for i in $(seq 1 36); do [ -s data/root.json ] && break; sleep 5; done; tail -1 run/oracle.log
```

Check: the log line reads `[oracle] dash-cli height ..., N leaves, root ... signed by ... -> data/root.json`.
The first snapshot can take a minute or more, so the check waits up to three minutes for it. Start the
gateway only after this line appears. The oracle loop records its own process ID in `run/oracle.pid`,
which step 6 uses to stop it.

### 3c. Start the gateway

**Pilot host.**

```bash
cd ~/mno-pilot && . ./pilot.conf
PUB="$(grep '^MNO_ORACLE_PUBKEYS=' secrets/oracle-key.txt | cut -d= -f2-)"
CTX="$(cd repo && node --input-type=module -e 'import {contextHash} from "./common/index.js"; console.log(contextHash({platform:"discord", communityId: process.argv[1], roleId: "mn-members"}).toString())' "$GUILD_ID")"
U="$(id -u):$(id -g)"; H="$HOME/mno-pilot"
docker run -d --name mno-pilot-gateway --memory=1g --cpus=2 -p 127.0.0.1:8787:8787 --user "$U" \
  -v "$H/repo:/work:ro" -v "$H/data:/data" -v "$H/secrets:/secrets:ro" -w /work \
  -e MNO_MODE=two-tier -e MNO_STORE=sqlite -e MNO_NULLIFIER_PATH=/data/nullifiers.sqlite \
  -e MNO_REG_PATH=/data/registrations.jsonl -e MNO_TIME_MARKS_PATH=/data/time_marks.json \
  -e MNO_ORACLE_SOURCE=/data/root.json -e "MNO_ORACLE_PUBKEYS=$PUB" -e "MNO_REGISTER_CONTEXTS=$CTX" \
  -e MNO_EPOCH_SECONDS=1800 -e MNO_SEASON_SECONDS=86400 \
  node:22-bookworm sh -c 'export MNO_ADAPTER_SECRET="$(cat /secrets/adapter.secret)"; exec node core/gateway.js'
sleep 10; curl -fsS http://127.0.0.1:8787/v1/health; printf '\n'
```

Check: the JSON starts `{"ok":true,"canChallenge":true,"canVerify":true,"canRegister":true,"mode":"two-tier"`.
If `canRegister` is `false`, wait 30 seconds and run the `curl` line again, since the gateway re-reads the
snapshot every 30 seconds. The gateway is published only on the pilot host's loopback address, so it is
not reachable from the internet.

### 3d. Start the bot

**Pilot host.**

```bash
cd ~/mno-pilot && . ./pilot.conf
U="$(id -u):$(id -g)"; H="$HOME/mno-pilot"
docker run -d --name mno-pilot-bot --memory=512m --network host --user "$U" \
  -v "$H/repo:/work:ro" -v "$H/data/bot:/botdata" -v "$H/secrets:/secrets:ro" -w /work \
  -e "DISCORD_APP_ID=$APP_ID" -e "DISCORD_GUILD_ID=$GUILD_ID" -e "DISCORD_GRANT_CHANNEL_IDS=$CHANNEL_ID" \
  -e DISCORD_CONTEXT_ID=mn-members -e MNO_GATEWAY_URL=http://127.0.0.1:8787 \
  -e MNO_MEMBER_GATEWAY_URL=http://127.0.0.1:8787 \
  -e DISCORD_GRANTS_DB=/botdata/grants.db -e DISCORD_SWEEP_SECONDS=60 \
  node:22-bookworm sh -c 'export DISCORD_TOKEN="$(cat /secrets/discord.token)" MNO_ADAPTER_SECRET="$(cat /secrets/adapter.secret)"; exec node adapters/discord/bot.js'
for i in $(seq 1 24); do docker logs mno-pilot-bot 2>&1 | grep -q 'interactions are open' && break; sleep 5; done
docker logs mno-pilot-bot 2>&1 | grep '\[discord\]'
```

Check: the log includes `slash commands registered`, `logged in as ...`, and `reconciled; interactions are open`.
The bot shows members `http://127.0.0.1:8787` in its commands, which works because the prover also runs
on the pilot host.

## 4. Register

**Pilot host.** Save the testnet voting key without showing it, export the node's masternode list,
and register. Registration takes 1 to 2 minutes and about 2 GB of memory.

```bash
cd ~/mno-pilot/repo && . ../pilot.conf
(umask 077; set -o noclobber; read -r -s -p 'TESTNET voting private key: ' K; printf '\n'; printf '%s\n' "$K" > ../secrets/voting-key.txt; unset K)
~/mno-pilot/bin/dash-cli masternodelist json > mnlist.json
npm run register -- --gateway http://127.0.0.1:8787 --platform discord --community "$GUILD_ID" --role mn-members --voting-key-file ../secrets/voting-key.txt --node-list mnlist.json
```

Expect `registered at members-tree index 0. Secret saved to member.discord...secret.json`. Keep that
file until the season ends. Once registered, `rm ../secrets/voting-key.txt` removes the key copy.

## 5. Verify in Discord

1. **Discord**, as the ordinary second account: in any channel it can see, type `/verify`, pick the
   bot's command from the menu, and press Enter. A reply marked "Only you can see this" appears with
   `challenge.json` attached. The challenge lasts ten minutes, so do steps 2 to 5 in one go.
2. **Your desktop:** download `challenge.json` and copy it into `~/mno-pilot/repo` on the pilot host,
   for example `scp challenge.json pilot-host:mno-pilot/repo/`.
3. **Pilot host:** in `~/mno-pilot/repo`, run `npm run prove-epoch -- --gateway http://127.0.0.1:8787 --challenge challenge.json`.
   It takes about a minute and prints `Wrote proof.json`.
4. **Your desktop:** copy `proof.json` back, for example `scp pilot-host:mno-pilot/repo/proof.json .`.
5. **Discord:** type `/submit`, attach `proof.json` in the command's `proof` field, and press Enter.

Success is a reply starting **Verified.** and the private channel appearing in the second account's
channel list. That is the end of the first pass.

## 6. Stop

**Pilot host.** This stops only what the pilot started. Stored state stays in `~/mno-pilot/data`.
Stopping the bot does not take back access it already granted. Discord keeps a member's channel
permission until the bot, running again, removes it after the period ends, or until you remove the
member's entry by hand in the channel's permission settings.

```bash
cd ~/mno-pilot && kill -- "-$(cat run/oracle.pid)" && rm run/oracle.pid
docker stop mno-pilot-bot mno-pilot-gateway && docker rm mno-pilot-bot mno-pilot-gateway
```

## What to send back

Either "admitted", or the step number, the command, and the error text. Leave out tokens, keys, and
secret files.

## Optional follow-ups

None of these is part of the first pass.

- **Recovery and revocation checks.** With the pilot still running, record the reply text for each.
  - A proof from a challenge issued to another account is refused as `account-mismatch`.
  - An expired challenge is refused, and a fresh `/verify` recovers.
  - Restarting the gateway and bot keeps the member's access.
  - The bot removes channel access within a minute after the 30-minute period ends.
- **A separate proving computer and a public address.** This is the arrangement real members would use.
  It splits the roles into three machines: the gateway host runs the gateway and bot, the testnet node
  answers `dash-cli`, and the proving computer holds the voting key and runs the prover. The gateway
  then needs a public https address, set as `MNO_MEMBER_GATEWAY_URL`, and the checks before exposing
  it are in [the moderator guide, section 5](MODERATOR_GUIDE.md#5-expose-only-the-member-service-needed-for-the-pilot).
  `mnlist.json` is made on the testnet node (`dash-cli -testnet masternodelist json > mnlist.json`) and
  copied to the proving computer, the one machine that must have it. No project pilot has run this
  arrangement yet.
- **The setup ceremony.** Separate from membership testing and needing no voting key. See
  [the contributor guide](ceremony/CONTRIBUTOR_GUIDE.md).
