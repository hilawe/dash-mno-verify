# Discord adapter

The first platform adapter. It is deliberately thin: it does Discord input and output
and the access grant, and delegates every decision to the gateway.

## Channel and role grant modes

A verified member is granted access in one of two ways, set by `DISCORD_GRANT_MODE`.

- `channel` (**the default**). The bot adds the member to the private channel(s) in `DISCORD_GRANT_CHANNEL_IDS` with a per-user permission overwrite, which is the automated form of adding someone by hand. It shows nothing on the member's public profile, so an ordinary server member outside the channel cannot tell who holds a masternode. The people who can already see that channel's access (server admins who inspect the overwrites or the audit log, the bot operator, and the other members inside the private channel) still can, and the proof hides which node in every case. The members of the private channel see each other, exactly as they would if added manually.
- `role` (opt in, and it warns at startup). The bot assigns `DISCORD_MNO_ROLE_ID`. Easier to set up, but a Discord role is visible on the member's profile card to anyone in the server, so it announces who holds a masternode. That is the fact the proof exists to keep private, which is why it is no longer the default. Use it only where your community has decided that exposure does not matter.

The verification conversation itself is always private, since `/verify` and `/submit` use ephemeral replies that only the member sees. The grant is the only step that can be public, which is why `channel` mode exists.

Either way, the bot runs a sweep (`DISCORD_SWEEP_SECONDS`, default 300) that removes a member's access once their epoch grant lapses and they have not re-verified, so access tracks current masternode control rather than being permanent once granted. It persists its grant ledger to a SQLite database (`DISCORD_GRANTS_DB`, default `adapters/discord/grants.db`, which holds user ids, is mode 0600, and is gitignored), so access is still revoked after a restart, and it sweeps once at startup. An existing JSON ledger at `DISCORD_GRANTS_FILE` is migrated into it on first start and then renamed with a `.migrated` suffix.

**Every startup, before its first sweep, the bot checks the target it manages now.** It finds everyone
holding access there with no live matching grant and takes that access back. This is not a one-time
upgrade step: it runs every time, because the case it exists for is a bot stopped between Discord
accepting a request and acting on it, which always looks like an ordinary restart. Interactions are
refused with a "try again in a moment" reply until it finishes, since it calls Discord directly rather
than through the ledger's per-member queue.

**It never cleans up after a repoint by itself.** If you point the bot at a different channel or role,
the old one still holds whatever it held. **Decommission the old target deliberately, every time you
repoint.** Treat that as part of the repoint, not as something to wait for a prompt about:

```
npm run discord:decommission -- channel:111,222            # preview, changes nothing
npm run discord:decommission -- channel:111,222 --apply    # actually removes
```

The bot does print a warning naming an outstanding target when it starts, but **that warning is best
effort and its absence proves nothing.** It can only see targets that surviving ledger rows still name,
so an old channel holding access that predates the ledger, or whose rows have since expired and been
swept, produces no warning at all while the access is still there.

The removal is deliberate on purpose. On a decommissioned channel it takes back the three bits this
bot grants (`ViewChannel`, `SendMessages`, `ReadMessageHistory`) wherever a per-member overwrite
currently ALLOWS them, including overwrites you added by hand, because a stored overwrite carries no
record of who created it. Any other permission is left alone.

**An explicit denial is never lifted, anywhere.** If you have denied someone `ViewChannel` on a
channel a role otherwise allows, neither expiry, nor the startup check, nor decommissioning will
clear that denial, because removing it would let the role's allow through and hand access to the
person you excluded. For the same reason the bot refuses to grant a member who is explicitly
denied: your exclusion outranks their proof, and the failure is reported rather than silently
overridden. That trade is reasonable at the moment you decide
to decommission a channel, and unreasonable for a bot to make on its own at every restart, which is
what an earlier version did.

A startup pass that cannot clear someone refuses to start rather than reporting success.

**What it cannot catch.** A startup check is a snapshot. If Discord accepts a request and applies it
after the check has run, that access exists and nothing will find it until the next restart. The
window is small but real, and it is the reason to restart the bot after any incident where it was
stopped abruptly.

Role mode needs the SERVER MEMBERS INTENT enabled for the application in Discord's developer portal,
because deciding who should keep a role means enumerating who holds it. Channel mode needs no
privileged intent. `npm run discord:decommission` asks for the intent only when the target you name is
a role, so you can enable it, run the command once, and turn it off again.

Only one adapter process may run against a given ledger at a time, and the database enforces it: it is
opened in an exclusive locking mode, so the operating system holds it for the life of the process and a
second one is refused. The lock is released whenever the process ends, however it ends, so a restart is
always immediate with nothing to wait out and nothing to clean up by hand.

Two limits on that, both real. **Keep the ledger on local storage.** The exclusion is the filesystem's,
and SQLite's own documentation warns that locking is unreliable on network filesystems such as NFS,
where two hosts can both believe they hold it, costing both the guarantee and possibly the file. **A
process terminated mid-request is not covered.** If the bot records a grant, sends the platform the
request, the platform accepts it, and the bot is terminated before the effect lands, a replacement can
start, see the grant expire, remove it, and forget the member, after which the original request still
takes effect. That leaves access the ledger does not know about. No local lock prevents it, because the
process holding the lock is gone and the side effect is on the platform's servers.


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

# Role mode (opt in): assign a server role, VISIBLE on the profile card, so it discloses
# who holds a masternode. The bot warns at startup if you use it.
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
