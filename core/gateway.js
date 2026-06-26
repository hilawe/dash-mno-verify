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
import { MembersTree } from "./members_tree.js";
import { contextHash, signalHash, epochNow, seasonNow } from "../common/index.js";

const twoTier = config.mode === "two-tier";
const nowSec = () => Math.floor(Date.now() / 1000);

const challenges = new ChallengeStore(config.challengeTtlSeconds);

// The spent-nullifier set. Shared across gateways via the Dash Platform contract when
// MNO_STORE=platform, otherwise in memory for a single gateway.
let nullifiers, regNullifiers;
if (config.store === "platform") {
  const { connectPlatform, DocumentNullifierStore } = await import("./platform_store.js");
  const backend = await connectPlatform({
    network: config.platform.network,
    mnemonic: config.platform.mnemonic,
    contractId: config.platform.contractId,
    appName: config.platform.appName,
  });
  nullifiers = new DocumentNullifierStore(backend);
  regNullifiers = new DocumentNullifierStore(backend);
  console.log(`[gateway] shared nullifier state on Dash Platform (${config.platform.contractId})`);
} else {
  nullifiers = new NullifierStore();
  regNullifiers = new NullifierStore();
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

let vkey, regVkey, membersVkey, membersTree, membersRoots;
if (twoTier) {
  regVkey = await loadVerificationKey(config.registrationVkeyPath);
  membersVkey = await loadVerificationKey(config.membersVkeyPath);
  membersTree = await MembersTree.create();
  membersRoots = new RootStore(config.rootWindow);
  membersRoots.update([{ height: 0, root: membersTree.root(), ts: nowSec() }]);
} else {
  vkey = await loadVerificationKey(config.verificationKeyPath);
}

await refreshRoots();
setInterval(refreshRoots, config.oracleRefreshSeconds * 1000);
setInterval(() => challenges.sweep(), 60_000);

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
      const cur = twoTier ? membersRoots.current() : dmlRoots.current();
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
      const pending = challenges.take(nonce);
      if (!pending) return send(res, 410, { ok: false, reason: "unknown-or-expired-challenge" });

      const result = await verifyMembership({
        vkey: twoTier ? membersVkey : vkey,
        proof,
        publicSignals,
        nullifiers,
        expected: {
          rootStore: twoTier ? membersRoots : dmlRoots,
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
      const result = await verifyRegistration({
        vkey: regVkey,
        proof,
        publicSignals,
        expected: { rootStore: dmlRoots, season, contextHash: ctx },
        regNullifiers,
        membersTree,
      });
      if (!result.ok) return send(res, 200, result);
      membersRoots.update([{ height: membersTree.size(), root: result.membersRoot, ts: nowSec() }]);
      return send(res, 200, { ok: true, index: result.index, membersRoot: result.membersRoot, size: membersTree.size() });
    }

    if (twoTier && req.method === "GET" && req.url === "/v1/members") {
      return send(res, 200, { membersRoot: membersTree.root(), size: membersTree.size(), commitments: membersTree.commitments });
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
      const cur = twoTier ? membersRoots.current() : dmlRoots.current();
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
