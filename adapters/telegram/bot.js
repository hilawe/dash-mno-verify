// Telegram adapter for dash-mno-verify.
//
// Like the Discord adapter, this file knows about Telegram and nothing about masternodes
// or zero-knowledge. The access action is different again (admission to a gated group), but
// the two calls to the gateway are identical, which is the point.
//
// Admission is bound to the account that proved. An earlier version replied with a single-use
// invite link, which is a bearer token: the gateway had carefully bound the proof to one Telegram
// account, and the adapter then handed out something anyone could use, so a forwarded or intercepted
// link admitted a different account entirely. The link now only creates a JOIN REQUEST, and the bot
// approves a request only from an account holding a live grant, declining every other. The link is
// therefore useless to anyone else.
//
// Access is also taken back when the epoch lapses, through the same persisted grant ledger the
// Discord adapter uses. Removal is a ban followed immediately by an unban, which is Telegram's way of
// removing a member without leaving them banned, so they can re-verify and rejoin next epoch.
//
// The bot must be an administrator of the gated group or channel with permission to invite users via
// link and to restrict members. Set TELEGRAM_GROUP_ID to that chat's id.
import { Bot, InputFile } from "grammy";
import process from "node:process";
import { proveInstructions } from "../../common/prover_instructions.js";
import { GrantLedger } from "../common/grant_ledger.js";
import { requireReconciled } from "../common/reconcile.js";
import { contextHash } from "../../common/index.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const COMMUNITY_ID = process.env.TELEGRAM_COMMUNITY ?? String(GROUP_ID);
const ROLE_ID = process.env.TELEGRAM_ROLE ?? "member";
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there (review B1/M5).
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};
const LEDGER_FILE = process.env.TELEGRAM_GRANT_LEDGER ?? "data/telegram-grants.json";
const SWEEP_SECONDS = Number(process.env.TELEGRAM_SWEEP_SECONDS ?? 60);
const RECONCILE_MARKER = process.env.TELEGRAM_RECONCILED_MARKER ?? "data/telegram-reconciled.json";
const LINK_TTL_SECONDS = Number(process.env.TELEGRAM_LINK_TTL_SECONDS ?? 3600);
// The proof context this bot admits for. A grant records it, so a ledger reused after the chat or
// the community changed cannot admit anyone to a target they never proved for.
const CONTEXT_HASH = contextHash({ platform: "telegram", communityId: COMMUNITY_ID, roleId: ROLE_ID }).toString();

const bot = new Bot(TOKEN);

// The grant record is the authorization. It is written before the member is given a link, and it is
// what the join-request handler checks, so admission can never outrun the record. `apply` has nothing
// to do at grant time because admission happens later, when the member actually asks to join.
const ledger = new GrantLedger({
  file: LEDGER_FILE,
  resetClock: process.env.TELEGRAM_RESET_CLOCK === "1",
  log: (m) => console.error("[telegram]", m),
  apply: async () => {},
  revoke: async (userId) => {
    // Ban then unban removes the member without leaving a standing ban, so they can rejoin after
    // re-verifying. only_if_banned keeps the unban from touching anyone else's state.
    // until_date makes the ban self-expiring, so if the unban below fails the member is not stranded
    // banned until a later sweep happens to succeed. Telegram treats a ban shorter than 30 seconds or
    // longer than 366 days as permanent, so a minute is the smallest safe self-healing window (this
    // applies to supergroups and channels, which is what a gated chat is).
    await bot.api.banChatMember(GROUP_ID, Number(userId), {
      until_date: Math.floor(Date.now() / 1000) + 60,
    });
    try {
      await bot.api.unbanChatMember(GROUP_ID, Number(userId), { only_if_banned: true });
    } catch (e) {
      // The ban still lifts on its own, so report rather than leave the operator guessing.
      console.error(`[telegram] unban after removing ${userId} failed (${e.message}); the ban self-expires in 60s`);
      throw e;
    }
  },
});

bot.command("start", (ctx) =>
  ctx.reply("Run /verify to prove you control a masternode and get an invite to the group.")
);

