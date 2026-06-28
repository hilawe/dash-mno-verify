// Discord adapter for dash-mno-verify.
//
// This file knows about Discord. It knows nothing about masternodes or zero-knowledge.
// It asks the gateway for a challenge, relays it to the member, takes the proof the
// member produced locally, asks the gateway to verify, and assigns a role on success.
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
} from "discord.js";
import process from "node:process";
import { proveInstructions } from "../../common/prover_instructions.js";

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_MNO_ROLE_ID;
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there. Sent on the
// account-bearing calls so the gateway trusts the account this adapter vouches for (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};

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
      body: JSON.stringify({ platform: "discord", communityId: GUILD_ID, roleId: ROLE_ID, account: i.user.id }),
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
        ...proveInstructions(challenge.mode).map((l) => "   `" + l + "`"),
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

    const member = await i.guild.members.fetch(i.user.id);
    await member.roles.add(ROLE_ID);
    const until = new Date(out.expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    return i.editReply(`Verified. You have the masternode role for this epoch (until ${until} UTC). Re-run \`/verify\` after it rolls over.`);
  }
});

client.once("ready", () => console.log(`[discord] logged in as ${client.user.tag}`));

await registerCommands();
await client.login(TOKEN);
