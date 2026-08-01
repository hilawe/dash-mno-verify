// Discord adapter for dash-mno-verify.
//
// This file knows about Discord. It knows nothing about masternodes or zero-knowledge.
// It asks the gateway for a challenge, relays it to the member, takes the proof the
// member produced locally, asks the gateway to verify, and grants access on success.
//
// Access is a per-user permission overwrite on the private channel, the automated form of adding
// someone by hand, so nothing about their masternode shows on their public profile. There is no other
// mode. A server role would have been simpler but is visible on the profile card, so it revealed who
// holds a masternode, and that mode has been removed rather than left one variable away.
//
// To port to Telegram or Matrix, reimplement these two handlers against that platform's
// API and keep every call to the gateway byte-for-byte identical.
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder,
  MessageFlags,
  OverwriteType,
} from "discord.js";
import process from "node:process";
import { proveInstructions } from "../../common/prover_instructions.js";
import {
  GrantLedger,
  authorizesTarget,
  staleTargets,
  memberDenialsOnGatedChannel,
  foreignGuildRecords,
  isGone,
  isNotOurs,
} from "./grant_ledger.js";
// Every Discord permission mutation goes through these, and each one performs its own denial check
// immediately before acting. Nine rounds of adding the check at the site a reviewer named, and leaving
// its twin unguarded a few lines away, is what this import exists to end.
import { clearMemberOverwrite, isDenialConflict, retainedManagedAllows } from "./permissions.js";
import { makeAccess } from "./access.js";

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there. Sent on the
// account-bearing calls so the gateway trusts the account this adapter vouches for (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};

