import process from "node:process";
import { publicKeyFromRaw, rawPublicB64 } from "../common/oracle_sig.js";

// Parse the trusted oracle public keys, a comma-separated list of raw Ed25519 keys (base64). Each is
// turned into a key object once, at boot, failing loud on a malformed key rather than per refresh.
// Duplicates are dropped on the decoded key bytes, not the raw string, so the same key written in two
// base64 spellings (padded, unpadded, or base64url) counts once and cannot satisfy a quorum twice.
function oraclePubkeys(name) {
  const raw = process.env[name];
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const key = publicKeyFromRaw(entry); // decodes and validates the 32-byte key, throws on a bad one
    const id = rawPublicB64(key); // canonical base64 of the raw bytes, identical across base64 spellings
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ b64: id, key });
  }
  return out;
}

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

  // Trusted oracle public keys and how many must sign a snapshot before the gateway adopts it. The
  // signature authenticates the leaf set, so a host serving the JSON cannot forge a membership set
  // (see common/oracle_sig.js). With several keys and a quorum above one, an attacker must compromise
  // several independent signers. The gateway fails closed: with no keys it refuses to start unless
  // allowUnsignedOracle is set, the same shape as the adapter-secret guard below.
  oraclePubkeys: oraclePubkeys("MNO_ORACLE_PUBKEYS"),
  oracleQuorum: intEnv("MNO_ORACLE_QUORUM", 1, { min: 1 }),
  allowUnsignedOracle: process.env.MNO_ALLOW_UNSIGNED_ORACLE === "1",
  // Deployment-scoped requirement for the zkVM dual-root snapshot. When any zkVM registration
  // context is served, the gateway MUST adopt only a v2 snapshot carrying the SHA-256 root under a
  // v2 quorum signature, so a downgraded v1 snapshot (which lacks the root the zkVM statement needs)
  // cannot become current. Set MNO_REQUIRE_SHA_ROOT=1 for a zkVM deployment. Until the durable
  // per-(season, context) engine declaration lands (step 5), this flag is the deployment-scoped
  // signal; step 5 refines it to also require v2 whenever a current-season zkVM context is declared.
  requireShaRoot: process.env.MNO_REQUIRE_SHA_ROOT === "1",

  // Unauthenticated-endpoint guards. Per-client fixed-window limits on /v1/challenge and /v1/verify
  // plus a hard cap on pending challenges, so one source cannot mint unlimited nonces or force
  // unlimited PLONK verifies. Adapter-only authentication (the real fix) is a tracked P1 item.
  rateWindowSeconds: intEnv("MNO_RATE_WINDOW", 60),
  challengeRateMax: intEnv("MNO_RATE_CHALLENGE", 60),
  verifyRateMax: intEnv("MNO_RATE_VERIFY", 120),
  // Registration (two-tier) runs the heaviest proof verify and is a once-per-season action, so it
  // gets the tightest limit.
  registerRateMax: intEnv("MNO_RATE_REGISTER", 30),
  // /v1/members is an unauthenticated read whose context comes from the client, so it is limited too.
  membersRateMax: intEnv("MNO_RATE_MEMBERS", 120),
  maxPendingChallenges: intEnv("MNO_MAX_PENDING_CHALLENGES", 100_000),
  // Request-body size caps. The general cap stays small, since challenge and verify bodies are tiny.
  // The registration cap is separate and larger, because a zkVM registration carries the STARK
  // receipt (a few megabytes for the unwrapped path, docs/ZKVM_INTEGRATION.md). Kept a distinct knob
  // so raising it for the receipt does not widen the unauthenticated challenge and verify endpoints.
  maxBodyBytes: intEnv("MNO_MAX_BODY_BYTES", 2_000_000, { min: 1024 }),
  maxRegisterBodyBytes: intEnv("MNO_MAX_REGISTER_BODY_BYTES", 2_000_000, { min: 1024 }),
  // Honor the first X-Forwarded-For hop for the client key. Only enable behind a trusted proxy,
  // otherwise a client can spoof the header to dodge the limit.
  trustProxy: process.env.MNO_TRUST_PROXY === "1",

  // Shared secret an adapter presents (Authorization: Bearer <secret>) to call the account-bearing
  // endpoints (/v1/challenge, /v1/verify). When set, the gateway trusts the submitted account
  // because only an authenticated adapter could send it, which is what makes the B1 account binding
  // authoritative rather than just closing the adapter relay path. /v1/register is member-driven and
  // proof-authenticated, so it does not take this token; public reads (members, dml, health) never do.
  adapterSecret: process.env.MNO_ADAPTER_SECRET || null,

  // The gateway fails closed: with no adapterSecret it refuses to start, so an operator cannot
  // silently run an open gateway by forgetting the secret. Set this to "1" to opt into running
  // unauthenticated on purpose (local dev, demos, tests); the gateway then warns at boot.
  allowUnauthGateway: process.env.MNO_ALLOW_UNAUTH_GATEWAY === "1",

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

// A quorum larger than the number of trusted keys can never be met, so the gateway would never adopt
// a root. Catch that at boot rather than letting it look like a perpetually stale oracle.
if (config.oraclePubkeys.length > 0 && config.oracleQuorum > config.oraclePubkeys.length) {
  throw new Error(
    `config: MNO_ORACLE_QUORUM (${config.oracleQuorum}) exceeds the number of trusted oracle keys (${config.oraclePubkeys.length})`,
  );
}
