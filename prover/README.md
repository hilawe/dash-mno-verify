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

## Two encodings that must match the circuit

These are the same two validation points called out in `circuits/README.md`. The prover
and the circuit have to agree, or `fullProve` will fail to satisfy the constraints.

- `leafFromPriv` here computes `hash160(compressed pubkey)`. It must equal the in-circuit `CompressAndHash160` output.
- `privToLimbs` here packs the key into circom-ecdsa's limb layout (k=4 limbs of 64 bits, little-endian). It must match whatever your installed circom-ecdsa expects.

Validate both against one real vector before trusting the system end to end.
