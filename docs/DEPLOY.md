# Deploying dash-mno-verify

This is the front-to-back guide for standing up a masternode-verified gated community, and
for a member to get into one. The other docs go deep on single pieces. This one is the path
through all of them.

## What you run, and who needs what

There are four programs:

- The oracle reads your Dash node's masternode list and publishes a Merkle root to `oracle/root.json`.
- The gateway is the verification service. It boots straight from the repo, because the verification keys are committed.
- An adapter connects the gateway to one platform (Discord, Telegram, Matrix, or a web page) and performs the access grant.
- The prover runs on a member's machine and turns their voting key into a proof.

The split that matters is which side needs which key. The gateway only needs the small
verification keys, which are committed, so an operator never handles a large key. A member
needs the proving key for the circuit they prove against.

| Who | Needs |
|-----|-------|
| Operator, oracle | a synced Dash node reachable by dash-cli or JSON-RPC |
| Operator, gateway | the committed verification keys, and the oracle's `root.json` |
| Operator, adapter | platform credentials and the gateway URL |
| Member, single-tier proof | the membership proving key (about 2.3 GB) and its wasm |
| Member, two-tier registration (once a season) | the registration proving key (about 2.3 GB) and its wasm |
| Member, two-tier per-epoch proof (often) | the members proving key (about 35 MB) and its wasm, both on the release |

## Prerequisites

- Node.js 20 or newer, and git.
- For the operator, a synced Dash mainnet node reachable by `dash-cli` or JSON-RPC.
- For a member building the large keys, the circom compiler and some disk (see `circuits/README.md`). The cheap per-epoch path needs no compiler, only `scripts/fetch_keys.sh`.

## Operator: run a gated community

1. Clone and install.

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm install            # full, for an adapter. Use npm ci --omit=optional for oracle and gateway only.
```

2. Publish the masternode root from your node, and keep it fresh on a schedule. Generate an oracle
   signing key once and sign every snapshot, so the gateway authenticates the membership set against
   a key you pin rather than trusting whoever serves the JSON.

```bash
# generate the oracle key once, save the private key, and keep the public key line for the gateway
node scripts/gen_oracle_key.mjs > oracle-key.txt

# local dash-cli, signing each snapshot:
export MNO_ORACLE_SIGNING_KEY=oracle-key.txt        # the keygen output (the private key is read from it)
npm run oracle
# or JSON-RPC:
export MNO_RPC_URL=http://127.0.0.1:9998
export MNO_RPC_USER=rpcuser MNO_RPC_PASS=rpcpassword
npm run oracle
```

Run it from cron every few minutes. For stronger assurance run two or three oracles on independent
nodes, each with its own key, and require a quorum (see `oracle/README.md`). A provider example and
the read-only safety notes are in `docs/run_on_your_node.md`.

3. Run the gateway. Single-tier is the simplest. Two-tier gives members a cheap per-epoch proof. Set
   `MNO_ADAPTER_SECRET` to a strong random value and give the SAME value to the gateway and to every
   adapter, so only your adapters can call the account-bearing endpoints. The gateway and the adapters
   are separate long-lived processes, so set the secret in each one's environment (a shared `.env` or
   a secrets manager is the usual way); do not rely on one process's shell passing it to another. The
   gateway refuses to start without the secret unless you set `MNO_ALLOW_UNAUTH_GATEWAY=1`, which is
   for local development only. Pin the oracle's public key in `MNO_ORACLE_PUBKEYS` (the value from the
   keygen output, comma-separated for a quorum, with `MNO_ORACLE_QUORUM`). The gateway also refuses to
   start without pinned oracle keys unless you set `MNO_ALLOW_UNSIGNED_ORACLE=1`, for local or
   trusted-network use only.

```bash
# generate once, then make it available to BOTH the gateway and the adapters
openssl rand -hex 32                # store the output where the gateway and adapters can read it

