// The nullifier and commitment derivation chains, spelled independently in JS so the circuits can
// be differentially checked against them (scripts/check_circuits.sh, the derivation checks).
//
// These are the same chains the circuits compute in circomlib Poseidon:
//   mno_members.circom      nullifier    = Poseidon3(secret, epoch, contextHash)
//   mno_membership.circom   nullifier    = Poseidon4(TAG_SINGLE_TIER, Poseidon4(privkey limbs), epoch, contextHash)
//   mno_registration.circom regNullifier = Poseidon4(TAG_REGISTRATION, Poseidon4(privkey limbs), season, contextHash)
//   mno_registration.circom commitment   = Poseidon1(secret), also the members-tree leaf
//
// The two purpose tags are recomputed here from their labels with node:crypto, not imported from
// common/purpose_tags.js or read from circuits/purpose_tags.circom, so a wrong tag in either of those
// fails the comparison rather than agreeing with itself.
//
// The seam this pins is cross-implementation agreement, circomlibjs (what the prover and the
// members tree use) against circomlib's circuit templates (what the proofs compute), over the
// exact input order, arity, and limb order of each chain. Production depends on that agreement
// already: prover/two_tier.js derives Poseidon(secret) in JS to find its leaf in the members
// tree the gateway built in JS, and the circuit must reproduce both. A disagreement here is a
// member who can never prove, or a spent tag that no longer follows the intended derivation.
//
// What this does not establish: anything about Poseidon itself, or the ECDSA component. The
// chains are checked as wirings of Poseidon, against an independent spelling of the same wiring.

import { createHash } from "node:crypto";

// nullifier chain of the cheap per-epoch members circuit
export function membersNullifier(poseidon, secret, epoch, contextHash) {
  const F = poseidon.F;
  return F.toObject(poseidon([F.e(secret), F.e(epoch), F.e(contextHash)])).toString();
}

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const tagOf = (label) => BigInt("0x" + createHash("sha256").update(label, "utf8").digest("hex")) % BN254_R;
export const TAG_SINGLE_TIER = tagOf("dash-mno-verify:purpose:single-tier-admission:v1");
export const TAG_REGISTRATION = tagOf("dash-mno-verify:purpose:seasonal-registration:v1");

function taggedKeyNullifier(poseidon, tag, privkeyLimbs, period, contextHash) {
  const F = poseidon.F;
  const keyHash = poseidon(privkeyLimbs.map((l) => F.e(BigInt(l))));
  return F.toObject(poseidon([F.e(tag), keyHash, F.e(period), F.e(contextHash)])).toString();
}

// nullifier chain of the single-tier circuit, per epoch
export function singleTierNullifier(poseidon, privkeyLimbs, epoch, contextHash) {
  return taggedKeyNullifier(poseidon, TAG_SINGLE_TIER, privkeyLimbs, epoch, contextHash);
}

// registration nullifier chain of the registration circuit, per season
export function registrationNullifier(poseidon, privkeyLimbs, season, contextHash) {
  return taggedKeyNullifier(poseidon, TAG_REGISTRATION, privkeyLimbs, season, contextHash);
}

// the member commitment, also the members-tree leaf
export function commitment(poseidon, secret) {
  const F = poseidon.F;
  return F.toObject(poseidon([F.e(secret)])).toString();
}
