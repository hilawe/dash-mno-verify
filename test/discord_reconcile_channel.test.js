import { test } from "node:test";
import assert from "node:assert/strict";

// discord.js is an optional dependency, so the module that imports it loads inside a guard and the tests
// skip with a reason when it is absent (see test/discord_permissions.test.js).
let OverwriteType, reconcileChannel;
try {
  ({ OverwriteType } = await import("discord.js"));
  ({ reconcileChannel } = await import("../adapters/discord/reconcile_channel.js"));
} catch {
  OverwriteType = null;
}
const OPT = OverwriteType ? {} : { skip: "discord.js is an optional dependency and is not installed" };

// Found 2026-09-30 on the live testnet pilot. Reconciliation looped over the channel's LIVE overwrite
// cache, and the clear path re-fetches the channel, which discord.js answers by rebuilding that cache in
// place. The member being cleared was deleted and set again, landing at the end of the Map the loop was
// walking, so the loop met it again forever. Every restart after the first revocation hung before
// admissions opened.
const BOT = "900";
function channelWith(entries) {
  const cache = new Map(entries.map(([id, type]) => [id, { id, type }]));
  return {
    permissionOverwrites: { cache },
    // What discord.js does on a forced fetch: clear the cache and set every entry again.
    refetch() {
      const again = [...cache.values()];
      cache.clear();
      for (const ow of again) cache.set(ow.id, ow);
    },
  };
}

test("each unauthorized member is cleared exactly once, even though clearing rebuilds the cache", OPT, async () => {
  const ch = channelWith([
    [BOT, OverwriteType.Member],
    ["111", OverwriteType.Member],
    ["222", OverwriteType.Member],
    ["333", OverwriteType.Member],
    ["444", OverwriteType.Role],
  ]);
  const cleared = [];
  await reconcileChannel(ch, {
    botId: BOT,
    authorized: (id) => id === "222",
    clear: async (id) => {
      cleared.push(id);
      if (cleared.length > 20) throw new Error("the pass did not end: it keeps meeting the same members");
      ch.refetch();
    },
  });
  assert.deepEqual(cleared, ["111", "333"], "unauthorized members once each; the bot, the authorized member, and the role are left alone");
});

test("a member whose entry already allows nothing is still visited once and the pass ends", OPT, async () => {
  // The exact live case: one empty member entry left by a revocation, and a fresh ledger.
  const ch = channelWith([[BOT, OverwriteType.Member], ["3059", OverwriteType.Member]]);
  let calls = 0;
  await reconcileChannel(ch, {
    botId: BOT,
    authorized: () => false,
    clear: async () => {
      calls++;
      if (calls > 20) throw new Error("the pass did not end");
      ch.refetch();
    },
  });
  assert.equal(calls, 1);
});
