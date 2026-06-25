// Shared primitives used by both the prover and the verification gateway.
// Keeping them in one place is what guarantees the two sides agree on the
// context hash, the signal hash, and the epoch index. If those drift apart,
// otherwise valid proofs stop verifying.
import { createHash } from "node:crypto";

// BN254 (alt_bn128) scalar field, the field Circom and snarkjs operate over.
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Hash an arbitrary string into a field element. Read the SHA-256 digest as a
// big-endian integer and reduce into the field.
export function hashToField(s) {
  const digest = createHash("sha256").update(s, "utf8").digest("hex");
  return BigInt("0x" + digest) % FIELD_PRIME;
}

// Domain separator that scopes a membership to one community, platform, and role.
// The same voting key used in a different context yields an unrelated nullifier,
// so nothing correlates across communities or applications.
export function contextHash({ platform, communityId, roleId, version = "v1" }) {
  return hashToField(
    `dash-mno-verify:${version}:${platform}:${communityId}:${roleId}`
  );
}

// Bind a proof to one challenge so it cannot be replayed on another account.
export function signalHash(nonce) {
  return hashToField(`dash-mno-verify:signal:${nonce}`);
}

// Epoch index. Time-based by default so an adapter does not need its own Dash node.
// The gateway is the single source of truth: it issues the epoch inside the
// challenge and the prover echoes it back, which sidesteps clock-skew disputes.
export function epochNow(epochSeconds, nowSeconds) {
  return Math.floor(nowSeconds / epochSeconds);
}
