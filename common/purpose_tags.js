// The purpose tags that separate the two key-derived nullifiers from each other and from the members
// nullifier (tools/circuit-analysis/RESULTS.md, item A3).
//
// Both heavy circuits derive their nullifier from the same key hash, Poseidon(privkey limbs). Untagged,
// the single-tier nullifier Poseidon(keyHash, epoch, context) and the registration nullifier
// Poseidon(keyHash, season, context) were the same function, so they were equal whenever an epoch number
// equaled a season number for one context. The members nullifier Poseidon(secret, epoch, context) had
// the same shape again, and the members circuit accepts any secret, so a member who chose secret =
// keyHash reproduced the single-tier nullifier exactly. A secret's intended origin is not separation.
//
// Each key-derived nullifier now hashes a fixed tag first, Poseidon(tag, keyHash, period, context), a
// four-input Poseidon. That separates the two from each other by the tag, and from the three-input
// members nullifier by arity, because circomlib's Poseidon for four inputs is a different permutation
// (width 5) from the one for three (width 4), with its own round constants, so equality across them
// would be a Poseidon collision. Each tag is also above 2^64, so it can never equal a range-checked key
// limb, and the tagged hash never has the same inputs as the four-input key hash Poseidon(limbs).
//
// The values are fixed field elements, not computed in the circuit. circuits/purpose_tags.circom spells
// them as literals, test/purpose_tags.test.js checks the two spellings agree with the derivation below,
// and the CI derivation checks confirm the compiled circuits emit nullifiers built from them.
import { hashToField } from "./index.js";

export const PURPOSE_LABELS = Object.freeze({
  singleTierAdmission: "dash-mno-verify:purpose:single-tier-admission:v1",
  seasonalRegistration: "dash-mno-verify:purpose:seasonal-registration:v1",
});

export const TAG_SINGLE_TIER_ADMISSION = hashToField(PURPOSE_LABELS.singleTierAdmission);
export const TAG_SEASONAL_REGISTRATION = hashToField(PURPOSE_LABELS.seasonalRegistration);
