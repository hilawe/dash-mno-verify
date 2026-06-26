# Adapters

An adapter connects one platform to the verification gateway. It does platform input and
output and the access action (assign a role, add to a group, set a flag), and delegates
every decision to the gateway over two HTTP calls. Nothing platform-specific belongs
anywhere else in the repo.

- `discord/` grants a server role.
- `web/` a browser gate for a token-gated site, grants a session.
- `telegram/` gates a group with a single-use invite link.

Three different access actions (a role, a web session, an invite link), one gateway
contract. That is the platform-neutral seam working.

Planned, same gateway contract, different platform glue:

- `matrix/` gate a Matrix room.

Each adapter uses a distinct `platform` string in its gateway calls. Because the context
hash includes that string, the same voting key yields unlinkable nullifiers across
platforms, so a member's memberships never correlate.