MNO_ADAPTER_SECRET=<that value> MNO_ORACLE_PUBKEYS=<oracle public key> npm run gateway   # single-tier, :8787
# or
MNO_ADAPTER_SECRET=<that value> MNO_ORACLE_PUBKEYS=<oracle public key> MNO_MODE=two-tier npm run gateway
```

   If you front the gateway with a reverse proxy, set `MNO_TRUST_PROXY=1` so the per-client rate
   limit keys off the real client address (the last `X-Forwarded-For` hop) rather than the proxy.

The gateway reads `oracle/root.json` on its own, so it boots even before the first oracle run
and picks up the root when it appears.

4. Run an adapter for your platform. Each one wants its own credentials and the gateway URL,
and the full set is in the adapter's README.

```bash
# Discord. MNO_ADAPTER_SECRET must be the same value the gateway runs with, or its calls get 401.
export DISCORD_TOKEN=... DISCORD_APP_ID=... DISCORD_GUILD_ID=... DISCORD_MNO_ROLE_ID=...
export MNO_GATEWAY_URL=http://127.0.0.1:8787
export MNO_ADAPTER_SECRET=<the same value the gateway uses>
npm run bot
```

The other adapters are `npm run telegram`, `npm run matrix`, and `npm run web`, documented
under `adapters/`.

## Member: get into a community

1. Clone, install the lean way, and fetch the cheap keys.

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm ci --omit=optional
bash scripts/fetch_keys.sh         # downloads and checksum-verifies the members key and the wasms
```

2. Prove. In two-tier mode there are two commands. Registration is member-driven and posts directly
   to the gateway (it is accountless and proof-authenticated, so it needs no adapter token). The
   per-epoch prove consumes a `challenge.json` the adapter minted and writes a `proof.json` the
   member hands back to the adapter, which submits it. The member never holds the adapter secret.

```bash
# once a season, the heavy proof, needs a few GB of RAM
npm run register -- --gateway https://the-gateway --platform discord --community <id> --role <id> --voting-key <WIF>

# every epoch, the cheap proof, fine on a Raspberry Pi. The adapter gave you challenge.json.
npm run prove-epoch -- --gateway https://the-gateway --challenge challenge.json --secret member.secret.json
# then submit the resulting proof.json back through the adapter (it calls /v1/verify with the token).
```

Registration needs the 2.3 GB registration proving key, which you rebuild once with
`scripts/build_proving_key.sh` on a machine with enough memory, or download if the operator
hosts it. The per-epoch key is the 35 MB one from `fetch_keys.sh`.

In single-tier mode it is one command, `npm run prove`, against the challenge the adapter
gives you. The voting key controls only governance votes, never funds, so it is the low-risk
key to use, and it never leaves your machine.

## The two decisions

- `MNO_MODE`. Use `two-tier`. A member registers once a season with the heavy proof, then every epoch runs the cheap proof that works on small hardware, about sixty times faster per epoch than single-tier. `single` is simpler but every proof is the heavy one.
- `MNO_STORE`. Use `memory` for one gateway. Use `platform` for several gateways that share one spent set through the Dash Platform contract, which needs a funded Platform identity. See `docs/PLATFORM.md`.

## Keys, in one place

- The oracle signing key is yours to generate (`scripts/gen_oracle_key.mjs`). The private half signs snapshots on the oracle (`MNO_ORACLE_SIGNING_KEY`); the public half is pinned on the gateway (`MNO_ORACLE_PUBKEYS`). It is a separate operational identity, unrelated to any masternode key.
- The gateway's verification keys are committed, so the gateway is turnkey.
- The cheap members proving key and all three circuit wasms are on the `circuit-keys-v1` release. Get them with `scripts/fetch_keys.sh`, which checks each file's sha256 against `keys.manifest.json`.
- The two large proving keys (membership and registration, about 2.3 GB each) are over GitHub's release limit. Rebuild them deterministically with `scripts/build_proving_key.sh`, which verifies the rebuilt key against the committed verification key, or host them yourself on object storage or IPFS and add them to `keys.manifest.json`. See `docs/PROVING_KEY.md`.

## Status to be honest about

This is a working prototype, not audited. The cryptography is standard and the full pipeline
runs end to end, and it has been exercised on real mainnet data on a Raspberry Pi, but do not
gate anything of real value on it until it has had more eyes and an audit. The Dash Platform
shared-state option is wired and logic-tested but not yet proven against live Platform.

## Where each piece is documented

- `docs/run_on_your_node.md`: the oracle, against your own node.
- `circuits/README.md` and `docs/PROVING_KEY.md`: building and distributing keys.
- `adapters/README.md` and `adapters/*/README.md`: each platform.
- `prover/README.md`: the single-tier and two-tier provers.
- `docs/PLATFORM.md`: sharing state across gateways on Dash Platform.
- `docs/DESIGN.md` and `docs/THREAT_MODEL.md`: how it works, and what it does and does not protect.
