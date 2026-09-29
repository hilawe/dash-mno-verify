import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReply, verifiedReply, accessEndedNotice, failureReply, splitForDiscord, escapeMarkdown, MAX_CONTENT } from "../adapters/discord/messages.js";
import { proveSteps } from "../common/prover_instructions.js";

// The Discord adapter's member-facing text (adapters/discord/messages.js), rewritten after the Discord
// pilot (2026-09-29) found it hard to follow. These pin the layout members rely on and the defects that
// prompted the rewrite.

// Realistic lengths: an 18-digit guild id and a long https gateway, so the length check is not flattered.
const CTX = { gateway: "https://verify.masternode-community.example.org", platform: "discord", community: "398654604268797954", role: "mn-members" };
const T = { challengeExpiresAt: 1790700000, accessEndsAt: 1796256000, seasonEndsAt: 1796256000 };
const twoTier = (over = {}) => verifyReply({ challenge: { mode: "two-tier", ...T, ...over }, steps: proveSteps("two-tier", CTX), guideUrl: "https://example.org/guide" });
const fences = (text) => text.match(/```\n([^`]+)\n```/g) ?? [];

test("the two-tier reply lays out register, prove, submit in order, each command in its own code block", () => {
  const text = twoTier();
  const at = (s) => text.indexOf(s);
  assert.ok(at("### 1. Register (first time this season only)") > 0);
  assert.ok(at("### 2. Make your proof") > at("### 1. Register"));
  assert.ok(at("### 3. Submit it") > at("### 2. Make your proof"));
  const { register, prove } = proveSteps("two-tier", CTX);
  assert.deepEqual(fences(text), ["```\n" + register + "\n```", "```\n" + prove + "\n```"], "exactly the two commands, verbatim");
  assert.ok(at(register) < at(prove));
});

test("every time is a Discord timestamp, and the deadline no longer reads 'expires ... ago'", () => {
  const text = twoTier();
  assert.match(text, /Use it before \*\*<t:1790700000:t>\*\* \(<t:1790700000:R>\)/);
  assert.match(text, /access lasts until \*\*<t:1796256000:f>\*\*/);
  assert.match(text, /Registration lasts until \*\*<t:1796256000:D>\*\*/);
  // The old text spliced a relative timestamp after "expires", which rendered "expires 32 minutes ago".
  assert.doesNotMatch(text, /expires <t:\d+:R>/);
  assert.doesNotMatch(text, /UTC/);
});

test("a challenge without the time fields renders no broken timestamps", () => {
  const text = verifyReply({ challenge: { mode: "two-tier" }, steps: proveSteps("two-tier", CTX) });
  assert.doesNotMatch(text, /<t:(undefined|null|NaN)/);
  assert.doesNotMatch(text, /Registration lasts until/);
  assert.doesNotMatch(text, /access lasts until/);
  assert.match(text, /If it expires, type `\/verify` again/);
});

test("the reply fits in one Discord message", () => {
  assert.ok(twoTier().length < MAX_CONTENT, `${twoTier().length} characters`);
});

test("the placeholder note appears only when the member-facing gateway is unknown", () => {
  assert.doesNotMatch(twoTier(), /<gateway-url>/);
  const unknown = verifyReply({ challenge: { mode: "two-tier", ...T }, steps: proveSteps("two-tier", { ...CTX, gateway: null }) });
  assert.match(unknown, /Replace `<gateway-url>` with the gateway address a server admin gives you/);
  assert.doesNotMatch(unknown, /127\.0\.0\.1|localhost/);
});

test("the single-tier reply has no register step and explains the key file where the key is used", () => {
  const text = verifyReply({ challenge: { mode: "single", challengeExpiresAt: 1790700000, accessEndsAt: 1790800000 }, steps: proveSteps("single", CTX) });
  assert.doesNotMatch(text, /Register/);
  assert.match(text, /### 1\. Make your proof/);
  assert.match(text, /### 2\. Submit it/);
  assert.match(text, /`voting-key\.txt` is a file holding your masternode's voting private key/);
  assert.equal(fences(text).length, 1);
});

test("the setup guide link is a masked link that does not unfurl, and is omitted without a URL", () => {
  assert.match(twoTier(), /\[setup guide\]\(<https:\/\/example\.org\/guide>\)/);
  const none = verifyReply({ challenge: { mode: "two-tier", ...T }, steps: proveSteps("two-tier", CTX) });
  assert.doesNotMatch(none, /setup guide/);
});

test("member-facing prose does not use the internal word 'epoch'", () => {
  // Commands and reason codes are exempt. The npm script is named prove-epoch, and a reason code is
  // quoted for an admin, but neither is prose a member has to understand.
  const prose = (text) => text.split("\n-# Reason code")[0].replace(/```[^`]*```/g, "").replace(/`[^`]*`/g, "");
  for (const text of [twoTier(), verifiedReply({ expiresAt: 1796256000, channelIds: ["1"] }), accessEndedNotice({ guildName: "G" }), ...["epoch-rolled-over", "wrong-epoch"].map(failureReply)]) {
    assert.doesNotMatch(prose(text), /\bepoch\b/i, text);
  }
});

test("the success reply names the granted channels and shows the end in the member's time zone", () => {
  const text = verifiedReply({ expiresAt: 1796256000, channelIds: ["111", "222"] });
  assert.match(text, /access to <#111>, <#222>\. It lasts until \*\*<t:1796256000:f>\*\* \(<t:1796256000:R>\)/);
  assert.match(text, /type `\/verify` again/);
  assert.doesNotMatch(text, /UTC/);
  assert.match(verifiedReply({ expiresAt: 1 }), /access to the masternode channel/);
});

test("the access-ended notice names the server when it is known", () => {
  assert.match(accessEndedNotice({ guildName: "Hilawe's Server" }), /access in \*\*Hilawe's Server\*\* has ended/);
  assert.match(accessEndedNotice(), /access on the server has ended/);
  assert.match(accessEndedNotice(), /type `\/verify` in the server/);
});

test("a refusal is explained in plain words and keeps the reason code for an admin", () => {
  const used = failureReply("already-used");
  assert.match(used, /^\*\*Not verified\.\*\* This membership has already let a different Discord account in/);
  assert.match(used, /-# Reason code: `already-used`$/);
  assert.match(failureReply("unknown-or-expired-challenge"), /expired or was already used/);
  const other = failureReply("engine-mismatch");
  assert.match(other, /Verification failed\. Type `\/verify` to start over\./);
  assert.match(other, /`engine-mismatch`/);
});

test("a reason that is not a plain code is not echoed into the message", () => {
  for (const hostile of ["`@everyone`", "a\nb", "x".repeat(65), null, undefined, 42]) {
    assert.match(failureReply(hostile), /Reason code: `unknown`$/, String(hostile));
  }
});

// Review of the rewrite: a long but valid configured gateway address (427 characters) pushed the reply
// past Discord's limit, which would have lost the challenge entirely, and 80 configured channels did the
// same to the confirmation after access was already granted.
test("a reply too long for one message is split at section breaks, losing nothing", () => {
  const long = { ...CTX, gateway: "https://" + "a".repeat(600) + ".example.org" };
  const text = verifyReply({ challenge: { mode: "two-tier", ...T }, steps: proveSteps("two-tier", long), guideUrl: "https://example.org/guide" });
  assert.ok(text.length > MAX_CONTENT, "the case really is over the limit");
  const pieces = splitForDiscord(text);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) assert.ok(p.length <= MAX_CONTENT, `${p.length} characters`);
  assert.equal(pieces.join("\n\n"), text, "split only at blank lines, so rejoining gives the original");
  for (const p of pieces) assert.equal((p.match(/```/g) ?? []).length % 2, 0, "no code block is cut in half");
  assert.deepEqual(splitForDiscord(twoTier()), [twoTier()], "an ordinary reply stays one message");
});

