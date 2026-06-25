# Discord adapter

The first platform adapter. It is deliberately thin: it does Discord input and output
and role assignment, and delegates every decision to the gateway.

## Setup

1. Create a Discord application and bot, and invite it to your server with the `bot` and `applications.commands` scopes plus the "Manage Roles" permission. Place the bot's role above the masternode role it will assign.
2. Set the environment, then run `npm run bot`.

```bash
export DISCORD_TOKEN=...           # bot token
export DISCORD_APP_ID=...          # application id
export DISCORD_GUILD_ID=...        # the server id
export DISCORD_MNO_ROLE_ID=...     # the role to grant on success
export MNO_GATEWAY_URL=http://127.0.0.1:8787
```

## Flow

1. A member runs `/verify`. The bot fetches a challenge from the gateway and returns it as `challenge.json` in an ephemeral reply.
2. The member runs the prover locally with their voting key and that challenge, producing `proof.json`.
3. The member runs `/submit` with `proof.json` attached. The bot forwards it to the gateway, and on success assigns the role.

## Writing another adapter

Copy the two handlers and re-point them at the target platform. The contract with the
gateway never changes:

- Call `POST /v1/challenge` with `{ platform, communityId, roleId, account }` and relay the result to the member.
- Call `POST /v1/verify` with `{ nonce, proof, publicSignals }` and act on `ok`.

Use a distinct `platform` string per adapter (for example `telegram`, `matrix`, `web`).
Because the context hash includes that string, the same voting key produces unlinkable
nullifiers across platforms, so memberships never correlate.
