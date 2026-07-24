// Platform-neutral verification gateway.
//
// Any adapter (Discord, Telegram, Matrix, a web gate) speaks to these HTTP endpoints. The
// gateway never learns a masternode address, a voting key, or which node proved. It learns
// only a per-account nonce and an unlinkable nullifier.
//
// The account-bearing endpoints (/v1/challenge, /v1/verify) require the adapter bearer token
// (Authorization: Bearer $MNO_ADAPTER_SECRET) when that secret is set, so the account is vouched for
// by a trusted adapter. /v1/register is member-driven and proof-authenticated (no account, no token);
// the read-only endpoints (members, dml, health) are public.
//
// Single mode (MNO_MODE=single):
//   POST /v1/challenge  { platform, communityId, roleId, account }
//        -> { nonce, signalHash, epoch, root, contextHash, epochSeconds, mode }
//        mode is "single" or "two-tier", so the adapter renders the matching local prover command.
//   POST /v1/verify     { nonce, proof, publicSignals, account }  -> { ok, account, epoch, expiresAt }
//        account is the submitter, and must equal the account the challenge was minted for (B1).
//
// Two-tier mode (MNO_MODE=two-tier) adds a heavy seasonal registration and makes the
// per-epoch challenge and verify run against the cheap members tree:
//   POST /v1/register   { platform, communityId, roleId, proof, publicSignals }
//        -> { ok, index, membersRoot, size }
//   GET  /v1/members?context=<hash> -> { membersRoot, size, commitments }  (per-context, for paths)
//
//   GET  /v1/health     -> { ok, mode, root, dmlRoot, season, contexts? }
import { createServer } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { RootStore, NullifierStore, ChallengeStore, RateLimiter, loadOracle } from "./stores.js";
import { loadVerificationKey, verifyMembership, verifyRegistration } from "./verifier.js";
import { SeasonMembers } from "./season.js";
import { makeDmlRootHasher } from "./dml_root.js";
import { shaRootFromLeaves } from "../common/dml_sha_root.js";
import { isCanonicalField } from "../common/field.js";
import { contextHash, signalHash, epochNow, seasonNow } from "../common/index.js";
import { snapshotMessage, verifySnapshotSig, snapshotVersion } from "../common/oracle_sig.js";

const twoTier = config.mode === "two-tier";
const nowSec = () => Math.floor(Date.now() / 1000);

// Fail closed: refuse to start unauthenticated unless the operator explicitly opted in. This keeps
// a forgotten MNO_ADAPTER_SECRET from silently exposing the account-bearing endpoints to any caller.
if (!config.adapterSecret && !config.allowUnauthGateway) {
  throw new Error(
    "refusing to start unauthenticated: set MNO_ADAPTER_SECRET so adapters authenticate the account, " +
      "or set MNO_ALLOW_UNAUTH_GATEWAY=1 to run open on purpose (local dev, demos, tests only).",
  );
}

// Fail closed on the oracle too: without trusted oracle keys, the gateway would adopt any
// self-consistent snapshot a source serves, so a forged membership set could grant access. Require
// pinned keys unless the operator opts into an unsigned oracle on purpose.
if (config.oraclePubkeys.length === 0 && !config.allowUnsignedOracle) {
  throw new Error(
    "refusing to start with an unauthenticated oracle: set MNO_ORACLE_PUBKEYS to the trusted oracle " +
      "public key(s), or MNO_ALLOW_UNSIGNED_ORACLE=1 to trust an unsigned source on purpose (local " +
      "dev, demos, tests, or a trusted private network only).",
  );
}

const challenges = new ChallengeStore(config.challengeTtlSeconds, config.maxPendingChallenges);

// Per-client rate-limit guards on the request-facing endpoints (review finding M5). The
// account-bearing ones additionally require the adapter bearer token when MNO_ADAPTER_SECRET is set.
const challengeLimiter = new RateLimiter({ windowSeconds: config.rateWindowSeconds, max: config.challengeRateMax });
const verifyLimiter = new RateLimiter({ windowSeconds: config.rateWindowSeconds, max: config.verifyRateMax });
const registerLimiter = new RateLimiter({ windowSeconds: config.rateWindowSeconds, max: config.registerRateMax });
const membersLimiter = new RateLimiter({ windowSeconds: config.rateWindowSeconds, max: config.membersRateMax });
// Adapter authentication for the account-bearing endpoints. When MNO_ADAPTER_SECRET is set, a
// caller must present it as a bearer token, so the account on /v1/challenge and /v1/verify is
// vouched for by an authenticated adapter rather than chosen by any HTTP caller (this is what makes
// the B1 binding authoritative). The compare is constant-time over sha256 digests so it neither
// leaks the secret's length nor short-circuits on the first differing byte. The expected digest is
// computed once at boot. With no secret the gateway fails closed at boot unless explicitly allowed.
const adapterSecretDigest = config.adapterSecret ? createHash("sha256").update(config.adapterSecret).digest() : null;
function authorized(req) {
  if (!adapterSecretDigest) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] ?? "");
  if (!m) return false;
  const got = createHash("sha256").update(m[1]).digest();
  return timingSafeEqual(got, adapterSecretDigest);
}