// THERE IS ONE GRANT MODE, AND IT IS PER-CHANNEL OVERWRITES. ROLE MODE IS GONE.
//
// A Discord role is visible on the member's profile card to everyone in the server, so granting one
// announced who holds a masternode. Never which one, but that they hold one at all, and that is
// precisely the fact the zero-knowledge construction upstream exists to keep private. Every other
// protection in this project is downstream of that fact staying secret, so a mode that discloses it
// defeated the system by design rather than by defect, and it should not have been reachable by
// setting one environment variable.
//
// Removing it also removes the part of this adapter nobody could verify. A role inverts if it denies
// any permission anywhere, so adding it removed access and removing it granted access, and every guard
// against that ran against a cached, guild-wide scan of every channel. Four reviewers marked every
// role finding INFERRED, because none of them could execute those semantics against a live server, and
// neither could the tests. The channel paths are the ones with real reproductions behind them.
//
// A ledger written by an older version can still hold role records. Those are NOT silently ignored:
// the bot refuses to start and names them, and `npm run discord:decommission -- role:<id>` still exists
// to take that access back. Removing a mode must not strand the access it granted.
const GRANT_CHANNEL_IDS = (process.env.DISCORD_GRANT_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// The context the proof is scoped to (platform, community, and this id). This is the PROTOCOL's
// context id and has nothing to do with a Discord role. The nullifier and the two-tier members set are
// scoped to it, so keep it stable. It defaults to the first channel id, but set DISCORD_CONTEXT_ID for
// a context that does not change if the channel ids do.
const CONTEXT_ID = process.env.DISCORD_CONTEXT_ID ?? GRANT_CHANNEL_IDS[0];
const SWEEP_SECONDS = Number(process.env.DISCORD_SWEEP_SECONDS ?? 300);
// The ledger is a SQLite database now. DISCORD_GRANTS_FILE keeps its old meaning, the JSON file, and
// is read once on first start to migrate its grants and clock state across, after which it is renamed
// with a .migrated suffix and never read again. Point DISCORD_GRANTS_DB somewhere else to move the
// database itself.
const GRANTS_DB = process.env.DISCORD_GRANTS_DB ?? "adapters/discord/grants.db";
const LEGACY_GRANTS_FILE = process.env.DISCORD_GRANTS_FILE ?? "adapters/discord/grants.json";

// Refuse a configuration that asks for the removed mode rather than quietly doing something else with
// it. An operator who set DISCORD_GRANT_MODE=role chose the disclosing behaviour on purpose, and
// silently giving them channel mode would change who can see what without telling them.
if (process.env.DISCORD_GRANT_MODE && process.env.DISCORD_GRANT_MODE !== "channel") {
  console.error(
    `[discord] DISCORD_GRANT_MODE=${process.env.DISCORD_GRANT_MODE} is not available. Role mode has ` +
      `been removed, because a Discord role is visible on the member's profile card and so discloses ` +
      `who holds a masternode, which is the fact this system exists to keep private. Per-channel ` +
      `access is the only mode. Unset DISCORD_GRANT_MODE, or set it to 'channel'.\n` +
      `  If a role is still granting access from an earlier deployment, take it back with:\n` +
      `    npm run discord:decommission -- role:<id> --apply`,
  );
  process.exit(1);
}
if (process.env.DISCORD_MNO_ROLE_ID) {
  console.error(
    "[discord] DISCORD_MNO_ROLE_ID is set, but role mode has been removed and this bot never grants a " +
      "role. Unset it so nobody reads this configuration as still handing out that role. Access that " +
      "role already carries is cleared with: npm run discord:decommission -- role:<id> --apply",
  );
  process.exit(1);
}
if (GRANT_CHANNEL_IDS.length === 0) {
  console.error("[discord] DISCORD_GRANT_CHANNEL_IDS is required (comma-separated channel ids)");
  process.exit(1);
}
if (!Number.isFinite(SWEEP_SECONDS) || SWEEP_SECONDS <= 0) {
  console.error(`[discord] DISCORD_SWEEP_SECONDS must be a positive number, got '${process.env.DISCORD_SWEEP_SECONDS}'`);
  process.exit(1);
}

let guildRef = null;
const getGuild = async () => (guildRef ??= await client.guilds.fetch(GUILD_ID));
// The two ledger-driven operations live in access.js so tests can drive them. This file logs in to
// Discord at import, so nothing inside it was ever reachable from a test, which is why the
// apply-and-compensate composition went unverified for two rounds.
const { applyAccess, revokeAccess, repairAccess } = makeAccess({
  getGuild,
  guildId: GUILD_ID,
  managedChannels: GRANT_CHANNEL_IDS,
  log: (m) => console.warn("[discord]", m),
});

// The ledger is bound to this guild in the database itself, not only on each record.
//
// Per-record guild ids protect records written since the field existed. They cannot protect the ones
// written before it, which read as "unknown", and treating unknown as "ours" let a repointed bot
// revoke a legacy record against the new guild, receive a not-found that the code already classified
// as already gone, and delete the row while the access stayed live and untracked in the old guild.
// Binding the database removes the question, because every row in it belongs to this guild by
// construction.
//
// DISCORD_LEDGER_ADOPT_GUILD_ID is the operator asserting which guild an existing unbound ledger's
// grants were made in. It has to name the guild explicitly and match, because the whole difficulty is
// that nothing inside this process can work that out.
const ledger = new GrantLedger({
  file: GRANTS_DB,
  importFrom: LEGACY_GRANTS_FILE,
  scope: GUILD_ID,
  adoptScope: process.env.DISCORD_LEDGER_ADOPT_GUILD_ID ?? null,
  // The clock floor's escape hatch, which the README described and this adapter never wired. Matrix
  // and Telegram both pass their own. Without it a large enough forward clock jump, once recorded,
  // refused every new grant until real time caught up, and the documented recovery reached no branch
  // any Discord configuration could take. A guard whose exit exists only in the documentation is a
  // guard with no exit.
  resetClock: process.env.DISCORD_RESET_CLOCK === "1",
  apply: applyAccess,
  revoke: revokeAccess,
  log: (m) => console.error("[discord]", m),
});

// Revoke lapsed grants, then DM the affected members. The ledger does the revoking and persistence;
// the DM is a Discord concern, so it stays here. Runs at startup as well as on the timer, so a grant that lapsed
// while the bot was down is cleared promptly.
// Reapply access that a live record says should exist and Discord does not have.
//
// The gap this closes: the gateway spends the nullifier when it verifies and the challenge is
// one-time, so a member whose apply failed after a successful verification could not prove again in
// that epoch. Nothing created a missing overwrite from a live record, so they stayed verified,
// recorded, and locked out until expiry, while being told to run /verify again, which cannot work.
//
// Runs on the same schedule as the sweep, so the wait is bounded by DISCORD_SWEEP_SECONDS rather than
// by the next restart. Idempotent: a member whose overwrite is present and complete costs one cached
// read and no request.
async function repairLiveGrants() {
  let repaired = 0;
  // Only the ACCOUNT is taken from this snapshot. The record it carries is deliberately discarded,
  // because the repair below rereads the current one inside the member's own lock.
  for (const [userId] of ledger.entries()) {
    try {
      // admitIfLive takes the per-member queue, rereads the row inside it, and judges expiry against
      // the persisted clock sample, so the record handed to the repair is the one that is true at the
      // moment of the mutation.
      //
      // The first version passed the snapshot straight to the mutation, outside the queue. A renewal
      // could then replace the row with a new target and revoke the old one while a repair was in
      // flight on the old, after which the repair reapplied it and nothing tracked it. Untracked live
      // access is the single failure this ledger exists to prevent, and reaching around its queue is
      // how it comes back.
      await ledger.admitIfLive(userId, async (record) => {
        repaired += (await repairAccess(userId, record)).length;
      });
    } catch (e) {
      console.error(`[discord] repair failed for ${userId}: ${e.message}`);
    }
  }
  if (repaired) console.log(`[discord] reapplied access on ${repaired} channel(s) from live records`);
}

async function sweepAndNotify() {
  const revoked = await ledger.sweep();
  await repairLiveGrants().catch((e) => console.error("[discord] repair pass failed:", e.message));
  for (const userId of revoked) {
    try {
      const u = await client.users.fetch(userId);
      await u.send("Your anonymous masternode verification has expired. Run /verify again to renew access.");
    } catch {}
  }
}

const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("Start anonymous masternode verification"),
  new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit the proof you generated locally")
    .addAttachmentOption((o) =>
      o.setName("proof").setDescription("proof.json from the prover").setRequired(true)
    ),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log("[discord] slash commands registered");
}


