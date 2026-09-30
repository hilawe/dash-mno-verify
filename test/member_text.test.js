import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isChallengeFile, CHALLENGE_NOT_PROOF } from "../common/member_text.js";
import { challengeNotProofReply } from "../adapters/discord/messages.js";

// 2026-09-30. A member attached challenge.json in place of proof.json. The file is recognized from its
// contents, whatever the browser named it, so it can be answered before the gateway is asked.
const challenge = { nonce: "n", signalHash: "1", epoch: 1, root: "2", contextHash: "3", challengeExpiresAt: 1, mode: "two-tier" };

test("a challenge is recognized, and a proof or anything else is not", () => {
  assert.equal(isChallengeFile(challenge), true);
  assert.equal(isChallengeFile({ nonce: "n", proof: {}, publicSignals: [] }), false, "a real proof");
  assert.equal(isChallengeFile({ ...challenge, proof: {} }), false, "anything carrying a proof goes to the gateway");
  for (const other of [null, undefined, [], "text", 7, {}, { nonce: "n" }, { signalHash: 1 }]) {
    assert.equal(isChallengeFile(other), false, JSON.stringify(other));
  }
});

test("the reply says what the file is, what to send instead, and that the challenge is still usable", () => {
  assert.match(CHALLENGE_NOT_PROOF, /^That is the challenge file, not the proof\. Run the prove command on it, which saves proof\.json/);
  assert.match(CHALLENGE_NOT_PROOF, /did not use it up\.$/);
  assert.match(challengeNotProofReply(), /^\*\*Not the proof\.\*\* That is the challenge file, not the proof\. Run the prove command on it, which saves `proof\.json`/);
});

// Source checks, not behavior. Discord's /submit and Matrix's pasted-proof handler are not driven by a
// test here (Telegram's is, in telegram_private_only.test.js), so these pin that each answers a challenge
// file BEFORE its request to the gateway, and that Matrix stays silent outside a private room.
const source = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
test("Discord's /submit answers a challenge file before it asks the gateway", () => {
  const src = source("../adapters/discord/bot.js");
  const check = src.indexOf("if (isChallengeFile(payload)) return i.editReply(challengeNotProofReply());");
  const verify = src.indexOf("${GATEWAY}/v1/verify");
  assert.ok(check > 0, "the check is present");
  assert.ok(check < verify, "and comes before the verify request");
});

test("Matrix answers a pasted challenge only in a private room, before it asks the gateway", () => {
  const src = source("../adapters/matrix/bot.js");
  const check = src.indexOf("if (isChallengeFile(payload)) return isPrivate() ? sendText(roomId, CHALLENGE_NOT_PROOF) : undefined;");
  const verify = src.indexOf("${GATEWAY}/v1/verify");
  assert.ok(check > 0, "the check is present, replying only when isPrivate()");
  assert.ok(check < verify, "and comes before the verify request");
});
