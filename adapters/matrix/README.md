# Matrix adapter

Gates a Matrix room behind anonymous masternode verification. It uses the Matrix
Client-Server API directly, so it needs no extra dependency, and grants access by inviting
the member to the gated room.

## Setup

1. Create a Matrix account for the bot and get an access token for it.
2. Put the bot in the gated room with permission to invite users AND to kick them (removal at expiry needs the kick power level, typically 50).
3. Set the environment, then run `npm run matrix`.

Members verify in a direct chat with the bot whose history visibility is "joined". A freshly created direct message often defaults to "shared", which the bot declines, so a member may need to set the room's history visibility to "Members only (since they joined)" before running `!verify`. A configured private verification room is tracked as a follow-up in `TODO.md`.

```bash
export MATRIX_HOMESERVER=https://matrix.org
export MATRIX_ACCESS_TOKEN=...           # the bot's access token
export MATRIX_USER_ID=@yourbot:matrix.org
export MATRIX_GATED_ROOM=!roomid:matrix.org
export MNO_GATEWAY_URL=http://127.0.0.1:8787

# recovery only
# MATRIX_RESET_CLOCK=1 drops the adapter's clock floor to the current time, for the case where a large
# forward clock glitch was recorded and every grant now reads as expired. Start once with it, then
# unset it. Only use it when the host clock is known to be correct: the floor is what stops a
# rolled-back clock reviving access that has already lapsed.

# optional
export MATRIX_GRANT_LEDGER_DB=data/matrix-grants.db  # where granted access is recorded
# An older JSON ledger at MATRIX_GRANT_LEDGER (default data/matrix-grants.json) is migrated
# into it on first start, then renamed with a .migrated suffix.

**Run exactly one adapter process against a given ledger.** This is an operator requirement. The
database is opened in an exclusive locking mode, which refuses a second process in the common case and
releases whenever the process ends, so a restart is always immediate with nothing to wait out. It is
not a guarantee: under sustained concurrency a second opener is admitted roughly one attempt in six,
which is an open blocker rather than settled behaviour. Do not rely on it to catch a misconfigured
supervisor.

Two limits on that, both real. **Keep the ledger on local storage.** SQLite's exclusion is the
filesystem's, and its own documentation warns that locking is unreliable on network filesystems such
as NFS, where two hosts can both believe they hold it. Nothing detects this, and the consequence is
both a lost guarantee and possible file corruption. **A process terminated mid-request is not
covered.** If the bot persists a grant, sends the platform the request, the platform accepts it, and
the bot is then terminated before the effect lands, a replacement can start, see the grant expire,
remove it, and forget the member, after which the original request still takes effect. That leaves
access the ledger does not know about. No local lock can prevent it, because the process holding the
lock is gone and the side effect is on the platform's servers.

export MATRIX_SWEEP_SECONDS=60                      # how often lapsed access is taken back
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