// No privileged intent. Per-user channel overwrites arrive with the ordinary Guilds intent. Role mode
// was the only thing that needed SERVER MEMBERS, because deciding who should keep a role meant
// enumerating who holds it, and removing that mode removed the need to ask Discord for the member list
// at all.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });


// `channelId` names the ONE channel being judged, so a member keeps the channel their record covers
// even when the configuration has since grown to include others.
const authorizedNow = (userId, channelId = null) =>
  authorizesTarget(ledger.get(userId), ledger.live(userId), { mode: "channel", channel: channelId });

// Interactions arrive as soon as the gateway is ready, and the ready handler awaits this pass, so a
// member can run /submit while it is running. Reconciliation touches Discord directly rather than
// through the ledger's per-member queue, so without this gate its removal and a concurrent grant's
// addition could overlap and land in the wrong order, leaving a live record and no access, which the
// sweep then leaves alone because the record looks fine.
let reconciled = false;

// Runs on EVERY startup, over the target this bot grants through NOW and nothing else.
//
// It exists because the ledger only knows access IT issued, and three things leave access it cannot
// know about: members admitted before this lifecycle existed, and above all a bot terminated between
// Discord ACCEPTING a request and acting on it, which leaves access live with no record. That last
// case always looks like an ordinary restart, which is why this must never be skipped. An earlier
// version returned early when a marker matched the configured target, and so never did the one job it
// was written for.
//
// It does NOT clean up after a repoint. Removing access in bulk from a role or channel the bot no
// longer manages is a deliberate act, not something a restart should decide to do: three review rounds
// of trying to make that automatic produced a blocker every time, including stripping access an
// operator had granted by hand on a channel the bot had finished with. Stale targets are REPORTED
// here and cleared by `npm run discord:decommission`.
// The target this bot is configured for must actually exist in this guild, and that has to be checked
// before the pass removes anything or interactions open.
//
// Role and channel ids are globally unique, so an id belonging to a different server does not error, it
// simply matches nothing. Without this the bot logged a successful reconciliation, opened for business,
// and then persisted a ledger record naming a role it could never apply. Worse, that bad record then
// blocked recovery: the next renewal tried to revoke the recorded foreign role first, which also failed,
// so the member stayed stuck even after the configuration was corrected.
//
// The same validation was added to the decommission command last round and not here, which is the
// recurring mistake in this component: fix the site a reviewer names, leave the identical shape beside it.
// Returns the channels this bot can actually work with, and refuses outright on a conflict it must not
// paper over.
//
// Two different failure classes, deliberately handled differently, because conflating them was
// finding 3 of the last round:
//
//   UNREACHABLE (deleted, another guild's, no permission). Not fatal. Skip that channel, keep working
//   the others, and keep interactions closed so nobody is granted against a target that is not there.
//   Throwing here previously exited the ready handler BEFORE the sweep and its timer were installed,
//   so one bad channel stopped every other member's expired grant from ever being revoked. A guard
//   that protects startup must not block the cleanup it exists to enable.
//
//   A DENIAL ON A GATED CHANNEL. Fatal, and it stops the process. A per-member overwrite carrying a
//   denial means somebody else is using the slot this bot owns, and every action available here is
//   wrong: clearing it grants the member access through a role-level allow, honouring it means
//   read-modify-write against a cache on state that changes underneath, and both were tried and both
//   produced a defect worse than the one they fixed. Refusing is the only honest option, and the
//   operator fixes it with a role-level deny instead.
async function usableTargets(guild) {
  const usable = [];
  const unreachable = [];
  const conflicted = [];
  for (const chId of GRANT_CHANNEL_IDS) {
    // Only a genuinely absent or foreign channel counts as unreachable. Swallowing EVERY error here
    // meant a Discord 500 or a rate limit read as "this channel does not exist", which locked out
    // verification until somebody restarted the bot: a guard causing a larger outage than the blip it
    // was reacting to. A transient failure propagates so the supervisor restarts and retries.
    let ch;
    try {
      ch = await guild.channels.fetch(chId);
    } catch (e) {
      if (!isGone(e) && !isNotOurs(e)) throw e;
      unreachable.push(chId);
      continue;
    }
    const offenders = memberDenialsOnGatedChannel([...ch.permissionOverwrites.cache.values()].filter(
      (ow) => ow.type === OverwriteType.Member,
    ));
    if (offenders.length) {
      // QUARANTINE, not exit. Calling process.exit here killed the sweep for every unrelated member,
      // which is exactly the inversion the readiness split fixed for unreachable channels and left in
      // place for denials. One conflicting member must not stop everyone else's expired access being
      // revoked.
      conflicted.push(chId);
      console.error(
        `[discord] channel ${chId} is QUARANTINED: per-member overwrites DENY ` +
          `${[...new Set(offenders.flatMap((o) => o.deny))].join(", ")} for ` +
          `${offenders.map((o) => o.id).join(", ")}. Per-member overwrites on a gated channel belong to ` +
          `this bot, and it will not fight whoever set those: clearing one would grant that member ` +
          `access through a role-level allow. Express the exclusion with a role-level deny, or remove ` +
          `the member overwrite. Admissions stay closed and this channel is left alone; cleanup of ` +
          `other channels continues.`,
      );
      continue;
    }
    usable.push(chId);
  }
  if (unreachable.length || conflicted.length) {
    return {
      channels: usable,
      ready: false,
      why: [
        unreachable.length ? `channel(s) ${unreachable.join(", ")} are missing from ${guild.name} (${guild.id})` : "",
        conflicted.length ? `channel(s) ${conflicted.join(", ")} have conflicting per-member denials` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  }
  return { channels: usable, ready: true };
}

async function reconcileGuild() {
  const guild = await getGuild();
  // Records naming another guild describe access this process cannot reach. Sweeping would delete the
  // row and forget it. Refuse until the operator decommissions it over there.
  const foreign = foreignGuildRecords(ledger.all(), GUILD_ID);
  if (foreign.length) {
    throw new Error(
      `the ledger holds grants for guild(s) ${[...new Set(foreign.map((f) => f.guildId))].join(", ")}, ` +
        `but this bot serves ${GUILD_ID}. That access is still live and unreachable from here.\n` +
        `  Point DISCORD_GUILD_ID back at the old guild, stop this bot, and for each target it names ` +
        `run:\n` +
        `    npm run discord:decommission -- <target>            # preview\n` +
        `    npm run discord:decommission -- <target> --apply    # remove, and stop tracking it\n` +
        `  The command retires the rows it clears, so once nothing is left the ledger rebinds by itself ` +
        `and this bot starts against ${GUILD_ID}.`,
    );
  }
  // A role record can only have come from a version that had role mode. This bot cannot take that
  // access back, so it must not pretend the ledger is clean: it refuses and names the command that
  // does. Removing a mode must not strand the access it granted, and quietly ignoring those rows would
  // leave a masternode holder's status visible on their profile card with nothing tracking it.
  const roleRecords = ledger.all().filter((r) => r?.mode === "role");
  if (roleRecords.length) {
    const ids = [...new Set(roleRecords.map((r) => String(r.roleId)).filter(Boolean))];
    throw new Error(
      `the ledger holds ${roleRecords.length} grant(s) for role(s) ${ids.join(", ")}, from a version ` +
        `that granted roles. Role mode has been removed because a role is visible on the member's ` +
        `profile card and so discloses who holds a masternode. That access is still live and still ` +
        `disclosing.\n` +
        ids.map((id) => `    npm run discord:decommission -- role:${id} --apply`).join("\n") +
        `\n  Run that for each, then start again. The command retires the rows it clears.`,
    );
  }
  const targets = await usableTargets(guild);
  const removed = [];
  const failed = [];
  // A member who left between the snapshot and the removal holds nothing, so that is completion, not
  // failure. Counting it as a failure aborted the whole pass, and because the pass runs before the
  // sweep and its timer are installed, one departed member stopped every OTHER member's expired grant
  // from ever being revoked until a clean restart.
  const clear = async (userId, undo, conflictKept = null) => {
    try {
      await undo();
      removed.push(userId);
    } catch (e) {
      if (isGone(e)) return; // already gone; nothing to take back
      // A refusal is not a failure here, and must not be counted as one. This member carries a denial,
      // so they hold no access to take back and leaving their overwrite alone is the correct outcome.
      // Counting it as a failure would throw at the end of the pass, close admissions for everybody,
      // and turn one deliberately excluded member into a server-wide outage: the same "guard causes a
      // larger failure than it reports" shape this component keeps producing.
      if (isDenialConflict(e)) {
        // THE TWIN of the same question in revokeAccess, and it needs the same check even though the
        // answer differs. A refusal means "nothing to take back" only when the denial covers
        // everything. A mixed overwrite leaves the member able to see a private channel with no live
        // grant, and reporting a clean pass over that is how untracked access becomes invisible.
        //
        // Unlike the sweep there is no record to keep here, because this member has no live grant, so
        // the loudest honest thing available is naming them. It must not fail the pass: that closes
        // admissions for the whole server over one member, which is the larger-failure shape this
        // component keeps producing.
        const kept = conflictKept?.(userId);
        if (kept && kept.length) {
          console.error(
            `[discord] ${userId} has NO live grant and is still ALLOWED ${kept.join(", ")} on a gated ` +
              `channel, behind a denial this bot will not touch. Their access is real and nothing ` +
              `tracks it. Clear that overwrite by hand.`,
          );
          return;
        }
        console.warn(`[discord] left ${userId} alone during reconciliation: ${e.message}`);
        return;
      }
      failed.push(userId);
      console.error(`[discord] could not take access back from ${userId} during reconciliation: ${e.message}`);
    }
  };

  {
    for (const chId of targets.channels) {
      let ch;
      try {
        ch = await guild.channels.fetch(chId);
      } catch (e) {
        if (isGone(e)) continue; // a deleted channel holds no access
        throw e;
      }
      for (const [id, ow] of ch.permissionOverwrites.cache) {
        if (ow.type !== OverwriteType.Member) continue; // role overwrites are the operator's business
        if (id === client.user.id) continue;
        if (authorizedNow(id, chId)) continue;
        // Guarded per member, not by the startup snapshot alone. usableTargets checked this channel
        // moments ago, but the loop below can run for a long time on a large channel and an
        // administrator can add a denial while it runs. Clearing that denial lets a role-level allow
        // through, so the pass whose whole purpose is taking access back would hand it out. All four
        // round 9 reviewers found this one.
        await clear(
          id,
          () => clearMemberOverwrite(ch, id),
          (uid) => retainedManagedAllows(ch, uid),
        );
      }
    }
  }

  if (failed.length) {
    throw new Error(
      `could not take access back from ${failed.length} member(s) with no live grant ` +
        `(${failed.join(", ")}). Give the bot the permission it needs, or clear them by hand.`,
    );
  }

  // Report, never act. A record naming a target this bot no longer grants through means an earlier
  // configuration handed out access that is still out there.
  const stale = staleTargets(ledger.all(), { mode: "channel", channels: GRANT_CHANNEL_IDS });
  for (const t of stale) {
    console.warn(
      `[discord] WARNING: the ledger holds grants for ${t}, which this bot no longer manages. Members ` +
        `may still hold access there and no sweep will ever find it. Clear it with: ` +
        `npm run discord:decommission -- ${t}`,
    );
  }

  console.log(`[discord] reconciled, took access back from ${removed.length} member(s)`);
  return targets;
}

// Every failure inside the handler has to be caught here. discord.js does not look at the promise an
// async listener returns, so anything that rejects below (an unreachable gateway, a 502 that is not
// JSON, a Discord API error) became an unhandled rejection, and Node ends the process on those by
// default. One transient blip on a dependency therefore locked every member out until a supervisor
// restarted the bot. Report it to the member instead and stay up.
client.on("interactionCreate", (i) => {
  // Refuse until reconciliation has finished. It removes access by calling Discord directly rather
  // than through the ledger's per-member queue, so a grant landing mid-pass could have its addition
  // and the pass's removal apply in either order, leaving a live record and no access that the sweep
  // then leaves alone because the record looks fine. A few seconds of "try again" beats that.
  if (!reconciled) {
    if (i.isChatInputCommand?.()) {
      i.reply({ content: "Starting up and checking existing access. Try again in a moment.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  handleInteraction(i).catch(async (e) => {
    console.error("[discord] interaction failed:", e.message);
    // Best effort: the interaction may already have been answered, or its token may have expired.
    const note = "Something went wrong talking to the verification service. Try `/verify` again shortly.";
    try {
      if (i.deferred || i.replied) await i.editReply(note);
      else await i.reply({ content: note, flags: MessageFlags.Ephemeral });
    } catch (replyErr) {
      console.error("[discord] could not tell the member about it:", replyErr.message);
    }
  });
});

async function handleInteraction(i) {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === "verify") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await fetch(`${GATEWAY}/v1/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ platform: "discord", communityId: GUILD_ID, roleId: CONTEXT_ID, account: i.user.id }),
    });
    if (!res.ok) return i.editReply("Verification service is unavailable right now. Try again shortly.");
    const challenge = await res.json();

    // The challenge carries no secret, so it is safe to show. The member feeds it to
    // the prover on their own machine, where the voting key never leaves.
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(challenge, null, 2)), {
      name: "challenge.json",
    });
    await i.editReply({
      content: [
        "Anonymous masternode verification, step 1 of 2.",
        "",
        "1. Download `challenge.json` below.",
        "2. On the machine holding your masternode voting key, run:",
        ...proveInstructions(challenge.mode, { gateway: GATEWAY, platform: "discord", community: GUILD_ID, role: CONTEXT_ID }).map((l) => "   `" + l + "`"),
        "3. Run `/submit` here and attach the `proof.json` it produces.",
        "",
        "Your key, and which node you control, never leave your device. The bot learns only that some valid masternode vouched for you.",
      ].join("\n"),
      files: [file],
    });
    return;
  }

  if (i.commandName === "submit") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const attachment = i.options.getAttachment("proof");
    let payload;
    try {
      payload = await (await fetch(attachment.url)).json(); // { nonce, proof, publicSignals }
    } catch {
      return i.editReply("That attachment is not a readable proof.json. Run `/verify` to start over.");
    }

    // Submit the account this user is identified by. The gateway binds the verify to it (review B1).
    const res = await fetch(`${GATEWAY}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ ...payload, account: i.user.id }),
    });
    const out = await res.json();
    if (!out.ok)
      return i.editReply(`Verification failed (${out.reason ?? "unknown"}). Run \`/verify\` to start over.`);
    if (!Number.isFinite(out.expiresAt)) {
      console.error("[discord] gateway returned no valid expiresAt");
      return i.editReply("The verification response was malformed. Run `/verify` to try again.");
    }

    try {
      await ledger.grant(i.user.id, {
        expiresAt: out.expiresAt,
        mode: "channel",
        guildId: GUILD_ID, // so a repoint cannot delete a record for access in a guild we can no longer reach
        channels: GRANT_CHANNEL_IDS,
      });
    } catch (e) {
      console.error("[discord] grant failed:", e.message);
      // TWO different outcomes, and telling the member the wrong one is its own defect.
      //
      // A refusal means nothing was applied and the row was dropped, because this member is excluded
      // on every configured channel. No repair can occur, so promising one is a lie that leaves them
      // waiting. A transient failure keeps the record, and the repair pass genuinely does reapply it.
      //
      // Neither says "run /verify again". The challenge is one-time and the nullifier is spent for this
      // epoch, so a second proof from the same voting key is refused either way.
      if (e?.mutated === false) {
        return i.editReply(
          "Verified, but access could not be applied on this server. An administrator has set a " +
            "permission on your account that this bot will not override. Ask a server admin about it. " +
            "Verifying again will not change this.",
        );
      }
      return i.editReply(
        "Verified. Applying your access did not complete just now, which is usually temporary. Your " +
          "verification still counts and it will be applied automatically within a few minutes. There " +
          "is no need to verify again, and doing so will not help until the next epoch.",
      );
    }
    const until = new Date(out.expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    const where = "access to the masternode channel";
    return i.editReply(`Verified. You have ${where} for this epoch (until ${until} UTC). Run \`/verify\` again after it rolls over to keep access.`);
  }
}

