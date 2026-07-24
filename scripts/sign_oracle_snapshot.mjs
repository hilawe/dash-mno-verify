// Add this signer's signature to an existing oracle snapshot, for a quorum. One snapshot is built
// once (by oracle/oracle.js), then each independent signer runs this to add its entry, so the gateway
// sees one snapshot carrying the quorum of signatures. Before signing, it recomputes the root from the
// published leaves and refuses to sign an inconsistent snapshot, so a signer never vouches for a
// tampered membership set. A rigorous signer should go further and rebuild the snapshot from its own
// node at the same height and confirm the root matches, which is the independent attestation the
// quorum is meant to provide; that is the chain-anchor follow-up in TODO.md.
//
// Usage: MNO_ORACLE_SIGNING_KEY=key.pem node scripts/sign_oracle_snapshot.mjs oracle/root.json
import { readFile, writeFile, rename } from "node:fs/promises";
import process from "node:process";
import { createPrivateKey } from "node:crypto";
import { makeDmlRootHasher } from "../core/dml_root.js";
import { shaRootFromLeaves } from "../common/dml_sha_root.js";
import { addSignature } from "../common/oracle_sig.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: MNO_ORACLE_SIGNING_KEY=<pem> node scripts/sign_oracle_snapshot.mjs <snapshot.json>");
  process.exit(1);
}
const keyEnv = process.env.MNO_ORACLE_SIGNING_KEY;
if (!keyEnv) {
  console.error("set MNO_ORACLE_SIGNING_KEY to the PKCS8 PEM private key (file path or inline)");
  process.exit(1);
}

const snapshot = JSON.parse(await readFile(file, "utf8"));
const recomputed = (await makeDmlRootHasher(snapshot.depth))(snapshot.leaves ?? []);
if (recomputed !== String(snapshot.root)) {
  console.error(`refusing to sign: root ${snapshot.root} does not hash from the leaves (recomputed ${recomputed})`);
  process.exit(1);
}
// A v2 snapshot also carries the SHA-256 root, which the v2 signature covers, so recompute it from
// the same leaves before signing. Refuse to attest a shaRoot that does not hash from the leaves.
if (snapshot.shaRoot != null) {
  const shaRecomputed = shaRootFromLeaves(snapshot.leaves ?? [], snapshot.depth);
  if (shaRecomputed !== String(snapshot.shaRoot)) {
    console.error(`refusing to sign: shaRoot ${snapshot.shaRoot} does not hash from the leaves (recomputed ${shaRecomputed})`);
    process.exit(1);
  }
}

const pem = keyEnv.includes("BEGIN") ? keyEnv : await readFile(keyEnv, "utf8");
snapshot.sigs = addSignature(snapshot, createPrivateKey(pem));

// Atomic replace, so a reader never sees a half-written snapshot.
const tmp = `${file}.tmp`;
await writeFile(tmp, JSON.stringify(snapshot));
await rename(tmp, file);
const added = snapshot.sigs[snapshot.sigs.length - 1].key;
console.error(`[sign] added ${added}, ${snapshot.sigs.length} signature(s) total -> ${file}`);
