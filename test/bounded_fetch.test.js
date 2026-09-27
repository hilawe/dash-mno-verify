import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fetchJsonCapped, SubmissionRefused, MAX_PROOF_BYTES } from "../common/bounded_fetch.js";

// Review finding F5. The Discord and Telegram bots downloaded and parsed a member's proof.json with no
// size or time limit. fetchJsonCapped bounds both, and these run it against a real local server.

async function serve(handler, fn) {
  const held = new Set();
  const server = http.createServer((req, res) => {
    held.add(res);
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/proof.json`);
  } finally {
    for (const r of held) r.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const refusedAs = (reason) => (err) => err instanceof SubmissionRefused && err.reason === reason;

test("contrary: an ordinary proof.json is accepted and parsed", async () => {
  const proof = { nonce: "n", proof: { a: 1 }, publicSignals: ["1", "2"] };
  const got = await serve((req, res) => res.end(JSON.stringify(proof)), (url) => fetchJsonCapped(url));
  assert.deepEqual(got, proof);
});

test("a response that declares more than the cap is refused before its body is read", async () => {
  await serve(
    (req, res) => {
      res.writeHead(200, { "content-length": String(MAX_PROOF_BYTES + 1) });
      res.write("{"); // and never the rest
    },
    (url) => assert.rejects(fetchJsonCapped(url, { timeoutMs: 5_000 }), refusedAs("too-large")),
  );
});

test("a response with no declared length is cut off once it passes the cap", async () => {
  await serve(
    (req, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      const chunk = "x".repeat(16 * 1024);
      for (let i = 0; i < 8; i++) res.write(chunk); // 128 KB, twice the cap, with no content-length
      res.end();
    },
    (url) => assert.rejects(fetchJsonCapped(url), refusedAs("too-large")),
  );
});

test("a response that stalls is abandoned at the deadline", async () => {
  await serve(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"nonce":'); // then nothing more
    },
    async (url) => {
      const started = Date.now();
      await assert.rejects(fetchJsonCapped(url, { timeoutMs: 500 }), refusedAs("timeout"));
      assert.ok(Date.now() - started < 5_000, "it gave up at the deadline, not later");
    },
  );
});

test("invalid JSON and an HTTP error are refused with their reason", async () => {
  await serve((req, res) => res.end("not json at all"), (url) => assert.rejects(fetchJsonCapped(url), refusedAs("not-json")));
  await serve(
    (req, res) => {
      res.statusCode = 404;
      res.end("gone");
    },
    (url) => assert.rejects(fetchJsonCapped(url), refusedAs("http-404")),
  );
});

test("both bots take a submitted proof through the bounded fetch, after a size and rate check", () => {
  // A source-shape guard, since the bots need a live platform client to run. The behavior is what the
  // tests above pin.
  for (const f of ["adapters/discord/bot.js", "adapters/telegram/bot.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /fetchJsonCapped\(/, `${f} uses the bounded fetch`);
    assert.match(src, /submitLimiter\.allow\(/, `${f} limits submissions per member`);
    assert.match(src, /MAX_PROOF_BYTES/, `${f} checks the reported size`);
    assert.doesNotMatch(src, /\(await fetch\([^)]*\)\)\.json\(\)/, `${f} still parses an unbounded download`);
  }
});
