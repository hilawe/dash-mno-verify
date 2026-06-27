import process from "node:process";

// Read an integer setting from the environment, failing loud at boot on a malformed value rather
// than letting a silent NaN through. A NaN here is not harmless: NaN as a cap or limit makes every
// `size >= cap` comparison false, which would quietly disable the very guard the setting controls.
function intEnv(name, defaultValue, { min = 1 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`config: ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

// All deployment-specific values come from the environment so nothing is hard-coded, except
// treeDepth, which is pinned to the compiled circuits (see below).
export const config = {
  port: intEnv("MNO_GATEWAY_PORT", 8787),

  // How a membership epoch is sized. One week by default. A sold node loses access
  // within one epoch, because it can no longer produce a fresh proof.
  epochSeconds: intEnv("MNO_EPOCH_SECONDS", 7 * 24 * 3600),

  // How long an issued challenge stays valid before the member must request a new one.
  challengeTtlSeconds: intEnv("MNO_CHALLENGE_TTL", 600),

  // How many recently published roots the gateway will accept. A small window absorbs
  // DML churn between blocks while keeping the eviction lag for removed nodes short.
  rootWindow: intEnv("MNO_ROOT_WINDOW", 8),

  // Where to read freshly published roots from. Either a URL serving the oracle JSON
  // or a local file path.
  oracleSource: process.env.MNO_ORACLE_SOURCE ?? "oracle/root.json",
  oracleRefreshSeconds: intEnv("MNO_ORACLE_REFRESH", 30),

  // Merkle tree depth, shared by the oracle, the members tree, and the gateway's root recompute.
  // Pinned to the compiled circuits and verification keys, so it is a constant, not an env knob: a
  // mismatch would silently drift the root recompute and /v1/dml from the proof artifacts. Changing
  // it requires recompiling the circuits and a re-setup.
  treeDepth: 16,

  // Stop serving an accepted root once its snapshot timestamp is this old, so a stalled or replayed
  // source stops admitting members. Expiry keys off the snapshot's own timestamp, which adoption
  // bounds to no more than oracleFutureSkewSeconds in the future, so a forged future timestamp can
  // hold a root open by at most that skew, not indefinitely. Set to 0 to disable (for example a
  // pinned local fixture). Must exceed the oracle's publish cadence.
  oracleMaxAgeSeconds: intEnv("MNO_ORACLE_MAX_AGE", 1800, { min: 0 }),

  // Bounds on the oracle's self-reported timestamp at adoption. A snapshot stamped older than
  // oracleMaxAgeSeconds, or more than this far in the future, is not adopted. The future bound stops
  // a clock-skewed or replayed future-dated snapshot from being treated as fresh.
  oracleFutureSkewSeconds: intEnv("MNO_ORACLE_FUTURE_SKEW", 120, { min: 0 }),

  // Unauthenticated-endpoint guards. Per-client fixed-window limits on /v1/challenge and /v1/verify
  // plus a hard cap on pending challenges, so one source cannot mint unlimited nonces or force
  // unlimited PLONK verifies. Adapter-only authentication (the real fix) is a tracked P1 item.
  rateWindowSeconds: intEnv("MNO_RATE_WINDOW", 60),
  challengeRateMax: intEnv("MNO_RATE_CHALLENGE", 60),
  verifyRateMax: intEnv("MNO_RATE_VERIFY", 120),
  // Registration (two-tier) runs the heaviest proof verify and is a once-per-season action, so it
  // gets the tightest limit.
  registerRateMax: intEnv("MNO_RATE_REGISTER", 30),
  maxPendingChallenges: intEnv("MNO_MAX_PENDING_CHALLENGES", 100_000),
  // Honor the first X-Forwarded-For hop for the client key. Only enable behind a trusted proxy,
  // otherwise a client can spoof the header to dodge the limit.
  trustProxy: process.env.MNO_TRUST_PROXY === "1",

  // PLONK verification key for the single-tier membership circuit.
  verificationKeyPath: process.env.MNO_VKEY ?? "circuits/build/verification_key.json",

  // "single" runs the one-tier membership proof every epoch. "two-tier" splits it into a
  // heavy seasonal registration plus a cheap per-epoch members proof.
  mode: process.env.MNO_MODE ?? "single",

  // Two-tier keys and season length.
  registrationVkeyPath: process.env.MNO_REG_VKEY ?? "circuits/build/mno_registration_vkey.json",
  membersVkeyPath: process.env.MNO_MEMBERS_VKEY ?? "circuits/build/mno_members_vkey.json",
  seasonSeconds: intEnv("MNO_SEASON_SECONDS", 90 * 24 * 3600),

  // Durable, season-scoped registration records for the two-tier flow. Append-only JSON lines on
  // a single gateway, so registrations survive a restart and the members tree rebuilds from them.
  // With MNO_STORE=platform the records live on Dash Platform instead (the next step).
  registrationStorePath: process.env.MNO_REG_PATH ?? "data/registrations.jsonl",

  // Where the spent-nullifier set lives. "memory" is a single gateway. "platform" shares it
  // across gateways via the Dash Platform contract's unique index. See docs/PLATFORM.md.
  store: process.env.MNO_STORE ?? "memory",
  platform: {
    network: process.env.MNO_PLATFORM_NETWORK ?? "testnet",
    mnemonic: process.env.MNO_PLATFORM_MNEMONIC,
    contractId: process.env.MNO_PLATFORM_CONTRACT_ID,
    appName: process.env.MNO_PLATFORM_APP ?? "mnoVerify",
  },
};
