// Ed25519 signing for oracle snapshots, so the gateway trusts a snapshot because a pinned oracle key
// signed it, not merely because its leaves hash to its root. Recomputing the root from the published
// leaves proves the snapshot is internally consistent, but a compromised source can publish a
// consistent {leaves, root} over an attacker-chosen masternode set. The signature closes that: only a
// holder of a trusted oracle private key can produce one, so the operator can run the signer apart
// from whatever host serves the JSON, and require several independent signers (a quorum).
//
// The signature covers the fields that pin the snapshot to a chain position and a membership set. The
// root commits to the leaves (the gateway recomputes it), so signing the root authenticates the whole
// leaf set without signing every leaf. The block hash is included so a genuine reorg can later be told
// apart from a replayed lower height.
//
// The oracle signing key is a separate operational identity, unrelated to any masternode key.
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";

const DOMAIN_V1 = "mno-oracle-snapshot-v1";
const DOMAIN_V2 = "mno-oracle-snapshot-v2";

// Canonical authenticated message for a snapshot. The oracle and the gateway derive it the same way
// from the snapshot object, so the signed bytes match exactly. The domain prefix stops a signature
// being replayed as one for a different message type, and the version stops a v1 signature (which
// never covered the SHA-256 root) from being replayed as a v2 one over an attacker-chosen shaRoot.
//
// v1: the original fields, unchanged, so existing v1 snapshots and their signatures verify exactly.
// v2: appends the SHA-256 root and an explicit version, the zkVM dual-root snapshot. A v2 snapshot
// MUST carry a shaRoot; the version field, set by the oracle, selects the form so a v1 snapshot with
// a stray shaRoot cannot be verified as v2 (or vice versa).
export function snapshotMessage(o) {
  const version = snapshotVersion(o); // throws on any version other than absent/1/2
  if (version === 2) {
    if (typeof o.shaRoot !== "string") throw new Error("v2 snapshot message requires a string shaRoot");
    const fields = [DOMAIN_V2, "2", o.height, o.blockHash ?? "", o.depth, o.root, o.shaRoot, o.ts];
    return Buffer.from(fields.map((f) => String(f)).join("\n"), "utf8");
  }
  const fields = [DOMAIN_V1, o.height, o.blockHash ?? "", o.depth, o.root, o.ts];
  return Buffer.from(fields.map((f) => String(f)).join("\n"), "utf8");
}

// The canonical snapshot version, failing closed. An absent version or the integer 1 is v1, the
// integer 2 is v2, and everything else (an unknown version, a string, a float) is rejected, so an
// unknown-version snapshot can never be signed or verified under the legacy v1 message and slip
// through with future fields unauthenticated. One dispatch point for the oracle, the signer, and the
// gateway.
export function snapshotVersion(o) {
  const v = o?.version;
  if (v == null || v === 1) return 1;
  if (v === 2) return 2;
  throw new Error(`unsupported oracle snapshot version: ${JSON.stringify(v)}`);
}

// A trusted public key object from the raw 32-byte Ed25519 key an operator pins (base64 or base64url).
export function publicKeyFromRaw(encoded) {
  const raw = Buffer.from(String(encoded).trim(), "base64");
  if (raw.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

// The raw 32-byte public key as base64, for a public or private key object. Used to label a signature
// and to print a freshly generated key for pinning. createPublicKey derives the public half from a
// private key but rejects a key that is already public, so only convert when needed.
export function rawPublicB64(keyObject) {
  const pub = keyObject.type === "private" ? createPublicKey(keyObject) : keyObject;
  const jwk = pub.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

export function signSnapshot(message, privateKey) {
  return sign(null, message, privateKey).toString("base64");
}

// Add this signer's signature to a snapshot's `sigs`, returning the new array. One entry per key: a
// re-sign by the same key replaces its old entry rather than duplicating it. The oracle and the
// standalone signer both use this, so a quorum snapshot is one snapshot carrying one entry per signer.
export function addSignature(snapshot, privateKey) {
  const key = rawPublicB64(privateKey);
  const sig = signSnapshot(snapshotMessage(snapshot), privateKey);
  const others = (snapshot.sigs ?? []).filter((s) => s && s.key !== key);
  return [...others, { key, sig }];
}

// Verify one base64 signature over `message` under `publicKey`. Returns false rather than throwing on
// a malformed signature, so the caller can simply count how many trusted keys verified.
export function verifySnapshotSig(message, sigB64, publicKey) {
  try {
    return verify(null, message, publicKey, Buffer.from(String(sigB64), "base64"));
  } catch {
    return false;
  }
}

// A PKCS8 PEM (inline or already read from a file) to a private key object.
export function privateKeyFromPem(pem) {
  return createPrivateKey(pem);
}
