import { test } from "node:test";
import assert from "node:assert/strict";
import { proveInstructions } from "../common/prover_instructions.js";

// Pin the prover commands the adapters show. The two-tier commands must be copy-pasteable: the
// gateway URL, platform, community, and role are filled in from the adapter's context (a wrong guess
// would register into a tree that does not satisfy the challenge), and only <WIF>, the member's own
// voting key, stays a placeholder. The single-tier prover reads the oracle locally, so it needs none.
const CTX = { gateway: "https://gw.example", platform: "discord", community: "C123", role: "R456" };

test("single-tier renders the full prover and needs no gateway URL or context", () => {
  const lines = proveInstructions("single", CTX);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /npm run prove\b/);
  assert.match(lines[0], /--challenge challenge\.json/);
  assert.match(lines[0], /--voting-key/);
  assert.doesNotMatch(lines[0], /--gateway/, "single-tier reads the oracle locally");
  assert.doesNotMatch(lines[0], /prove-epoch/);
});

test("two-tier fills in the concrete gateway, platform, community, and role", () => {
  const [prove, register] = proveInstructions("two-tier", CTX);
  assert.match(prove, /npm run prove-epoch\b/);
  assert.match(prove, /--gateway https:\/\/gw\.example/);
  assert.match(prove, /--challenge challenge\.json/);
  assert.match(prove, /--secret/);
  assert.match(register, /npm run register\b/);
  assert.match(register, /--gateway https:\/\/gw\.example/);
  assert.match(register, /--platform discord/);
  assert.match(register, /--community C123/);
  assert.match(register, /--role R456/);
  assert.match(register, /--voting-key <WIF>/);
  // <WIF> is the only placeholder left; everything the adapter knows is filled in.
  for (const line of [prove, register]) {
    const unfilled = (line.match(/<[^>]+>/g) ?? []).filter((p) => p !== "<WIF>");
    assert.deepEqual(unfilled, [], `unfilled placeholders in: ${line}`);
  }
});

test("two-tier without context falls back to angle-bracket placeholders", () => {
  assert.match(proveInstructions("two-tier")[0], /--gateway <gateway-url>/);
});

test("an unknown mode falls back to the single-tier command", () => {
  assert.deepEqual(proveInstructions(undefined, CTX), proveInstructions("single"));
});
