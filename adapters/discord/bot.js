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
import { GrantLedger } from "./grant_ledger.js";

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
const GRANTS_FILE = process.env.DISCORD_GRANTS_FILE ?? "adapters/discord/grants.json";

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
  file: GRANTS_FILE,
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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (i) => {
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
});

client.once("ready", async () => {
  console.log(`[discord] logged in as ${client.user.tag}, grant mode ${GRANT_MODE}`);
  // Sweep once now (clearing grants that lapsed while the bot was down), then on a timer, so a member
  // who does not re-verify loses access after the epoch.
  await sweepAndNotify().catch((e) => console.error("[discord] startup sweep failed:", e.message));
  setInterval(() => sweepAndNotify().catch((e) => console.error("[discord] sweep failed:", e.message)), SWEEP_SECONDS * 1000);
});

await registerCommands();
await client.login(TOKEN);
