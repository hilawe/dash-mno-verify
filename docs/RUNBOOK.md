# Deploy runbook for a private masternode channel

This is the opinionated, copy-paste path for one setup, a Discord channel that only verified masternode holders can see, granted with no public role, so nothing on a member's profile reveals to the wider server that they hold a masternode. Server admins, the bot operator, and the other members already in the channel can still see who has access. For the full reference with every option, see [DEPLOY.md](DEPLOY.md).

## Just testing the core, without Discord?

If you only want to confirm the pipeline works against your own Dash node, with no Discord and no zero-knowledge proving, this is the whole path. It reads the masternode list from your node and serves it, which is the part worth smoke-testing first.

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm ci --omit=optional                                   # oracle and gateway only, no proving toolchain

npm run oracle                                            # reads your node, writes oracle/root.json

# in the same terminal, or a second one:
MNO_ALLOW_UNSIGNED_ORACLE=1 MNO_ALLOW_UNAUTH_GATEWAY=1 npm run gateway   # listens on :8787
```

Then, from another terminal, confirm it is serving the list:

```bash
curl -s http://127.0.0.1:8787/v1/health; echo
curl -s -X POST http://127.0.0.1:8787/v1/challenge \
  -H 'content-type: application/json' \
  -d '{"platform":"test","communityId":"c","roleId":"r","account":"me"}'; echo
```

`/v1/health` should return `ok:true` with a root, and `/v1/challenge` should return a nonce, a signal hash, an epoch, and that same root. That is the core proven end to end. You need no Discord application, no channel, no oracle signing key, no adapter secret, and no proving keys. If your Dash node runs on the same box, `dash-cli` is already on your PATH and the oracle finds it. The one prerequisite is Node.js 22.13 or newer, which is often newer than the version a Raspberry Pi ships, so check `node --version` first. Stop after the gateway check. The numbered steps below add the signed oracle, the shared secret, and the Discord bot for a full deployment.

Details on the flags, the smoke-test, and the common first-run gotchas are in "Check the gateway is up before wiring Discord" under step 3.

## What you end up with

- A private channel that a member can only see after proving they control a masternode.
- No role, and nothing on anyone's public profile that reveals they hold a masternode.
- Access that lapses on its own if a member stops re-verifying, for example after selling the node.

## Before you start

- A synced Dash mainnet node, reachable by `dash-cli` or JSON-RPC.
- A host that stays up (a small VPS or a Pi), with Node.js 22.13 or newer (per `package.json` engines) and git.
- A Discord application and bot in your server.
- The private masternode channel you already use, with `@everyone` denied View Channel. The bot adds people to it.

## 1. Clone and install

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm install
```

## 2. Publish the masternode list (the oracle)

Generate a signing key once, then run the oracle on a timer so the list stays current.

```bash
node scripts/gen_oracle_key.mjs > oracle-key.txt    # save this. the public key line goes to the gateway
export MNO_ORACLE_SIGNING_KEY=oracle-key.txt
npm run oracle                                       # local dash-cli, or set MNO_RPC_URL/USER/PASS
```

Run `npm run oracle` from cron every few minutes. It writes `oracle/root.json`.

If `dash-cli` is not on your PATH, for example your node runs in a container or you use a hosted RPC (remote procedure call) endpoint, the oracle can reach the node over JSON-RPC instead. Set `MNO_RPC_URL`, plus `MNO_RPC_USER` and `MNO_RPC_PASS` for a node with an rpc password. For a node in a local Docker container, a one-line `dash-cli` shim on your PATH that proxies into it also works:

```bash
printf '#!/bin/sh\nexec docker exec YOUR_CONTAINER dash-cli "$@"\n' > ~/bin/dash-cli
chmod +x ~/bin/dash-cli
export PATH="$HOME/bin:$PATH"           # add to your shell profile to persist it
```

Only the oracle talks to the node. The gateway reads the `oracle/root.json` file, so it needs neither the node nor the shim.

## 3. Run the gateway

Pick one strong secret shared by the gateway and the bot, and pin the oracle public key.

```bash
SECRET=$(openssl rand -hex 32)                       # store this. the bot needs the same value
export MNO_ADAPTER_SECRET=$SECRET
export MNO_ORACLE_PUBKEYS=<public key from oracle-key.txt>
export MNO_MODE=two-tier                              # members get a cheap per-epoch proof
npm run gateway                                       # listens on :8787
```

The gateway boots straight from the repo, because the verification keys are committed, and it reads `oracle/root.json` on its own.

### Check the gateway is up before wiring Discord

Confirm the gateway booted and is serving the list before you add the bot, so a problem shows up here rather than deep in the adapter. For a quick LOCAL check, without a signed oracle or an adapter token, start the gateway in demo mode:

```bash
MNO_ALLOW_UNSIGNED_ORACLE=1 MNO_ALLOW_UNAUTH_GATEWAY=1 npm run gateway
```

Both flags are local-only. `MNO_ALLOW_UNSIGNED_ORACLE=1` trusts the unsigned `root.json` from step 2, and `MNO_ALLOW_UNAUTH_GATEWAY=1` drops the adapter-token requirement so a plain curl can reach the account-bearing endpoints. A real deployment uses neither, and instead pins `MNO_ORACLE_PUBKEYS` and sets `MNO_ADAPTER_SECRET` as in step 3. Then, from another terminal:

