# Evaluating this in about ten minutes

This is for someone deciding whether the system is sound and worth running, not for someone deploying it. You can judge most of it without generating a single proof, because the heavy cryptography is not needed to check that the logic and the security argument hold. For a non-specialist overview first, read [docs/EXPLAINER.md](docs/EXPLAINER.md).

## The no-keys path

The full test suite runs with no proving keys at all. It exercises the gateway, the policy and security checks, the oracle signature and quorum logic, and the double-spend guard.

```bash
git clone https://github.com/hilawe/dash-mno-verify
cd dash-mno-verify
npm install
npm test            # the whole suite, no keys required
```

If you run a Dash node, see the oracle read the real masternode list and build the root the proofs are checked against. It calls `getblockcount`, `getblockhash`, and `masternodelist json`, keeps the `ENABLED` nodes, and writes a snapshot to `oracle/root.json`.

```bash
npm run oracle                       # local dash-cli on PATH
# or a JSON-RPC node:
MNO_RPC_URL=http://127.0.0.1:9998 MNO_RPC_USER=user MNO_RPC_PASS=pass npm run oracle
```

That is enough to see that the membership set comes from real chain data and that the security checks behave as claimed.

## What to scrutinize

The claims worth attacking, and where they live:

- One voting key, one membership per epoch. The nullifier is the anti-double-spend tag. Check that a non-canonical public signal cannot alias one tag into two (`core/verifier.js`, `common/field.js`), that the circuit binds the canonical private scalar (`circuits/mno_membership.circom`), and that the spend is recorded per epoch and context (`core/stores.js`).
- A proof for one account cannot grant another. The challenge nonce is bound to the requesting account through the signal hash (`common/index.js`), and the verify rejects a mismatched submitter before any spend (`core/gateway.js`).
- The oracle is not blindly trusted. The gateway recomputes the root from the published leaves and requires a quorum of signatures from pinned oracle keys, failing closed without them (`core/gateway.js`, `common/oracle_sig.js`). The honest limit, that this trusts pinned keys and not yet the chain itself, is stated in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- No party links a chat identity to an on-chain address. Walk the data flow in [docs/DESIGN.md](docs/DESIGN.md) and the "what each party learns" section of the threat model.

The prior adversarial review and the fixes are recorded in `REVIEW_FINDINGS_dash-mno-verify_2026-06-26.md` and in the git history.

## Seeing a real proof end to end

This needs the large proving key (about 2.3 GB), which is over the release size limit and is rebuilt locally. This is the main rough edge, and it is honest to treat it as the open adoption question.

```bash
bash scripts/fetch_keys.sh           # pulls the circuit wasm and the small per-epoch key
bash scripts/build_proving_key.sh    # rebuilds the large key, verified against the committed vkey
node scripts/two_tier_demo.mjs       # registration, then a per-epoch members proof, verified
```

## Honest status

This is a working prototype, not professionally audited. It has been exercised on real mainnet data on a Raspberry Pi, and it has had a careful, multi-pass adversarial self-review, which is valuable but is not a formal audit. The remaining work before a real deployment is listed at the end of [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Where to read more

- [docs/EXPLAINER.md](docs/EXPLAINER.md), the plain-language overview.
- [docs/DESIGN.md](docs/DESIGN.md), how the pieces fit and why.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), what each party learns, what it defends against, and the known limits.
- [docs/DEPLOY.md](docs/DEPLOY.md), the front-to-back operator guide.