client.once("ready", async () => {
  console.log(`[discord] logged in as ${client.user.tag}, granting per-channel access`);
  // Sweep once now (clearing grants that lapsed while the bot was down), then on a timer, so a member
  // who does not re-verify loses access after the epoch.
  // Reconcile BEFORE the first sweep. The sweep only knows the ledger, so running it first would
  // report a tidy result while untracked access sat there unseen.
  // Admission readiness and cleanup readiness are SEPARATE, which was the point of the last round's
  // third finding. A target that is missing means nobody new should be admitted, and it must not also
  // stop the bot revoking access that has already expired. Previously a single bad channel threw out
  // of this handler before the sweep and its timer existed, so every other member's lapsed grant went
  // unrevoked until somebody noticed. Interactions stay shut; cleanup runs regardless.
  let ready = false;
  try {
    ready = (await reconcileGuild()).ready;
  } catch (e) {
    console.error(`[discord] reconciliation failed: ${e.message}`);
  }
  if (ready) {
    reconciled = true;
  } else {
    console.error(
      "[discord] interactions stay CLOSED because a configured target is missing. Expired access is " +
        "still being revoked on the usual schedule. Fix the configuration and restart to accept " +
        "verifications again.",
    );
  }
  await sweepAndNotify().catch((e) => console.error("[discord] startup sweep failed:", e.message));
  setInterval(() => sweepAndNotify().catch((e) => console.error("[discord] sweep failed:", e.message)), SWEEP_SECONDS * 1000);
});

await registerCommands();
await client.login(TOKEN).catch((e) => {
  // Discord rejects a disallowed privileged intent at the gateway handshake, before `ready`, so any
  // explanation inside the startup pass is never reached. Say the useful thing here instead.
  console.error(
    `[discord] could not log in: ${e.message}` +
      (/disallowed intents/i.test(e.message)
        ? "\nThis bot asks only for the ordinary Guilds intent, so a disallowed-intent rejection means " +
          "something else is requesting a privileged one. It no longer needs SERVER MEMBERS."
        : ""),
  );
  process.exit(1);
});
