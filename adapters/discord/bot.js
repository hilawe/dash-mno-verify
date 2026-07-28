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
import { GrantLedger, authorizesTarget, targetKey, targetsToSweep } from "./grant_ledger.js";
import { markReconciled, readMarker } from "../common/reconcile.js";

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_MNO_ROLE_ID;
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there. Sent on the
// account-bearing calls so the gateway trusts the account this adapter vouches for (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};

// Default "role" for back-compatibility; a privacy-sensitive community should set "channel".
const GRANT_MODE = process.env.DISCORD_GRANT_MODE ?? "role";
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

if (GRANT_MODE !== "channel" && GRANT_MODE !== "role") {
  console.error(`[discord] DISCORD_GRANT_MODE must be 'channel' or 'role', got '${GRANT_MODE}'`);
  process.exit(1);
}
if (GRANT_MODE === "channel" && GRANT_CHANNEL_IDS.length === 0) {
  console.error("[discord] DISCORD_GRANT_MODE=channel needs DISCORD_GRANT_CHANNEL_IDS (comma-separated channel ids)");
  process.exit(1);
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
const ACCESS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true };
// Reset only the bits the bot granted, back to inherit, rather than deleting the whole overwrite, so a
// permission the channel set on this user for another reason is left intact. Treat a bot-managed
// channel as bot-owned (see the README), since the bot cannot tell a manual ViewChannel grant from its
// own and will clear it on expiry.
const ACCESS_CLEARED = { ViewChannel: null, SendMessages: null, ReadMessageHistory: null };

// Apply the access a grant record describes. The overwrite type is passed explicitly, because after a
// restart a raw user id is not resolvable to a member from cache, and the edit would otherwise throw.
async function applyAccess(userId, record) {
  const guild = await getGuild();
  if (record.mode === "channel") {
    for (const chId of record.channels) {
      const ch = await guild.channels.fetch(chId);
      await ch.permissionOverwrites.edit(userId, ACCESS, { type: OverwriteType.Member });
    }
  } else {
    const member = await guild.members.fetch(userId);
    await member.roles.add(record.roleId);
  }
}

// A 404 from Discord means the channel, member, or guild is already gone, so there is nothing to
// revoke and the access cannot still be live. Any other error (a lost permission, an outage) is a real
// failure that must propagate, so the sweep keeps the record and retries instead of dropping it and
// stranding live access.
const isGone = (e) => e?.status === 404 || [10003, 10004, 10007, 10011, 10013].includes(e?.code);

// Undo exactly what a grant record granted, using the record's own mode and target. Throws on a real
// failure so the caller can keep the grant and retry.
async function revokeAccess(userId, record) {
  const guild = await getGuild();
  if (record.mode === "channel") {
    for (const chId of record.channels ?? []) {
      let ch;
      try { ch = await guild.channels.fetch(chId); } catch (e) { if (isGone(e)) continue; throw e; }
      await ch.permissionOverwrites.edit(userId, ACCESS_CLEARED, { type: OverwriteType.Member });
    }
  } else if (record.roleId) {
    let member;
    try { member = await guild.members.fetch(userId); } catch (e) { if (isGone(e)) return; throw e; }
    await member.roles.remove(record.roleId);
  }
}

const ledger = new GrantLedger({
  file: GRANTS_DB,
  importFrom: LEGACY_GRANTS_FILE,
  apply: applyAccess,
  revoke: revokeAccess,
  log: (m) => console.error("[discord]", m),
});

// Revoke lapsed grants, then DM the affected members. The ledger does the revoking and persistence;
// the DM is a Discord concern, so it stays here. Runs once at startup too, so a grant that lapsed
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
const client = new Client({
  intents:
    GRANT_MODE === "role" ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] : [GatewayIntentBits.Guilds],
});

// Members who were given access before this lifecycle existed, or by a previous deployment pointed at
// a different target, hold access the ledger knows nothing about, and the sweep only ever looks at the
// ledger. Discord can read its own state, so the closed starting state is reachable automatically the
// way Matrix does it: find everyone currently holding access this bot has no live, matching grant for,
// and take it back. Runs once, then records that it happened.
//
// This is also the only mitigation available for the case no lock can cover: a bot terminated between
// a platform request being accepted and taking effect leaves access with no record, and nothing but a
// pass over real platform state will ever find it.
const RECONCILE_MARKER = process.env.DISCORD_RECONCILED_MARKER ?? "data/discord-reconciled.json";
// The marker is bound to the target, so a marker earned for one role or channel set does not satisfy
// the gate after the operator repoints the bot, which is exactly when unknown members appear. Ids are
// sorted and deduplicated, so merely reordering DISCORD_GRANT_CHANNEL_IDS does not look like a new
// target and trigger a second destructive pass over nothing.
const RECONCILE_TARGET =
  GRANT_MODE === "channel" ? targetKey("channel", GRANT_CHANNEL_IDS) : targetKey("role", [ROLE_ID]);
// Prior targets the operator knows about but nothing recorded, for the first upgrade only. Same form
// as the marker, comma-separated: "role:oldRoleId" or "channel:c1,c2".
const RECONCILE_ALSO = (process.env.DISCORD_RECONCILE_ALSO ?? "").split(/\s+/).filter(Boolean);

