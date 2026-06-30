# Deploy runbook for a private masternode channel

This is the opinionated, copy-paste path for one setup, a Discord channel that only verified masternode holders can see, granted with no public role, so nothing on a member's profile reveals to the wider server that they hold a masternode. Server admins, the bot operator, and the other members already in the channel can still see who has access. For the full reference with every option, see [DEPLOY.md](DEPLOY.md).

## What you end up with

- A private channel that a member can only see after proving they control a masternode.
- No role, and nothing on anyone's public profile that reveals they hold a masternode.
- Access that lapses on its own if a member stops re-verifying, for example after selling the node.

## Before you start

- A synced Dash mainnet node, reachable by `dash-cli` or JSON-RPC.
- A host that stays up (a small VPS or a Pi), with Node.js 20 or newer and git.
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

## 4. Discord bot in channel mode (the no-roles part)

Invite the bot with the `bot` and `applications.commands` scopes, and give it "Manage Roles", or "Manage Permissions" on the private channel, so it can edit per-user channel overwrites. It needs no role above anything, because it assigns no role.

```bash
export DISCORD_TOKEN=... DISCORD_APP_ID=... DISCORD_GUILD_ID=...
export MNO_GATEWAY_URL=http://127.0.0.1:8787
export MNO_ADAPTER_SECRET=$SECRET                    # the SAME value the gateway uses
export DISCORD_GRANT_MODE=channel
export DISCORD_GRANT_CHANNEL_IDS=<private channel id> # comma-separate several
export DISCORD_CONTEXT_ID=mn-members                 # a stable label the proof is scoped to
npm run bot
```

On a successful proof the bot adds the member to the channel with a per-user permission overwrite, which is the automated form of how you add people by hand today. Nothing shows on their public profile. The verification itself happens in ephemeral replies only the member sees. Let the bot do the adds rather than adding people to that channel by hand, since its expiry sweep resets the access it manages.

## 5. The member's side

Members clone the repo, fetch the small keys, and prove. The one heavy step is the once-a-season registration, which needs a large proving key.

```bash
git clone https://github.com/hilawe/dash-mno-verify && cd dash-mno-verify
npm ci --omit=optional
bash scripts/fetch_keys.sh                            # the 35 MB per-epoch key and the wasms
```

- Once a season: `npm run register -- --gateway https://your-gateway --platform discord --community <guild id> --role mn-members --voting-key <WIF>`. This needs the 2.3 GB registration key, rebuilt once with `scripts/build_proving_key.sh` or downloaded if you host it.
- Every epoch, in Discord: `/verify` gives them a challenge, they run `npm run prove-epoch` locally (fine on a Pi), and `/submit` hands the proof back. The bot adds them to the channel.

The 2.3 GB key is the real friction. Host it once on object storage and add it to `keys.manifest.json` so members download rather than rebuild, or accept that each member rebuilds it once.

## How access ends

Access is for one epoch. A member keeps it by running `/verify` again each epoch. If they stop, for example after selling the node, the next proof would fail, and the bot's sweep removes their channel access. Tune the cadence with `DISCORD_SWEEP_SECONDS` (default 300). The bot persists its grant ledger to a file, so access is still revoked after a restart, and it sweeps once at startup.

## Honest status

This is a working prototype, not audited. It runs end to end and has been exercised on real mainnet data on a Pi. Do not gate anything of real value on it until it has had an audit.

## More depth

- [DEPLOY.md](DEPLOY.md), the full reference with every option.
- [../adapters/discord/README.md](../adapters/discord/README.md), all the Discord variables.
- [THREAT_MODEL.md](THREAT_MODEL.md), what each party learns and the known limits.
