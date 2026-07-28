# Telegram adapter

Gates a Telegram group behind anonymous masternode verification. It talks to the same
gateway endpoints as every other adapter. Admission is bound to the account that proved, and
access is taken back when the epoch lapses.

## Setup

1. Create a bot with @BotFather and get its token.
2. Add the bot to the gated group or channel and make it an administrator with permission to invite users via link AND to restrict or ban members (removal at expiry needs that second permission).
3. Set the environment, then run `npm run telegram`.

```bash
export TELEGRAM_BOT_TOKEN=...        # from BotFather
export TELEGRAM_GROUP_ID=-100...     # the gated chat id (bot must be admin)
export MNO_GATEWAY_URL=http://127.0.0.1:8787

# recovery only
# TELEGRAM_RESET_CLOCK=1 drops the adapter's clock floor to the current time, for the case where a large
# forward clock glitch was recorded and every grant now reads as expired. Start once with it, then
# unset it. Only use it when the host clock is known to be correct: the floor is what stops a
# rolled-back clock reviving access that has already lapsed.

# optional
export TELEGRAM_GRANT_LEDGER_DB=data/telegram-grants.db  # where granted access is recorded
# An older JSON ledger at TELEGRAM_GRANT_LEDGER (default data/telegram-grants.json) is migrated
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

export TELEGRAM_SWEEP_SECONDS=60                        # how often lapsed access is taken back
export TELEGRAM_LINK_TTL_SECONDS=3600                   # how long the join-request link stays usable
```

## Flow

1. A member sends `/verify`. The bot fetches a challenge from the gateway and returns it as `challenge.json`.
2. The member runs the prover locally with their voting key and that challenge.
3. The member sends `proof.json` back to the bot. The bot verifies it through the gateway, records the grant, and replies with a link that creates a JOIN REQUEST.
4. The member follows the link and asks to join. The bot approves the request only if that Telegram account holds a live grant, and declines it otherwise.
5. When the epoch lapses, a sweep removes the member (a ban immediately followed by an unban, so they are not left banned and can rejoin after re-verifying).

## Why the link is not a bearer token

An earlier version replied with a single-use invite link. That was a real hole: the gateway
binds a proof to one Telegram account, and the adapter then handed out something anyone could
use, so a forwarded or intercepted link admitted a different account entirely. A join-request
link cannot do that, because following it only asks to join and the bot approves the request
solely for the account that proved. A forwarded link grants nobody.

## Why this proves the seam

The access action here (approving a join request, then removing the member at expiry) looks
nothing like the Discord role grant or the web session. Yet the two gateway calls, `POST /v1/challenge` and
`POST /v1/verify`, are byte-for-byte the same. The distinct `platform` string ("telegram")
keeps a member's nullifier unlinkable across platforms.
