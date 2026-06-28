# Matrix adapter

Gates a Matrix room behind anonymous masternode verification. It uses the Matrix
Client-Server API directly, so it needs no extra dependency, and grants access by inviting
the member to the gated room.

## Setup

1. Create a Matrix account for the bot and get an access token for it.
2. Put the bot in the gated room with permission to invite users.
3. Set the environment, then run `npm run matrix`.

Members verify in a direct chat with the bot whose history visibility is "joined". A freshly created direct message often defaults to "shared", which the bot declines, so a member may need to set the room's history visibility to "Members only (since they joined)" before running `!verify`. A configured private verification room is tracked as a follow-up in `TODO.md`.

```bash
export MATRIX_HOMESERVER=https://matrix.org
export MATRIX_ACCESS_TOKEN=...           # the bot's access token
export MATRIX_USER_ID=@yourbot:matrix.org
export MATRIX_GATED_ROOM=!roomid:matrix.org
export MNO_GATEWAY_URL=http://127.0.0.1:8787
```

## Flow

1. A member sends `!verify` in a private one-to-one chat with the bot. The bot fetches a challenge from the gateway and posts it. Verification runs only in a room the bot checks as a private one-to-one chat, to keep the challenge and the proof out of a shared room. A `!verify` anywhere else is answered with a note to start a direct message instead.
2. The member runs the prover locally with their voting key and that challenge.
3. The member pastes the resulting `proof.json` back into the direct chat. The bot forwards it to the gateway, and on success invites the member to the gated room.

The bot counts a room as a private direct chat only when exactly the bot and the message sender are joined, the join rule is invite-only, and history visibility is "joined" so a member sees only messages sent after they join (see `room_privacy.js`). The "joined" requirement matters because a room can have only the bot and member joined yet still have a third user invited, and any looser history setting would let that pending invitee read the proof. A missing or unreadable room state is treated as not private, so the bot fails closed.

The check uses the room state as of each message, not a live read afterward. The bot keeps a room-state cache fed from every `/sync` batch and walks each timeline in order, so a message is judged against the room as it stood when it was sent. A room that was shared when a proof was posted, then trimmed to two members before the bot handled the event, is judged on how it was at posting time. A production bot could narrow this further by also tracking the rooms it accepted as direct from an `m.direct` invite, or by using a configured verification room.

## Why this proves the seam

The access action here, an invite to a Matrix room, is different again from a Discord role,
a web session, or a Telegram invite link. The two gateway calls are identical. The distinct
`platform` string ("matrix") keeps a member's nullifier unlinkable across platforms.
