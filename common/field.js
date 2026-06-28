// The BN254 (alt_bn128) scalar field convention, shared by everything that handles field elements:
// the oracle snapshot validation, the DML root recompute, and the proof public signals. It lives in
// its own module so the verifier can validate signals without importing the Poseidon hasher.
//
// A canonical element has exactly one decimal spelling: no leading zeros (so "0", "1", "1234", never
// "01" or "00"), and a value in [0, FIELD_PRIME). Both rules matter because the field arithmetic maps
// many strings to one element. An out-of-range value like x + p reduces mod p, and a leading-zero
// value like "01" is the same integer as "1", so without this check two string-distinct values could
// denote one field element and, used as a nullifier key, spend one membership twice. Requiring the one
// canonical spelling before a value is hashed or used as a key is what stops that aliasing.
export const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// The most decimal digits a canonical element can have, so an oversized hostile decimal is rejected by
// length before the O(digits) BigInt parse.
const MAX_FIELD_DIGITS = (FIELD_PRIME - 1n).toString().length;

// Requiring a string (every real signal, leaf, and root arrives as a JSON string) also rejects a
// number or an array like ["1"] that would otherwise coerce to a canonical-looking decimal.
export const isCanonicalField = (v) =>
  typeof v === "string" && /^(0|[1-9]\d*)$/.test(v) && v.length <= MAX_FIELD_DIGITS && BigInt(v) < FIELD_PRIME;
