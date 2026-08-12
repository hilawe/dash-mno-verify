// Web gate adapter for dash-mno-verify.
//
// This adapter gates a web session instead of a chat role, which makes it the clearest
// demonstration that the verification core is platform-neutral: the access action is
// completely different from Discord, yet the two calls to the gateway are identical.
// Use it as the reference for any token-gated site.
//
// It deliberately uses no web framework, only node:http, to stay dependency-light and
// consistent with the gateway. The in-memory session store is fine for a reference
// adapter; a production gate would use signed, persisted sessions.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { proveInstructions } from "../../common/prover_instructions.js";
import { assertSafeGatewayUrl } from "../../common/gateway_url.js";

const PORT = Number(process.env.MNO_WEB_PORT ?? 8080);
const GATEWAY = assertSafeGatewayUrl(process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787");
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there (review B1/M5).
// Server-side only; it is never exposed to the browser.
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};
const COMMUNITY_ID = process.env.MNO_WEB_COMMUNITY ?? "example.org";
const ROLE_ID = process.env.MNO_WEB_ROLE ?? "members";

const sessions = new Map(); // sid -> { verifiedUntil } in unix seconds

function getCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

const MAX_BODY_BYTES = 2_000_000;

// Rejecting the promise does not stop the request. The old version kept its data listener attached
// and went on appending every later chunk to the same string, so a caller who ignored the rejection
// and kept streaming grew it without any bound at all, and one unauthenticated request could exhaust
// the process. Settle once, stop retaining, and destroy the request so the sender is actually cut off.
// Counting is on BYTES: the old check measured a string, which undercounts multi-byte characters and
// so admitted well over the stated cap.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.destroy();
      reject(err);
    };
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) return fail(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", fail);
  });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Masternode-gated area</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.5rem 1rem;cursor:pointer}code{background:#f0f0f0;padding:.1rem .3rem}
#out{white-space:pre-wrap;background:#f6f6f6;padding:1rem;margin-top:1rem;border-radius:6px}</style>
</head><body>
<h1>Masternode-gated area</h1>
<p>Prove you control a Dash masternode without revealing which one. Your voting key never leaves your machine.</p>
<ol>
<li><button id="start">1. Get challenge</button> downloads <code>challenge.json</code> and shows the exact prover command.</li>
<li>On the machine with your voting key, run the command shown below after step 1.</li>
<li>Upload the resulting <code>proof.json</code>: <input type="file" id="proof"> <button id="submit">3. Submit</button></li>
</ol>
<p><a href="/members">Go to the members area</a></p>
<div id="out"></div>
<script>
const out = document.getElementById("out");
document.getElementById("start").onclick = async () => {
  const r = await fetch("/api/start", { method: "POST" });
  if (!r.ok) { out.textContent = "Could not reach the verification service."; return; }
  const data = await r.json();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data.challenge, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "challenge.json"; a.click();
  out.textContent = "Downloaded challenge.json. On the machine with your voting key, run:\\n  " + data.proverInstructions.join("\\n  ") + "\\nThen upload the proof.json it produces.";
};
document.getElementById("submit").onclick = async () => {
  const f = document.getElementById("proof").files[0];
  if (!f) { out.textContent = "Choose your proof.json first."; return; }
  const r = await fetch("/api/submit", { method: "POST", headers: { "content-type": "application/json" }, body: await f.text() });
  const o = await r.json();
  out.textContent = o.ok ? "Verified. Open the members area." : ("Failed: " + (o.reason || "unknown"));
};
</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    let sid = getCookie(req, "mno_sid");
    const setCookie = {};
    if (!sid) {
      sid = randomUUID();
      setCookie["set-cookie"] = `mno_sid=${sid}; HttpOnly; SameSite=Lax; Path=/`;
    }

    if (req.method === "GET" && req.url === "/") return html(res, 200, PAGE);
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    if (req.method === "POST" && req.url === "/api/start") {
      const r = await fetch(`${GATEWAY}/v1/challenge`, {
        method: "POST",
        redirect: "error", // never follow a redirect off the guarded origin (it would carry the body in the clear)
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ platform: "web", communityId: COMMUNITY_ID, roleId: ROLE_ID, account: sid }),
      });
      if (!r.ok) return send(res, 502, { error: "gateway unavailable" }, setCookie);
      const challenge = await r.json();
      // Send the prover command(s) for the gateway's mode alongside the challenge, computed with the
      // shared helper, so the page shows the right command without duplicating the logic in browser JS.
      return send(res, 200, { challenge, proverInstructions: proveInstructions(challenge.mode, { gateway: GATEWAY, platform: "web", community: COMMUNITY_ID, role: ROLE_ID }) }, setCookie);
    }

    if (req.method === "POST" && req.url === "/api/submit") {
      const payload = await readBody(req); // { nonce, proof, publicSignals }
      // Submit the session id as the account. The gateway binds the verify to it (review B1).
      const r = await fetch(`${GATEWAY}/v1/verify`, {
        method: "POST",
        redirect: "error", // never follow a redirect off the guarded origin (it would carry the body in the clear)
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ ...payload, account: sid }),
      });
      const out = await r.json();
      if (out.ok) sessions.set(sid, { verifiedUntil: out.expiresAt });
      return send(res, 200, out, setCookie);
    }

    if (req.method === "GET" && req.url === "/members") {
      const s = sessions.get(sid);
      const now = Math.floor(Date.now() / 1000);
      // Drop a lapsed session the first time it is seen, rather than leaving it in the map to be
      // re-judged later. The map outlived the deadline, so a host clock that moved backwards made an
      // expired session pass this comparison again and readmit a member whose epoch had ended, at the
      // same moment the gateway itself would be refusing fresh proofs over the same regression.
      // Deleting is the one-way version of the high-water floor the adapters' grant ledger keeps.
      if (s && s.verifiedUntil <= now) sessions.delete(sid);
      if (s && s.verifiedUntil > now) {
        return html(res, 200, `<!doctype html><meta charset="utf-8"><body style="font:16px/1.6 system-ui;max-width:42rem;margin:3rem auto">
<h1>Members area</h1><p>You are in. This page is gated behind anonymous masternode verification, and the gate never learned your address.</p>
<p>Access valid until ${new Date(s.verifiedUntil * 1000).toISOString().slice(0, 16)} UTC.</p></body>`);
      }
      return html(res, 403, `<!doctype html><meta charset="utf-8"><body style="font:16px/1.6 system-ui;max-width:42rem;margin:3rem auto">
<h1>Not verified</h1><p>This area needs masternode verification. <a href="/">Start here</a>.</p></body>`);
    }

    return send(res, 404, { error: "not found" }, setCookie);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`[web] dash-mno-verify gate listening on :${PORT}`));
