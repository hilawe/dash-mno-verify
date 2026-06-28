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
// four, so it passes them in ctx and only <WIF>, the member's own voting key, stays a placeholder.
// Values left out of ctx fall back to angle-bracket placeholders. Single-tier needs none of this,
// because that prover reads the oracle snapshot locally.
export function proveInstructions(mode, ctx = {}) {
  if (mode === "two-tier") {
    const gateway = ctx.gateway ?? "<gateway-url>";
    const platform = ctx.platform ?? "<platform>";
    const community = ctx.community ?? "<community-id>";
    const role = ctx.role ?? "<role-id>";
    return [
      `npm run prove-epoch -- --gateway ${gateway} --challenge challenge.json --secret member.secret.json`,
      `(once per season, before your first proof, run: npm run register -- --gateway ${gateway} --platform ${platform} --community ${community} --role ${role} --voting-key <WIF>)`,
    ];
  }
  return ["npm run prove -- --challenge challenge.json --voting-key <WIF>"];
}
