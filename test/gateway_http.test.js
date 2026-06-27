import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Negative-path integration tests against the real gateway booted on a loopback port. The four
// policy checks (root, epoch, context, signal) and the one-time nonce all reject before the
// PLONK verify is ever reached, so these run around the crypto, not through it, and need no proof.
// The season-rollover consistency (M2) is unit-tested in season_rollover.test.js, since driving a
// registration through HTTP would need a real registration proof.

const REPO = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startGateway(extraEnv) {
  const port = await freePort();
  const proc = spawn("node", ["core/gateway.js"], {
    cwd: REPO,
    env: { ...process.env, MNO_MODE: "single", MNO_STORE: "memory", MNO_GATEWAY_PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway did not start in time:\n" + err)), 15000);
    proc.stdout.on("data", (d) => {
      if (String(d).includes("listening on :")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited early (code ${code}):\n` + err));
    });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function challenge(base) {
  const res = await post(base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
  assert.equal(res.status, 200, "challenge should mint a nonce");
  return res.body; // { nonce, signalHash, epoch, root, contextHash, epochSeconds }
}

// publicSignals layout (SIGNAL_INDEX): [nullifier, root, epoch, contextHash, signalHash].
const signalsFor = (ch, over = {}) => [
  over.nullifier ?? "1",
  over.root ?? ch.root,
  over.epoch ?? ch.epoch,
  over.contextHash ?? ch.contextHash,
  over.signalHash ?? ch.signalHash,
];

let gw, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mno-gw-"));
  const oracle = join(dir, "root.json");
  await writeFile(oracle, JSON.stringify({ height: 1, root: "123456789", ts: 0 }));
  gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
});

after(async () => {
  gw?.proc.kill();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("missing fields are rejected", async () => {
  assert.equal((await post(gw.base, "/v1/challenge", { platform: "p" })).status, 400);
  const v = await post(gw.base, "/v1/verify", { nonce: "x" });
  assert.equal(v.status, 400);
  assert.equal(v.body.error, "missing fields");
});

test("an unknown nonce is rejected", async () => {
  const v = await post(gw.base, "/v1/verify", { nonce: randomUUID(), proof: {}, publicSignals: ["1", "2", "3", "4", "5"] });
  assert.equal(v.status, 410);
  assert.equal(v.body.reason, "unknown-or-expired-challenge");
});

test("a replayed nonce is rejected (the challenge is one-time)", async () => {
  const ch = await challenge(gw.base);
  // The first verify fails policy (wrong root) but still consumes the one-time nonce.
  const first = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, { root: "999" }) });
  assert.equal(first.body.reason, "stale-or-unknown-root");
  const second = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, { root: "999" }) });
  assert.equal(second.status, 410);
  assert.equal(second.body.reason, "unknown-or-expired-challenge");
});

test("tampered public signals are rejected by the policy layer, before any proof verify", async () => {
  for (const [name, over, reason] of [
    ["root", { root: "999" }, "stale-or-unknown-root"],
    ["epoch", { epoch: "999999999" }, "wrong-epoch"],
    ["context", { contextHash: "0" }, "wrong-context"],
    ["signal", { signalHash: "0" }, "wrong-signal"],
  ]) {
    const ch = await challenge(gw.base);
    const v = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, over) });
    assert.equal(v.body.ok, false, `tampered ${name} should be rejected`);
    assert.equal(v.body.reason, reason, `tampered ${name}`);
  }
});

test("two-tier with the Platform store fails loud at boot, before any Platform connection", async () => {
  // The guard must reject this combination up front rather than fall back to a non-shared store.
  await assert.rejects(startGateway({ MNO_MODE: "two-tier", MNO_STORE: "platform" }), /not wired yet/);
});

test("an expired nonce is rejected", async () => {
  const oracle = join(dir, "root.json");
  const short = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_CHALLENGE_TTL: "1" });
  try {
    const ch = await challenge(short.base);
    await delay(1300);
    const v = await post(short.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch) });
    assert.equal(v.status, 410);
    assert.equal(v.body.reason, "unknown-or-expired-challenge");
  } finally {
    short.proc.kill();
  }
});

// Documents blocker B1 (proof not bound to the requesting account). The gateway returns the
// account the challenge was minted for, but the proof binds only to the nonce, and no adapter
// compares out.account to the submitter, so a valid (nonce, proof) relayed by a stranger grants
// the stranger. This cannot be enforced at the gateway today (no authenticated submitter, M5).
// Enable once the account is bound into the circuit signal (see REVIEW_FINDINGS B1, Lens 3 idea 1).
test(
  "a proof relayed for a different submitter is denied",
  { skip: "documents B1: proof binds to the nonce, not the account; enable when the account is in the signal" },
  () => {},
);
