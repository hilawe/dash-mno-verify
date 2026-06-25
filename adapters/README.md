# Adapters

An adapter connects one platform to the verification gateway. It does platform input and
output and the access action (assign a role, add to a group, set a flag), and delegates
every decision to the gateway over two HTTP calls. Nothing platform-specific belongs
anywhere else in the repo.

- `discord/` the first adapter, and the reference for writing others.

Planned, same gateway contract, different platform glue:

- `telegram/` gate a Telegram group.
- `matrix/` gate a Matrix room.
- `web/` a browser gate for a token-gated site.

Each adapter uses a distinct `platform` string in its gateway calls. Because the context
hash includes that string, the same voting key yields unlinkable nullifiers across
platforms, so a member's memberships never correlate.
