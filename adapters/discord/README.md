# Discord adapter

The first platform adapter. It is deliberately thin: it does Discord input and output
and the access grant, and delegates every decision to the gateway.

## Channel and role grant modes

A verified member is granted access in one of two ways, set by `DISCORD_GRANT_MODE`.

- `channel` (recommended for privacy). The bot adds the member to the private channel(s) in `DISCORD_GRANT_CHANNEL_IDS` with a per-user permission overwrite, which is the automated form of adding someone by hand. It shows nothing on the member's public profile, so an ordinary server member outside the channel cannot tell who holds a masternode. The people who can already see that channel's access (server admins who inspect the overwrites or the audit log, the bot operator, and the other members inside the private channel) still can, and the proof hides which node in every case. The members of the private channel see each other, exactly as they would if added manually.
- `role` (default, simpler). The bot assigns `DISCORD_MNO_ROLE_ID`. This is easier to set up, but a Discord role is visible on the member's profile card to anyone in the server, so it reveals who holds a masternode. Do not use this where that exposure matters.

The verification conversation itself is always private, since `/verify` and `/submit` use ephemeral replies that only the member sees. The grant is the only step that can be public, which is why `channel` mode exists.

Either way, the bot runs a sweep (`DISCORD_SWEEP_SECONDS`, default 300) that removes a member's access once their epoch grant lapses and they have not re-verified, so access tracks current masternode control rather than being permanent once granted. It persists its grant ledger to a file (`DISCORD_GRANTS_FILE`, default `adapters/discord/grants.json`, which holds user ids and is gitignored), so access is still revoked after a restart, and it sweeps once at startup.

In `channel` mode, treat the configured channels as bot-managed. The bot cannot tell a member it added from one added by hand, so when a grant lapses its sweep resets the access bits it manages on that channel for that member. Do not also add members to a bot-managed channel manually.

## Setup

1. Create a Discord application and bot, and invite it to your server with the `bot` and `applications.commands` scopes. For `role` mode grant it "Manage Roles" and place the bot's role above the masternode role. For `channel` mode grant it "Manage Roles", or "Manage Permissions" on each private channel, so it can edit per-user channel overwrites.
2. Set the environment, then run `npm run bot`.

```bash
export DISCORD_TOKEN=...                 # bot token
export DISCORD_APP_ID=...                # application id
export DISCORD_GUILD_ID=...              # the server id
export MNO_GATEWAY_URL=http://127.0.0.1:8787
export MNO_ADAPTER_SECRET=...            # the same value the gateway runs with, or its calls get 401

# Channel mode (recommended): add verified members to the private channel(s), no public role
export DISCORD_GRANT_MODE=channel
export DISCORD_GRANT_CHANNEL_IDS=111111111111111111,222222222222222222
export DISCORD_CONTEXT_ID=mn-members     # stable context the proof is scoped to (optional)

# Role mode (default): assign a server role (visible on the profile card)
# export DISCORD_GRANT_MODE=role
# export DISCORD_MNO_ROLE_ID=...

# export DISCORD_SWEEP_SECONDS=300       # how often to revoke lapsed access
```

`DISCORD_CONTEXT_ID` is the identifier the proof and the anti-double-spend nullifier are scoped to. Keep it stable. It defaults to the role id, or in channel mode the first channel id, so set it explicitly if you want a context that does not change when a channel or role id does. Changing it starts a fresh membership set.

## Flow

1. A member runs `/verify`. The bot fetches a challenge from the gateway and returns it as `challenge.json` in an ephemeral reply.
2. The member runs the prover locally with their voting key and that challenge, producing `proof.json`.
3. The member runs `/submit` with `proof.json` attached. The bot forwards it to the gateway, and on success grants access by the configured mode.

## Writing another adapter

Copy the two handlers and re-point them at the target platform. The contract with the
gateway never changes:

- Call `POST /v1/challenge` with `{ platform, communityId, roleId, account }` and relay the result to the member.
- Call `POST /v1/verify` with `{ nonce, proof, publicSignals, account }` and act on `ok`. The `account` must be the platform-authenticated submitter (the same id the challenge was minted for), not a value read from the member's `proof.json`. The gateway rejects with `account-mismatch` if it differs, which is what stops a relayed proof (review finding B1).
- When the gateway is run with `MNO_ADAPTER_SECRET` set, send `Authorization: Bearer $MNO_ADAPTER_SECRET` on both calls. The gateway returns `401` without it. Keep the secret server-side, never in code the member's browser or device can read, since it is what lets the gateway trust the `account` the adapter sends. The read-only endpoints (`/v1/members`, `/v1/dml`, `/v1/health`) need no token.

Use a distinct `platform` string per adapter (for example `telegram`, `matrix`, `web`).
Because the context hash includes that string, the same voting key produces unlinkable
nullifiers across platforms, so memberships never correlate.
