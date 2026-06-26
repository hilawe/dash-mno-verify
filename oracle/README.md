# Oracle

Reads the deterministic masternode list from a real Dash node and publishes a Poseidon
Merkle root over the ENABLED nodes' voting-key hashes. The output is reproducible from
public chain data, so anyone can recompute the root and catch a dishonest oracle.

## Point it at a node

Local `dash-cli` is the default, for when it is on PATH and talks to a synced `dashd`:

```bash
npm run oracle            # writes oracle/root.json
```

A JSON-RPC endpoint is used when `MNO_RPC_URL` is set:

```bash
# your own dashd (rpcuser and rpcpassword from dash.conf)
export MNO_RPC_URL=http://127.0.0.1:9998
export MNO_RPC_USER=rpcuser
export MNO_RPC_PASS=rpcpassword
npm run oracle

# a hosted provider that authenticates with an API-key header
export MNO_RPC_URL=https://dash.getblock.io/mainnet/
export MNO_RPC_HEADER="x-api-key: YOUR_KEY"
npm run oracle
```

It calls `getblockcount` and `masternodelist json`, keeps the nodes whose status is
ENABLED, and writes `{ height, depth, ts, root, leaves }` to `oracle/root.json`, which the
gateway reads.

## Determinism

Nodes are ordered by their masternode-list key before hashing, so every honest oracle
builds the identical tree. Run two or three on independent nodes and require their roots to
agree, or have the gateway recompute locally.
