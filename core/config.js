import process from "node:process";
import { publicKeyFromRaw, rawPublicB64 } from "../common/oracle_sig.js";
import { isValidEngineStatement } from "./registration_store.js";

// Parse the trusted oracle public keys, a comma-separated list of raw Ed25519 keys (base64). Each is
// turned into a key object once, at boot, failing loud on a malformed key rather than per refresh.
// Duplicates are dropped on the decoded key bytes, not the raw string, so the same key written in two
// base64 spellings (padded, unpadded, or base64url) counts once and cannot satisfy a quorum twice.
function oraclePubkeys(env, name) {
  const raw = env[name];
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

// A comma-separated list setting, trimmed, empties dropped, duplicates collapsed.
// A snapshot needs one signature per trusted signer and no more. Exported so the boot check below
// and the gateway's own refusal cannot drift apart.
export const MAX_SNAPSHOT_SIGS = 64;

function listEnv(env, name) {
  const raw = env[name];
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

// Read an integer setting from the environment, failing loud at boot on a malformed value rather
// than letting a silent NaN through. A NaN here is not harmless: NaN as a cap or limit makes every
// `size >= cap` comparison false, which would quietly disable the very guard the setting controls.
function intEnv(env, name, defaultValue, { min = 1 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`config: ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

// All deployment-specific values come from the environment so nothing is hard-coded, except
// treeDepth, which is pinned to the compiled circuits (see below).
// Built from an environment object rather than read from process.env at import, so a caller can
// construct a fully validated config for a synthetic environment. That is what makes the gateway
// boot refusals testable: they are the behaviour of a config plus a boot, and both are now values
// a test can produce. The module-level `config` below is the process environment applied to it, so
// nothing about running the gateway changes.
export function buildConfig(env = process.env) {
  const config = {
    port: intEnv(env, "MNO_GATEWAY_PORT", 8787),

    // How a membership epoch is sized. One week by default. A sold node loses access
    // within one epoch, because it can no longer produce a fresh proof.
    epochSeconds: intEnv(env, "MNO_EPOCH_SECONDS", 7 * 24 * 3600),

    // How long an issued challenge stays valid before the member must request a new one.
    challengeTtlSeconds: intEnv(env, "MNO_CHALLENGE_TTL", 600),

    // How many recently published roots the gateway will accept. A small window absorbs
    // DML churn between blocks while keeping the eviction lag for removed nodes short.
    rootWindow: intEnv(env, "MNO_ROOT_WINDOW", 8),

    // The total leaf elements the root window may retain across every record it holds, 0 to disable
    // the bound. The window keeps one record per (height, leaf ordering), each carrying the snapshot
    // whose leaves /v1/dml serves, so its memory was the product of three unrelated limits: the
    // window size, the two orderings that coexist during a changeover, and the per-snapshot leaf cap
    // of 2**treeDepth. Measured on this build: 16 records hold 3.1 MiB at the live mainnet size of
    // 2,972 leaves and 64.7 MiB at full tree capacity.
    //
    // The default admits four full-capacity snapshots (about 16 MiB), which at the live mainnet size
    // is 88 records. UNDER THE DEFAULT MNO_ROOT_WINDOW OF 8 that is well clear of the at most 16
    // records a changeover can produce, so the height window binds first and this never fires.
    //
    // THAT CLAIM IS ABOUT THE DEFAULT WINDOW, NOT ABOUT EVERY WINDOW, and MNO_ROOT_WINDOW has no
    // upper bound. A deployment running a window of 100 heights at mainnet size holds up to 200
    // records, and this bound would keep 88 of them, so the accepted history would be shorter than
    // the one configured, quietly, after an upgrade. A deployment that raises MNO_ROOT_WINDOW must
    // raise this with it. The interaction is pinned by a test rather than left to this comment.
    //
    // Where it does bind it shortens the accepted-root history, and a proof anchored to a height it
    // evicted IS refused (stale-or-unknown-root), exactly as one aged out by MNO_ORACLE_MAX_AGE is.
    // An earlier version of this comment said the bound shortens history "rather than refusing
    // anything", which is not true of the member holding that proof: the prover re-reads /v1/dml and
    // re-proves, which is the same recovery every other eviction rule already asks for. What the
    // bound never does is refuse the NEWEST height, because a root current with no leaves behind it
    // would leave /v1/dml unable to serve what /v1/challenge advertised.
    rootWindowMaxLeaves: intEnv(env, "MNO_ROOT_WINDOW_MAX_LEAVES", 4 * 65536, { min: 0 }),

    // Where to read freshly published roots from. Either a URL serving the oracle JSON
    // or a local file path.
    oracleSource: env.MNO_ORACLE_SOURCE ?? "oracle/root.json",
    oracleRefreshSeconds: intEnv(env, "MNO_ORACLE_REFRESH", 30),

    // Permit a plain-HTTP oracle URL to a non-loopback host. Off by default, because the snapshot
    // authenticates the membership set and an unencrypted fetch hands a network position the ability
    // to serve a different one. Read here rather than deep in the fetch, so it is part of the config
    // a caller supplies and cannot be flipped by an ambient process environment variable.
    oracleAllowHttp: env.MNO_ORACLE_ALLOW_HTTP === "1",

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
    oracleMaxAgeSeconds: intEnv(env, "MNO_ORACLE_MAX_AGE", 1800, { min: 0 }),

    // Bounds on the oracle's self-reported timestamp at adoption. A snapshot stamped older than
    // oracleMaxAgeSeconds, or more than this far in the future, is not adopted. The future bound stops
    // a clock-skewed or replayed future-dated snapshot from being treated as fresh.
    oracleFutureSkewSeconds: intEnv(env, "MNO_ORACLE_FUTURE_SKEW", 120, { min: 0 }),

    // Trusted oracle public keys and how many must sign a snapshot before the gateway adopts it. The
    // signature authenticates the leaf set, so a host serving the JSON cannot forge a membership set
    // (see common/oracle_sig.js). With several keys and a quorum above one, an attacker must compromise
    // several independent signers. The gateway fails closed: with no keys it refuses to start unless
    // allowUnsignedOracle is set, the same shape as the adapter-secret guard below.
    // WHERE THE DML COMES FROM. `snapshot` (the default) fetches published JSON from
    // MNO_ORACLE_SOURCE and authenticates it against pinned oracle keys. `node` reads it directly
    // from a Dash Core node this gateway is configured to talk to, gated on ChainLock.
    //
    // The two have DIFFERENT TRUST MODELS, which is the point rather than a detail. The snapshot path
    // trusts whoever holds the oracle signing keys, and exists for split deployments where the gateway
    // cannot reach a node. The node path trusts the node the operator already runs, which for a
    // self-hosting operator is a strictly smaller trust set: no signing keys, no quorum, no snapshot
    // transport, nothing to compromise between the chain and the gateway.
    //
    // It is NOT chain-authenticated even so. One server answers the ChainLock query, the block hash,
    // and the list, so it can return matching hashes alongside an arbitrary set. That is a trusted-node
    // read, and it becomes chain-authenticated only when the merkleRootMNList commitment check exists.
    dmlSource: env.MNO_DML_SOURCE ?? "snapshot",
    nodeRpcUrl: env.MNO_RPC_URL ?? null,
    nodeRpcUser: env.MNO_RPC_USER ?? null,
    nodeRpcPass: env.MNO_RPC_PASS ?? "",
    nodeRpcHeader: env.MNO_RPC_HEADER ?? null,
    nodeCallTimeoutMs: intEnv(env, "MNO_RPC_TIMEOUT_MS", 30_000, { min: 1000 }),
    oraclePubkeys: oraclePubkeys(env, "MNO_ORACLE_PUBKEYS"),
    oracleQuorum: intEnv(env, "MNO_ORACLE_QUORUM", 1, { min: 1 }),
    allowUnsignedOracle: env.MNO_ALLOW_UNSIGNED_ORACLE === "1",
    // An operator's assertion that the shared Platform nullifier state was written under THIS
    // epoch/season schedule. See the refusal in gateway.js for why it cannot be checked automatically.
    // The operator's assertion, which must NAME the schedule it is asserting rather than being a bare
    // "1". A boolean stands for whatever the config later says, so an operator who set it once to boot
    // and then changed the epoch or season length would have their old assertion wave the new schedule
    // through, which is the exact silent reinterpretation the refusal exists to prevent.
    platformAssumeSchedule: env.MNO_PLATFORM_ASSUME_SCHEDULE ?? "",
    platformSchedulePath: env.MNO_PLATFORM_SCHEDULE_PATH ?? "data/platform_schedule.json",
    // Explicit opt-in to the pre-allowlist behaviour, in the same style as MNO_ALLOW_UNAUTH_GATEWAY
    // and MNO_ALLOW_UNSIGNED_ORACLE: an unset allowlist is a misconfiguration, not a default.
    allowAnyRegisterContext: env.MNO_ALLOW_ANY_REGISTER_CONTEXTS === "1",
    // Deployment-scoped requirement for the zkVM dual-root snapshot. When any zkVM registration
    // context is served, the gateway MUST adopt only a v2 snapshot carrying the SHA-256 root under a
    // v2 quorum signature, so a downgraded v1 snapshot (which lacks the root the zkVM statement needs)
    // cannot become current. Set MNO_REQUIRE_SHA_ROOT=1 for a zkVM deployment. Until the durable
    // per-(season, context) engine declaration lands (step 5), this flag is the deployment-scoped
    // signal; step 5 refines it to also require v2 whenever a current-season zkVM context is declared.
    requireShaRoot: env.MNO_REQUIRE_SHA_ROOT === "1",

    // Unauthenticated-endpoint guards. Per-client fixed-window limits on /v1/challenge and /v1/verify
    // plus a hard cap on pending challenges, so one source cannot mint unlimited nonces or force
    // unlimited PLONK verifies. Adapter-only authentication (the real fix) is a tracked P1 item.
    rateWindowSeconds: intEnv(env, "MNO_RATE_WINDOW", 60),
    challengeRateMax: intEnv(env, "MNO_RATE_CHALLENGE", 60),
    // PER-ACCOUNT limits for the account-bearing endpoints, applied in addition to the per-source
    // ones above. Every shipped adapter makes the gateway request itself and forwards no originating
    // client address, so the gateway sees ONE client for every user behind that adapter, and a
    // source-keyed limit is therefore a shared bucket: one noisy user could spend the whole window
    // and deny challenges to everyone else in that community. Keying by account restores fairness
    // between users, and the source-keyed limit stays as the aggregate guard.
    //
    // These are per account per window, so they are deliberately small: a human verifying membership
    // needs a handful of attempts, not dozens.
    // A cheap per-source gate checked BEFORE the request body is read, so an unauthenticated flood
    // cannot buy body reads and JSON parsing. The account-bearing limits cannot do this job: the
    // account is only knowable after parsing, which is exactly what needs bounding first. Generous on
    // purpose, because it is an ingress shield rather than a fairness rule.
    ingressRateMax: intEnv(env, "MNO_RATE_INGRESS", 300),
    // How many distinct windows one limiter tracks before it starts evicting the oldest. Exposed so a
    // test can fill the table without sending fifty thousand requests, and so an operator can trade
    // memory against accuracy deliberately.
    rateMaxKeys: intEnv(env, "MNO_RATE_KEYS", 50_000, { min: 16 }),
    // The longest account identifier this gateway will accept. The body is already capped, but a
    // single enormous account string still becomes a rate-limit key, a stored challenge field, and a
    // durable claim value, so it is retained far past the request that carried it. Adapters supply
    // platform user ids, which are short; this is generous next to any of them.
    maxAccountBytes: intEnv(env, "MNO_MAX_ACCOUNT_BYTES", 256, { min: 8 }),
    accountChallengeRateMax: intEnv(env, "MNO_RATE_CHALLENGE_ACCOUNT", 10),
    accountVerifyRateMax: intEnv(env, "MNO_RATE_VERIFY_ACCOUNT", 20),
    verifyRateMax: intEnv(env, "MNO_RATE_VERIFY", 120),
    // Registration (two-tier) runs the heaviest proof verify and is a once-per-season action, so it
    // gets the tightest limit.
    registerRateMax: intEnv(env, "MNO_RATE_REGISTER", 30),
    // /v1/members is an unauthenticated read whose context comes from the client, so it is limited too.
    membersRateMax: intEnv(env, "MNO_RATE_MEMBERS", 120),
    // /v1/dml is public, unauthenticated, and returns the whole leaf set, which is the largest
    // response this gateway serves. It was the one read endpoint with no limit at all while its
    // sibling /v1/members had one, so a flood forced repeated serialization of a multi-megabyte array.
    dmlRateMax: intEnv(env, "MNO_RATE_DML", 60),
    maxPendingChallenges: intEnv(env, "MNO_MAX_PENDING_CHALLENGES", 100_000),
    // Request-body size caps. The general cap stays small, since challenge and verify bodies are tiny.
    // The registration cap is separate and larger, because a zkVM registration carries the STARK
    // receipt (a few megabytes for the unwrapped path, docs/ZKVM_INTEGRATION.md). Kept a distinct knob
    // so raising it for the receipt does not widen the unauthenticated challenge and verify endpoints.
    maxBodyBytes: intEnv(env, "MNO_MAX_BODY_BYTES", 2_000_000, { min: 1024 }),
    maxRegisterBodyBytes: intEnv(env, "MNO_MAX_REGISTER_BODY_BYTES", 2_000_000, { min: 1024 }),
    // Global cap on how many expensive cryptographic verifies (the PLONK proof or zkVM receipt check)
    // run at once, plus how many may wait before the gateway sheds load with a 503. The per-client rate
    // limit bounds one source; this bounds the whole gateway against a distributed flood exhausting CPU
    // and memory. Only the verify is gated, so cheap policy rejections never consume a slot.
    verifyConcurrency: intEnv(env, "MNO_VERIFY_CONCURRENCY", 4, { min: 1 }),
    verifyQueueMax: intEnv(env, "MNO_VERIFY_QUEUE_MAX", 256, { min: 0 }),
    // Honor the first X-Forwarded-For hop for the client key. Only enable behind a trusted proxy,
    // otherwise a client can spoof the header to dodge the limit.
    trustProxy: env.MNO_TRUST_PROXY === "1",

    // Shared secret an adapter presents (Authorization: Bearer <secret>) to call the account-bearing
    // endpoints (/v1/challenge, /v1/verify). When set, the gateway trusts the submitted account
    // because only an authenticated adapter could send it, which is what makes the B1 account binding
    // authoritative rather than just closing the adapter relay path. /v1/register is member-driven and
    // proof-authenticated, so it does not take this token; public reads (members, dml, health) never do.
    adapterSecret: env.MNO_ADAPTER_SECRET || null,

    // The gateway fails closed: with no adapterSecret it refuses to start, so an operator cannot
    // silently run an open gateway by forgetting the secret. Set this to "1" to opt into running
    // unauthenticated on purpose (local dev, demos, tests); the gateway then warns at boot.
    allowUnauthGateway: env.MNO_ALLOW_UNAUTH_GATEWAY === "1",

    // PLONK verification key for the single-tier membership circuit.
    verificationKeyPath: env.MNO_VKEY ?? "circuits/build/verification_key.json",

    // "single" runs the one-tier membership proof every epoch. "two-tier" splits it into a
    // heavy seasonal registration plus a cheap per-epoch members proof.
    mode: env.MNO_MODE ?? "single",
    // The contexts this gateway will accept a registration for, as context hashes, empty meaning no
    // allowlist is configured. Registration is deliberately unauthenticated (the proof is the
    // credential), and the caller chooses the platform, community, and role that form the context, so
    // without a list one valid masternode holder can create unlimited context trees, each costing a
    // durable record and a cached tree. An operator already knows which communities they gate, so the
    // list is the smallest thing that bounds it.
    registerContexts: listEnv(env, "MNO_REGISTER_CONTEXTS"),
    // How old the DML root a REGISTRATION is anchored to may be, in seconds. 0 disables the rule and
    // falls back to whatever the membership window accepts.
    //
    // WHY THIS IS SEPARATE FROM THE MEMBERSHIP WINDOW. A membership proof against a slightly stale
    // root buys one epoch of access. A REGISTRATION proof against the same root buys the REMAINDER OF
    // THE CURRENT SEASON, up to 90 days by default. So a node that left the masternode list minutes
    // ago can register against a root published just before it left and keep membership for the rest
    // of that season, which is weaker than what "seasonal re-registration re-proves current control"
    // promises.
    //
    // SOME grace is unavoidable in this design, because a prover must fetch leaves, build a tree, and
    // produce a heavy proof before submitting, so a root is always somewhat old by the time it is
    // used. A different design could remove it (a short registration challenge pinning an eligible
    // root would), and that is recorded in TODO.md rather than claimed here.
    //
    // THE DEFAULT IS FINITE AND IS A JUDGMENT, not a measurement. 900 seconds is meant to sit
    // comfortably above the observed registration proving time (minutes on masternode-class hardware
    // per docs/REDUCING_PROVING_COST.md) while being well under the membership window's own 1800s
    // bound, so the grace a departed node gets is halved rather than inherited. A deployment whose
    // provers are slower should raise it and will see the refusal as stale-or-unknown-root; one that
    // wants the tightest defensible anchor should lower it.
    registerRootMaxAgeSeconds: intEnv(env, "MNO_REGISTER_ROOT_MAX_AGE", 900, { min: 0 }),

    // Two-tier keys and season length.
    registrationVkeyPath: env.MNO_REG_VKEY ?? "circuits/build/mno_registration_vkey.json",
    membersVkeyPath: env.MNO_MEMBERS_VKEY ?? "circuits/build/mno_members_vkey.json",
    seasonSeconds: intEnv(env, "MNO_SEASON_SECONDS", 90 * 24 * 3600),

    // The registration engine and statement this gateway offers (two-tier). "plonk"/"derive" is the
    // shipping default (the compiled mno_registration circuit). "zkvm" selects the RISC Zero
    // registration path, which needs the live receipt verifier (deferred, artifact-gated), so a zkvm
    // gateway refuses to boot until one is wired. The pair binds each (season, context) this gateway
    // seeds, and it must be a valid engine/statement combination (validated at boot).
    registrationEngine: env.MNO_REGISTRATION_ENGINE ?? "plonk",
    registrationStatement: env.MNO_REGISTRATION_STATEMENT ?? "derive",

    // Durable, season-scoped registration records for the two-tier flow. Append-only JSON lines on
    // a single gateway, so registrations survive a restart and the members tree rebuilds from them.
    // With MNO_STORE=platform the records live on Dash Platform instead (the next step).
    registrationStorePath: env.MNO_REG_PATH ?? "data/registrations.jsonl",

    // Where the spent-nullifier set lives.
    //   "sqlite"   (default) durable on one gateway, survives a restart mid-epoch.
    //   "platform" shared across gateways via the Dash Platform contract's unique index.
    //   "memory"   ephemeral, for local work only, and it must be asked for explicitly (see
    //              allowEphemeralNullifiers) because a restart forgets every spend and lets one
    //              voting key claim a second account inside the same epoch.
    // See docs/PLATFORM.md.
    store: env.MNO_STORE ?? "sqlite",

    // The durable claim database for MNO_STORE=sqlite.
    nullifierStorePath: env.MNO_NULLIFIER_PATH ?? "data/nullifiers.sqlite",

    // Where the highest observed epoch and season are recorded, so a backward clock cannot roll the
    // gateway's security state back into a period it has already left. Unused in ephemeral mode
    // (MNO_STORE=memory), which has no durable state to protect. If a clock jumped far forward and was
    // then corrected, the gateway stays refused until real time passes the mark; deleting this file is
    // the deliberate operator override, and it should be done only when the correct time is known.
    timeMarksPath: env.MNO_TIME_MARKS_PATH ?? "data/time_marks.json",

    // One-time acknowledgement that an existing registration store, written before the schedule header
    // existed, really was produced under the current epoch and season lengths.
    assumeSchedule: env.MNO_ASSUME_SCHEDULE === "1",

    // How many past epochs of spent nullifiers to keep beyond the current one. The verifier only ever
    // consults the epoch a challenge was minted for, so older rows are dead weight, but one past epoch
    // is retained because a challenge minted just before a rollover is still verified against its own
    // epoch. Keeping too much is harmless; keeping too little would forget a live spend, so this floors
    // at 1 rather than trusting the environment.
    nullifierRetainEpochs: Math.max(1, intEnv(env, "MNO_NULLIFIER_RETAIN_EPOCHS", 1)),

    // Opt in to the ephemeral in-memory spent set. The gateway refuses to start on "memory" without
    // this, so a deployment cannot lose the one-membership-per-epoch guarantee by leaving a default
    // in place. Local runs and tests set it deliberately.
    allowEphemeralNullifiers: env.MNO_ALLOW_EPHEMERAL_NULLIFIERS === "1",
    platform: {
      network: env.MNO_PLATFORM_NETWORK ?? "testnet",
      mnemonic: env.MNO_PLATFORM_MNEMONIC,
      contractId: env.MNO_PLATFORM_CONTRACT_ID,
      appName: env.MNO_PLATFORM_APP ?? "mnoVerify",
    },
  };

  // The configured registration engine/statement must be a valid pair, or the gateway would seed
  // buckets under a declaration the store rejects. Validated here so a typo fails fast at boot.
  if (!isValidEngineStatement(config.registrationEngine, config.registrationStatement)) {
    throw new Error(
      `config: MNO_REGISTRATION_ENGINE/STATEMENT (${config.registrationEngine}/${config.registrationStatement}) is not a valid pair`,
    );
  }

  // A quorum larger than the number of trusted keys can never be met, so the gateway would never adopt
  // a root. Catch that at boot rather than letting it look like a perpetually stale oracle.
  // MNO_MODE selects which implementation runs, so an unrecognised value must not quietly pick one.
  // Every value other than "two-tier" selected the single-tier keys and handlers while the challenge
  // response echoed the unvalidated string back to clients, so a typo booted the opposite gateway
  // from the operator's intent and said so in a field nobody reads.
  const DML_SOURCES = new Set(["snapshot", "node"]);
  if (!DML_SOURCES.has(config.dmlSource)) {
    throw new Error(
      `MNO_DML_SOURCE must be one of ${[...DML_SOURCES].join(", ")}, got ${JSON.stringify(config.dmlSource)}. ` +
        `Refusing rather than defaulting, because the two have different trust models.`,
    );
  }

  const MODES = new Set(["single", "two-tier"]);
  if (!MODES.has(config.mode)) {
    throw new Error(
      `MNO_MODE must be one of ${[...MODES].join(", ")}, got ${JSON.stringify(config.mode)}. Refusing ` +
        `rather than defaulting, because the default would be the other implementation.`,
    );
  }

  // The signature cap must not make a configured quorum unreachable. The cap exists to bound work on a
  // hostile array, so a deployment pinning more signers than the cap would refuse every snapshot,
  // which is a guard with no exit that ordinary correct operation reaches.
  // The reachable question is the QUORUM, not the roster. A deployment may pin many keys and require
  // only a few signatures, and such a snapshot fits under the cap comfortably. A first version of this
  // check compared the roster size and refused a 65-key roster with a quorum of one, which is a guard
  // with no exit for a configuration that works, and a reviewer reproduced it.
  if (config.oracleQuorum > MAX_SNAPSHOT_SIGS) {
    throw new Error(
      `MNO_ORACLE_QUORUM is ${config.oracleQuorum}, above the ${MAX_SNAPSHOT_SIGS} signature cap, so no ` +
        `snapshot could ever carry enough signatures to meet it. Raise the cap deliberately or lower ` +
        `the quorum.`,
    );
  }

  if (config.oraclePubkeys.length > 0 && config.oracleQuorum > config.oraclePubkeys.length) {
    throw new Error(
      `config: MNO_ORACLE_QUORUM (${config.oracleQuorum}) exceeds the number of trusted oracle keys (${config.oraclePubkeys.length})`,
    );
  }

  return config;
}

// NO CONFIG IS BUILT AT IMPORT. This module used to export `config = buildConfig(process.env)`, which
// meant importing it (and so importing the gateway) VALIDATED the ambient environment: a malformed
// MNO_GATEWAY_PORT in the shell made the import itself throw, before any caller could supply a config
// of its own. That is the same defect the gateway's own import-time boot was, one level down, and it
// made "importing the gateway does nothing" not quite true. The environment is read when a gateway is
// built, which is where a refusal belongs.
