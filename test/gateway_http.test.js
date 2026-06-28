import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeDmlRootHasher } from "../core/dml_root.js";
import { signalHash } from "../common/index.js";

// A real, self-consistent snapshot: the root is the recompute of these leaves, so it passes the
// gateway's M3 root check. ts is stamped fresh per write so the freshness check passes.
const rootHasher = await makeDmlRootHasher();
const REAL_LEAVES = ["111", "222", "333"];
const REAL_ROOT = rootHasher(REAL_LEAVES);
const snapshot = (over = {}) => ({ height: 1, depth: 16, root: REAL_ROOT, leaves: REAL_LEAVES, ts: Math.floor(Date.now() / 1000), ...over });

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

async function startGateway(extraEnv = {}) {
  const port = await freePort();
  // The gateway fails closed without auth, so tests run in the explicit unauthenticated mode unless
  // a case opts in via extraEnv. Drop any MNO_ADAPTER_SECRET inherited from the shell, so a developer
  // who exported one (per the docs) does not flip the default test gateway into authenticated mode.
  const env = { ...process.env, MNO_MODE: "single", MNO_STORE: "memory", MNO_ALLOW_UNAUTH_GATEWAY: "1", MNO_GATEWAY_PORT: String(port), ...extraEnv };
  if (!("MNO_ADAPTER_SECRET" in extraEnv)) delete env.MNO_ADAPTER_SECRET;
  const proc = spawn("node", ["core/gateway.js"], {
    cwd: REPO,
    env,
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
  await writeFile(oracle, JSON.stringify(snapshot()));
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
  const v = await post(gw.base, "/v1/verify", { nonce: randomUUID(), proof: {}, publicSignals: ["1", "2", "3", "4", "5"], account: "alice" });
  assert.equal(v.status, 410);
  assert.equal(v.body.reason, "unknown-or-expired-challenge");
});

test("a verify with a mismatched submitter account is rejected before the proof or nullifier (B1)", async () => {
  const ch = await challenge(gw.base); // minted for alice
  // A stranger relays alice's challenge but submits under their own account. The gateway returns
  // account-mismatch, and because that check runs before verifyMembership, no nullifier is spent,
  // so a relay cannot even burn alice's epoch.
  const v = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch), account: "mallory" });
  assert.equal(v.body.ok, false);
  assert.equal(v.body.reason, "account-mismatch");
});

test("a replayed nonce is rejected (the challenge is one-time)", async () => {
  const ch = await challenge(gw.base);
  // The first verify fails policy (wrong root) but still consumes the one-time nonce.
  const first = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, { root: "999" }), account: "alice" });
  assert.equal(first.body.reason, "stale-or-unknown-root");
  const second = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, { root: "999" }), account: "alice" });
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
    const v = await post(gw.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, over), account: "alice" });
    assert.equal(v.body.ok, false, `tampered ${name} should be rejected`);
    assert.equal(v.body.reason, reason, `tampered ${name}`);
  }
});

test("two-tier with the Platform store fails loud at boot, before any Platform connection", async () => {
  // The guard must reject this combination up front rather than fall back to a non-shared store.
  await assert.rejects(startGateway({ MNO_MODE: "two-tier", MNO_STORE: "platform" }), /not wired yet/);
});

test("a malformed numeric config value fails loud at boot rather than disabling a guard", async () => {
  // A non-numeric cap must not become NaN (which would make every size check false and silently
  // disable the pending-challenge cap); the gateway must refuse to start instead.
  await assert.rejects(startGateway({ MNO_MAX_PENDING_CHALLENGES: "not-a-number" }), /must be an integer/);
});

// M5/B1: the gateway fails closed. With neither a secret nor the explicit unauth override, it
// refuses to start rather than silently exposing the account endpoints.
test("the gateway refuses to start unauthenticated unless explicitly allowed", async () => {
  await assert.rejects(startGateway({ MNO_ALLOW_UNAUTH_GATEWAY: "" }), /refusing to start unauthenticated/);
});

