import { test } from "node:test";
import assert from "node:assert/strict";
import { proveInstructions } from "../common/prover_instructions.js";

// Pin the prover commands the adapters show, so a runnable mismatch (like a missing --gateway flag
// for the two-tier prove, which fetches the members tree) is caught without booting the gateway.

test("single-tier renders the full prover and needs no gateway URL", () => {
  const lines = proveInstructions("single");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /npm run prove\b/);
  assert.match(lines[0], /--challenge challenge\.json/);
  assert.match(lines[0], /--voting-key/);
  assert.doesNotMatch(lines[0], /--gateway/, "single-tier reads the oracle locally");
  assert.doesNotMatch(lines[0], /prove-epoch/);
});

test("two-tier renders prove-epoch with the gateway URL it needs to fetch the members tree", () => {
  const lines = proveInstructions("two-tier");
  assert.match(lines[0], /npm run prove-epoch\b/);
  assert.match(lines[0], /--gateway/);
  assert.match(lines[0], /--challenge challenge\.json/);
  assert.match(lines[0], /--secret/);
  assert.ok(lines.some((l) => /npm run register\b/.test(l)), "includes the once-per-season register reminder");
});

test("an unknown mode falls back to the single-tier command", () => {
  assert.deepEqual(proveInstructions(undefined), proveInstructions("single"));
});
