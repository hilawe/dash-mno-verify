import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("../contract/mno-verify.contract.json", import.meta.url)));

test("A13: the immutable root document types are also non-deletable", () => {
  // documentsMutable:false blocks an update in place, but without canBeDeleted:false a published root
  // could be swapped by delete-then-recreate at the same height or season, defeating the append-only
  // intent that immutability is meant to provide. All four durable types must set both.
  for (const type of ["dmlRoot", "membersRoot", "nullifier", "registration"]) {
    assert.equal(contract[type].documentsMutable, false, `${type} is immutable`);
    assert.equal(contract[type].canBeDeleted, false, `${type} is non-deletable, so it cannot be swapped by delete-then-recreate`);
  }
});