// M5/B1: when MNO_ADAPTER_SECRET is set, the account-bearing endpoints require the adapter bearer
// token, so the account is vouched for by an authenticated adapter and not chosen by any caller.
// Public reads stay open. (The default suite gateway has no secret, so its tests run unauthenticated.)
test("the account endpoints require the adapter secret when it is set", async () => {
  const oracle = join(dir, "root.json");
  const sec = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_ADAPTER_SECRET: "s3cr3t" });
  try {
    const challenge = (headers) =>
      fetch(sec.base + "/v1/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ platform: "p", communityId: "c", roleId: "r", account: "alice" }),
      }).then((r) => r.status);
    assert.equal(await challenge({}), 401, "no token is rejected");
    assert.equal(await challenge({ authorization: "Bearer wrong" }), 401, "a wrong token is rejected");
    assert.equal(await challenge({ authorization: "Bearer s3cr3t" }), 200, "the correct token is accepted");
    // verify is gated the same way; a public read is not.
    const verifyStatus = await fetch(sec.base + "/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: "x", proof: {}, publicSignals: ["1"], account: "alice" }),
    }).then((r) => r.status);
    assert.equal(verifyStatus, 401, "verify without a token is rejected");
    assert.equal((await fetch(sec.base + "/v1/health")).status, 200, "health stays public");
  } finally {
    sec.proc.kill();
  }
});

test("an expired nonce is rejected", async () => {
  const oracle = join(dir, "root.json");
  const short = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_CHALLENGE_TTL: "1" });
  try {
    const ch = await challenge(short.base);
    await delay(1300);
    const v = await post(short.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch), account: "alice" });
    assert.equal(v.status, 410);
    assert.equal(v.body.reason, "unknown-or-expired-challenge");
  } finally {
    short.proc.kill();
  }
});

// B1: the gateway binds the requesting account into the signal hash, so a proof committed for one
// account's challenge cannot satisfy another account's challenge (the signal hashes differ). The
// adapters then grant out.account and reject a mismatched submitter, which is what closes the relay.
test("the challenge binds the account into the signal hash (B1)", async () => {
  const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
  assert.equal(res.status, 200);
  assert.equal(res.body.signalHash, signalHash(res.body.nonce, "alice").toString(), "signal hash must bind nonce and account");
  assert.notEqual(
    signalHash(res.body.nonce, "alice").toString(),
    signalHash(res.body.nonce, "bob").toString(),
    "a different account yields a different signal hash for the same nonce",
  );
});

// M3: the gateway recomputes the DML root from the published leaves and refuses a snapshot whose
// root does not match. With no usable root, the challenge endpoint reports none available rather
// than minting against an unverified set.
test("an oracle snapshot whose root does not match its leaves is rejected", async () => {
  const oracle = join(dir, "bad-root.json");
  await writeFile(oracle, JSON.stringify(snapshot({ root: "999999999" })));
  const bad = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(bad.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "no root should be available when the snapshot is rejected");
  } finally {
    bad.proc.kill();
  }
});

// M3: a snapshot older than the max age is rejected, so a stalled or replayed source stops being
// trusted once its root goes stale.
test("a stale oracle snapshot is rejected on the freshness check", async () => {
  const oracle = join(dir, "stale.json");
  await writeFile(oracle, JSON.stringify(snapshot({ ts: 1 }))); // ancient timestamp
  const stale = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_ORACLE_MAX_AGE: "60" });
  try {
    const res = await post(stale.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "a stale snapshot should leave no usable root");
  } finally {
    stale.proc.kill();
  }
});

// M3: a root accepted while fresh must stop being served once the source stalls. The freshness
// check blocks adopting a stale snapshot, but the held root also has to expire, or a stalled or
// replayed oracle keeps admitting members against a frozen root.
test("an accepted root is expired once the oracle snapshot ages out", async () => {
  const oracle = join(dir, "aging.json");
  await writeFile(oracle, JSON.stringify(snapshot())); // fresh ts, accepted at boot
  const aging = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "1", MNO_ORACLE_MAX_AGE: "4" });
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    assert.equal((await post(aging.base, "/v1/challenge", body)).status, 200, "served while fresh");
    await delay(5500); // the snapshot ts is now older than max age; a refresh tick should drop it
    assert.equal((await post(aging.base, "/v1/challenge", body)).status, 503, "dropped once stale");
  } finally {
    aging.proc.kill();
  }
});

// M3: a stable masternode set republishes the same root with a fresh timestamp, and that must keep
// the root served. The freshness clock has to advance on an unchanged root, or a healthy stable
// network would lose access after MNO_ORACLE_MAX_AGE.
test("a stable root that keeps being republished is not falsely expired", async () => {
  const oracle = join(dir, "stable.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const stable = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "1", MNO_ORACLE_MAX_AGE: "3" });
  // Keep publishing the same root with a fresh ts, as an unchanged masternode set would.
  const republish = setInterval(() => writeFile(oracle, JSON.stringify(snapshot())).catch(() => {}), 500);
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    await delay(4500); // well past MAX_AGE; an unchanged root must still be served (clock keeps advancing)
    assert.equal((await post(stable.base, "/v1/challenge", body)).status, 200, "stable root must stay served");
  } finally {
    clearInterval(republish);
    stable.proc.kill();
  }
});

