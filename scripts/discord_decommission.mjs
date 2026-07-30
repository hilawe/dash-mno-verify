// Take back every access this bot handed out on a role or channel it no longer manages.
//
// WHY THIS IS A COMMAND AND NOT PART OF STARTUP
//
// Removing access in bulk is a deliberate act. Three review rounds were spent trying to make it happen
// automatically when the bot noticed its configuration had changed, and every round found a blocker in
// it: a pass that skipped itself on ordinary restarts, a role-to-channel switch that wedged the bot
// permanently, and a retired channel that stayed "bot owned" forever so access an operator later
// granted there by hand was stripped on the next restart. None of those failures were possible in the
// simple part of the work. They came from a program deciding on its own to delete people's access
// based on a guess about what an earlier configuration had been.
//
// So the bot now reports what it can see and does nothing about it, and this runs when you decide.
// It takes one target, tells you exactly what it will do, does it, and exits.
//
//   npm run discord:decommission -- channel:111,222            # shows what it WOULD remove
//   npm run discord:decommission -- channel:111,222 --apply    # actually removes it
//
// Preview is the default and removal requires --apply. The first version had it the other way round,
// with a --dry-run flag matched by an exact string, so `--dryrun` silently performed the real deletion.
// For a command whose whole purpose is removing access in bulk, the destructive path is the one that
// has to be asked for explicitly.
//
// It reads the same environment as the bot. It never touches the ledger, because the ledger is the
// record of what was granted and a decommission is not a reason to forget that history.
import process from "node:process";
import { Client, GatewayIntentBits, OverwriteType } from "discord.js";
// isGone is IMPORTED, not copied. This file had its own numeric-only copy while the bot's had learned
// discord.js's string codes, so the same error was "already gone" in one file and a hard failure in the
// other. A duplicated predicate is how a fix reaches one site and misses its twin.
import {
  parseTargetKey,
  isGone,
  memberDenialsOnGatedChannel,
  roleDenialsAcrossChannels,
} from "../adapters/discord/grant_ledger.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const args = process.argv.slice(2);
// Reject anything unrecognised rather than ignoring it. Silently dropping an option the operator
// believed in is how a mistyped safety flag becomes a live deletion, and silently dropping an extra
// positional target is how half a decommission reports success.
const KNOWN_FLAGS = new Set(["--apply", "--dry-run"]);
const flags = args.filter((a) => a.startsWith("-"));
const positionals = args.filter((a) => !a.startsWith("-"));
const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
const apply = flags.includes("--apply");
const askedDryRun = flags.includes("--dry-run");
const dryRun = !apply; // --dry-run is accepted for explicitness; it is already the default
const targetArg = positionals[0];

if (!TOKEN || !GUILD_ID) {
  console.error("[decommission] DISCORD_TOKEN and DISCORD_GUILD_ID must be set, the same as for the bot.");
  process.exit(1);
}
// Both flags together is a contradiction, and resolving it in favour of the destructive one is exactly
// the mistake this command already made once: an operator who typed --dry-run got a real deletion. If
// the request is ambiguous, do nothing.
if (apply && askedDryRun) {
  console.error(
    "[decommission] --apply and --dry-run contradict each other. Refusing rather than guessing which " +
      "you meant. Run with neither to preview, or with --apply alone to remove.",
  );
  process.exit(1);
}
if (unknown.length) {
  console.error(
    `[decommission] unrecognised option(s): ${unknown.join(", ")}. Known options are --apply and ` +
      `--dry-run. Refusing rather than guessing, because a mistyped flag on this command deletes access.`,
  );
  process.exit(1);
}
if (positionals.length !== 1) {
  console.error(
    (positionals.length === 0
      ? "[decommission] name exactly one target to clear."
      : `[decommission] name exactly ONE target, got ${positionals.length}: ${positionals.join(", ")}. ` +
        "Run it once per target so each result is reported separately.") +
      "\n  npm run discord:decommission -- channel:111,222          # preview\n" +
      "  npm run discord:decommission -- channel:111,222 --apply   # remove\n" +
      "The bot names the targets it can see are outstanding when it starts.",
  );
  process.exit(1);
}

