# Sharing state across gateways with Dash Platform

A single gateway keeps its spent-nullifier set in memory, which is fine on its own. If you
run several gateways for the same community, they each need to see the same spent set, or
the same proof could be used to gain access twice. Dash Platform is the natural shared
ledger for this, because the contract's `nullifier` document type carries a unique index on
(epoch, contextHash, nf). Platform consensus rejects a second insert of the same tag, so two
gateways cannot double-grant even under a race.

## What is on Platform

The data contract is `contract/mno-verify.contract.json`. The type that matters is
`nullifier`, with the unique index `uniqueSpend` over (epoch, contextHash, nf). The `dmlRoot`
and `membersRoot` types let an oracle publish roots on Platform too, so gateways can read the
current root from the same place.

## Turning it on

Set `MNO_STORE=platform` and the gateway records and checks nullifiers on Platform instead of
in memory. It needs a funded Platform identity and a deployed contract.

```bash
export MNO_STORE=platform
export MNO_PLATFORM_NETWORK=testnet            # or mainnet
export MNO_PLATFORM_MNEMONIC="your wallet mnemonic"
export MNO_PLATFORM_CONTRACT_ID="<the registered contract id>"
npm run gateway
```

## Deploying to Platform

1. Install the SDK: `npm install dash` (it is an optional dependency).
2. Create and fund a Platform identity. On testnet this means generating a wallet, getting testnet DASH from a faucet, and creating an identity, which costs a little credit. Follow the current Dash Platform tutorials for this, since the exact steps and the faucet move over time.
3. Register the contract once with your funded wallet:

```bash
MNO_PLATFORM_NETWORK=testnet MNO_PLATFORM_MNEMONIC="your funded wallet" \
  node scripts/register_contract.mjs
```

It deploys `contract/mno-verify.contract.json` and prints the contract id. Set that as
`MNO_PLATFORM_CONTRACT_ID` along with the env above, and the gateway runs on Platform.

A note from testing here: the SDK installs and loads, and the store and registration code are
written to the documented SDK API, but the live path was not exercised end to end. A
read-only testnet connect returned "no available addresses", which means the default DAPI
endpoints need configuring for your network. Treat the live write path as wired but unproven
until you run it against a funded identity with working DAPI access.

## What is verified, and what is not

The store logic is backend-agnostic. The unique-index behavior the gateway relies on is
pinned by `test/platform_store.test.js`, which runs an in-memory backend with the same
semantics, so the dedup and the cross-gateway race are covered in CI.

The live Dash Platform backend in `core/platform_store.js` needs a funded identity and access
to DAPI, the decentralized API that fronts Platform, so it is not exercised in CI. Treat it
as wired but unproven against live Platform until you run it against a funded testnet
identity. The `dash` SDK is an optional dependency, loaded only when `MNO_STORE=platform`.

## Sharing roots

Sharing the DML root across gateways does not require Platform. The simplest path is to point
every gateway at the same oracle output by setting `MNO_ORACLE_SOURCE` to one shared URL. For
a fully on-Platform setup, have the oracle publish `dmlRoot` documents and have the gateways
read them. The nullifier set is the part that genuinely needs consensus, which is why it is
the focus here.
