import { test } from "node:test";
import assert from "node:assert";

import { contextHash, signalHash } from "../common/index.js";

// Regression for the ambiguous colon-joined encoding: distinct component tuples must
// no longer share a serialized preimage once a field can contain the delimiter. This
// tests the encoding, not hash injectivity (hashToField collides by pigeonhole).
test("contextHash gives distinct delimiter-containing tuples distinct preimages", () => {
  const a = contextHash({ platform: "p", communityId: "a:b", roleId: "c" }).toString();
  const b = contextHash({ platform: "p", communityId: "a", roleId: "b:c" }).toString();
  assert.notEqual(a, b, "distinct (community, role) tuples must not share a preimage");
});

test("signalHash gives a colon-containing account a distinct preimage", () => {
  const a = signalHash("n:1", "acct").toString();
  const b = signalHash("n", "1:acct").toString();
  assert.notEqual(a, b, "distinct (nonce, account) tuples must not share a preimage");
});

test("contextHash and signalHash are stable for identical inputs", () => {
  const c = { platform: "discord", communityId: "123", roleId: "admin" };
  assert.equal(contextHash(c).toString(), contextHash(c).toString());
  assert.equal(signalHash("nonce", "acct").toString(), signalHash("nonce", "acct").toString());
});
