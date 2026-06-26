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

To register the contract once, deploy `contract/mno-verify.contract.json` with the Dash SDK
under a funded identity, then use the returned contract id above.

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
