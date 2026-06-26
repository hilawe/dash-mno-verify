# Running the oracle on your own Dash node

This walks through running the dash-mno-verify oracle against a real masternode list using
your node. It is a read-only test. The oracle only reads public chain data and never
touches a wallet, collateral, or any key. Running it from a fresh machine also tells us how
portable the setup is.

## What the oracle does

It asks a Dash node for two things, the current block height and the masternode list
(`masternodelist json`), keeps the nodes whose status is ENABLED, and writes a small file
`oracle/root.json` holding a Merkle root over those nodes' public voting-key hashes. That
root is the public anchor the rest of the system proves membership against. Everything it
reads is public, and the only thing it writes is that one local file.

## Prerequisites

- Node.js 20 or newer. Check with `node -v`.
- git.
- Access to a synced Dash mainnet full node, in one of two ways:
  - `dash-cli` on your PATH that talks to your `dashd` (the simplest), or
  - your node's JSON-RPC URL plus its rpcuser and rpcpassword.

If `dash-cli getblockcount` prints a number for you, you are in the first case and the run
is a single command.

## Steps

1. Clone and install.

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm ci --omit=optional
```

The `--omit=optional` flag skips the Discord and Telegram adapter libraries, which the
oracle does not need. Leave it off if you also want to run an adapter.

2. Run the oracle. Pick the line that matches how you reach your node.

If `dash-cli` works on this machine:

```bash
npm run oracle
```

If you reach your node over JSON-RPC instead, for example a remote node:

```bash
export MNO_RPC_URL=http://127.0.0.1:9998
export MNO_RPC_USER=your_rpcuser
export MNO_RPC_PASS=your_rpcpassword
npm run oracle
```

3. Read the result. The oracle prints one line, for example:

```
[oracle] dash-cli height 2178432, 3970 ENABLED nodes, root 188244019356... -> oracle/root.json
```

and writes `oracle/root.json`.

A good result is a height that matches the current Dash block height, an ENABLED count near
the current masternode count (a few thousand), and a non-zero root.

## What to send back

- The one summary line above (height, ENABLED count, and the root).
- The `oracle/root.json` file, if you do not mind. It is all public data, so there is nothing sensitive in it.
- Your operating system and the output of `node -v`, so we know the platform it ran on.

## Is this safe to run?

Yes. The oracle issues only two read-only queries, `getblockcount` and
`masternodelist json`. It does not unlock a wallet, read or use any private key, touch your
collateral, or send anything over the network beyond those two read calls. The only thing
it writes is the local `oracle/root.json`. The whole program is about 80 lines in
`oracle/oracle.js` if you want to read it first.

## Optional, only if you want to test more

These are not needed for the oracle test. They just show how far the rest of the system
runs on your machine.

- Boot the verification gateway against the root you just produced:

```bash
npm run gateway
# then, in another terminal:
curl http://127.0.0.1:8787/v1/health
```

It should answer `{"ok":true, ... "root":"<the root from your run>"}`, which shows the
gateway loaded the committed verification key and your oracle output.

- A full zero-knowledge prove-and-verify of the cheap members circuit lives in
`scripts/prove_members.sh`. It needs the circom compiler, so it is more setup. See
`circuits/README.md`.

## Thanks

This is the first run by someone other than the author, and on a real node, so it doubles
as the portability check. Anything that breaks or reads unclearly is useful to hear about.
