import { test } from "node:test";
import assert from "node:assert/strict";
import { isCanonicalField, FIELD_PRIME } from "../common/field.js";

// A field element must have exactly one accepted spelling, or two string-distinct values for one
// element could be used as two nullifier keys and spend one membership twice. This table pins both
// rules: the value is in [0, FIELD_PRIME), and it is the canonical decimal with no leading zeros.

test("canonical decimal values in range are accepted", () => {
  for (const v of ["0", "1", "9", "1234567890", (FIELD_PRIME - 1n).toString()]) {
    assert.equal(isCanonicalField(v), true, v);
  }
});

test("out-of-range values are rejected, including p itself and p + 1", () => {
  for (const v of [FIELD_PRIME.toString(), (FIELD_PRIME + 1n).toString(), (FIELD_PRIME * 2n).toString()]) {
    assert.equal(isCanonicalField(v), false, v);
  }
});

test("leading-zero and other non-canonical spellings are rejected", () => {
  // "01" and "1" are the same integer, so accepting both would alias one field element to two keys.
  for (const v of ["01", "00", "001", "0001234", "007"]) {
    assert.equal(isCanonicalField(v), false, JSON.stringify(v));
  }
});

test("non-decimal junk is rejected", () => {
  for (const v of ["", " 1", "1 ", "-1", "1.0", "0x1", "1e3", "abc", "+1", null, undefined, "12n"]) {
    assert.equal(isCanonicalField(v), false, JSON.stringify(v));
  }
});

test("non-string inputs are rejected, including a number or an array that would coerce to a decimal", () => {
  for (const v of [1, 0, 1234, ["1"], [1], { toString: () => "1" }, true]) {
    assert.equal(isCanonicalField(v), false, String(v));
  }
});

test("an oversized decimal is rejected by length before the BigInt parse", () => {
  assert.equal(isCanonicalField("9".repeat(100000)), false);
});
