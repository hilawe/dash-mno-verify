// The startup reconciliation pass over one gated channel, in its own module so it can be tested
// without a Discord connection.
//
// It walks a SNAPSHOT of the channel's member overwrites (found 2026-09-30 on the live testnet pilot).
// The clear path re-fetches the channel before it decides (permissions.js refreshed), and discord.js
// rebuilds the channel's overwrite cache in place on that fetch, deleting each entry and setting it
// again. A loop over the live cache therefore met the same entry again after every clear and never
// ended. It only happened when a member held an overwrite with no live grant, which is exactly what
// a revocation leaves behind, so every restart after the first revocation hung before admissions
// opened, while fetching the channel from Discord without pause.
import { OverwriteType } from "discord.js";

// `authorized(userId)` says whether a live grant covers this member on this channel, and `clear(userId)`
// takes back what the bot manages there. Role overwrites are the operator's, and the bot's own entry
// is its own, so neither is visited.
export async function reconcileChannel(ch, { botId, authorized, clear }) {
  const members = [...ch.permissionOverwrites.cache.values()].filter(
    (ow) => ow.type === OverwriteType.Member && String(ow.id) !== String(botId),
  );
  for (const ow of members) {
    if (authorized(ow.id)) continue;
    await clear(ow.id);
  }
}
