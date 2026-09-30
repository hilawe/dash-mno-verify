# Dependency audit triage

Triage of `npm audit` on September 29, 2026 (review finding F9). A count of advisory entries is not a
count of exposures, because one advisory repeats through every package that depends on the affected
one. Each entry below records how it arrives, whether this project's code reaches the affected
function with input an outsider controls, and what was done.

The conclusion is scoped to the supported configuration, a gateway with `MNO_STORE=sqlite` and the
Discord bot, which is what the Linux pilot runs. In that configuration none of the remaining entries is
reached. The optional Platform backend (`MNO_STORE=platform`) is a different case, below, and the bot
has not yet logged in to Discord on the updated library.

## Counts

| Install | Before | After the update below |
| --- | --- | --- |
| Lean, `npm ci --omit=optional` (gateway, oracle, prover) | 19 (5 high, 2 moderate, 12 low) | 18 (4 high, 2 moderate, 12 low) |
| Full, `npm ci` (adds the Discord library and the Dash SDK) | 34 (2 critical, 14 high, 4 moderate, 14 low) | 28 (1 critical, 11 high, 2 moderate, 14 low) |

The update was `npm audit fix` without `--force`, so no dependency moved to a new major version. It
changed eight packages: `discord.js` 14.26.4 to 14.27.0, `@discordjs/rest` 2.6.1 to 2.6.3, `undici`
6.24.1 to 6.29.0, `tar` 7.5.17 to 7.5.22, `js-yaml` 3.14.2 to 3.15.2, `brace-expansion` 2.1.1 to 2.1.7,
`discord-api-types`, and `@sapphire/snowflake`, and removed one duplicate. The full suite (834 tests)
and the real-proof expiry check passed after it. The bot has not yet logged in to Discord on 14.27.0.

`discord.js` carries the Discord adapter's security reasoning, which rests on facts read from its
14.26.4 source. In 14.27.0, `PermissionOverwriteManager.js` and `PermissionOverwrites.js` are
byte-identical, and so are `GuildChannel`'s `memberPermissions`, `rolePermissions`, `overwritesFor`,
and `permissionsFor`. Its two changed `GuildChannel` members, `permissionsLocked` and `manageable`, are
not used by the adapter.

## Remaining entries, in the SQLite configuration unless a row says otherwise

| Advisory package | Arrives through | Loaded by | Affected function and input | Reached | Resolution |
| --- | --- | --- | --- | --- | --- |
| `ws` 8.18.0 (memory disclosure, memory-exhaustion DoS) | `circomlibjs` to `ethers` 5 to `@ethersproject/providers` | Gateway and prover, because `circomlibjs`'s entry imports its contract generators, which import `ethers` | Frames received on an open WebSocket. Only an `ethers` WebSocket provider opens one | No. No code here constructs an `ethers` provider | Recorded. `ethers` 5 pins this version, so no compatible fix exists |
| `elliptic` 6.6.1 (risky primitive) | `ethers` signing, and `@dashevo/dashcore-lib` in the full install | As above | ECDSA signing and verification | No. The project's secp256k1 work uses `@noble/curves` (`common/dml.js`) | Recorded |
| `ethers` and eleven `@ethersproject/*` packages | `circomlibjs` | As above | Flagged only because they depend on `ws` and `elliptic` | No | Recorded |
| `underscore`, `jsonpath`, `bfj` (recursion DoS) | `snarkjs` | Only `snarkjs`'s command-line tool (`build/cli.cjs`), never its library, which the gateway and prover import | `underscore`'s `flatten` and `isEqual` on deep input, reached through `jsonpath` matching inside `bfj` | No. The tool calls only `bfj.write` on data it produced, and matching runs only when `bfj` reads | Recorded |
| `protobufjs` 6.11.6 (critical, code injection) | `dash` 4 to `@grpc/proto-loader` | Only `core/platform_store.js` and `scripts/register_contract.mjs`, through a dynamic import | Code generated from a protobuf schema. The Dash SDK loads its own bundled schemas | Not from network data | Blocks the Platform backend going live, below |
| `@grpc/grpc-js` (memory above limits, crash on a malformed or compressed message) | `dash` 4 | As above | Messages received from a DAPI node | Yes, but only with `MNO_STORE=platform`, which is not live and refuses to start by default | Blocks the Platform backend going live, below |
| `@dashevo/*` and `dash` | `dash` 4 | As above | Flagged only as dependents of the rows above | As above | As above |

## Conditions for the Platform backend

The Platform nullifier backend (`MNO_STORE=platform`) is the only configuration that loads the Dash
SDK, and on `dash` 4 it would reach the `@grpc/grpc-js` defects: a DAPI node that sends a malformed
message could crash the gateway. The fix requires a new major version (`dash` 7.1.1), which is a
migration, not an update. Making the Platform backend live therefore includes either that migration or
the project's standing alternative, `dash-platform-sdk` (github.com/pshenmic/dash-platform-sdk), and
re-running this triage on whichever is chosen. The supported configuration, `MNO_STORE=sqlite`, never
imports the SDK.

## Re-running it

```bash
npm audit --omit=optional
npm audit
npm ls ws elliptic bfj protobufjs @grpc/grpc-js undici
```

Record new entries here with the same columns, and apply updates without `--force`. Re-read any
library source the project's claims rest on when that library changes, as was done for `discord.js`.
