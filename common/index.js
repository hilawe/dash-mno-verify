// Shared primitives used by both the prover and the verification gateway.
// Keeping them in one place is what guarantees the two sides agree on the
// context hash, the signal hash, and the epoch index. If those drift apart,
// otherwise valid proofs stop verifying.
import { createHash } from "node:crypto";
// BN254 (alt_bn128) scalar field, the field Circom and snarkjs operate over. Defined once in
// common/field.js and re-exported here, so the hash-to-field reduction and the canonical-element
// check cannot drift to different moduli.
import { FIELD_PRIME } from "./field.js";
export { FIELD_PRIME };

// Hash an arbitrary string into a field element. Read the SHA-256 digest as a
// big-endian integer and reduce into the field.
export function hashToField(s) {
  const digest = createHash("sha256").update(s, "utf8").digest("hex");
  return BigInt("0x" + digest) % FIELD_PRIME;
}

// Domain separator that scopes a membership to one community, platform, and role.
// The same voting key used in a different context yields an unrelated nullifier,
// so nothing correlates across communities or applications.
export function contextHash({ platform, communityId, roleId, version = "v2" }) {
  // Unambiguous tuple encoding: JSON-array the components so a colon inside any field
  // cannot shift a boundary. The old v1 delimiter join let community "a:b" + role "c"
  // share a preimage with community "a" + role "b:c" (this makes the preimage
  // unambiguous; the hash itself still collides by pigeonhole, just not infeasibly).
  // The version is bumped to v2 because every derived context value changes, so a
  // deployment must cut over at a season boundary, not run v1 and v2 side by side. The
  // circuits take contextHash as an opaque field-element public input (they never
  // reconstruct it from parts), so this is a JS-only change with no R1CS or key change.
  return hashToField(
    `dash-mno-verify:context:${version}:` +
      JSON.stringify([String(platform), String(communityId), String(roleId)])
  );
}

// Bind a proof to one challenge AND to the account it was issued for. The proof commits to this
// value (Circom's signal trick), and the gateway checks the committed value against the one it minted
// for the account, so a valid proof issued for one account cannot be relayed to grant another (review
// finding B1). The account is mixed in here, outside the circuit, so this needs no circuit change.
export function signalHash(nonce, account) {
  // Unambiguous tuple encoding, same as contextHash: a colon in the account can no
  // longer make one (nonce, account) share a preimage with another. Also an opaque
  // field-element public input, so this is a JS-only change with no circuit change.
  return hashToField(
    `dash-mno-verify:signal:v2:` + JSON.stringify([String(nonce), String(account)])
  );
}

// Epoch index. Time-based by default so an adapter does not need its own Dash node.
// The gateway is the single source of truth: it issues the epoch inside the
// challenge and the prover echoes it back, which sidesteps clock-skew disputes.
export function epochNow(epochSeconds, nowSeconds) {
  return Math.floor(nowSeconds / epochSeconds);
}

// Season index for the two-tier flow. Registration is valid for one season, after which
// members re-register against the then-current masternode list.
export function seasonNow(seasonSeconds, nowSeconds) {
  return Math.floor(nowSeconds / seasonSeconds);
}

// When a verified grant ends, in unix seconds. Every grant ends with the epoch its challenge was
// minted in. A TWO-TIER grant also ends with that challenge's SEASON, because the season's members
// tree is what vouched for the member, and that tree is cleared at the season boundary.
//
// Found on 2026-09-27 (review finding F1). The gateway returned only the epoch end. Epochs (7 days)
// and seasons (90 days) do not share boundaries by default, so a grant minted just before a season
// ended outlived it by up to six days, after the members tree had already been emptied. Pass season
// and seasonSeconds only for a two-tier grant. Single-tier has no season, and its expiry is unchanged.
export function grantExpiresAt({ epoch, epochSeconds, season = null, seasonSeconds = null }) {
  const epochEnd = (Number(epoch) + 1) * epochSeconds;
  if (season === null || season === undefined) return epochEnd;
  if (!(seasonSeconds > 0)) throw new Error("grantExpiresAt: a season needs a positive seasonSeconds");
  return Math.min(epochEnd, (Number(season) + 1) * seasonSeconds);
}

// Identifies the epoch and season schedule a durable store was written under. Season and epoch
// numbers are derived from these lengths, so changing either RENUMBERS every period: a modest change
// can make today's season number equal a season number from the old schedule, and a store keyed only
// by that integer would rebuild those old registrations and revive members who never re-proved. A
// store records this and refuses to open under a different one.
export function scheduleId(epochSeconds, seasonSeconds) {
  return `e${Number(epochSeconds)}s${Number(seasonSeconds)}`;
}
