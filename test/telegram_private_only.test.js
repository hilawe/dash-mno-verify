import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPrivateChat, privateOnly, GROUP_VERIFY_REFUSAL } from "../adapters/telegram/private_only.js";

// Review finding F1 (2026-09-29). The Telegram bot answered /verify and checked uploaded proofs in group
// chats, so the group saw who sought or completed masternode verification. These drive the REAL
// adapters/telegram/bot.js handlers (test/telegram/handler_probe.mjs replaces only Telegram, the gateway,
// and the file download) and count what each chat type made them do.
const probe = fileURLToPath(new URL("./telegram/handler_probe.mjs", import.meta.url));
const runs = JSON.parse(execFileSync("node", ["--experimental-vm-modules", probe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }));

for (const type of ["group", "supergroup", "channel"]) {
  test(`in a ${type} chat, /verify gets only the private-chat instruction and reaches no gateway`, () => {
    const r = runs[`verify:${type}`];
    assert.deepEqual(r.fetches, []);
    assert.deepEqual(r.replies, [GROUP_VERIFY_REFUSAL]);
  });

  test(`in a ${type} chat, an uploaded file is ignored without a reply, a download, or a gateway call`, () => {
    const r = runs[`document:${type}`];
    assert.deepEqual(r.fetches, []);
    assert.equal(r.getFileCalls, 0);
    assert.equal(r.fileFetches, 0);
    assert.deepEqual(r.replies, []);
  });
}

test("contrary: in a private chat, /verify fetches a challenge and sends the file and the steps", () => {
  const r = runs["verify:private"];
  assert.deepEqual(r.fetches, ["https://verify.example.org/v1/challenge"]);
  assert.equal(r.replies[0].document, "challenge.json");
  assert.match(r.replies[1], /This challenge expires at 2026-09-29 16:50 UTC\./);
  assert.match(r.replies[1], /This proves you control an eligible masternode voting key/);
  assert.doesNotMatch(r.replies[1], /never leave/);
});

test("contrary: in a private chat, an uploaded proof is downloaded, verified, and answered", () => {
  const r = runs["document:private"];
  assert.equal(r.getFileCalls, 1);
  assert.equal(r.fileFetches, 1);
  assert.deepEqual(r.fetches, ["https://verify.example.org/v1/verify"]);
  assert.match(r.replies[0], /^Verified\. Request to join here: /);
  assert.match(r.replies[0], /Verifying again before then does not extend it\. After it ends, send \/verify again, and register first if a new season has started\./);
  assert.doesNotMatch(r.replies[0], /re-verify before then/);
});

test("the guard itself passes only private chats", async () => {
  const seen = [];
  const guarded = privateOnly(async () => seen.push("handled"), async () => seen.push("refused"));
  for (const chat of [{ type: "private" }, { type: "group" }, { type: "supergroup" }, { type: "channel" }, undefined]) await guarded({ chat });
  assert.deepEqual(seen, ["handled", "refused", "refused", "refused", "refused"]);
  assert.equal(isPrivateChat({}), false, "a missing chat type is not private");
});

// Review of the repairs (2026-09-29). A 401 carries no reason code, and it means the adapter's secret does
// not match the gateway's, which no member can fix by proving again.
test("a gateway refusal with no reason code is reported as a service problem with its status", () => {
  const r = runs["document:private:401"];
  assert.equal(r.replies.length, 1);
  assert.match(r.replies[0], /^Not verified\. This is a problem with the verification service, not with your proof\./);
  assert.match(r.replies[0], /Reason code: http-401$/);
});