// M3: an accepted root must still expire when the source goes bad and keeps returning a fresh but
// inconsistent snapshot. The mismatch-rejection path must not skip the staleness cleanup, or the
// frozen root would keep verifying past MNO_ORACLE_MAX_AGE.
test("a stale accepted root expires even while the source returns a mismatched snapshot", async () => {
  const oracle = join(dir, "mismatch-aging.json");
  await writeFile(oracle, JSON.stringify(snapshot())); // good, accepted at boot
  const bad = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "1", MNO_ORACLE_MAX_AGE: "4" });
  // The source now keeps publishing a fresh-but-inconsistent snapshot (root does not match leaves).
  const republish = setInterval(() => writeFile(oracle, JSON.stringify(snapshot({ root: "999999999" }))).catch(() => {}), 500);
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    await delay(5500); // the good root accepted at boot must age out and be dropped
    assert.equal((await post(bad.base, "/v1/challenge", body)).status, 503, "frozen root must not survive");
  } finally {
    clearInterval(republish);
    bad.proc.kill();
  }
});

// M3: a future-dated snapshot must not be adopted, or it would pose as fresh and defeat the
// receipt-time staleness guard until local time caught up.
test("a snapshot timestamped far in the future is rejected", async () => {
  const oracle = join(dir, "future.json");
  await writeFile(oracle, JSON.stringify(snapshot({ ts: Math.floor(Date.now() / 1000) + 100000 })));
  const fut = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_ORACLE_FUTURE_SKEW: "120" });
  try {
    const res = await post(fut.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "a future-dated snapshot must not be accepted");
  } finally {
    fut.proc.kill();
  }
});

// M3: freshness is enforced at request time, not only on the refresh tick. With the refresh
// interval far longer than the max age, no tick fires before the check, so only a request-time
// expiry can catch the aged-out root.
test("an aged-out root is dropped at request time even between refresh ticks", async () => {
  const oracle = join(dir, "req-stale.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const slow = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_ORACLE_MAX_AGE: "4" });
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    assert.equal((await post(slow.base, "/v1/challenge", body)).status, 200, "served while fresh");
    await delay(5500); // past MAX_AGE, and no refresh tick will fire (interval is 3600s)
    assert.equal((await post(slow.base, "/v1/challenge", body)).status, 503, "dropped at request time");
  } finally {
    slow.proc.kill();
  }
});

// M3: a masternode-list height only moves forward, so a fresh, self-consistent, but lower-height
// snapshot (a replay or a reorg) must not be adopted over a higher accepted one. Otherwise the
// served root and /v1/dml diverge and a node evicted between the two heights could prove against
// the stale set.
test("a lower-height snapshot is not adopted over a higher accepted one", async () => {
  const oracle = join(dir, "rollback.json");
  const high = { height: 10, leaves: ["111", "222"] };
  const low = { height: 5, leaves: ["333"] };
  const R10 = rootHasher(high.leaves);
  const R5 = rootHasher(low.leaves);
  await writeFile(oracle, JSON.stringify(snapshot({ height: high.height, root: R10, leaves: high.leaves })));
  const gw2 = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "1", MNO_ORACLE_MAX_AGE: "3600" });
  try {
    // The source now serves a fresh, self-consistent, but lower-height snapshot.
    await writeFile(oracle, JSON.stringify(snapshot({ height: low.height, root: R5, leaves: low.leaves })));
    await delay(1500); // let a refresh tick process the lower-height snapshot
    const dml = await (await fetch(gw2.base + "/v1/dml")).json();
    assert.equal(String(dml.root), R10, "served DML root must stay on the higher height");
    assert.equal(Number(dml.height), 10, "served DML height must not regress");
  } finally {
    gw2.proc.kill();
  }
});

// M3: a leaf at or above the field prime is not a canonical field element. It passes the decimal
// regex but the Poseidon reduction would alias it, so validateSnapshot must reject the snapshot.
test("a snapshot with a noncanonical field-element leaf is rejected", async () => {
  const oracle = join(dir, "noncanonical.json");
  const FIELD_PRIME = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
  await writeFile(oracle, JSON.stringify(snapshot({ root: "0", leaves: [FIELD_PRIME] })));
  const bad = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(bad.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "a noncanonical snapshot must leave no usable root");
  } finally {
    bad.proc.kill();
  }
});

