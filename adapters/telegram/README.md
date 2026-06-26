# Telegram adapter

Gates a Telegram group behind anonymous masternode verification. It talks to the same
gateway endpoints as every other adapter and grants access with a single-use invite link.

## Setup

1. Create a bot with @BotFather and get its token.
2. Add the bot to the gated group or channel and make it an administrator with permission to invite users via link.
3. Set the environment, then run `npm run telegram`.

```bash
export TELEGRAM_BOT_TOKEN=...        # from BotFather
export TELEGRAM_GROUP_ID=-100...     # the gated chat id (bot must be admin)
export MNO_GATEWAY_URL=http://127.0.0.1:8787
```

## Flow

1. A member sends `/verify`. The bot fetches a challenge from the gateway and returns it as `challenge.json`.
2. The member runs the prover locally with their voting key and that challenge.
3. The member sends `proof.json` back to the bot. The bot verifies it through the gateway and, on success, replies with a single-use invite link that expires in one hour.

## Why this proves the seam

The access action here (a single-use invite link to a group) looks nothing like the
Discord role grant or the web session. Yet the two gateway calls, `POST /v1/challenge` and
`POST /v1/verify`, are byte-for-byte the same. The distinct `platform` string ("telegram")
keeps a member's nullifier unlinkable across platforms.
