// The local prover command(s) an adapter tells a member to run, chosen by the gateway's mode, which
// the gateway returns in the challenge. A single-tier member runs the full proof each epoch. A
// two-tier member registers once a season, then runs the cheap per-epoch proof. Both consume the
// adapter's challenge.json and emit proof.json that the adapter submits. Returned as lines so each
// adapter can format them for its platform. test/prover_instructions.test.js pins the commands.
//
// Kept out of common/index.js, which holds the value primitives the prover and gateway must agree
// on (context hash, signal hash, epoch). This is adapter-facing copy, a different boundary.
export function proveInstructions(mode) {
  if (mode === "two-tier") {
    // The two-tier prove fetches the members tree from the gateway, so it needs --gateway.
    return [
      "npm run prove-epoch -- --gateway <url> --challenge challenge.json --secret member.secret.json",
      "(once per season, before your first proof, run: npm run register -- --gateway <url> --platform <p> --community <id> --role <id> --voting-key <WIF>)",
    ];
  }
  // The single-tier prover reads the oracle snapshot locally, so it needs no gateway URL.
  return ["npm run prove -- --challenge challenge.json --voting-key <WIF>"];
}