bot.command("verify", async (ctx) => {
  let res;
  try {
    res = await fetch(`${GATEWAY}/v1/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      platform: "telegram",
      communityId: COMMUNITY_ID,
      roleId: ROLE_ID,
      account: String(ctx.from.id),
      }),
    });
  } catch (e) {
    // A refused connection or a DNS failure THROWS rather than returning a non-ok response, so
    // without this the member simply got silence and no idea whether to retry.
    console.error("[telegram] challenge request failed:", e.message);
    return ctx.reply("Cannot reach the verification service right now. Try again shortly.");
  }
  if (!res.ok) return ctx.reply("Verification service is unavailable right now. Try again shortly.");
  const challenge = await res.json();

  // The challenge carries no secret, so it is safe to send. The member feeds it to the
  // prover on their own machine, where the voting key never leaves.
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(JSON.stringify(challenge, null, 2)), "challenge.json"),
    {
      caption: [
        "Step 1 of 2. On the machine holding your masternode voting key, run:",
        ...proveInstructions(challenge.mode, { gateway: GATEWAY, platform: "telegram", community: COMMUNITY_ID, role: ROLE_ID }),
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
  let out;
  try {
    const res = await fetch(`${GATEWAY}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ ...payload, account: String(ctx.from.id) }),
    });
    out = await res.json();
  } catch (e) {
    console.error("[telegram] verify request failed:", e.message);
    return ctx.reply("Cannot reach the verification service right now. Your proof is still valid; try again shortly.");
  }
  if (!out.ok) return ctx.reply(`Verification failed (${out.reason ?? "unknown"}). Run /verify to start over.`);

  if (!Number.isFinite(out.expiresAt)) {
    console.error("[telegram] gateway returned no valid expiresAt");
    return ctx.reply("Verification succeeded but the gateway did not say when access ends. Nothing was granted; run /verify again.");
  }

  // Record the grant BEFORE handing out the link, so a link can never be usable without a record
  // behind it. The reverse order would admit a member the sweep does not know to remove.
  try {
    await ledger.grant(String(ctx.from.id), {
      expiresAt: out.expiresAt,
      chatId: String(GROUP_ID),
      contextHash: CONTEXT_HASH,
    });
  } catch (e) {
    console.error("[telegram] grant failed:", e.message);
    return ctx.reply("Verification succeeded but access could not be recorded. Run /verify to try again.");
  }

  // A join-request link, not a direct invite: following it only asks to join, and the request is
  // approved only for the account that proved. A forwarded link therefore grants nobody.
  const link = await ctx.api.createChatInviteLink(GROUP_ID, {
    creates_join_request: true,
    expire_date: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
  });
  const until = new Date(out.expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16);
  await ctx.reply(
    `Verified. Request to join here: ${link.invite_link}\n\nOnly this Telegram account will be approved, ` +
      `so the link is no use to anyone else. Access lasts until ${until} UTC; re-verify before then to keep it.`,
  );
});

// The admission decision. The link is public by nature, so this is the check that actually binds
// access to the account that proved.
bot.on("chat_join_request", async (ctx) => {
  const req = ctx.chatJoinRequest;
  if (String(req.chat.id) !== String(GROUP_ID)) return; // not our gated chat
  const userId = String(req.from.id);
  // The check and the approval share the ledger's queue, so an expiry sweep cannot delete the record
  // while the approval is in flight and leave the member admitted but untracked. The record must also
  // name this chat and this proof context: a ledger carried across a TELEGRAM_GROUP_ID or community
  // change would otherwise authorize admission to a chat the member never proved for.
  const admitted = await ledger.admitIfLive(
    userId,
    () => ctx.api.approveChatJoinRequest(req.chat.id, req.from.id),
    (rec) => String(rec.chatId) === String(GROUP_ID) && String(rec.contextHash) === String(CONTEXT_HASH),
  );
  if (admitted) return;
  // No grant, or one that has lapsed. Decline rather than leave the request pending, so a forwarded
  // link fails closed and visibly instead of waiting for an admin to notice it.
  await ctx.api.declineChatJoinRequest(req.chat.id, req.from.id);
  console.log(`[telegram] declined join request from ${userId} (no live grant)`);
});

bot.catch((err) => console.error("[telegram] error:", err.message));

// Take back access whose epoch has lapsed, at startup as well as on the interval, so grants that
// expired while the bot was down do not linger until the first tick.
async function sweep() {
  const revoked = await ledger.sweep();
  for (const userId of revoked) console.log(`[telegram] access revoked for ${userId} (epoch lapsed)`);
}
// Members admitted before this lifecycle existed are not in the ledger, so the sweep cannot see
// them. The Bot API exposes no general member roster, so this one cannot self-reconcile.
await requireReconciled({
  platform: "Telegram",
  markerPath: RECONCILE_MARKER,
  ledgerSize: ledger.size(),
  target: String(GROUP_ID),
  instructions:
    "Establish a closed starting state first. Either point TELEGRAM_GROUP_ID at a NEW gated group and\n" +
    "move members over as they re-verify, or have an admin remove every current member of the existing\n" +
    "group so that access is only re-granted through this adapter.",
});

await sweep().catch((e) => console.error("[telegram] startup sweep failed:", e.message));
setInterval(() => sweep().catch((e) => console.error("[telegram] sweep failed:", e.message)), SWEEP_SECONDS * 1000).unref();

// chat_join_request updates are not in grammY's default allowed set, so they must be asked for
// explicitly or the bot would never see a request and nobody would ever be admitted.
bot.start({
  allowed_updates: ["message", "chat_join_request"],
  onStart: (me) => console.log(`[telegram] running as @${me.username}`),
});