// Throws, loudly and specifically, on anything malformed. Guessing at a half-parsed target is how a
// previous version cleared one channel, reported success, and silently forgot the rest.
let target;
try {
  target = parseTargetKey(targetArg);
} catch (e) {
  console.error(`[decommission] ${e.message}`);
  process.exit(1);
}

// Reset the three managed bits to inherit, AFTER the preflight below has established there is no
// denial to lift. The bot's startup refusal does not protect this command: it covers only the current
// gated channels of one process, and decommission runs separately against a target the bot by
// definition no longer manages. All four reviewers of the previous version found that gap.
const ACCESS_CLEARED = { ViewChannel: null, SendMessages: null, ReadMessageHistory: null };

// Role removal needs the privileged member intent, because it means enumerating who holds the role.
// Channel work does not. Ask for it only when the target actually requires it.
const client = new Client({
  intents:
    target.mode === "role" ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] : [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  const removed = [];
  const failed = [];
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    // Name the guild before touching anything. A command that removes access in bulk should say which
    // server it is about to act on, so a wrong DISCORD_GUILD_ID is obvious in the output.
    console.log(`[decommission] guild ${guild.name} (${guild.id}), target ${targetArg}${dryRun ? ", PREVIEW ONLY" : ""}`);

    if (target.mode === "role") {
      const roleId = target.ids[0];
      // Confirm the role belongs to THIS guild. Role ids are globally unique, so naming a role from
      // another server simply matched nobody, reported zero holders, and exited zero as if it had
      // succeeded, while every real holder kept the role.
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        throw new Error(
          `role ${roleId} does not exist in ${guild.name} (${guild.id}). Check DISCORD_GUILD_ID and the ` +
            `role id; nothing was changed.`,
        );
      }
      // PREFLIGHT. Removing a role that DENIES something hands that permission back, so a command whose
      // purpose is taking access away would grant it. Same check the bot makes before it will start.
      const roleOffenders = roleDenialsAcrossChannels(
        [...(await guild.channels.fetch()).values()].filter(Boolean).map((c) => ({
          id: c.id,
          overwrites: [...(c.permissionOverwrites?.cache?.values() ?? [])],
        })),
        roleId,
      );
      if (roleOffenders.length) {
        throw new Error(
          `role ${role.name} (${roleId}) DENIES ` +
            `${roleOffenders.map((o) => `${o.deny.join("/")} on ${o.channel}`).join(", ")}. Removing it ` +
            `would GRANT those permissions rather than take access away. Nothing was changed. Remove the ` +
            `deny overwrite first, or take the role away by hand knowing what it restores.`,
        );
      }
      let members;
      try {
        members = await guild.members.fetch();
      } catch (e) {
        throw new Error(
          `cannot read the member list (${e.message}). Enable the SERVER MEMBERS INTENT for this ` +
            `application in Discord's developer portal, run this once, and you can turn it off again.`,
        );
      }
      const holders = [...members.values()].filter((m) => m.roles.cache.has(roleId) && m.id !== client.user.id);
      console.log(`[decommission] role ${role.name} (${roleId}): ${holders.length} member(s) hold it`);
      for (const m of holders) {
        if (dryRun) {
          removed.push(m.id);
          continue;
        }
        try {
          await m.roles.remove(roleId);
          removed.push(m.id);
        } catch (e) {
          if (isGone(e)) continue; // the member or role went away; nothing left to take back
          failed.push(m.id);
          console.error(`[decommission] could not remove the role from ${m.id}: ${e.message}`);
        }
      }
    } else {
      for (const chId of target.ids) {
        // Each channel stands alone. An unguarded fetch here meant one bad channel threw out of the
        // whole loop: every channel before it had already been cleared, every channel after it was
        // left untouched, and the summary that would have said so was never printed. The operator saw
        // an error and had no idea how far it had got. This is the same shape as the per-holder catch
        // below and the isGone-and-continue in the bot, neither of which was applied here.
        let ch;
        try {
          ch = await guild.channels.fetch(chId);
        } catch (e) {
          if (isGone(e)) {
            // A typo looks identical to a deleted channel here, and a manual destructive command must
            // not report success for a target it never found. Fail, so the operator checks the id.
            failed.push(`${chId}/*`);
            console.error(
              `[decommission] channel ${chId} is not in ${guild.name} (${guild.id}). If you meant a ` +
                `deleted channel there is nothing to clear; otherwise check the id. Nothing was changed ` +
                `for it.`,
            );
            continue;
          }
          failed.push(`${chId}/*`);
          console.error(`[decommission] could not read channel ${chId}: ${e.message}`);
          continue;
        }
        // Member overwrites only. A role overwrite on this channel is the operator's own arrangement.
        const members = [...ch.permissionOverwrites.cache.values()].filter(
          (ow) => ow.type === OverwriteType.Member && ow.id !== client.user.id,
        );
        // PREFLIGHT, per channel. Clearing an overwrite that DENIES lifts the denial and lets a
        // role-level allow through, so the removal would grant. Refuse the channel, keep going.
        const denied = memberDenialsOnGatedChannel(members);
        if (denied.length) {
          failed.push(`${chId}/*`);
          console.error(
            `[decommission] channel ${chId} SKIPPED: ${denied.map((d) => `${d.id} is denied ${d.deny.join("/")}`).join(", ")}. ` +
              `Clearing those would GRANT access through a role-level allow. Remove the member overwrite ` +
              `or express the exclusion with a role-level deny, then run this again.`,
          );
          continue;
        }
        const holders = members;
        console.log(`[decommission] channel ${chId}: ${holders.length} per-member overwrite(s)`);
        for (const ow of holders) {
          if (dryRun) {
            removed.push(`${chId}/${ow.id}`);
            continue;
          }
          try {
            await ch.permissionOverwrites.edit(ow.id, ACCESS_CLEARED, { type: OverwriteType.Member });
            removed.push(`${chId}/${ow.id}`);
          } catch (e) {
            if (isGone(e)) continue; // already gone
            failed.push(`${chId}/${ow.id}`);
            console.error(`[decommission] could not clear ${ow.id} on ${chId}: ${e.message}`);
          }
        }
      }
    }

    // The three bits this bot grants are reset to inherit on every per-member overwrite found,
    // including overwrites an operator added by hand, because a stored overwrite carries no record of
    // who created it. Any OTHER permission on that overwrite is left alone, so this is narrower than
    // "clear the overwrite". That trade is right HERE, at the moment you deliberately decommission a
    // target, and wrong for a bot to make on its own at every restart, which an earlier design did.
    console.log(
      `[decommission] ${dryRun ? "would take" : "took"} access back from ${removed.length} member(s) on ${targetArg}` +
        `${failed.length ? `, ${failed.length} failed` : ""}` +
        `${dryRun && removed.length ? ". Nothing was changed; re-run with --apply to do it." : ""}`,
    );
    if (failed.length) {
      console.error(
        `[decommission] ${failed.length} could not be cleared (${failed.join(", ")}). They still hold ` +
          `access. Give the bot the permission it needs, or clear them by hand, then run this again.`,
      );
    }
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error(`[decommission] ${e.message}`);
    process.exit(1);
  }
});

client.login(TOKEN).catch((e) => {
  console.error(
    `[decommission] could not log in: ${e.message}` +
      (/disallowed intents/i.test(e.message)
        ? "\nThis target needs the SERVER MEMBERS INTENT enabled for the application in Discord's " +
          "developer portal. Enable it, run this once, and you can turn it off again."
        : ""),
  );
  process.exit(1);
});
