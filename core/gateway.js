// Platform-neutral verification gateway.
//
// Any adapter (Discord, Telegram, Matrix, a web gate) speaks to these HTTP endpoints. The
// gateway never learns a masternode address, a voting key, or which node proved. It learns
// only a per-account nonce and an unlinkable nullifier.
//
// Single mode (MNO_MODE=single):
//   POST /v1/challenge  { platform, communityId, roleId, account }
//        -> { nonce, signalHash, epoch, root, contextHash, epochSeconds }
//   POST /v1/verify     { nonce, proof, publicSignals }  -> { ok, account, epoch, expiresAt }
//
// Two-tier mode (MNO_MODE=two-tier) adds a heavy seasonal registration and makes the
// per-epoch challenge and verify run against the cheap members tree:
//   POST /v1/register   { platform, communityId, roleId, proof, publicSignals }
//        -> { ok, index, membersRoot, size }
//   GET  /v1/members    -> { membersRoot, size, commitments }   (so provers can build paths)
//
//   GET  /v1/health     -> { ok, mode, root, dmlRoot, season }
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RootStore, NullifierStore, ChallengeStore, loadOracle } from "./stores.js";
import { loadVerificationKey, verifyMembership, verifyRegistration } from "./verifier.js";
import { SeasonMembers } from "./season.js";
import { contextHash, signalHash, epochNow, seasonNow } from "../common/index.js";

const twoTier = config.mode === "two-tier";
const nowSec = () => Math.floor(Date.now() / 1000);

const challenges = new ChallengeStore(config.challengeTtlSeconds);

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
let latestDml = null; // the full oracle snapshot, so provers can fetch leaves and build paths
async function refreshRoots() {
  try {
    const o = await loadOracle(config.oracleSource);
    dmlRoots.update([{ height: o.height, root: o.root, ts: o.ts ?? nowSec() }]);
    latestDml = o;
  } catch (err) {
    console.error("[gateway] root refresh failed:", err.message);
  }
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
  seasonMembers = new SeasonMembers({ store: registrationStore, rootWindow: config.rootWindow, nowSec });
  await seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec()));
} else {
  vkey = await loadVerificationKey(config.verificationKeyPath);
}

await refreshRoots();
setInterval(refreshRoots, config.oracleRefreshSeconds * 1000);
setInterval(() => challenges.sweep(), 60_000);
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
    if (req.method === "POST" && req.url === "/v1/challenge") {
      const { platform, communityId, roleId, account } = await readBody(req);
      if (!platform || !communityId || !roleId || !account) return send(res, 400, { error: "missing fields" });
      if (twoTier) await seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec()));
      const cur = twoTier ? seasonMembers.rootCurrent() : dmlRoots.current();
      if (!cur) return send(res, 503, { error: "no root available yet" });

      const nonce = randomUUID();
      const epoch = epochNow(config.epochSeconds, nowSec());
      const ctx = contextHash({ platform, communityId, roleId }).toString();
      const sig = signalHash(nonce).toString();
      challenges.put(nonce, { account, signalHash: sig, epoch, contextHash: ctx });
      return send(res, 200, { nonce, signalHash: sig, epoch, root: cur.root, contextHash: ctx, epochSeconds: config.epochSeconds });
    }

    if (req.method === "POST" && req.url === "/v1/verify") {
      const { nonce, proof, publicSignals } = await readBody(req);
      if (!nonce || !proof || !publicSignals) return send(res, 400, { error: "missing fields" });
      if (twoTier) await seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec()));
      const pending = challenges.take(nonce);
      if (!pending) return send(res, 410, { ok: false, reason: "unknown-or-expired-challenge" });

      const result = await verifyMembership({
        vkey: twoTier ? membersVkey : vkey,
        proof,
        publicSignals,
        nullifiers,
        expected: {
          rootStore: twoTier ? seasonMembers.rootStore() : dmlRoots,
          epoch: pending.epoch,
          contextHash: pending.contextHash,
          signalHash: pending.signalHash,
        },
      });
      if (!result.ok) return send(res, 200, result);
      const expiresAt = (pending.epoch + 1) * config.epochSeconds;
      return send(res, 200, { ok: true, account: pending.account, epoch: result.epoch, expiresAt });
    }

    if (twoTier && req.method === "POST" && req.url === "/v1/register") {
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
        // serialization, re-checking the season so a rollover during the proof verify above
        // cannot publish a stale-season root (the M2 race).
        commit: ({ season: s, commitment, contextHash: c, regNullifier: n }) =>
          seasonMembers.commit(s, commitment, () =>
            registrationStore.append({ season: s, contextHash: c, regNullifier: n, commitment }),
          ),
      });
      if (!result.ok) return send(res, 200, result);
      return send(res, 200, { ok: true, index: result.index, membersRoot: result.membersRoot, size: result.size });
    }

    if (twoTier && req.method === "GET" && req.url === "/v1/members") {
      await seasonMembers.ensure(seasonNow(config.seasonSeconds, nowSec()));
      return send(res, 200, { membersRoot: seasonMembers.root(), size: seasonMembers.size(), commitments: seasonMembers.commitments() });
    }

    if (req.method === "GET" && req.url === "/v1/dml") {
      // public DML snapshot so a prover can find its leaf and build a Merkle path
      return send(res, 200, {
        root: latestDml?.root ?? null,
        height: latestDml?.height ?? null,
        depth: latestDml?.depth ?? 16,
        leaves: latestDml?.leaves ?? [],
      });
    }

    if (req.method === "GET" && req.url === "/v1/health") {
      const cur = twoTier ? seasonMembers.rootCurrent() : dmlRoots.current();
      return send(res, 200, {
        ok: true,
        mode: config.mode,
        root: cur?.root ?? null,
        dmlRoot: dmlRoots.current()?.root ?? null,
        season: seasonNow(config.seasonSeconds, nowSec()),
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(config.port, () => console.log(`[gateway] dash-mno-verify (${config.mode}) listening on :${config.port}`));