// The client key for rate limiting. With MNO_TRUST_PROXY set, the gateway is assumed to sit behind
// exactly one trusted reverse proxy, which appends the connecting client to X-Forwarded-For. The
// LAST hop is the address that proxy observed, so it is the one entry the client cannot forge (the
// left entries are client-supplied and spoofable). Without the flag the header is ignored entirely
// and the socket address is used. A multi-proxy chain would need a configured trusted-hop count,
// tracked in TODO.md.
function clientKey(req) {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",").pop().trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

// The shared Platform registration store is the follow-up to the file-backed path. Fail loudly
// here, before any Platform connection or key load, rather than fall back to a non-shared store and
// silently double-grant. Checking up front means a missing optional dependency or incomplete
// Platform config cannot mask this with an earlier, more confusing error.
if (twoTier && config.store === "platform") {
  throw new Error(
    "MNO_MODE=two-tier with MNO_STORE=platform is not wired yet. Use the durable file-backed " +
      "registration store (unset MNO_STORE or set MNO_STORE=memory); Platform-backed " +
      "registration records are the next step. See core/registration_store.js and docs/PLATFORM.md.",
  );
}

// The per-epoch spent-nullifier set for the membership verify. Shared across gateways via the
// Dash Platform contract when MNO_STORE=platform, otherwise in memory for a single gateway.
// The per-season registration spend lives in the registration store, not here.
let nullifiers;
if (config.store === "platform") {
  const { connectPlatform, DocumentNullifierStore } = await import("./platform_store.js");
  const backend = await connectPlatform({
    network: config.platform.network,
    mnemonic: config.platform.mnemonic,
    contractId: config.platform.contractId,
    appName: config.platform.appName,
  });
  nullifiers = new DocumentNullifierStore(backend);
  console.log(`[gateway] shared nullifier state on Dash Platform (${config.platform.contractId})`);
} else {
  nullifiers = new NullifierStore();
}

// The DML root, fed by the oracle. Used by single-tier verify and by two-tier registration.
const dmlRoots = new RootStore(config.rootWindow);
let latestDml = null; // the last verified oracle snapshot, so provers can fetch leaves and build paths
const dmlRootFromLeaves = await makeDmlRootHasher(config.treeDepth);

