// Telegram adapter for dash-mno-verify.
//
// Like the Discord adapter, this file knows about Telegram and nothing about masternodes
// or zero-knowledge. The access action is different again (a single-use invite link to a
// gated group), but the two calls to the gateway are identical, which is the point.
//
// The bot must be an administrator of the gated group or channel with permission to invite
// users via link. Set TELEGRAM_GROUP_ID to that chat's id.
import { Bot, InputFile } from "grammy";
import process from "node:process";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const COMMUNITY_ID = process.env.TELEGRAM_COMMUNITY ?? String(GROUP_ID);
const ROLE_ID = process.env.TELEGRAM_ROLE ?? "member";
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};

const bot = new Bot(TOKEN);

bot.command("start", (ctx) =>
  ctx.reply("Run /verify to prove you control a masternode and get an invite to the group.")
);

bot.command("verify", async (ctx) => {
  const res = await fetch(`${GATEWAY}/v1/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      platform: "telegram",
      communityId: COMMUNITY_ID,
      roleId: ROLE_ID,
      account: String(ctx.from.id),
    }),
  });
  if (!res.ok) return ctx.reply("Verification service is unavailable right now. Try again shortly.");
  const challenge = await res.json();

  // The challenge carries no secret, so it is safe to send. The member feeds it to the
  // prover on their own machine, where the voting key never leaves.
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(JSON.stringify(challenge, null, 2)), "challenge.json"),
    {
      caption: [
        "Step 1 of 2. On the machine holding your masternode voting key, run:",
        "npm run prove -- --challenge challenge.json --voting-key <WIF>",
        "Then send me the proof.json it produces.",
        "",
        "Your key, and which node you control, never leave your device.",
      ].join("\n"),
    }
  );
});

// Step 2: the member sends back proof.json as a document.
bot.on("message:document", async (ctx) => {
  let payload;
  try {
    const file = await ctx.getFile(); // path valid for ~1 hour
    const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    payload = await (await fetch(url)).json(); // { nonce, proof, publicSignals }
  } catch {
    return ctx.reply("That file is not a readable proof.json. Run /verify to start over.");
  }

  // Submit the account this user is identified by. The gateway binds the verify to it (review B1).
  const res = await fetch(`${GATEWAY}/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ ...payload, account: String(ctx.from.id) }),
  });
  const out = await res.json();
  if (!out.ok) return ctx.reply(`Verification failed (${out.reason ?? "unknown"}). Run /verify to start over.`);

  // Access is membership in the gated group, granted by a single-use, expiring invite link.
  const link = await ctx.api.createChatInviteLink(GROUP_ID, {
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600,
  });
  await ctx.reply(`Verified. Your single-use invite (valid one hour): ${link.invite_link}`);
});

bot.catch((err) => console.error("[telegram] error:", err.message));
bot.start({ onStart: (me) => console.log(`[telegram] running as @${me.username}`) });