const authorizedNow = (userId) =>
  authorizesTarget(ledger.get(userId), ledger.live(userId), {
    mode: GRANT_MODE,
    channels: GRANT_CHANNEL_IDS,
    roleId: ROLE_ID,
  });

// Interactions arrive as soon as the gateway is ready, and the ready handler awaits this pass, so a
// member can run /submit while it is running. Reconciliation touches Discord directly rather than
// through the ledger's per-member queue, so without this gate its removal and a concurrent grant's
// addition could overlap and land in the wrong order, leaving a live record and no access, which the
// sweep then leaves alone because the record looks fine.
let reconciled = false;

async function reconcileGuild() {
  const prior = await readMarker(RECONCILE_MARKER);
  if (prior && String(prior.target ?? "") === RECONCILE_TARGET) {
    reconciled = true;
    return;
  }
  const guild = await getGuild();
  const removed = [];
  const failed = [];

  // Everything this bot may have granted through: the current target, whatever the last marker
  // recorded, the targets the ledger's own records name, and anything the operator supplied. A pass
  // over only the current target leaves a member holding a role the operator moved away from, and the
  // sweep cannot see them either, because the ledger never had a record for them.
  const { roles, channels } = targetsToSweep({
    current: RECONCILE_TARGET,
    history: [...(prior?.covered ?? []), ...(prior?.target ? [prior.target] : []), ...RECONCILE_ALSO],
    records: ledger.all(),
  });

  const clear = async (userId, undo) => {
    try {
      await undo();
      removed.push(userId);
    } catch (e) {
      failed.push(userId);
      console.error(`[discord] could not take access back from ${userId} during reconciliation: ${e.message}`);
    }
  };

  if (roles.length) {
    // Reading the member list needs the privileged intent, which is only requested in role mode. A
    // channel-mode bot that has an old ROLE to clean cannot get it, so say exactly what to do rather
    // than skipping the role silently and recording a pass that did not cover it.
    if (GRANT_MODE !== "role") {
      throw new Error(
        `refusing to start: a previous configuration granted the role(s) ${roles.join(", ")}, and ` +
          `clearing them needs the member list, which only role mode requests. Start once with ` +
          `DISCORD_GRANT_MODE=role and DISCORD_MNO_ROLE_ID set to the old role to clean it up, or remove ` +
          `the role from its remaining holders by hand, then start again.`,
      );
    }
    let members;
    try {
      members = await guild.members.fetch();
    } catch (e) {
      throw new Error(
        `refusing to start: role mode cannot reconcile without reading the member list (${e.message}). ` +
          `Enable the SERVER MEMBERS INTENT for this application in Discord's developer portal.`,
      );
    }
    for (const [id, m] of members) {
      if (id === client.user.id) continue; // never strip the bot
      for (const roleId of roles) {
        if (!m.roles.cache.has(roleId)) continue;
        // Only the CURRENT target can be authorized. A live record never justifies keeping a role the
        // bot no longer grants through.
        if (roleId === ROLE_ID && authorizedNow(id)) continue;
        await clear(id, () => m.roles.remove(roleId));
      }
    }
  }

  for (const chId of channels) {
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
      if (GRANT_CHANNEL_IDS.includes(chId) && authorizedNow(id)) continue;
      await clear(id, () => ch.permissionOverwrites.edit(id, ACCESS_CLEARED, { type: OverwriteType.Member }));
    }
  }

  // Only a CLEAN pass may be recorded. Marking a partial one done would skip reconciliation on every
  // later start, leaving the members it could not clear holding access the sweep can never see, which
  // is the exact hole this gate exists to close.
  if (failed.length) {
    throw new Error(
      `refusing to start: could not take access back from ${failed.length} member(s) with no live grant ` +
        `during reconciliation (${failed.join(", ")}). Give the bot the permission it needs, or clear ` +
        `them by hand, then start again.`,
    );
  }
  // Carry the history forward, so a later repoint still knows about every target used before it.
  const covered = [...new Set([...(prior?.covered ?? []), ...(prior?.target ? [prior.target] : []), ...RECONCILE_ALSO])];
  await markReconciled(RECONCILE_MARKER, { removed: removed.length, target: RECONCILE_TARGET, covered });
  reconciled = true;
  console.log(
    `[discord] reconciled ${RECONCILE_TARGET}` +
      `${covered.length ? ` (also swept ${covered.join(", ")})` : ""}, ` +
      `took access back from ${removed.length} member(s)`,
  );
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
      await ledger.grant(i.user.id, { expiresAt: out.expiresAt, mode: GRANT_MODE, channels: GRANT_CHANNEL_IDS, roleId: ROLE_ID });
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
  try {
    await reconcileGuild();
  } catch (e) {
    console.error(`[discord] ${e.message}`);
    process.exit(1);
  }
  await sweepAndNotify().catch((e) => console.error("[discord] startup sweep failed:", e.message));
  setInterval(() => sweepAndNotify().catch((e) => console.error("[discord] sweep failed:", e.message)), SWEEP_SECONDS * 1000);
});

await registerCommands();
await client.login(TOKEN);