// Reject a malformed or implausibly-timestamped snapshot before it can reach the verify path
// (review finding M3). Shape, depth, and leaf field-elements are checked here, plus a bound on the
// oracle's self-reported timestamp: too old to adopt, or too far in the future (which would
// otherwise let a clock-skewed or replayed future-dated snapshot pose as fresh). The root recompute
// in refreshRoots is the separate check that the leaves actually produce the claimed root.
function validateSnapshot(o) {
  if (!o || typeof o !== "object") throw new Error("snapshot is not an object");
  if (!Number.isInteger(o.height) || o.height < 0) throw new Error("snapshot height invalid");
  const depth = o.depth ?? config.treeDepth;
  if (depth !== config.treeDepth) throw new Error(`snapshot depth ${depth} != expected ${config.treeDepth}`);
  if (o.root == null || !isCanonicalField(o.root)) throw new Error("snapshot root is not a canonical field element");
  if (!Array.isArray(o.leaves)) throw new Error("snapshot leaves missing");
  if (o.leaves.length > 2 ** config.treeDepth) throw new Error("snapshot leaves exceed tree capacity");
  for (const l of o.leaves) if (!isCanonicalField(l)) throw new Error("snapshot leaf is not a canonical field element");
  // Strict version, failing closed: absent/1 is v1, 2 is v2, anything else is rejected, so an
  // unknown-version snapshot cannot be adopted under the legacy v1 message with future fields
  // unauthenticated. One dispatch point shared with the signer (common/oracle_sig.js).
  const version = snapshotVersion(o);
  // A shaRoot, when present, must be a 64-lowercase-hex STRING (not a coercible array or number), so
  // a malformed value cannot pass the recompute and signature paths via String() and land in
  // latestDml. Checked regardless of deployment, so a non-zkVM gateway also rejects a malformed one.
  if (o.shaRoot != null) {
    if (typeof o.shaRoot !== "string" || !/^[0-9a-f]{64}$/.test(o.shaRoot)) {
      throw new Error("snapshot shaRoot is not a 64 lowercase hex string");
    }
  }
  // Deployment-scoped dual-root requirement (docs/ZKVM_INTEGRATION.md). A zkVM deployment refuses a
  // v1 snapshot outright, since it lacks the SHA-256 root the zkVM statement is checked against, so a
  // downgrade cannot slip a rootless snapshot in through the same refresh path.
  if (config.requireShaRoot && (version !== 2 || o.shaRoot == null)) {
    throw new Error("zkVM deployment requires a v2 snapshot with a shaRoot (downgrade refused)");
  }
  if (config.oracleMaxAgeSeconds > 0) {
    const ts = Number(o.ts);
    if (!Number.isFinite(ts)) throw new Error("snapshot timestamp invalid");
    if (nowSec() - ts > config.oracleMaxAgeSeconds) throw new Error("snapshot is too old");
    if (ts - nowSec() > config.oracleFutureSkewSeconds) throw new Error("snapshot timestamp too far in the future");
  }
}

// Authenticate the leaf set, not just its internal consistency. With trusted oracle keys configured,
// count how many distinct keys signed this snapshot's canonical message and require the quorum. A
// signature covers the root, which commits to the leaves, so a met quorum means trusted oracle keys
// vouched for this membership set, and a host that merely serves the JSON cannot forge one. With no
// keys configured (allowUnsignedOracle let the gateway boot), signing is not enforced.
function oracleSignaturesOk(o) {
  if (config.oraclePubkeys.length === 0) return true;
  // A signed snapshot must anchor a real block, since the signature covers the block hash and the
  // chain-anchor argument rests on it. Reject a missing or malformed one rather than count signatures
  // over an empty anchor.
  if (!/^[0-9a-fA-F]{64}$/.test(String(o.blockHash ?? ""))) {
    console.error(`[gateway] signed oracle snapshot has no valid block hash, rejected`);
    return false;
  }
  const msg = snapshotMessage(o);
  const sigs = Array.isArray(o.sigs) ? o.sigs : [];
  let met = 0;
  for (const trusted of config.oraclePubkeys) {
    if (sigs.some((s) => s && typeof s.sig === "string" && verifySnapshotSig(msg, s.sig, trusted.key))) met += 1;
  }
  return met >= config.oracleQuorum;
}

// Enforce the freshness bound on EVERY root the window will still accept, not only the newest. Each
// root carries its own oracle timestamp (bounded at adoption to no more than oracleFutureSkewSeconds
// in the future), so dropping those older than the bound stops a removed node from proving against
// an aged-out root that newer snapshots happened to keep in the window, and clears latestDml when
// its own root ages out. Called on the refresh tick and at request time, so a refresh interval
// longer than the bound cannot leave a stale root servable between ticks.
function enforceDmlFreshness() {
  if (config.oracleMaxAgeSeconds <= 0) return;
  const cutoff = nowSec() - config.oracleMaxAgeSeconds;
  dmlRoots.dropOlderThan(cutoff);
  if (latestDml && Number(latestDml.ts) < cutoff) {
    console.error(`[gateway] oracle snapshot stale (ts ${latestDml.ts}), dropping root until a fresh one arrives`);
    latestDml = null;
  }
}