// M5: with MNO_TRUST_PROXY the limiter keys off the LAST X-Forwarded-For hop (the address the
// trusted proxy observed), not the spoofable first hop. Requests with different first hops but the
// same last hop must share one rate-limit bucket.
test("the proxy client key uses the last X-Forwarded-For hop, not the spoofable first", async () => {
  const oracle = join(dir, "root.json");
  const px = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_TRUST_PROXY: "1", MNO_RATE_CHALLENGE: "2" });
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    const send = (first) =>
      fetch(px.base + "/v1/challenge", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `${first}, 9.9.9.9` },
        body: JSON.stringify(body),
      }).then((r) => r.status);
    // Three distinct (spoofed) first hops, one shared real last hop: the third must be limited.
    assert.equal(await send("1.1.1.1"), 200);
    assert.equal(await send("2.2.2.2"), 200);
    assert.equal(await send("3.3.3.3"), 429, "same last hop shares the bucket, so the limit applies");
  } finally {
    px.proc.kill();
  }
});

// M5: the challenge endpoint is rate-limited per client.
test("the challenge endpoint rate-limits a single client", async () => {
  const oracle = join(dir, "root.json");
  const rl = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_RATE_CHALLENGE: "3" });
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(rl.base, "/v1/challenge", body)).status);
    assert.equal(codes.slice(0, 3).every((c) => c === 200), true, "first three within the limit");
    assert.equal(codes.slice(3).every((c) => c === 429), true, "the rest are rate limited");
  } finally {
    rl.proc.kill();
  }
});

// M5: the registration endpoint runs the heaviest proof verify, so it is rate-limited too. The
// limiter runs before the body is parsed, so an empty body returns 400 under the limit and 429 over.
test("the registration endpoint is rate-limited in two-tier mode", async () => {
  const oracle = join(dir, "root.json");
  const reg = await startGateway({
    MNO_MODE: "two-tier",
    MNO_STORE: "memory",
    MNO_REG_PATH: join(dir, "reg.jsonl"),
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_RATE_REGISTER: "3",
  });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(reg.base, "/v1/register", {})).status);
    assert.equal(codes.slice(0, 3).every((c) => c === 400), true, "first three pass the limiter, then fail on missing fields");
    assert.equal(codes.slice(3).every((c) => c === 429), true, "the rest are rate limited");
  } finally {
    reg.proc.kill();
  }
});

// B2: the two-tier members endpoint is per-context. It requires a context and serves only that
// context's tree, so a prover fetches the leaves for its own community.
test("two-tier /v1/members requires a context and serves that context's tree", async () => {
  const oracle = join(dir, "root.json");
  const gw2 = await startGateway({
    MNO_MODE: "two-tier",
    MNO_STORE: "memory",
    MNO_REG_PATH: join(dir, "reg-members.jsonl"),
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
  });
  try {
    assert.equal((await fetch(gw2.base + "/v1/members")).status, 400, "context is required");
    // A non-canonical context (decimal but >= the field prime) is rejected before any tree work.
    const FIELD_PRIME = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    assert.equal((await fetch(gw2.base + `/v1/members?context=${FIELD_PRIME}`)).status, 400, "noncanonical context rejected");
    const res = await fetch(gw2.base + "/v1/members?context=42");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.size, 0, "a fresh context starts empty");
    assert.deepEqual(body.commitments, []);
    assert.ok(body.membersRoot, "an empty tree still has a root (served without building one)");
  } finally {
    gw2.proc.kill();
  }
});

// B2 DoS guard: /v1/members is rate-limited, since its context is unauthenticated client input and
// an empty context is served from the shared empty root without building a tree.
test("two-tier /v1/members is rate-limited per client", async () => {
  const oracle = join(dir, "root.json");
  const gw2 = await startGateway({
    MNO_MODE: "two-tier",
    MNO_STORE: "memory",
    MNO_REG_PATH: join(dir, "reg-members-rl.jsonl"),
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_RATE_MEMBERS: "3",
  });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(gw2.base + `/v1/members?context=${i + 1}`)).status);
    assert.equal(codes.slice(0, 3).every((c) => c === 200), true, "first three within the limit");
    assert.equal(codes.slice(3).every((c) => c === 429), true, "the rest are rate limited");
  } finally {
    gw2.proc.kill();
  }
});

// M5: pending challenges are capped, so one client cannot grow the challenge map without bound.
test("the pending-challenge map is capped", async () => {
  const oracle = join(dir, "root.json");
  const cap = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_MAX_PENDING_CHALLENGES: "2",
    MNO_RATE_CHALLENGE: "100",
  });
  try {
    const body = { platform: "p", communityId: "c", roleId: "r", account: "alice" };
    assert.equal((await post(cap.base, "/v1/challenge", body)).status, 200);
    assert.equal((await post(cap.base, "/v1/challenge", body)).status, 200);
    const third = await post(cap.base, "/v1/challenge", body);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "too many pending challenges");
  } finally {
    cap.proc.kill();
  }
});
