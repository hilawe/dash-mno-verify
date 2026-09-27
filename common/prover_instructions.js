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
// four, so it passes them in ctx and only <key.wif>, the member's own voting-key file, stays a placeholder.
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
// challenge, then spent the measured 13 minutes registering, and reached the prove step with a
// challenge that had expired after ten. Registration needs no challenge, so it is presented first,
// with the instruction to request a fresh challenge afterwards. A registered member skips it.
//
// Lines are either a short note or a command, and every command starts with "npm run", so an adapter
// can render the commands as code. The key is given as a file (--voting-key-file), not as a bare WIF
// argument, which would land in shell history and the process list.
export function proveInstructions(mode, ctx = {}) {
  if (mode === "two-tier") {
    const gateway = ctx.gateway ?? "<gateway-url>";
    const platform = ctx.platform ?? "<platform>";
    const community = ctx.community ?? "<community-id>";
    const role = ctx.role ?? "<role-id>";
    return [
      "First proof this season? Register first. It needs no challenge, takes about 10 to 15 minutes, and is done once per season. Then request a fresh challenge. Replace <key.wif>, brackets included, with the path to a file holding your voting key, readable only by you.",
      `npm run register -- --gateway ${gateway} --platform ${platform} --community ${community} --role ${role} --voting-key-file <key.wif>`,
      "Already registered this season? Make the proof before the challenge expires.",
      `npm run prove-epoch -- --gateway ${gateway} --challenge challenge.json`,
    ];
  }
  return [
    "Make the proof before the challenge expires. It takes about 10 to 15 minutes. Replace <key.wif>, brackets included, with the path to a file holding your voting key, readable only by you.",
    "npm run prove -- --challenge challenge.json --voting-key-file <key.wif>",
  ];
}
