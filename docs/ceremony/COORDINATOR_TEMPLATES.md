# Coordinator templates for the setup ceremony

Fill-in templates for the public messages `docs/CEREMONY.md` requires, in the order they are sent. Every
value in angle brackets is filled in at the time. Nothing here is sent until the owner approves it.

## Announcement, before the first contribution

> dash-mno-verify setup ceremony, two Groth16 setups (single-tier admission and seasonal registration).
>
> - Source: tag `<tag>` at commit `<commit containing FREEZE.json>`. The circuits are frozen at
>   `5ab338c877b27b90b9c6e58c89ec1af725cbc8bf`, and `circuits/ceremony/FREEZE.json` (sha256 `<sha256>`)
>   records every input. `CIRCOM=<release binary> node scripts/freeze_candidate.mjs --check` confirms it.
> - Contributors, in order, with their slot: `<name, UTC window>`, ... Each contributes to both setups.
> - Initial files: `mno_membership_0000.zkey` sha256 `<sha256>`, `mno_registration_0000.zkey` sha256
>   `<sha256>`. Both come from `snarkjs groth16 setup` and anyone can recompute them.
> - Contribution deadline: `<UTC time>`.
> - Beacon: the Dash mainnet block hash at height H, taken once the block carries a ChainLock, iteration
>   exponent 10. H is the first of H0 = `<height>`, H0 + 576, H0 + 1152, and so on, mined after the
>   closing statement is published.
> - The closing statement and the transcript will be published at `<place>`.
> - Contributor instructions: `docs/ceremony/CONTRIBUTOR_GUIDE.md`.

## Hand-off to each contributor

> Your turn. Files: `mno_membership_in.zkey` sha256 `<sha256>`, `mno_registration_in.zkey` sha256
> `<sha256>`, at `<link>`. Contributions so far: `<list of name and hash per circuit>`. Please follow
> `docs/ceremony/CONTRIBUTOR_GUIDE.md` and publish your two hashes at `<place>`.

## Closing statement, after the last contribution and before the beacon block

> The contribution chains are closed. Nothing more will be added before the beacon.
>
> - mno_membership: contributions `<n. name hash>` ..., last file sha256 `<sha256>`.
> - mno_registration: contributions `<n. name hash>` ..., last file sha256 `<sha256>`.
>
> By the announced rule, the beacon is the first of H0 = `<height>`, H0 + 576, ... mined after this
> statement.

## Transcript, after the beacon

> - Beacon: block `<H>`, hash `<hash>`, ChainLocked, exponent 10.
> - For each circuit: the `snarkjs zkey verify` output of the final key, the sha256 of every intermediate
>   file and of the final key and verification key, and links to each contributor's published hashes.
> - Intermediate files: `<link>`.