test("a single section longer than the limit is still cut to size as a last resort", () => {
  const pieces = splitForDiscord("x".repeat(4500));
  assert.deepEqual(pieces.map((p) => p.length), [2000, 2000, 500]);
});

test("the confirmation names at most ten channels and drops anything that is not a channel id", () => {
  const ids = Array.from({ length: 80 }, (_, k) => String(100000000000000000n + BigInt(k)));
  const text = verifiedReply({ expiresAt: 1796256000, channelIds: ids });
  assert.ok(text.length <= MAX_CONTENT, `${text.length} characters`);
  assert.equal((text.match(/<#\d+>/g) ?? []).length, 10);
  assert.match(text, / and 70 more\./);
  assert.doesNotMatch(verifiedReply({ expiresAt: 1, channelIds: ["@everyone", "12>"] }), /@everyone|12>/);
});

test("a server name cannot inject markup into the access-ended notice", () => {
  const link = accessEndedNotice({ guildName: "[Renew here](https://example.org)" });
  assert.doesNotMatch(link, /(^|[^\\])\[Renew here(?!\\)\]\(/, "the masked link syntax is escaped");
  assert.doesNotMatch(link, /(^|[^\\])https:\/\//, "and a bare URL cannot autolink");
  const bold = accessEndedNotice({ guildName: "a**b" });
  assert.match(bold, /\*\*a\\\*\\\*b\*\*/, "the surrounding bold stays intact");
  assert.equal(escapeMarkdown("two\nlines"), "two lines");
});

test("the setup guide is linked only in two-tier mode, the only setup it covers", () => {
  const single = verifyReply({ challenge: { mode: "single", ...T }, steps: proveSteps("single", CTX), guideUrl: "https://example.org/guide" });
  assert.doesNotMatch(single, /setup guide/);
  assert.match(twoTier(), /setup guide/);
});
