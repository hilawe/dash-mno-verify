// The member-facing text of the Discord adapter, kept apart from bot.js so it can be tested without a
// Discord connection. Discord renders headings, numbered steps, code blocks, masked links, and
// <t:unix:style> timestamps, which show each member the time in their own time zone.
//
// Rewritten after the Discord pilot (2026-09-29) found the earlier text hard to follow. It was one block
// of notes, it named the adapter's internal gateway address (common/gateway_url.js memberGatewayUrl),
// it gave times in UTC and called the period an "epoch", and its deadline read "expires 32 minutes ago"
// once it had passed, because a relative timestamp was spliced after the word "expires".

const MAX_CONTENT = 2000; // Discord's limit on a message's content

const ts = (unix, style) => `<t:${unix}:${style}>`;
const finite = (x) => Number.isFinite(x);
const block = (cmd) => "```\n" + cmd + "\n```";

// Discord markdown and mention syntax, backslash-escaped, for a string the bot does not control (a
// server name). Without it a server named "[Renew here](https://example.org)" became a working link
// inside the bot's own message.
export function escapeMarkdown(text) {
  return String(text).replace(/[\r\n]+/g, " ").replace(/[\\*_~`|>\[\]()<#@:-]/g, "\\$&");
}

// Split a message into pieces Discord accepts, at blank lines so a section and its command block stay
// together. A single section longer than the limit is cut at the limit as a last resort, because a
// reply that arrives with broken formatting still beats one Discord refuses outright. The member
// gateway address and guide link are capped at 256 characters (common/gateway_url.js), so reaching
// that needs a context label of well over a thousand characters.
export function splitForDiscord(text, max = MAX_CONTENT) {
  const pieces = [];
  let cur = "";
  for (const section of text.split("\n\n")) {
    const next = cur ? cur + "\n\n" + section : section;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur) pieces.push(cur);
    cur = section;
    while (cur.length > max) {
      pieces.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// The reply to /verify, shown only to the member, with challenge.json attached. `steps` is
// common/prover_instructions.js proveSteps(). A register step appears only in two-tier mode, and so does
// the setup guide link, since docs/MEMBER_GUIDE.md covers the two-tier setup only. The result can pass
// Discord's limit with extreme configured values, so the caller sends it through splitForDiscord.
export function verifyReply({ challenge, steps, guideUrl = null }) {
  const lines = [
    "## Masternode verification",
    "This proves you run a Dash masternode without revealing which one. Your voting key, and which masternode is yours, never leave your computer.",
    "",
  ];
  if (finite(challenge?.challengeExpiresAt)) {
    const at = challenge.challengeExpiresAt;
    lines.push(`**Your challenge file is attached below.** Use it before **${ts(at, "t")}** (${ts(at, "R")}). If time runs out, type \`/verify\` again for a new one.`);
  } else {
    lines.push("**Your challenge file is attached below.** If it expires, type `/verify` again for a new one.");
  }
  if (finite(challenge?.accessEndsAt)) {
    lines.push(`If you finish now, your access lasts until **${ts(challenge.accessEndsAt, "f")}**.`);
  }

  let n = 0;
  if (steps.register) {
    const until = finite(challenge?.seasonEndsAt) ? ` Registration lasts until **${ts(challenge.seasonEndsAt, "D")}**.` : "";
    lines.push(
      "",
      `### ${++n}. Register (first time this season only)`,
      `It needs no challenge and takes 1 to 2 minutes.${until} \`voting-key.txt\` is a file holding your masternode's voting private key, readable only by you.`,
      block(steps.register),
    );
  }
  lines.push(
    "",
    `### ${++n}. Make your proof`,
    steps.register
      ? "Save `challenge.json` into your prover folder and run this there. It takes about a minute and saves `proof.json` in the same folder."
      : "Save `challenge.json` into your prover folder and run this there. It takes 1 to 2 minutes and saves `proof.json` in the same folder. `voting-key.txt` is a file holding your masternode's voting private key, readable only by you.",
    block(steps.prove),
    "",
    `### ${++n}. Submit it`,
    "Type `/submit` here, attach `proof.json`, and press Enter.",
  );

  const placeholder = [steps.register, steps.prove].some((c) => c?.includes("<gateway-url>"));
  const notes = [];
  if (placeholder) notes.push("-# Replace `<gateway-url>` with the gateway address a server admin gives you.");
  if (guideUrl && steps.register) notes.push(`-# New to this? Read the [setup guide](<${guideUrl}>).`);
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}

// The reply to a successful /submit. channelIds are the channels access was granted on. At most
// MAX_CHANNELS are named, so a long configured list cannot push the confirmation past Discord's limit
// after access was already granted. Anything that is not a Discord id is left out rather than echoed.
const MAX_CHANNELS = 10;
export function verifiedReply({ expiresAt, channelIds = [] }) {
  const ids = channelIds.filter((id) => /^\d{1,20}$/.test(String(id)));
  const named = ids.slice(0, MAX_CHANNELS).map((id) => `<#${id}>`).join(", ");
  const more = ids.length > MAX_CHANNELS ? ` and ${ids.length - MAX_CHANNELS} more` : "";
  const where = ids.length ? named + more : "the masternode channel";
  return [
    `**Verified.** You now have access to ${where}. It lasts until **${ts(expiresAt, "f")}** (${ts(expiresAt, "R")}).`,
    "To keep access after that, type `/verify` again and follow its steps.",
  ].join("\n");
}

// The direct message a member gets when the sweep takes their access back.
export function accessEndedNotice({ guildName = null } = {}) {
  const where = guildName ? `in **${escapeMarkdown(guildName)}**` : "on the server";
  return `Your masternode access ${where} has ended. To get it back, type \`/verify\` in the server and follow the steps.`;
}

// The plain explanation of a refused /submit, by the reason the gateway gave. The code itself is kept
// on a quiet last line, so a member can quote it to an admin.
const REASONS = {
  "already-used": "This membership has already let a different Discord account in for this period. Each membership admits one account at a time.",
  "unknown-or-expired-challenge": "That proof's challenge has expired or was already used. Type `/verify` for a new challenge, make a new proof from it, and submit that.",
  "account-mismatch": "That proof was made from a challenge issued to a different Discord account. Type `/verify` from this account and use that challenge.",
  "invalid-proof": "The proof did not check out. Make sure it was made from the challenge in your latest `/verify` reply, then type `/verify` to start over.",
  "season-rolled-over": "A new season started while you were proving. Register again, then type `/verify` for a new challenge.",
  "wrong-season": "Your proof was made for a season that has ended. Register again, then type `/verify` for a new challenge.",
  "epoch-rolled-over": "A new access period started while you were proving. Type `/verify` for a new challenge and prove again.",
  "wrong-epoch": "Your proof was made for an access period that has ended. Type `/verify` for a new challenge and prove again.",
  "stale-or-unknown-root": "Your proof was made against a list that is no longer accepted. Type `/verify` for a new challenge and prove again.",
  "clock-regressed": "The verification service has a clock problem. Try again later, and tell a server admin if it keeps happening.",
};

export function failureReply(reason) {
  const code = typeof reason === "string" && /^[a-z-]{1,64}$/.test(reason) ? reason : "unknown";
  const text = REASONS[code] ?? "Verification failed. Type `/verify` to start over.";
  return `**Not verified.** ${text}\n-# Reason code: \`${code}\``;
}

export { MAX_CONTENT };
