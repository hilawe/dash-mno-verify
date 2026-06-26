# Prover

Runs on the masternode owner's machine and turns a challenge into a proof. The voting
key is read locally and never transmitted. The output `proof.json` carries no secret.

```bash
npm run prove -- --challenge challenge.json --voting-key <WIF> --oracle oracle/root.json
```

## What it needs

1. `challenge.json` from the adapter (carries the root, epoch, context hash, signal hash, and nonce).
2. The voting key in wallet import format (WIF), the key behind `keyIDVoting` for the masternode. The voting key controls only governance votes, never funds, so this is the low-risk key to use.
3. An oracle snapshot (`oracle/root.json`) whose root matches the challenge. The prover checks this and refuses if the list has moved, so refresh the snapshot and request a new challenge if that happens.
4. The compiled circuit artifacts under `circuits/build/` (see `circuits/README.md`).

## Two-tier flow

`prover/two_tier.js` is the prover for a gateway running in `MNO_MODE=two-tier`. It talks
to the gateway directly, so a member does not assemble files by hand.

Register once per season. This is the heavy proof, so it needs a few GB of RAM, not a
Raspberry Pi:

```bash
npm run register -- \
  --gateway http://your-gateway:8787 \
  --platform discord --community <guildId> --role <roleId> \
  --voting-key <WIF> --secret-out member.secret.json
```

It finds your masternode in the gateway's published list, proves control, saves a secret
you keep, and registers your commitment.

Prove every epoch. This is the cheap proof, a few seconds and a small key, so it runs fine
on a Pi:

```bash
npm run prove-epoch -- \
  --gateway http://your-gateway:8787 \
  --platform discord --community <guildId> --role <roleId> \
  --secret member.secret.json
```

It fetches a challenge and the members tree from the gateway, builds the membership proof,
and submits it. On success the gateway grants access for the epoch.

Keep `member.secret.json` private. It is the only thing that proves your membership for the
season, and it is gitignored for that reason.

## Two encodings that must match the circuit

These are the same two validation points called out in `circuits/README.md`. The prover
and the circuit have to agree, or `fullProve` will fail to satisfy the constraints.

- `leafFromPriv` here computes `hash160(compressed pubkey)`. It must equal the in-circuit `CompressAndHash160` output.
- `privToLimbs` here packs the key into circom-ecdsa's limb layout (k=4 limbs of 64 bits, little-endian). It must match whatever your installed circom-ecdsa expects.

Validate both against one real vector before trusting the system end to end.
