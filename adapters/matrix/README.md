# Matrix adapter

Gates a Matrix room behind anonymous masternode verification. It uses the Matrix
Client-Server API directly, so it needs no extra dependency, and grants access by inviting
the member to the gated room.

## Setup

1. Create a Matrix account for the bot and get an access token for it.
2. Put the bot in the gated room with permission to invite users.
3. Set the environment, then run `npm run matrix`.

```bash
export MATRIX_HOMESERVER=https://matrix.org
export MATRIX_ACCESS_TOKEN=...           # the bot's access token
export MATRIX_USER_ID=@yourbot:matrix.org
export MATRIX_GATED_ROOM=!roomid:matrix.org
export MNO_GATEWAY_URL=http://127.0.0.1:8787
```

## Flow

1. A member sends `!verify` in a room the bot watches. The bot fetches a challenge from the gateway and posts it.
2. The member runs the prover locally with their voting key and that challenge.
3. The member pastes the resulting `proof.json` back into the room. The bot forwards it to the gateway, and on success invites the member to the gated room.

## Why this proves the seam

The access action here, an invite to a Matrix room, is different again from a Discord role,
a web session, or a Telegram invite link. The two gateway calls are identical. The distinct
`platform` string ("matrix") keeps a member's nullifier unlinkable across platforms.
