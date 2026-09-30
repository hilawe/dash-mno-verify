# Linux pilot walkthrough

The first pass asks for one thing: register a testnet masternode and see a private Discord channel
appear. Stop there, or at the first step that does not work, and send back the step number and the
error. Nobody expects you to troubleshoot it. Recovery checks, a separate proving computer, a public
address, and the setup ceremony are optional follow-ups at the end.

This is a testnet pilot on interim single-contributor keys, so do not gate anything of value on it.

## Where things run

In the first pass everything runs on **one Linux machine**, called the pilot host below. It holds
the testnet node, the gateway, the bot, and the prover, and nothing is exposed to the internet. This
is the arrangement the project's own testnet pilot used on 2026-09-28 and 2026-09-29. The gateway and
bot use that run's container settings and the oracle loop is the same, with its host-specific parts
removed. Two details differ from what ran there. That pilot ran the prover in a container rather than
directly, and it reached its node through dashmate, so step 3's wrapper for a plain Dash Core node is
untested.

Each block says where it runs, either **pilot host** or **Discord**. A block for **your desktop** only
moves a file between your Discord client and the pilot host.

## What you need

- A Linux pilot host with Docker, Git, curl, Node.js 22.13 or newer, and about 4 GiB of free memory.
- A synced testnet Dash node on that host that `dash-cli` can reach, and the voting private key of a
  testnet masternode.
- A disposable Discord server you own, with a private channel that `@everyone` cannot see. Turn on
  Discord's Developer Mode (User Settings, Advanced) so you can right-click to copy IDs.
- A Discord application and bot from the developer portal. Keep its bot token and application ID.
  Invite it with the `bot` and `applications.commands` scopes and the "Manage Roles" permission. It
  needs no privileged intent.
- A second, ordinary Discord account in that server to verify from. A server owner or administrator
  sees every channel already, so their account cannot show the channel appearing.

## 1. Get the code and keys

**Pilot host.** This is the last commit that changed code. Later commits change only documentation.

```bash
git clone https://github.com/hilawe/dash-mno-verify.git ~/mno-pilot/repo
cd ~/mno-pilot/repo
git checkout --detach 478ffcc00bd4309429bddb0985a901cf29423139
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

**Pilot host.** The oracle reads the masternode list through a `dash-cli` on its search path. Make
that name select testnet. For a plain Dash Core node:

```bash
printf '#!/bin/sh\nexec dash-cli -testnet "$@"\n' > ~/mno-pilot/bin/dash-cli && chmod +x ~/mno-pilot/bin/dash-cli
~/mno-pilot/bin/dash-cli getblockcount
```

With dashmate, write `exec dashmate core cli "$*"` as the second line instead. The check should print a
block height.

Then start the three services. The first run downloads Docker's official `node:22-bookworm` image. The
pilot uses 30-minute access periods and one-day seasons so the boundaries can be seen within a day. The
oracle loop records its own process ID in `run/oracle.pid`, which step 6 uses to stop it.

```bash
cd ~/mno-pilot && . ./pilot.conf
PUB="$(grep '^MNO_ORACLE_PUBKEYS=' secrets/oracle-key.txt | cut -d= -f2-)"
CTX="$(cd repo && node --input-type=module -e 'import {contextHash} from "./common/index.js"; console.log(contextHash({platform:"discord", communityId: process.argv[1], roleId: "mn-members"}).toString())' "$GUILD_ID")"
U="$(id -u):$(id -g)"; H="$HOME/mno-pilot"

setsid bash -c 'echo $$ > "$HOME/mno-pilot/run/oracle.pid"; cd "$HOME/mno-pilot"; export PATH="$HOME/mno-pilot/bin:$PATH" MNO_ORACLE_SIGNING_KEY="$HOME/mno-pilot/secrets/oracle-key.txt"; while true; do node repo/oracle/oracle.js --out data/root.json >> run/oracle.log 2>&1; sleep 120; done' </dev/null >/dev/null 2>&1 &
sleep 20; tail -1 run/oracle.log

docker run -d --name mno-pilot-gateway --memory=1g --cpus=2 -p 127.0.0.1:8787:8787 --user "$U" \
  -v "$H/repo:/work:ro" -v "$H/data:/data" -v "$H/secrets:/secrets:ro" -w /work \
  -e MNO_MODE=two-tier -e MNO_STORE=sqlite -e MNO_NULLIFIER_PATH=/data/nullifiers.sqlite \
  -e MNO_REG_PATH=/data/registrations.jsonl -e MNO_TIME_MARKS_PATH=/data/time_marks.json \
  -e MNO_ORACLE_SOURCE=/data/root.json -e "MNO_ORACLE_PUBKEYS=$PUB" -e "MNO_REGISTER_CONTEXTS=$CTX" \
  -e MNO_EPOCH_SECONDS=1800 -e MNO_SEASON_SECONDS=86400 \
  node:22-bookworm sh -c 'export MNO_ADAPTER_SECRET="$(cat /secrets/adapter.secret)"; exec node core/gateway.js'
sleep 10; curl -fsS http://127.0.0.1:8787/v1/health; printf '\n'

docker run -d --name mno-pilot-bot --memory=512m --network host --user "$U" \
  -v "$H/repo:/work:ro" -v "$H/data/bot:/botdata" -v "$H/secrets:/secrets:ro" -w /work \
  -e "DISCORD_APP_ID=$APP_ID" -e "DISCORD_GUILD_ID=$GUILD_ID" -e "DISCORD_GRANT_CHANNEL_IDS=$CHANNEL_ID" \
  -e DISCORD_CONTEXT_ID=mn-members -e MNO_GATEWAY_URL=http://127.0.0.1:8787 \
  -e MNO_MEMBER_GATEWAY_URL=http://127.0.0.1:8787 \
  -e DISCORD_GRANTS_DB=/botdata/grants.db -e DISCORD_SWEEP_SECONDS=60 \
  node:22-bookworm sh -c 'export DISCORD_TOKEN="$(cat /secrets/discord.token)" MNO_ADAPTER_SECRET="$(cat /secrets/adapter.secret)"; exec node adapters/discord/bot.js'
sleep 15; docker logs mno-pilot-bot 2>&1 | grep '\[discord\]'
```

What each check should show:

- The oracle log ends with `[oracle] dash-cli height ..., N leaves, root ... signed by ... -> data/root.json`.
- The health check prints JSON starting `{"ok":true,"canChallenge":true,"canVerify":true,"canRegister":true,"mode":"two-tier"`.
- The bot log includes `slash commands registered`, `logged in as ...`, and `reconciled; interactions are open`.

The gateway is published only on the pilot host's loopback address, so nothing here is reachable from
the internet. The bot shows members `http://127.0.0.1:8787` in its commands, which works because the
prover also runs on the pilot host.

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
