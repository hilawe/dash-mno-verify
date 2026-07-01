# Distributing the proving key

The full membership circuit needs three artifacts to make a proof: the circuit wasm
(witness generator), the PLONK proving key (`mno_membership.zkey`, about 2.3 GB), and the
verification key (about 2 KB). Only the verification key is in the repo. This page explains
how the large proving key reaches provers.

## The key is reproducible, not hosted

PLONK setup is deterministic. Given the same r1cs and the same universal SRS, it always
produces the same proving and verification keys. Every input to that is public:

- the circuits in this repo,
- circom-ecdsa pinned to a fixed commit by `scripts/setup_circom_ecdsa.sh`,
- the public Hermez Powers of Tau (the 2^20 SRS).

So the proving key does not need to be hosted at all. A prover rebuilds it locally:

```bash
npm ci
CIRCOM=/path/to/circom bash scripts/build_proving_key.sh
```

This compiles the circuit, downloads the SRS, runs the PLONK setup, then proves a test
witness with the rebuilt key and verifies it against the committed verification key. A
passing check means the locally built proving key is the canonical one, so a prover never
has to trust a downloaded multi-GB blob. Pass `mno_registration` as an argument to rebuild the
two-tier registration key the same way.

After an intentional circuit change (for example the M1 `d < n` constraint), the committed
verification key must change too. Run `scripts/rebuild_proving_keys.sh`, which rebuilds both
key-bearing circuits in promote mode (`MNO_PROMOTE_VKEY=1`), so the freshly proved verification
keys overwrite the committed ones instead of being checked against them.

The build needs about 3 GB of disk, a 1.15 GB SRS download, and several minutes per circuit.

## Downloading the prebuilt artifacts

Rebuilding is the trustless default, but it is heavy to ask of every prover, especially for
the cheap per-epoch members proof on a small device. The hostable artifacts, the members
proving key and the three circuit wasms, are published on a GitHub release and listed with
their sha256 in `keys.manifest.json`. Fetch and verify them with:

```bash
bash scripts/fetch_keys.sh
```

It downloads each file, checks its sha256 against the manifest, and places it under
`circuits/build/`. Point `MNO_KEYS_BASE_URL` at a different host if you mirror them.

The two large proving keys, membership and registration, are about 2.3 GB each, over the
GitHub 2 GB asset limit, so they are not on the release. They are listed under `largeFiles`
in `keys.manifest.json`, separate from the small `files`, and `fetch_keys.sh` fetches them
only when asked:

```bash
bash scripts/fetch_keys.sh --large
```

Until a large key is hosted, that `largeFiles` entry has an empty `url` and `sha256`, so
`--large` prints how to proceed and exits rather than downloading nothing. To host one,
rebuild it once with `scripts/rebuild_proving_keys.sh`, upload the `.zkey` to object storage
(S3, R2) or IPFS, compute its sha256, and fill in the `url` and `sha256` for that entry.
Because PLONK setup is deterministic given the same circuit and universal SRS, every builder
produces a byte-identical key, so one published sha256 verifies a rebuilt key too. Each
`largeFiles` entry may carry its own `url`, so the large keys can live on a different host
than the small `files`. Whatever the source, the build script's check still applies. It proves
a witness and verifies it against the committed verification key.

Hosting the large key is what turns the member side from "install circom and rebuild" into
"download one checksummed file," which matters most for a masternode operator running the
prover on the node itself, where the key lives once alongside the chain data.

## What the prover expects

`prover/prover.js` reads `circuits/build/mno_membership.zkey` and
`circuits/build/mno_membership_js/mno_membership.wasm`. Run `scripts/build_proving_key.sh`
once (or download the artifacts into `circuits/build/`) before proving. The verification
key is already in place, committed, so the gateway needs no extra step to boot.