async function refreshRoots() {
  try {
    const o = await loadOracle(config.oracleSource);
    validateSnapshot(o);
    // Always recompute the root from the published leaves and trust only a self-consistent snapshot,
    // whether the root is new or a republish of the current one. The fast hasher is O(real leaves),
    // so this runs every refresh cheaply, and a snapshot whose leaves do not hash to its root is
    // rejected and does not renew freshness, so a corrupted or inconsistent source cannot keep a
    // stale root alive. The recompute only proves internal consistency. oracleSignaturesOk is the
    // separate check that a trusted oracle key vouched for this leaf set, so a source that forges a
    // self-consistent pair over an attacker-chosen set is rejected unless it also holds a trusted key.
    const recomputed = dmlRootFromLeaves(o.leaves);
    // Recompute the SHA-256 root from the SAME leaves too, so a v2 snapshot whose shaRoot does not
    // hash from its leaves is rejected exactly like a mismatched Poseidon root. Both roots must be
    // self-consistent before the signature check, so a source cannot pair a good Poseidon root with a
    // forged shaRoot. The two provably describe one leaf set only because both recompute here.
    const shaRecomputed = o.shaRoot != null ? shaRootFromLeaves(o.leaves, config.treeDepth) : null;
    if (recomputed !== String(o.root)) {
      // Reject the inconsistent snapshot, but do not early-return: the staleness check below must
      // still run, or an aged-out accepted root would keep being served while the source is bad.
      console.error(`[gateway] oracle root mismatch, snapshot rejected: claimed ${o.root}, recomputed ${recomputed}`);
    } else if (shaRecomputed !== null && shaRecomputed !== String(o.shaRoot)) {
      console.error(`[gateway] oracle shaRoot mismatch, snapshot rejected: claimed ${o.shaRoot}, recomputed ${shaRecomputed}`);
    } else if (!oracleSignaturesOk(o)) {
      // Self-consistent but not vouched for by the quorum of trusted oracle keys, so the leaf set is
      // unauthenticated. Reject, and fall through to the freshness sweep like the mismatch case.
      console.error(`[gateway] oracle snapshot signature quorum not met (need ${config.oracleQuorum} trusted signer(s)), rejected`);
    } else if (latestDml && Number(o.height) < Number(latestDml.height)) {
      // Height regressed below the accepted root. A masternode list height is the block count and
      // only moves forward, so a lower height is a replayed old snapshot or a reorg, and the two are
      // indistinguishable without the block hash (tracked with the leaf-authentication follow-up).
      // The safe default for a security gate is to reject: adopting it would diverge latestDml from
      // RootStore.current(), strand provers, and re-window a stale root a node may have been evicted
      // from. If the lower height is a genuine sustained reorg, the old root ages out within
      // oracleMaxAgeSeconds, enforceDmlFreshness clears latestDml, and the next lower-height snapshot
      // is then accepted, so the gateway self-heals onto the canonical branch within the bound.
      console.error(`[gateway] oracle height regressed (${o.height} < ${latestDml.height}), snapshot rejected`);
    } else if (latestDml && Number(o.height) === Number(latestDml.height) && String(o.root) !== String(latestDml.root)) {
      // Same height, different root: the list at a fixed height is deterministic, so this is
      // inconsistent. Reject rather than flap the served root.
      console.error(`[gateway] oracle root changed at height ${o.height}, snapshot rejected`);
    } else {
      // Height is at or above the accepted root, so this snapshot becomes (or stays) current and
      // latestDml never diverges from RootStore.current(). Only a self-consistent snapshot reaches
      // here, so the ts that drives expiry is verified-fresh.
      latestDml = o;
      dmlRoots.update([{ height: o.height, root: o.root, ts: o.ts ?? nowSec() }]);
    }
  } catch (err) {
    console.error("[gateway] root refresh failed:", err.message);
  }
  // Prune aged-out roots from the window. validateSnapshot only blocks adopting a stale snapshot;
  // this stops serving ones already accepted, so a stalled, replayed, or inconsistent source cannot
  // keep admitting members against a frozen root. Runs every tick, even when the fetch failed or the
  // snapshot was rejected above, and again at request time (see the server handler).
  enforceDmlFreshness();
}

// Two-tier state. SeasonMembers owns the season-scoped members tree (a cache rebuilt from the
// durable registration records, so a restart never loses a registration and a season boundary
// starts a fresh empty tree) and serializes rollovers and member commits on one queue, which is
// what closes the season-rollover race. See core/season.js.
let vkey, regVkey, membersVkey, registrationStore, seasonMembers;

if (twoTier) {
  // The two-tier + Platform-store combination is rejected up front (see the guard near the top).
  regVkey = await loadVerificationKey(config.registrationVkeyPath);
  membersVkey = await loadVerificationKey(config.membersVkeyPath);
  const { RegistrationStore, FileBackend } = await import("./registration_store.js");
  registrationStore = new RegistrationStore(new FileBackend(config.registrationStorePath));
  await registrationStore.ready();
  console.log(`[gateway] durable registration records at ${config.registrationStorePath}`);
  // The empty members root, computed once via the fast hasher (instant), so an empty context never
  // forces a 2**16 tree build (see SeasonMembers).
  const emptyMembersRoot = dmlRootFromLeaves([]);
  seasonMembers = new SeasonMembers({ store: registrationStore, rootWindow: config.rootWindow, nowSec, emptyRoot: emptyMembersRoot });
  await seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec()));
} else {
  vkey = await loadVerificationKey(config.verificationKeyPath);
}

