import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadOracle } from "../core/stores.js";

// loadOracle hardening (review finding M3, plus the body-cap follow-up). Loopback http is allowed,
// so these serve over 127.0.0.1 without tripping the https requirement.

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/root.json`, close: () => server.close() };
}

test("a small valid snapshot loads over loopback http", async () => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ height: 1, root: "5", leaves: ["5"], ts: 0 }));
  });
  try {
    const o = await loadOracle(s.url);
    assert.equal(o.root, "5");
  } finally {
    s.close();
  }
});

test("a body past the cap is rejected even with no content-length", async () => {
  // Stream more than maxBytes in chunks and never set content-length, so the cap can only hold if
  // it is enforced while streaming rather than after buffering the whole body.
  const s = await serve(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); // no content-length
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 40; i++) res.write(chunk); // ~2.6 MB
    res.end();
  });
  try {
    await assert.rejects(loadOracle(s.url, { maxBytes: 1_000_000 }), /too large/);
  } finally {
    s.close();
  }
});

test("a non-loopback http URL is refused", async () => {
  await assert.rejects(loadOracle("http://example.com/root.json"), /must be https/);
});

test("ipv6 loopback over http is allowed", async () => {
  // The hostname keeps its brackets ("[::1]"), so the loopback exception must match that form. The
  // connection is expected to fail (nothing is listening), but it must get past the https check.
  await assert.rejects(loadOracle("http://[::1]:1/root.json", { timeoutMs: 500 }), (err) => !/must be https/.test(err.message));
});
