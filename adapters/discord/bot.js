// Discord adapter for dash-mno-verify.
//
// This file knows about Discord. It knows nothing about masternodes or zero-knowledge.
// It asks the gateway for a challenge, relays it to the member, takes the proof the
// member produced locally, asks the gateway to verify, and grants access on success.
//
// Access is granted in one of two ways (DISCORD_GRANT_MODE). In "channel" mode the bot adds the
// member straight to the private channel with a per-user permission overwrite, the automated form of
// adding someone by hand, so nothing about their masternode shows on their public profile. In "role"
// mode it assigns a server role, which is simpler but visible on the profile card, so it reveals who
// holds a masternode. A privacy-sensitive community should use "channel".
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
  roleDenialsAcrossChannels,
  foreignGuildRecords,
  isGone,
  isNotOurs,
} from "./grant_ledger.js";
// Every Discord permission mutation goes through these, and each one performs its own denial check
// immediately before acting. Nine rounds of adding the check at the site a reviewer named, and leaving
// its twin unguarded a few lines away, is what this import exists to end.
import {
  grantMemberOverwrite,
  clearMemberOverwrite,
  addRole,
  removeRole,
  isDenialConflict,
} from "./permissions.js";

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_MNO_ROLE_ID;
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there. Sent on the
// account-bearing calls so the gateway trusts the account this adapter vouches for (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};

