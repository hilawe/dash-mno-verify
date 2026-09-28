import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { TAG_SINGLE_TIER_ADMISSION, TAG_SEASONAL_REGISTRATION, PURPOSE_LABELS } from "../common/purpose_tags.js";
import { TAG_SINGLE_TIER, TAG_REGISTRATION, singleTierNullifier, registrationNullifier, membersNullifier } from "./derivations.mjs";

// Item A3 in tools/circuit-analysis/RESULTS.md. The two key-derived nullifiers hash a fixed purpose tag
// first, which separates them from each other and, by arity, from the members nullifier.

const circomLiteral = (name) => {
  const src = readFileSync(new URL("../circuits/purpose_tags.circom", import.meta.url), "utf8");
  const m = src.match(new RegExp(`function ${name}\\(\\) \\{\\s*return (\\d+);`));
  assert.ok(m, `circuits/purpose_tags.circom defines ${name}`);
  return BigInt(m[1]);
};

test("the circuit literals, the production module, and the independent derivation agree on both tags", () => {
  assert.equal(circomLiteral("TAG_SINGLE_TIER_ADMISSION"), TAG_SINGLE_TIER_ADMISSION);
  assert.equal(circomLiteral("TAG_SEASONAL_REGISTRATION"), TAG_SEASONAL_REGISTRATION);
  assert.equal(TAG_SINGLE_TIER_ADMISSION, TAG_SINGLE_TIER, "test/derivations.mjs recomputes it from the label");
  assert.equal(TAG_SEASONAL_REGISTRATION, TAG_REGISTRATION);
  assert.notEqual(PURPOSE_LABELS.singleTierAdmission, PURPOSE_LABELS.seasonalRegistration);
});

test("the tags are distinct and above 2^64, so neither can equal a range-checked key limb", () => {
  assert.notEqual(TAG_SINGLE_TIER_ADMISSION, TAG_SEASONAL_REGISTRATION);
  for (const t of [TAG_SINGLE_TIER_ADMISSION, TAG_SEASONAL_REGISTRATION]) assert.ok(t >= 2n ** 64n);
});

const poseidon = await buildPoseidon();
const F = poseidon.F;
const limbs = ["1", "0", "0", "0"];
const ctx = 123456789n;
const keyHash = F.toObject(poseidon(limbs.map((l) => F.e(BigInt(l))))).toString();

// The untagged constructions these replace, kept here only to show the separation is real. Each case
// below was an equality before the tags.
const untagged = (period) => F.toObject(poseidon([F.e(BigInt(keyHash)), F.e(period), F.e(ctx)])).toString();

test("single-tier and registration nullifiers differ for one key when the epoch number equals the season number", () => {
  // Untagged, both were untagged(n): one expression, so they were equal by construction.
  const n = 230n;
  assert.notEqual(singleTierNullifier(poseidon, limbs, n, ctx), registrationNullifier(poseidon, limbs, n, ctx));
});

test("a members nullifier with the secret chosen as the key hash no longer reproduces a key-derived nullifier", () => {
  // The members circuit accepts any secret, so a member can pick secret = Poseidon(privkey limbs).
  const epoch = 2960n;
  const chosen = membersNullifier(poseidon, BigInt(keyHash), epoch, ctx);
  assert.equal(chosen, untagged(epoch), "before the tags this was exactly the single-tier nullifier");
  assert.notEqual(chosen, singleTierNullifier(poseidon, limbs, epoch, ctx));
  assert.notEqual(chosen, registrationNullifier(poseidon, limbs, epoch, ctx));
});
