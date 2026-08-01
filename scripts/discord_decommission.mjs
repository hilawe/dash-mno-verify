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
// It reads the same environment as the bot, INCLUDING the ledger, which it updates once Discord has
// been changed and only for the access that actually came back.
//
// It used to leave the ledger alone, on the reasoning that a decommission is not a reason to forget
// history. That reasoning was wrong about what a ledger row is. The sweep does not read rows as
// history, it reads every one of them as revocation work still owed, and two failures came out of the
// mismatch. A retired channel stayed in the record until it expired, so the sweep cleared those bits a
// second time, possibly long after the channel was repurposed and somebody had been given access there
// for an unrelated reason: a command whose purpose is removing access ended up removing the wrong
// access later. And a ledger bound to a guild could never empty, so a bot repointed elsewhere was
// refused forever with no way to finish the recovery the refusal itself recommended.
//
// The bot must not be running against the same ledger file while this happens. The single-writer lock
// enforces that rather than trusting it.
import process from "node:process";
import { Client, GatewayIntentBits } from "discord.js";
// isGone is IMPORTED, not copied. This file had its own numeric-only copy while the bot's had learned
// discord.js's string codes, so the same error was "already gone" in one file and a hard failure in the
// other. A duplicated predicate is how a fix reaches one site and misses its twin.
import { GrantLedger, parseTargetKey } from "../adapters/discord/grant_ledger.js";
import { runDecommission } from "../adapters/discord/decommission.js";
// The same guarded mutations the bot uses. The per-channel and per-role preflights below still run,
// because an operator deserves to be told the whole target is unsafe before anything is touched, but
// the preflight is no longer the only thing standing between this command and an inverted removal. A
// denial added after the preflight, while a long holder loop is running, is caught at the mutation.

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
// The same ledger the bot uses. It is opened only when --apply is given and only AFTER Discord has
// been changed, because a preview must not touch it and a retirement must never run ahead of the
// removal it is recording.
const GRANTS_DB = process.env.DISCORD_GRANTS_DB ?? "adapters/discord/grants.db";
// The SAME legacy file the bot reads. This command used to open the database without it, so it could
// retire every row it found and report success while the real records sat in the JSON, and the next
// bot start imported them straight back. A cleanup tool that the thing it cleans up can undo is not a
// cleanup tool.
const LEGACY_GRANTS_FILE = process.env.DISCORD_GRANTS_FILE ?? "adapters/discord/grants.json";
const args = process.argv.slice(2);
// Reject anything unrecognised rather than ignoring it. Silently dropping an option the operator
// believed in is how a mistyped safety flag becomes a live deletion, and silently dropping an extra
// positional target is how half a decommission reports success.
const KNOWN_FLAGS = new Set(["--apply", "--dry-run", "--confirm-target-gone"]);
const flags = args.filter((a) => a.startsWith("-"));
const positionals = args.filter((a) => !a.startsWith("-"));
const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
const apply = flags.includes("--apply");
const askedDryRun = flags.includes("--dry-run");
const dryRun = !apply; // --dry-run is accepted for explicitness; it is already the default
const targetArg = positionals[0];
// A target that no longer exists holds no access, but a typo looks exactly the same from here, so the
// command refuses by default rather than reporting success for something it never found. That left no
// way to finish: a deleted channel can never come back, its rows were kept forever, and the guild
// binding could never empty, so the bot stayed unstartable. This is the exit. It is deliberately
// separate, apply-only, and it says out loud that the operator is asserting the target is gone.
const confirmGone = flags.includes("--confirm-target-gone");

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
if (confirmGone && !apply) {
  console.error(
    "[decommission] --confirm-target-gone only means anything with --apply. On its own it would change " +
      "nothing, so refusing rather than letting it look like it did something.",
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

// THE LEDGER LOCK IS TAKEN BEFORE DISCORD, not after.
//
// This used to construct the ledger only at the end, after every role removal and overwrite clear had
// already happened. The documentation said the single-writer lock enforced that the bot was stopped.
// It enforced that for the ledger transaction and not for the Discord work it exists to protect, so a
// live bot could re-grant a member this command had just cleared, and the command would report the
// access taken back. The lock now covers the operation it is meant to exclude.
//
// Preview opens nothing, because a preview must not take a lock away from a running bot.
let ledger = null;
if (apply) {
  try {
    ledger = new GrantLedger({
      file: GRANTS_DB,
      importFrom: LEGACY_GRANTS_FILE,
      scope: GUILD_ID,
      adoptScope: process.env.DISCORD_LEDGER_ADOPT_GUILD_ID ?? null,
      // Decommission is the documented way out of a foreign-scope refusal, so it must not be stopped
      // by that same refusal. It acts only on the target it was given and never sweeps.
      allowForeignScope: true,
      // This command never grants and never revokes through the ledger. It does its Discord work
      // directly, and these exist only to satisfy the constructor, so they throw rather than quietly
      // doing something if a future change ever reaches them.
      apply: async () => {
        throw new Error("the decommission command does not grant");
      },
      revoke: async () => {
        throw new Error("the decommission command does not revoke through the ledger");
      },
      log: (m) => console.error("[decommission]", m),
    });
  } catch (e) {
    console.error(
      `[decommission] cannot open ${GRANTS_DB}: ${e.message}\n` +
        `  Nothing was changed on Discord. If the database is locked, the bot is still running against ` +
        `it. Stop the bot and run this again.`,
    );
    process.exit(1);
  }
}

// Close the ledger on every way out, including the process.exit calls below, which do not run finally
// blocks. One place, so no exit path can leave the lock held by a dead process.
function done(code) {
  try {
    ledger?.close();
  } catch {
    // Already closed, or never opened far enough to matter.
  }
  process.exit(code);
}

// Role removal needs the privileged member intent, because it means enumerating who holds the role.
// Channel work does not. Ask for it only when the target actually requires it.
const client = new Client({
  intents:
    target.mode === "role" ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] : [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const { removed, failed } = await runDecommission({
      guild,
      target,
      targetArg,
      dryRun,
      confirmGone,
      ledger,
      botUserId: client.user.id,
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
      err: (m) => console.error(m),
    });

    console.log(
      `[decommission] ${dryRun ? "would take" : "took"} access back from ${removed.length} member(s) on ${targetArg}` +
        `${failed.length ? `, ${failed.length} failed` : ""}` +
        `${
          dryRun && removed.length
            ? ". Nothing was changed. Re-run with --apply to do it, which also stops the ledger " +
              "tracking whatever comes back, so no later sweep clears those bits a second time."
            : ""
        }`,
    );
    if (failed.length) {
      console.error(
        `[decommission] ${failed.length} could not be cleared (${failed.join(", ")}). They still hold ` +
          `access. Give the bot the permission it needs, or clear them by hand, then run this again.`,
      );
    }
    done(failed.length ? 1 : 0);
  } catch (e) {
    console.error(`[decommission] ${e.message}`);
    done(1);
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
  done(1);
});