// Channel mode is the default, because the alternative discloses the very thing the proof protects.
// A Discord ROLE is visible on the member's profile card to everyone in the server, so granting one
// announces who holds a masternode (never which one, but that they hold one at all). The whole point
// of the zero-knowledge construction upstream is that this fact stays private, and a default that
// leaks it means anyone who does not read the documentation gets the disclosing behaviour for free.
// Channel mode adds a per-user permission overwrite on the private channel instead, which is the
// automated form of adding someone by hand and shows nothing publicly.
const GRANT_MODE = process.env.DISCORD_GRANT_MODE ?? "channel";
const GRANT_CHANNEL_IDS = (process.env.DISCORD_GRANT_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// The context the proof is scoped to (platform, community, and this id). The nullifier and the
// two-tier members set are scoped to it, so keep it stable. In channel mode it defaults to the first
// channel id, in role mode to the role id, but set DISCORD_CONTEXT_ID for a context that does not
// change if the role or channel ids do.
const CONTEXT_ID = process.env.DISCORD_CONTEXT_ID ?? (GRANT_MODE === "channel" ? GRANT_CHANNEL_IDS[0] : ROLE_ID);
const SWEEP_SECONDS = Number(process.env.DISCORD_SWEEP_SECONDS ?? 300);
// The ledger is a SQLite database now. DISCORD_GRANTS_FILE keeps its old meaning, the JSON file, and
// is read once on first start to migrate its grants and clock state across, after which it is renamed
// with a .migrated suffix and never read again. Point DISCORD_GRANTS_DB somewhere else to move the
// database itself.
const GRANTS_DB = process.env.DISCORD_GRANTS_DB ?? "adapters/discord/grants.db";
const LEGACY_GRANTS_FILE = process.env.DISCORD_GRANTS_FILE ?? "adapters/discord/grants.json";

// The default changed from role to channel, so a deployment that never set DISCORD_GRANT_MODE gets a
// different mode than it used to. Require the mode explicitly whenever a role id is present, rather
// than guessing which one was meant.
//
// This check deliberately sits OUTSIDE the "no channel ids" branch. An earlier version put it inside,
// so a deployment carrying an unused DISCORD_GRANT_CHANNEL_IDS alongside its role id flipped silently
// from role mode to channel mode, taking the default proof context with it from the role id to the
// channel id. The condition is about the mode being unstated, not about which ids happen to be set.
if (!process.env.DISCORD_GRANT_MODE && ROLE_ID) {
  console.error(
    "[discord] set DISCORD_GRANT_MODE explicitly. The default is now 'channel', because a Discord role " +
      "is visible on the member's profile card and so discloses who holds a masternode, which is the " +
      "fact the proof exists to keep private. This bot has DISCORD_MNO_ROLE_ID set and no explicit " +
      "mode, so it may have been relying on the old 'role' default.\n" +
      "  DISCORD_GRANT_MODE=channel  with DISCORD_GRANT_CHANNEL_IDS set (recommended)\n" +
      "  DISCORD_GRANT_MODE=role     to keep the disclosing behaviour",
  );
  process.exit(1);
}
if (GRANT_MODE !== "channel" && GRANT_MODE !== "role") {
  console.error(`[discord] DISCORD_GRANT_MODE must be 'channel' or 'role', got '${GRANT_MODE}'`);
  process.exit(1);
}
if (GRANT_MODE === "channel" && GRANT_CHANNEL_IDS.length === 0) {
  console.error("[discord] DISCORD_GRANT_MODE=channel needs DISCORD_GRANT_CHANNEL_IDS (comma-separated channel ids)");
  process.exit(1);
}
if (GRANT_MODE === "role") {
  console.warn(
    "[discord] WARNING: role mode grants a Discord role, which is visible on the member's profile card " +
      "to everyone in the server. It therefore discloses who holds a masternode, which is the fact the " +
      "proof exists to keep private. Use channel mode unless your community has decided it does not " +
      "care about that disclosure.",
  );
}
if (GRANT_MODE === "role" && !ROLE_ID) {
  console.error("[discord] DISCORD_GRANT_MODE=role needs DISCORD_MNO_ROLE_ID");
  process.exit(1);
}
if (!Number.isFinite(SWEEP_SECONDS) || SWEEP_SECONDS <= 0) {
  console.error(`[discord] DISCORD_SWEEP_SECONDS must be a positive number, got '${process.env.DISCORD_SWEEP_SECONDS}'`);
  process.exit(1);
}

let guildRef = null;
const getGuild = async () => (guildRef ??= await client.guilds.fetch(GUILD_ID));
// Apply the access a grant record describes. Every channel is attempted independently and real
// failures are collected, so one bad channel cannot abandon the rest. Under the old bare loop a retry
// always restarted at the failing channel, so a member never received the channels behind it. Same
// shape as the decommission loop, which was fixed a commit earlier while this one was left alone.
//
// The grant path used to write the managed bits with no denial check at all, which three of the four
// round 9 reviewers reported as a blocker: setting the bits to true over a member-level deny overrides
// an exclusion an administrator set by hand, so a member who had been deliberately shut out could walk
// back in by running /submit. The fourth reviewer called that the intentional ownership claim, but the
// bot's own design says it refuses a conflict it can see, and the startup quarantine exists precisely
// to stop granting while a denial is present. A denial that appears after startup is the same conflict
// with worse timing. grantMemberOverwrite and addRole carry the check now.
async function applyAccess(userId, record) {
  const guild = await getGuild();
  if (record.mode !== "channel") {
    const member = await guild.members.fetch(userId);
    await addRole(guild, member, record.roleId);
    return;
  }
  const failures = [];
  for (const chId of record.channels) {
    try {
      const ch = await guild.channels.fetch(chId);
      await grantMemberOverwrite(ch, userId);
    } catch (e) {
      failures.push(`${chId}: ${e.message}`);
    }
  }
  if (failures.length) throw new Error(`could not grant ${failures.join("; ")}`);
}

// A 404 from Discord means the channel, member, or guild is already gone, so there is nothing to
// revoke and the access cannot still be live. Any other error (a lost permission, an outage) is a real
// failure that must propagate, so the sweep keeps the record and retries instead of dropping it and
// stranding live access.


// Undo exactly what a grant record granted, using the record's own mode and target. Throws on a real
// failure so the caller can keep the grant and retry.
// Refuses THIS mutation rather than the process, so the ledger keeps the record and unrelated cleanup
// continues. A startup gate cannot cover this: revocation acts on the target the RECORD names, which
// may be a channel dropped from the configuration, one that was briefly unreachable when the gate ran,
// or a whole other guild.
//
// Residual, stated rather than solved: the check reads the cached overwrite, so a denial the cache has
// not yet seen can still be cleared. There is no compare-and-set for Discord permissions. The
// difference from the two versions that were rejected is that this REFUSES to touch a conflict instead
// of trying to preserve it through a rewrite, which is a far smaller claim. The check itself lives in
// permissions.js now, attached to the mutation, so it cannot be present here and absent elsewhere.
async function revokeAccess(userId, record) {
  const guild = await getGuild();
  // A record from another guild names access this process cannot reach. Refusing keeps the row, so the
  // access stays tracked instead of being forgotten.
  if (record.guildId && String(record.guildId) !== String(GUILD_ID)) {
    throw new Error(
      `record names guild ${record.guildId}, this bot serves ${GUILD_ID}. The access is still live there ` +
        `and cannot be reached from here. Decommission it in that guild; the record is kept until then.`,
    );
  }
  // Every channel independently, failures collected and thrown after the loop, so the ledger keeps the
  // record for retry and a blocked channel does not hide the ones behind it.
  //
  // Every call is guarded by isGone, including the removal itself and not just the lookup.
  //
  // A record written before startup validation existed can name a role or channel from another guild.
  // Removal of it fails with Unknown Role or an unowned-channel error forever, and because a renewal
  // revokes the orphaned target BEFORE applying the new one, that member could never be repaired: every
  // re-verification aborted on the same failure and the bad record stayed. An id that this guild does
  // not have is by definition holding no access, so treat it as already gone and let the renewal
  // proceed.
  if (record.mode === "channel") {
    const failures = [];
    for (const chId of record.channels ?? []) {
      let ch;
      try {
        ch = await guild.channels.fetch(chId);
      } catch (e) {
        if (isGone(e)) continue; // genuinely absent from this guild: nothing to take back
        // NOT the same thing: another guild's channel is alive and unreachable, so keep the record.
        failures.push(`${chId}: ${isNotOurs(e) ? "belongs to another guild" : e.message}`);
        continue;
      }
      try {
        await clearMemberOverwrite(ch, userId);
      } catch (e) {
        if (!isGone(e)) failures.push(`${chId}: ${e.message}`);
      }
    }
    if (failures.length) throw new Error(`could not revoke ${failures.join("; ")}`);
  } else if (record.roleId) {
    let member;
    try { member = await guild.members.fetch(userId); } catch (e) { if (isGone(e)) return; throw e; }
    try {
      // Guarded now. A role that gained a denial after startup inverts removal, so taking it away
      // would hand the denied permission back. Refusing keeps the record for retry.
      await removeRole(guild, member, record.roleId);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
  }
}

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
  apply: applyAccess,
  revoke: revokeAccess,
  log: (m) => console.error("[discord]", m),
});

