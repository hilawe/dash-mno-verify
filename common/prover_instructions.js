// The local prover command(s) an adapter tells a member to run, chosen by the gateway's mode, which
// the gateway returns in the challenge. A single-tier member runs the full proof each epoch. A
// two-tier member registers once a season, then runs the cheap per-epoch proof. Both consume the
// adapter's challenge.json and emit proof.json that the adapter submits. Returned as lines so each
// adapter can format them for its platform. test/prover_instructions.test.js pins the commands.
//
// Kept out of common/index.js, which holds the value primitives the prover and gateway must agree
// on (context hash, signal hash, epoch). This is adapter-facing copy, a different boundary.
//
// The two-tier commands need the member-facing gateway URL (the prove fetches the members tree) and
// the exact platform, community, and role (registration hashes them into the context, so a wrong
// guess registers into a tree that will not satisfy this adapter's challenge). The adapter knows all
// four, so it passes them in ctx. The member's own voting-key file has a fixed name (VOTING_KEY_FILE).
// Values left out of ctx fall back to angle-bracket placeholders. Single-tier needs none of this,
// because that prover reads the oracle snapshot locally.
//
// The prove command deliberately passes NO --secret. Registration names the secret per (platform,
// community, role, season), so there is no one filename to print here, and the previous hardcoded
// `--secret member.secret.json` named a file registration has never created: an explicit --secret
// switches the prover out of its context lookup (prover/two_tier.js), so every member who followed
// these instructions hit a missing file. Left off, the prover finds the right secret from the
// challenge's own context and season, which is also the only form that survives a season rollover.
// REGISTRATION COMES BEFORE THE CHALLENGE (review finding F2, 2026-09-27). These lines used to name
// the prove command first and the registration as an aside, so a first-time member took the
// challenge, then spent the measured 13 minutes registering (under the PLONK keys then in use), and reached the prove step with a
// challenge that had expired after ten. Registration needs no challenge, so it is presented first,
// with the instruction to request a fresh challenge afterwards. A registered member skips it.
//
// Lines are either a short note or a command, and every command starts with "npm run", so an adapter
// can render the commands as code. The key is given as a file (--voting-key-file), not as a bare WIF
// argument, which would land in shell history and the process list. The file is named voting-key.txt
// rather than an angle-bracket placeholder, so a member who creates that file as docs/MEMBER_GUIDE.md
// shows can paste the command unchanged (Discord pilot, 2026-09-29).
export const VOTING_KEY_FILE = "voting-key.txt";

// Where the adapters point a member who has never set up the prover. MNO_MEMBER_GUIDE_URL overrides it,
// for a deployment that hosts its own copy, and an empty value turns the link off. Only https is
// accepted, because the link is shown to members as trustworthy.
export const DEFAULT_MEMBER_GUIDE_URL = "https://github.com/hilawe/dash-mno-verify/blob/main/docs/MEMBER_GUIDE.md";

export function memberGuideUrl(env = process.env) {
  const raw = env.MNO_MEMBER_GUIDE_URL;
  if (raw === "") return null;
  const url = raw ?? DEFAULT_MEMBER_GUIDE_URL;
  if (url.length > 256) throw new Error(`MNO_MEMBER_GUIDE_URL is ${url.length} characters, over the 256 the member instructions allow`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MNO_MEMBER_GUIDE_URL is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`MNO_MEMBER_GUIDE_URL must be https, got ${JSON.stringify(url)}`);
  return url;
}

// The commands alone, for an adapter that lays the steps out itself (the Discord adapter does). A null
// or missing gateway prints <gateway-url>, because an adapter that knows no member-facing address
// (common/gateway_url.js memberGatewayUrl) must not print one that cannot work.
export function proveSteps(mode, ctx = {}) {
  if (mode === "two-tier") {
    const gateway = ctx.gateway ?? "<gateway-url>";
    const platform = ctx.platform ?? "<platform>";
    const community = ctx.community ?? "<community-id>";
    const role = ctx.role ?? "<role-id>";
    return {
      register: `npm run register -- --gateway ${gateway} --platform ${platform} --community ${community} --role ${role} --voting-key-file ${VOTING_KEY_FILE}`,
      prove: `npm run prove-epoch -- --gateway ${gateway} --challenge challenge.json`,
    };
  }
  return { register: null, prove: `npm run prove -- --challenge challenge.json --voting-key-file ${VOTING_KEY_FILE}` };
}

const KEY_NOTE = `${VOTING_KEY_FILE} is a file holding your masternode's voting private key, readable only by you.`;

export function proveInstructions(mode, ctx = {}) {
  const { register, prove } = proveSteps(mode, ctx);
  // The guide covers the two-tier setup only (single-tier needs a local oracle snapshot it does not
  // explain), so it is linked only there.
  const guide = ctx.guide ? [`New to this? The setup guide is at ${ctx.guide}`] : [];
  if (mode === "two-tier") {
    return [
      `First time this season? Register first. It needs no challenge, takes 1 to 2 minutes, and is done once per season. ${KEY_NOTE} If your challenge runs out while you register, request a fresh challenge.`,
      register,
      "Then, in the folder holding challenge.json, make the proof before the challenge expires. It takes about a minute and saves proof.json.",
      prove,
      ...guide,
    ];
  }
  return [
    `In the folder holding challenge.json, make the proof before the challenge expires. It takes 1 to 2 minutes and saves proof.json. ${KEY_NOTE}`,
    prove,
  ];
}
