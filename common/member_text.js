// Member-facing sentences the adapters share, so the platforms cannot drift apart. The review of
// 2026-09-29 found one overbroad privacy claim and one wrong renewal instruction copied into three
// adapters each. Plain text only. An adapter adds its own markup around it.
//
// `verify` is how the member asks for a challenge on that platform, as a phrase that reads mid-sentence:
// "type `/verify`" on Discord, "send /verify" on Telegram, "send !verify" on Matrix.

// What the proof hides, stated no wider than it is (review finding F2). The key stays on the member's
// computer and the proof does not name the masternode. Where the prover connects from, timing, and a
// very small eligible set can still reveal it, which docs/MEMBER_GUIDE.md explains.
export const PRIVACY_LINE =
  "This proves you control an eligible masternode voting key. The key stays on your computer and the proof " +
  "does not name your masternode, but the network you run the prover from can still reveal which one it is.";

// After a grant (review finding F4). Access ends on a fixed boundary shared by every member, and with the
// default schedule that boundary is the season's, so proving again before it gains nothing and a new
// season needs a new registration first.
export function renewalLine(verify) {
  return `Verifying again before then does not extend it. After it ends, ${verify} again, and register first if a new season has started.`;
}

// When the verify request itself failed in transit (review finding F4). The gateway may already have
// taken the challenge, so nothing here can say the proof is still good. One resend is worth trying, and
// a fresh challenge from the same account is the way back if that is refused.
export function uncertainResultLine(verify) {
  return (
    "Could not get an answer from the verification service, so the result is unknown. Send the same proof " +
    `once more in a minute. If it is refused as expired, ${verify} for a fresh challenge and make a new proof from this account.`
  );
}

// A refused verify, explained by the reason the gateway gave, with the problems a member cannot fix
// told apart from the ones they can (review finding F4).
const SERVICE = "This is a problem with the verification service, not with your proof. Tell a server admin and quote the reason code.";
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const REASONS = {
  "already-used": () =>
    "This membership has already let a different account in for this period. Each membership admits one account at a time, so use the account that verified first.",
  "unknown-or-expired-challenge": (v) =>
    `That proof's challenge has expired or was already used. To start again, ${v} for a new challenge, make a new proof from it, and submit that.`,
  "account-mismatch": (v) => `That proof was made from a challenge issued to a different account. To fix it, ${v} from this account and use that challenge.`,
  // The gateway takes the challenge before it runs these checks, so it is used up by the time one fails.
  // Rebuilding from it could only be refused again, so each points to a fresh challenge.
  "invalid-proof": (v) => `The proof did not match its challenge, and that challenge is now used up. ${cap(v)} for a new challenge and make a new proof from it.`,
  "wrong-signal": (v) => `The proof was made from a different challenge, and this one is now used up. ${cap(v)} for a new challenge and make a new proof from it.`,
  "non-canonical-signal": (v) => `The proof file is malformed, and its challenge is now used up. ${cap(v)} for a new challenge and make a new proof from it.`,
  "wrong-context": (v) => `That proof was made for a different community, and its challenge is now used up. ${cap(v)} here for a new challenge and make a new proof from it.`,
  "season-rolled-over": (v) => `A new season started while you were proving. Register again, then ${v} for a new challenge.`,
  "wrong-season": (v) => `Your proof was made for a season that has ended. Register again, then ${v} for a new challenge.`,
  "epoch-rolled-over": (v) => `A new access period started while you were proving. To continue, ${v} for a new challenge and prove again.`,
  "wrong-epoch": (v) => `Your proof was made for an access period that has ended. To continue, ${v} for a new challenge and prove again.`,
  "stale-or-unknown-root": (v) => `Your proof was made against a list that is no longer accepted. To continue, ${v} for a new challenge and prove again.`,
  "clock-regressed": () => SERVICE,
  "context-not-served": () => SERVICE,
  "engine-mismatch": () => SERVICE,
  "invalid-engine-statement": () => SERVICE,
  "zkvm-verifier-not-configured": () => SERVICE,
  "missing-account": () => SERVICE,
};

// Returns { code, text }. A reason that is not a plain code is reported as "unknown" rather than echoed,
// so a gateway response cannot put arbitrary text into a member's chat.
export function refusalText(reason, verify) {
  const code = typeof reason === "string" && /^[a-z-]{1,64}$/.test(reason) ? reason : "unknown";
  const text = Object.hasOwn(REASONS, code) ? REASONS[code](verify) : `Verification failed. To start again, ${verify}.`;
  return { code, text };
}

// A refused verify as the adapter received it. A response with no reason code is not the member's to fix
// by proving again (review of 2026-09-29): a 401 means the adapter's secret does not match the gateway's,
// and a 5xx is the gateway failing. Only a malformed upload (400) and rate limiting (429) are the member's.
export function refusalFromResponse(status, body, verify) {
  if (body && typeof body.reason === "string") return refusalText(body.reason, verify);
  const code = Number.isInteger(status) ? `http-${status}` : "unknown";
  if (status === 400) return { code, text: `That file is not a complete proof. ${cap(verify)} for a new challenge and make a new proof from it.` };
  if (status === 429) return { code, text: "Too many attempts right now. Wait a few minutes, then try again." };
  return { code, text: SERVICE };
}

// The challenge deadline and the season end as UTC text, for platforms without a local-time markup.
export function scheduleLinesUtc(challenge) {
  const utc = (t) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [];
  if (Number.isFinite(challenge?.challengeExpiresAt)) lines.push(`This challenge expires at ${utc(challenge.challengeExpiresAt)}.`);
  if (Number.isFinite(challenge?.seasonEndsAt)) lines.push(`This season, and a registration made in it, ends at ${utc(challenge.seasonEndsAt)}.`);
  return lines;
}