// Revoke lapsed grants, then DM the affected members. The ledger does the revoking and persistence;
// the DM is a Discord concern, so it stays here. Runs at startup as well as on the timer, so a grant that lapsed
// while the bot was down is cleared promptly.
async function sweepAndNotify() {
  const revoked = await ledger.sweep();
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


// GuildMembers is a PRIVILEGED intent and must be enabled for the application in Discord's developer
// portal. Role mode needs it, because reconciliation has to enumerate who currently holds the role.
// Channel mode does not: per-user channel overwrites arrive with the Guilds intent. The startup
// reconciliation below fails closed with an explicit message if role mode cannot read the member list,
// rather than recording a pass it did not actually make.
// Role mode needs the privileged member intent, because deciding who should keep a role means
// enumerating who holds it. Channel mode does not: per-user channel overwrites arrive with the
// ordinary Guilds intent. This depends on the configured mode and nothing else, so there is no state
// to read before the client exists. An earlier version read the marker synchronously here to decide,
// which produced a startup that could refuse forever with no way out.
const client = new Client({
  intents:
    GRANT_MODE === "role" ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] : [GatewayIntentBits.Guilds],
});


// `channelId` names the ONE channel being judged, so a member keeps the channel their record covers
// even when the configuration has since grown to include others.
const authorizedNow = (userId, channelId = null) =>
  authorizesTarget(ledger.get(userId), ledger.live(userId), {
    mode: GRANT_MODE,
    channel: channelId,
    roleId: ROLE_ID,
  });

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
  if (GRANT_MODE === "role") {
    let role;
    try {
      role = await guild.roles.fetch(ROLE_ID);
    } catch (e) {
      if (!isGone(e) && !isNotOurs(e)) throw e; // a blip must not read as "the role is missing"
      role = null;
    }
    if (!role) {
      return { channels: [], ready: false, why: `role ${ROLE_ID} does not exist in ${guild.name} (${guild.id})` };
    }
    // A role the bot adds and removes must only ever ADD permissions. ANY denied bit anywhere inverts
    // it: granting takes that permission away and revoking hands it back, so a grant revokes and a
    // revocation grants. Not limited to the three bits channel mode manages, because a role denying
    // Connect inverts voice access exactly as one denying ViewChannel inverts text access.
    const channels = [...(await guild.channels.fetch()).values()].filter(Boolean).map((ch) => ({
      id: ch.id,
      overwrites: [...(ch.permissionOverwrites?.cache?.values() ?? [])],
    }));
    const offenders = roleDenialsAcrossChannels(channels, ROLE_ID);
    if (offenders.length) {
      // QUARANTINE, not exit. This used to call process.exit(1), which runs inside the ready handler
      // BEFORE the startup sweep and its timer are installed, so one deny overwrite on the configured
      // role stopped every unrelated member's expired access from ever being revoked, indefinitely if
      // the deny was deliberate operator policy. That is the exact inversion the channel branch below
      // was changed to fix, and the role branch beside it was left alone: the twin, again, and three
      // of the four round 9 reviewers found it. Admissions close, cleanup continues, and each role
      // mutation refuses on its own through removeRole, so the sweep keeps a conflicted record for
      // retry while unrelated records are swept normally.
      console.error(
        `[discord] role ${ROLE_ID} is QUARANTINED: it carries a denial on ` +
          `${offenders.map((o) => `${o.channel} (${o.deny.join(", ")})`).join(", ")}. Adding this role ` +
          `would REMOVE access there and removing it would GRANT access, so a grant would revoke and a ` +
          `revocation would grant. Use a role that only ever adds permissions. Admissions stay closed ` +
          `and expired access elsewhere is still being cleaned up.`,
      );
      return {
        channels: [],
        ready: false,
        why: `role ${ROLE_ID} carries a denial that would invert every grant and revocation`,
      };
    }
    return { channels: [], ready: true };
  }

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
  const targets = await usableTargets(guild);
  const removed = [];
  const failed = [];
  // A member who left between the snapshot and the removal holds nothing, so that is completion, not
  // failure. Counting it as a failure aborted the whole pass, and because the pass runs before the
  // sweep and its timer are installed, one departed member stopped every OTHER member's expired grant
  // from ever being revoked until a clean restart.
  const clear = async (userId, undo) => {
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
        console.warn(`[discord] left ${userId} alone during reconciliation: ${e.message}`);
        return;
      }
      failed.push(userId);
      console.error(`[discord] could not take access back from ${userId} during reconciliation: ${e.message}`);
    }
  };

  if (GRANT_MODE === "role") {
    let members;
    try {
      members = await guild.members.fetch();
    } catch (e) {
      throw new Error(
        `cannot read the member list to reconcile role ${ROLE_ID} (${e.message}). Enable the SERVER ` +
          `MEMBERS INTENT for this application in Discord's developer portal, or use channel mode, ` +
          `which needs no privileged intent and does not disclose who holds a masternode.`,
      );
    }
    for (const [id, m] of members) {
      if (id === client.user.id) continue; // never strip the bot
      if (!m.roles.cache.has(ROLE_ID)) continue;
      if (authorizedNow(id)) continue;
      await clear(id, () => removeRole(guild, m, ROLE_ID));
    }
  } else {
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
        await clear(id, () => clearMemberOverwrite(ch, id));
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
  const stale = staleTargets(ledger.all(), { mode: GRANT_MODE, channels: GRANT_CHANNEL_IDS, roleId: ROLE_ID });
  for (const t of stale) {
    console.warn(
      `[discord] WARNING: the ledger holds grants for ${t}, which this bot no longer manages. Members ` +
        `may still hold access there and no sweep will ever find it. Clear it with: ` +
        `npm run discord:decommission -- ${t}`,
    );
  }

  console.log(`[discord] reconciled ${GRANT_MODE} target, took access back from ${removed.length} member(s)`);
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
        mode: GRANT_MODE,
        guildId: GUILD_ID, // so a repoint cannot delete a record for access in a guild we can no longer reach
        channels: GRANT_CHANNEL_IDS,
        roleId: ROLE_ID,
      });
    } catch (e) {
      console.error("[discord] grant failed:", e.message);
      return i.editReply("Verified, but granting access did not complete. Run `/verify` again to retry.");
    }
    const until = new Date(out.expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    const where = GRANT_MODE === "channel" ? "access to the masternode channel" : "the masternode role";
    return i.editReply(`Verified. You have ${where} for this epoch (until ${until} UTC). Run \`/verify\` again after it rolls over to keep access.`);
  }
}

client.once("ready", async () => {
  console.log(`[discord] logged in as ${client.user.tag}, grant mode ${GRANT_MODE}`);
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
        ? "\nRole mode needs the SERVER MEMBERS INTENT enabled for this application in Discord's " +
          "developer portal. Channel mode needs no privileged intent, and does not disclose who holds " +
          "a masternode, so prefer it."
        : ""),
  );
  process.exit(1);
});
