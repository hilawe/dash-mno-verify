// Platform-neutral verification gateway.
//
// Every adapter (Discord, Telegram, Matrix, a web gate) speaks to these two endpoints.
// The gateway never learns a masternode address, a voting key, or which node proved.
// It learns only a per-account nonce and an unlinkable nullifier.
//
//   POST /v1/challenge  { platform, communityId, roleId, account }
//        -> { nonce, signalHash, epoch, root, contextHash, epochSeconds }
//   POST /v1/verify     { nonce, proof, publicSignals }
//        -> { ok: true, account, epoch, expiresAt } | { ok: false, reason }
//   GET  /v1/health     -> { ok, root, height }
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { RootStore, NullifierStore, ChallengeStore, loadOracle } from "./stores.js";
import { loadVerificationKey, verifyMembership } from "./verifier.js";
import { contextHash, signalHash, epochNow } from "../common/index.js";

const roots = new RootStore(config.rootWindow);
const nullifiers = new NullifierStore();
const challenges = new ChallengeStore(config.challengeTtlSeconds);
const vkey = await loadVerificationKey(config.verificationKeyPath);

async function refreshRoots() {
  try {
    const o = await loadOracle(config.oracleSource);
    roots.update([{ height: o.height, root: o.root, ts: o.ts ?? Math.floor(Date.now() / 1000) }]);
  } catch (err) {
    console.error("[gateway] root refresh failed:", err.message);
  }
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
      if (!platform || !communityId || !roleId || !account)
        return send(res, 400, { error: "missing fields" });

      const cur = roots.current();
      if (!cur) return send(res, 503, { error: "no root available yet" });

      const nonce = randomUUID();
      const epoch = epochNow(config.epochSeconds, Math.floor(Date.now() / 1000));
      const ctx = contextHash({ platform, communityId, roleId }).toString();
      const sig = signalHash(nonce).toString();

      // The nonce is bound to this exact account, so a proof for one account cannot
      // be replayed to grant another.
      challenges.put(nonce, { account, platform, communityId, roleId, signalHash: sig, epoch, contextHash: ctx });

      return send(res, 200, {
        nonce,
        signalHash: sig,
        epoch,
        root: cur.root,
        contextHash: ctx,
        epochSeconds: config.epochSeconds,
      });
    }

    if (req.method === "POST" && req.url === "/v1/verify") {
      const { nonce, proof, publicSignals } = await readBody(req);
      if (!nonce || !proof || !publicSignals)
        return send(res, 400, { error: "missing fields" });

      const pending = challenges.take(nonce);
      if (!pending) return send(res, 410, { ok: false, reason: "unknown-or-expired-challenge" });

      const result = await verifyMembership({
        vkey,
        proof,
        publicSignals,
        nullifiers,
        expected: {
          rootStore: roots,
          epoch: pending.epoch,
          contextHash: pending.contextHash,
          signalHash: pending.signalHash,
        },
      });

      if (!result.ok) return send(res, 200, result);
      const expiresAt = (pending.epoch + 1) * config.epochSeconds; // unix seconds
      return send(res, 200, { ok: true, account: pending.account, epoch: result.epoch, expiresAt });
    }

    if (req.method === "GET" && req.url === "/v1/health") {
      const cur = roots.current();
      return send(res, 200, { ok: true, root: cur?.root ?? null, height: cur?.height ?? null });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(config.port, () => {
  console.log(`[gateway] dash-mno-verify listening on :${config.port}`);
});
