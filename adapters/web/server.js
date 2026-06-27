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

const PORT = Number(process.env.MNO_WEB_PORT ?? 8080);
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Masternode-gated area</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}
button{font:inherit;padding:.5rem 1rem;cursor:pointer}code{background:#f0f0f0;padding:.1rem .3rem}
#out{white-space:pre-wrap;background:#f6f6f6;padding:1rem;margin-top:1rem;border-radius:6px}</style>
</head><body>
<h1>Masternode-gated area</h1>
<p>Prove you control a Dash masternode without revealing which one. Your voting key never leaves your machine.</p>
<ol>
<li><button id="start">1. Get challenge</button> downloads <code>challenge.json</code>.</li>
<li>On the machine with your voting key, run:<br><code>npm run prove -- --challenge challenge.json --voting-key &lt;WIF&gt;</code></li>
<li>Upload the resulting <code>proof.json</code>: <input type="file" id="proof"> <button id="submit">3. Submit</button></li>
</ol>
<p><a href="/members">Go to the members area</a></p>
<div id="out"></div>
<script>
const out = document.getElementById("out");
document.getElementById("start").onclick = async () => {
  const r = await fetch("/api/start", { method: "POST" });
  if (!r.ok) { out.textContent = "Could not reach the verification service."; return; }
  const ch = await r.json();
  const url = URL.createObjectURL(new Blob([JSON.stringify(ch, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "challenge.json"; a.click();
  out.textContent = "Downloaded challenge.json. Run the prover, then submit proof.json.";
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "web", communityId: COMMUNITY_ID, roleId: ROLE_ID, account: sid }),
      });
      if (!r.ok) return send(res, 502, { error: "gateway unavailable" }, setCookie);
      return send(res, 200, await r.json(), setCookie);
    }

    if (req.method === "POST" && req.url === "/api/submit") {
      const payload = await readBody(req); // { nonce, proof, publicSignals }
      // Submit the session id as the account. The gateway binds the verify to it (review B1).
      const r = await fetch(`${GATEWAY}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, account: sid }),
      });
      const out = await r.json();
      if (out.ok) sessions.set(sid, { verifiedUntil: out.expiresAt });
      return send(res, 200, out, setCookie);
    }

    if (req.method === "GET" && req.url === "/members") {
      const s = sessions.get(sid);
      const now = Math.floor(Date.now() / 1000);
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