```bash
curl -s http://127.0.0.1:8787/v1/health; echo
curl -s -X POST http://127.0.0.1:8787/v1/challenge \
  -H 'content-type: application/json' \
  -d '{"platform":"test","communityId":"c","roleId":"r","account":"me"}'; echo
```

`/v1/health` should return `ok:true` with the current root, and `/v1/challenge` should return a nonce, a signal hash, an epoch, and that same root. That confirms the oracle-to-gateway path end to end.

Three things commonly trip up a first run:

- Environment variables do not cross terminals. The shared `MNO_ADAPTER_SECRET` must be set in every terminal that uses it (the gateway and the bot), and the gateway reads its settings once at startup, so any change to a variable takes effect only after you stop and restart the gateway.
- The gateway is a long-running server. Stop it with Ctrl-C in its own terminal. Closing the terminal window does not always kill it, which can leave a stale process holding port 8787. If a restart fails to bind, find and stop the old one with `lsof -iTCP:8787 -sTCP:LISTEN` then `kill <pid>`.
- An `{"error":"unauthorized"}` from `/v1/challenge` means the bearer token is missing or does not match `MNO_ADAPTER_SECRET`, not that the gateway is down. Use the same secret the gateway was started with, or the demo flags above.

## 4. Discord bot in channel mode (the no-roles part)

Invite the bot with the `bot` and `applications.commands` scopes, and give it "Manage Roles", or "Manage Permissions" on the private channel, so it can edit per-user channel overwrites. It needs no role above anything, because it assigns no role.

```bash
export DISCORD_TOKEN=... DISCORD_APP_ID=... DISCORD_GUILD_ID=...
export MNO_GATEWAY_URL=http://127.0.0.1:8787
export MNO_ADAPTER_SECRET=$SECRET                    # the SAME value the gateway uses
export DISCORD_GRANT_CHANNEL_IDS=<private channel id> # comma-separate several
export DISCORD_CONTEXT_ID=mn-members                 # a stable label the proof is scoped to
npm run bot
```

On a successful proof the bot adds the member to the channel with a per-user permission overwrite, which is the automated form of how you add people by hand today. Nothing shows on their public profile. The verification itself happens in ephemeral replies only the member sees. Let the bot do the adds rather than adding people to that channel by hand, since its expiry sweep resets the access it manages.

## 5. The member's side, on the masternode itself

The heavy once-a-season registration needs a 2.3 GB proving key and a few gigabytes of RAM. The clean place to run it is the masternode the member already operates, not a laptop. The voting key and the spare CPU are already there, the box already stores a multi-gigabyte blockchain so 2.3 GB more is nothing, and the key is fetched or built there once. So the 2.3 GB stops being a barrier and becomes a one-time setup step on infrastructure the member already runs. The per-epoch proof after that is small (a 35 MB key) and runs anywhere.

On the masternode, once:

```bash
git clone https://github.com/hilawe/dash-mno-verify && cd dash-mno-verify
npm ci --omit=optional
bash scripts/fetch_keys.sh            # the 35 MB per-epoch key and the wasms, always
bash scripts/fetch_keys.sh --large    # the 2.3 GB keys, if you host them (see below); else rebuild:
# bash scripts/rebuild_proving_keys.sh
```

- Once a season: `npm run register -- --gateway https://your-gateway --platform discord --community <guild id> --role mn-members --voting-key-file key.wif`. This needs the 2.3 GB registration key. See the network-path warning below.
- Every epoch, in Discord: `/verify` gives a challenge, the member runs `npm run prove-epoch -- --gateway https://your-gateway --challenge challenge.json`, and `/submit` hands the resulting `proof.json` back. The bot adds them to the channel.

Network-path warning for two-tier: both the seasonal register and the per-epoch prove connect to the gateway directly (register posts to it, prove fetches the members tree from it), so the gateway sees the source address on both. If you run either on the masternode, that address is the node's own advertised service address, which is in the public masternode list, and the gateway operator can learn which node it is. The proof stays zero-knowledge, so this is a network-path exposure only, but it applies to BOTH two-tier steps, not registration alone. Run them over an anonymizing path (for example Tor) or from a machine whose public egress address cannot be matched to the node (a machine behind the same network address is not separation). The prover prints a reminder when the gateway is not loopback. Single-tier proving contacts no gateway and has no such exposure. See `docs/THREAT_MODEL.md` ("What each party learns").

To make the 2.3 GB a download instead of a rebuild, host each large key once on object storage or IPFS and fill in its `url` and `sha256` under `largeFiles` in `keys.manifest.json`, then members get it with `fetch_keys.sh --large`. PLONK setup is deterministic, so the rebuilt key is byte-identical and its checksum is stable. See `docs/PROVING_KEY.md`.

## How access ends

Access is for one epoch. A member keeps it by running `/verify` again each epoch. If they stop, for example after selling the node, the next proof would fail, and the bot's sweep removes their channel access. Tune the cadence with `DISCORD_SWEEP_SECONDS` (default 300). The bot persists its grant ledger to a SQLite database, so access is still revoked after a restart, and it sweeps once at startup. An older JSON ledger is migrated into it automatically on first start.

## Honest status

This is a working prototype, not audited. It runs end to end and has been exercised on real mainnet data on a Pi. Do not gate anything of real value on it until it has had an audit.

## More depth

- [DEPLOY.md](DEPLOY.md), the full reference with every option.
- [../adapters/discord/README.md](../adapters/discord/README.md), all the Discord variables.
- [THREAT_MODEL.md](THREAT_MODEL.md), what each party learns and the known limits.
