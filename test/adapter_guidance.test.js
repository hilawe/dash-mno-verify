import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Review finding F6. The Discord bot told operators to express an exclusion with a role-level deny,
// which does not work, because the bot's member-level allow outranks role denies (see
// adapters/discord/README.md, "How access is granted"). A source-level guard, so the advice cannot quietly come back in
// a message or comment.
test("no Discord adapter file recommends a role-level deny as an exclusion", () => {
  const dir = new URL("../adapters/discord/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /express the exclusion with a role-level deny/i, `${f} recommends a role-level deny`);
    assert.doesNotMatch(src, /fixes it with a role-level deny/i, `${f} recommends a role-level deny`);
  }
});

// A review of the first repair found its replacement advice wrong too. It said to take the channel out
// of DISCORD_GRANT_CHANNEL_IDS to keep a member out, but that only stops the bot managing the channel
// and leaves every grant it made in place. Wherever the exclusion messages mention the channel list,
// they must send the operator through the decommission command first.
test("the exclusion messages send an operator through decommission before dropping a channel", () => {
  // Messages are written as template pieces joined with `+` across lines, so join them back before matching.
  const read = (f) => readFileSync(new URL(`../adapters/discord/${f}`, import.meta.url), "utf8").replace(/`\s*\+\s*`/g, "");
  const bot = read("bot.js");
  const quarantine = bot.slice(bot.indexOf("is QUARANTINED"), bot.indexOf("Admissions stay closed"));
  const perms = read("permissions.js");
  const conflict = perms.slice(perms.indexOf("override an exclusion"), perms.indexOf("override an exclusion") + 700);
  for (const [name, msg] of [["bot.js quarantine", quarantine], ["permissions.js conflict", conflict]]) {
    assert.ok(msg.length > 50, `${name} message found`);
    if (/DISCORD_GRANT_CHANNEL_IDS/.test(msg)) assert.match(msg, /discord:decommission/, `${name} names the list without decommission`);
    assert.match(msg, /no supported per-member exclusion/i, `${name} states the limit plainly`);
  }
});