await refreshRoots();
setInterval(refreshRoots, config.oracleRefreshSeconds * 1000);
setInterval(() => challenges.sweep(), 60_000);
setInterval(() => { challengeLimiter.sweep(); verifyLimiter.sweep(); registerLimiter.sweep(); membersLimiter.sweep(); }, 60_000);
// Roll the members tree over at a season boundary even when no request arrives to trigger it.
if (twoTier) setInterval(() => seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec())).catch(() => {}), 60_000);

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    // Enforce DML freshness on every request, so a refresh interval longer than the freshness bound
    // cannot serve a root that aged out since the last tick.
    enforceDmlFreshness();
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && path === "/v1/challenge") {
      // Auth before the rate limiter, so an unauthorized caller cannot burn the bucket for a client
      // key and block the real adapter.
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (!challengeLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
      const { platform, communityId, roleId, account: rawAccount } = await readBody(req);
      if (!platform || !communityId || !roleId || !rawAccount) return send(res, 400, { error: "missing fields" });
      // Normalize the account to a string here, the one place it enters, so the signal hash and the
      // stored claim use the same form a numeric or other non-string account would otherwise mint a
      // challenge that the string-typed verify (verifyMembership) could never satisfy.
      const account = String(rawAccount);
      const ctx = contextHash({ platform, communityId, roleId }).toString();
      // Two-tier challenges run against this context's own members tree (review finding B2), so a
      // member registered for another community cannot prove here.
      let cur;
      if (twoTier) {
        const season = seasonNow(config.seasonSeconds, nowSec());
        await seasonMembers.ensureContext(season, ctx);
        cur = seasonMembers.rootCurrent(ctx);
      } else {
        cur = dmlRoots.current();
      }
      if (!cur) return send(res, 503, { error: "no root available yet" });

      const nonce = randomUUID();
      const epoch = epochNow(config.epochSeconds, nowSec());
      const sig = signalHash(nonce, account).toString();
      if (!challenges.put(nonce, { account, signalHash: sig, epoch, contextHash: ctx }))
        return send(res, 429, { error: "too many pending challenges" });
      return send(res, 200, { nonce, signalHash: sig, epoch, root: cur.root, contextHash: ctx, epochSeconds: config.epochSeconds, mode: config.mode });
    }

    if (req.method === "POST" && path === "/v1/verify") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      if (!verifyLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
      const { nonce, proof, publicSignals, account } = await readBody(req);
      if (!nonce || !proof || !publicSignals || !account) return send(res, 400, { error: "missing fields" });
      const pending = challenges.take(nonce);
      if (!pending) return send(res, 410, { ok: false, reason: "unknown-or-expired-challenge" });

      // The submitted account must equal the account the challenge was minted for, checked here
      // before the proof verify and the nullifier spend, so a relayed proof cannot grant the relayer
      // or burn the real owner's epoch (review finding B1). With MNO_ADAPTER_SECRET set, the account
      // is supplied only by an authenticated adapter (see authorized() above), so this binding is
      // authoritative rather than just an adapter-relay guard.
      if (String(account) !== String(pending.account)) return send(res, 200, { ok: false, reason: "account-mismatch" });

      // The challenge was minted for pending.epoch. If that epoch has since rolled over, reject here,
      // before the proof verify and the nullifier spend, so a stale-epoch proof does not burn the
      // member's epoch claim for a grant that would already be expired. The gateway owns epoch timing,
      // so an adapter can trust an ok response rather than re-checking expiry against its own clock. The
      // member re-verifies for the current epoch.
      if (nowSec() >= (pending.epoch + 1) * config.epochSeconds) return send(res, 200, { ok: false, reason: "epoch-rolled-over" });

      // The proof is checked against the root window of the same context the challenge was minted
      // for, in the current season. A season rollover since the challenge resets that window, so a
      // proof against the stale root is rejected as stale-or-unknown-root.
      let rootStore = dmlRoots;
      if (twoTier) {
        await seasonMembers.ensureContext(seasonNow(config.seasonSeconds, nowSec()), pending.contextHash);
        rootStore = seasonMembers.rootStore(pending.contextHash);
      }
      const result = await verifyMembership({
        vkey: twoTier ? membersVkey : vkey,
        proof,
        publicSignals,
        nullifiers,
        expected: {
          rootStore,
          epoch: pending.epoch,
          contextHash: pending.contextHash,
          signalHash: pending.signalHash,
          account: pending.account,
        },
      });
      if (!result.ok) return send(res, 200, result);
      const expiresAt = (pending.epoch + 1) * config.epochSeconds;
      // regranted is true when this was an idempotent re-verify of an already-spent tag by the same
      // account (its adapter recovering from a failed first grant), so an adapter can log the recovery.
      return send(res, 200, { ok: true, account: pending.account, epoch: result.epoch, expiresAt, regranted: result.regranted === true });
    }

    if (twoTier && req.method === "POST" && path === "/v1/register") {
      // No adapter token here: registration is member-driven (the member's own prover posts it) and
      // proof-authenticated, and it carries no account to vouch for. Its guards are the registration
      // PLONK proof, the one-per-(season, context) registration nullifier, and the rate limit.
      if (!registerLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
      const { platform, communityId, roleId, proof, publicSignals } = await readBody(req);
      if (!platform || !communityId || !roleId || !proof || !publicSignals) return send(res, 400, { error: "missing fields" });

      const ctx = contextHash({ platform, communityId, roleId }).toString();
      const season = seasonNow(config.seasonSeconds, nowSec());
      await seasonMembers.ensure(season);
      const result = await verifyRegistration({
        vkey: regVkey,
        proof,
        publicSignals,
        expected: { rootStore: dmlRoots, season, contextHash: ctx },
        registrationStore,
        // The durable record and the members-tree mirror happen together inside the season
        // serialization, re-checking the season so a rollover during the proof verify above cannot
        // publish a stale-season root (the M2 race). The commit targets this context's tree.
        commit: ({ season: s, commitment, contextHash: c, regNullifier: n }) =>
          seasonMembers.commit(s, c, commitment, () =>
            registrationStore.append({ season: s, contextHash: c, regNullifier: n, commitment }),
          ),
      });
      if (!result.ok) return send(res, 200, result);
      return send(res, 200, { ok: true, index: result.index, membersRoot: result.membersRoot, size: result.size });
    }

    if (twoTier && req.method === "GET" && path === "/v1/members") {
      // Per-context members tree, so a prover fetches the leaves and root for its own community. The
      // context comes straight from the client here, so it is rate-limited and validated as a
      // canonical field element, and an empty context serves the shared empty root without building
      // a tree (so varying the context cannot force expensive tree builds).
      if (!membersLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
      const ctx = url.searchParams.get("context");
      if (!ctx || !isCanonicalField(ctx)) return send(res, 400, { error: "context must be a canonical field element" });
      await seasonMembers.ensureContext(seasonNow(config.seasonSeconds, nowSec()), ctx);
      return send(res, 200, { membersRoot: seasonMembers.root(ctx), size: seasonMembers.size(ctx), commitments: seasonMembers.commitments(ctx) });
    }

    if (req.method === "GET" && path === "/v1/dml") {
      // public DML snapshot so a prover can find its leaf and build a Merkle path
      return send(res, 200, {
        root: latestDml?.root ?? null,
        height: latestDml?.height ?? null,
        depth: latestDml?.depth ?? config.treeDepth,
        leaves: latestDml?.leaves ?? [],
      });
    }

    if (req.method === "GET" && path === "/v1/health") {
      // Two-tier has no single members root (one per context), so health reports the count of
      // active context trees instead, alongside the shared DML root.
      const dmlRoot = dmlRoots.current()?.root ?? null;
      return send(res, 200, {
        ok: true,
        mode: config.mode,
        root: twoTier ? null : dmlRoot,
        dmlRoot,
        season: seasonNow(config.seasonSeconds, nowSec()),
        ...(twoTier ? { contexts: seasonMembers.contextCount() } : {}),
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

if (!config.adapterSecret)
  console.warn("[gateway] WARNING: running UNAUTHENTICATED (MNO_ALLOW_UNAUTH_GATEWAY=1). /v1/challenge, /v1/verify, and /v1/register accept any caller and the submitted account is not vouched for. Do not use in production; set MNO_ADAPTER_SECRET instead (review finding B1/M5).");

server.listen(config.port, () => console.log(`[gateway] dash-mno-verify (${config.mode}) listening on :${config.port}`));
