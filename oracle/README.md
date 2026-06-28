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

It calls `getblockcount`, `getblockhash`, and `masternodelist json`, keeps the nodes whose
status is ENABLED, and writes `{ height, blockHash, depth, ts, root, leaves }` to
`oracle/root.json`, which the gateway reads.

## Sign the snapshot

Recomputing the root proves a snapshot is internally consistent, but a host that serves the
JSON could still publish a consistent `{leaves, root}` over a masternode set it made up. So
the oracle signs the snapshot and the gateway trusts only snapshots signed by keys it pins.

Generate a key once, save the private half for the oracle, and pin the public half on the
gateway:

```bash
node scripts/gen_oracle_key.mjs > oracle-key.txt   # prints the PEM private key and the public key line
```

```bash
# oracle: sign each snapshot
export MNO_ORACLE_SIGNING_KEY=oracle-key.txt        # the keygen output (the private key is read from it)
npm run oracle                                      # writes a snapshot with a `sigs` entry

# gateway: trust that signer
export MNO_ORACLE_PUBKEYS=<public key from the keygen output>
```

The signature covers the root, which commits to the leaves, so a changed leaf set breaks it.
The gateway fails closed: without `MNO_ORACLE_PUBKEYS` it refuses to start unless
`MNO_ALLOW_UNSIGNED_ORACLE=1` is set for local or trusted-network use.

## Quorum

For a quorum, build one snapshot and have each signer add its signature to that same
snapshot, so the gateway sees one snapshot carrying every signature. Build it once, then on
each signer run:

```bash
export MNO_ORACLE_SIGNING_KEY=that-signer-key.txt
node scripts/sign_oracle_snapshot.mjs oracle/root.json   # adds this signer's entry, atomically
```

The signer recomputes the root from the leaves and refuses to sign an inconsistent snapshot.
Pin every public key in `MNO_ORACLE_PUBKEYS` (comma-separated) and set `MNO_ORACLE_QUORUM` to
how many must sign, so an attacker must compromise the quorum, not one machine. The signers
sign the same bytes, which is why their signatures combine. Two independently built snapshots
would not, because each stamps its own timestamp, so sign one shared snapshot rather than
merging separate runs.
