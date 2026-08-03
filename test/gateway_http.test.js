import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { makeDmlRootHasher, FIELD_PRIME } from "../core/dml_root.js";
import { shaRootFromLeaves } from "../common/dml_sha_root.js";
import { signalHash, contextHash } from "../common/index.js";
import { addSignature, rawPublicB64, signSnapshot, snapshotMessage } from "../common/oracle_sig.js";

// A real, self-consistent snapshot: the root is the recompute of these leaves, so it passes the
// gateway's M3 root check. ts is stamped fresh per write so the freshness check passes.
const rootHasher = await makeDmlRootHasher();
const REAL_LEAVES = ["111", "222", "333"];
const REAL_ROOT = rootHasher(REAL_LEAVES);
const shaRootHasher = (leaves) => shaRootFromLeaves(leaves, 16);
const snapshot = (over = {}) => ({ height: 1, blockHash: "ab".repeat(32), depth: 16, root: REAL_ROOT, leaves: REAL_LEAVES, ts: Math.floor(Date.now() / 1000), ...over });

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
  // The gateway fails closed without auth and without trusted oracle keys, so tests run in the
  // explicit unauthenticated and unsigned-oracle modes unless a case opts in via extraEnv. Drop any
  // MNO_ADAPTER_SECRET inherited from the shell, so a developer who exported one (per the docs) does
  // not flip the default test gateway into authenticated mode.
  // MNO_ALLOW_EPHEMERAL_NULLIFIERS is deliberate here: these tests want the in-memory spent set, and
  // the gateway refuses "memory" without the opt-in so a deployment cannot land on it by default.
  const env = { ...process.env, MNO_MODE: "single", MNO_STORE: "memory", MNO_ALLOW_EPHEMERAL_NULLIFIERS: "1", MNO_ALLOW_UNAUTH_GATEWAY: "1", MNO_ALLOW_UNSIGNED_ORACLE: "1", MNO_GATEWAY_PORT: String(port), ...extraEnv };
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

// publicSignals layout (SIGNAL_INDEX): [nullifier, root, epoch, contextHash, signalHash]. snarkjs
// emits each public signal as a decimal string, so build them as strings here too (the challenge
// returns epoch as a JSON number, which a real prover would carry as the string snarkjs produced).
const signalsFor = (ch, over = {}) => [
  String(over.nullifier ?? "1"),
  String(over.root ?? ch.root),
  String(over.epoch ?? ch.epoch),
  String(over.contextHash ?? ch.contextHash),
  String(over.signalHash ?? ch.signalHash),
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

test("an over-cap body is rejected cleanly, not hung or OOM", async () => {
  // Post a body larger than the 2 MB general cap to /v1/challenge (the small-cap endpoint). The
  // reader must reject (400 body too large) and destroy the request rather than keep buffering.
  const big = "x".repeat(2_100_000);
  const res = await fetch(gw.base + "/v1/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "p", communityId: "c", roleId: "r", account: "a", pad: big }),
  }).catch((e) => ({ status: 0, err: String(e) }));
  // The server closes the connection after destroy, so fetch may see a 400 or a connection reset.
  // Either is acceptable; what matters is the server does not hang or crash, proven by the next call.
  assert.ok(res.status === 400 || res.status === 0, `expected reject, got ${res.status}`);
  // The gateway is still healthy after the over-cap request.
  const health = await fetch(gw.base + "/v1/health");
  assert.equal(health.status, 200);
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

test("a non-canonical public signal is rejected before the proof verify", async () => {
  const ch = await challenge(gw.base);
  // FIELD_PRIME equals p, which is not in [0, p), so it is not canonical. snarkjs would reduce it mod
  // p, so without this guard a nullifier x and x + p would key two distinct spends for one field
  // element. The gateway rejects it before the nullifier is ever used as a key.
  const v = await post(gw.base, "/v1/verify", {
    nonce: ch.nonce,
    proof: {},
    publicSignals: signalsFor(ch, { nullifier: FIELD_PRIME.toString() }),
    account: "alice",
  });
  assert.equal(v.body.ok, false);
  assert.equal(v.body.reason, "non-canonical-signal");
});

test("two-tier with the Platform store fails loud at boot, before any Platform connection", async () => {
  // The guard must reject this combination up front rather than fall back to a non-shared store.
  await assert.rejects(startGateway({ MNO_MODE: "two-tier", MNO_STORE: "platform" }), /not wired yet/);
});

test("the ephemeral nullifier store refuses to boot without an explicit opt-in", async () => {
  // Losing the spent set on restart lets one voting key claim a second account in the same epoch,
  // so "memory" has to be asked for, never defaulted into.
  await assert.rejects(
    startGateway({ MNO_STORE: "memory", MNO_ALLOW_EPHEMERAL_NULLIFIERS: "" }),
    /MNO_ALLOW_EPHEMERAL_NULLIFIERS/,
  );
});

test("an unknown nullifier store name fails at boot rather than falling back", async () => {
  await assert.rejects(startGateway({ MNO_STORE: "postgres" }), /must be one of/);
});

test("a backward clock refuses the state-bearing endpoints and reports itself unready", async () => {
  // Seed the high-water marks in the future, which is what a gateway that ran before a backward
  // clock correction would have left behind. Rebuilding a past season's members tree from records
  // still on disk would revive registrations that were meant to have lapsed, so it must refuse.
  const dir = await mkdtemp(join(tmpdir(), "mno-clockback-"));
  const marks = join(dir, "time_marks.json");
  const epochSeconds = 100;
  const seasonSeconds = 1000;
  const future = Math.floor(Date.now() / 1000) + 10 * seasonSeconds;
  await writeFile(
    marks,
    JSON.stringify({
      epochSeconds,
      seasonSeconds,
      epoch: Math.floor(future / epochSeconds),
      season: Math.floor(future / seasonSeconds),
    }),
  );

  const gw = await startGateway({
    MNO_STORE: "sqlite",
    MNO_ALLOW_EPHEMERAL_NULLIFIERS: "",
    MNO_NULLIFIER_PATH: join(dir, "nf.sqlite"),
    MNO_TIME_MARKS_PATH: marks,
    MNO_EPOCH_SECONDS: String(epochSeconds),
    MNO_SEASON_SECONDS: String(seasonSeconds),
  });
  try {
    const ch = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(ch.status, 503, "challenge must refuse while the clock is behind its high-water mark");
    assert.equal(ch.body.error, "clock-regression");

    const health = await (await fetch(gw.base + "/v1/health")).json();
    assert.equal(health.ok, false, "health must report unready, not merely alive");
    // The handler observes the epoch before the season, and both regressed, so the first one seen
    // is what gets recorded.
    assert.equal(health.clockRegression.kind, "epoch");
  } finally {
    gw.proc.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a zkVM registration engine refuses to boot until the receipt verifier is wired", async () => {
  await assert.rejects(
    startGateway({ MNO_MODE: "two-tier", MNO_REGISTRATION_ENGINE: "zkvm", MNO_REGISTRATION_STATEMENT: "custody" }),
    /needs the RISC Zero receipt verifier/,
  );
});

test("an invalid registration engine/statement pair fails config validation at boot", async () => {
  await assert.rejects(
    startGateway({ MNO_MODE: "two-tier", MNO_REGISTRATION_ENGINE: "plonk", MNO_REGISTRATION_STATEMENT: "custody" }),
    /is not a valid pair/,
  );
});

test("a malformed numeric config value fails loud at boot rather than disabling a guard", async () => {
  // A non-numeric cap must not become NaN (which would make every size check false and silently
  // disable the pending-challenge cap). The gateway must refuse to start instead.
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
    // verify is gated the same way, but a public read is not.
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

// The gateway owns epoch timing: a proof for a challenge whose epoch has rolled over is rejected here,
// before the nullifier spend, so the member's epoch claim is not burned for an already-expired grant.
test("a proof for a rolled-over epoch is rejected before the nullifier spend", async () => {
  const oracle = join(dir, "root.json");
  const gw2 = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_EPOCH_SECONDS: "1", MNO_CHALLENGE_TTL: "600" });
  try {
    const ch = await challenge(gw2.base);
    await delay(1300); // the 1s epoch rolls over while the 600s challenge stays valid
    const v = await post(gw2.base, "/v1/verify", { nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch), account: "alice" });
    assert.equal(v.body.ok, false);
    assert.equal(v.body.reason, "epoch-rolled-over");
  } finally {
    gw2.proc.kill();
  }
});

// The challenge advertises the gateway mode, so each adapter renders the matching local prover
// command (single-tier `npm run prove` vs two-tier `npm run prove-epoch`).
test("the challenge advertises the gateway mode", async () => {
  const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "single");
});

// A non-string account is normalized to a string at the challenge boundary, so the signal hash uses
// the same form the string-typed verify expects. Otherwise a numeric account could mint a challenge
// it could never satisfy.
test("a numeric account is normalized so its challenge can verify", async () => {
  const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: 98765 });
  assert.equal(res.status, 200);
  assert.equal(res.body.signalHash, signalHash(res.body.nonce, "98765").toString());
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

// Oracle leaf authentication (review M3 remainder). With trusted oracle keys pinned, the gateway
// adopts a snapshot only when the quorum of those keys has signed it, so a host that serves a forged
// but self-consistent {leaves, root} cannot get the gateway to admit members against it. A rejected
// snapshot leaves no current root, so /v1/challenge has nothing to mint and returns 503.
async function gatewayWithSnapshot(snap, extraEnv = {}) {
  const d = await mkdtemp(join(tmpdir(), "mno-gw-sig-"));
  const oracle = join(d, "root.json");
  await writeFile(oracle, JSON.stringify(snap));
  let g;
  try {
    g = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", ...extraEnv });
  } catch (e) {
    await rm(d, { recursive: true, force: true });
    throw e;
  }
  return { g, cleanup: async () => { g.proc.kill(); await rm(d, { recursive: true, force: true }); } };
}
const signedBy = (snap, ...privs) => {
  let s = { ...snap, sigs: [] };
  for (const p of privs) s = { ...s, sigs: addSignature(s, p) };
  return s;
};
const mints = async (base) =>
  (await post(base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" })).status;

test("a snapshot signed by a trusted oracle key is adopted and mints challenges", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublicB64(privateKey);
  const snap = signedBy(snapshot({ blockHash: "ab".repeat(32) }), privateKey);
  const { g, cleanup } = await gatewayWithSnapshot(snap, { MNO_ORACLE_PUBKEYS: pub });
  try {
    assert.equal(await mints(g.base), 200);
  } finally {
    await cleanup();
  }
});

test("an unsigned snapshot is rejected when oracle keys are pinned, leaving no root", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const { g, cleanup } = await gatewayWithSnapshot(snapshot(), { MNO_ORACLE_PUBKEYS: rawPublicB64(privateKey) });
  try {
    assert.equal(await mints(g.base), 503);
  } finally {
    await cleanup();
  }
});

// The deployment-scoped dual-root requirement (docs/ZKVM_INTEGRATION.md): a zkVM gateway
// (MNO_REQUIRE_SHA_ROOT=1) refuses a v1 snapshot lacking the SHA-256 root, so a downgrade cannot
// slip one in, and adopts a self-consistent v2 snapshot.
test("a zkVM gateway refuses a v1 snapshot (downgrade), leaving no root", async () => {
  const v1 = snapshot(); // no version, no shaRoot
  const { g, cleanup } = await gatewayWithSnapshot(v1, { MNO_REQUIRE_SHA_ROOT: "1" });
  try {
    assert.equal(await mints(g.base), 503);
  } finally {
    await cleanup();
  }
});

test("a zkVM gateway adopts a v2 snapshot whose shaRoot hashes from its leaves", async () => {
  const v2 = snapshot({ version: 2, shaRoot: shaRootHasher(REAL_LEAVES) });
  const { g, cleanup } = await gatewayWithSnapshot(v2, { MNO_REQUIRE_SHA_ROOT: "1" });
  try {
    assert.equal(await mints(g.base), 200);
  } finally {
    await cleanup();
  }
});

test("a zkVM gateway rejects a v2 snapshot whose shaRoot does not hash from its leaves", async () => {
  const v2 = snapshot({ version: 2, shaRoot: "00".repeat(32) }); // wrong shaRoot
  const { g, cleanup } = await gatewayWithSnapshot(v2, { MNO_REQUIRE_SHA_ROOT: "1" });
  try {
    assert.equal(await mints(g.base), 503);
  } finally {
    await cleanup();
  }
});

// Version schema, enforced independent of deployment mode: v2 must carry a shaRoot, v1 must not.
test("even a non-zkVM gateway rejects a v2 snapshot with no shaRoot (schema)", async () => {
  const badV2 = snapshot({ version: 2 }); // v2 but no shaRoot
  const { g, cleanup } = await gatewayWithSnapshot(badV2); // no MNO_REQUIRE_SHA_ROOT
  try {
    assert.equal(await mints(g.base), 503, "malformed v2 not adopted");
  } finally {
    await cleanup();
  }
});

test("a v1 snapshot carrying a shaRoot is rejected as malformed (schema)", async () => {
  const badV1 = snapshot({ shaRoot: shaRootHasher(REAL_LEAVES) }); // v1 (no version) with a shaRoot
  const { g, cleanup } = await gatewayWithSnapshot(badV1);
  try {
    assert.equal(await mints(g.base), 503, "malformed v1 not adopted");
  } finally {
    await cleanup();
  }
});

// The full requirement is a v2 shaRoot under a v2 quorum SIGNATURE, so this matrix runs with a
// pinned oracle key (not unsigned mode): signed v1 is fine without the flag, the same signed v1 is
// refused with the flag (downgrade), a signed v2 is adopted with the flag, and a tampered-shaRoot v2
// is rejected because its v2 signature no longer verifies.
test("signed dual-root matrix under a pinned oracle key", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublicB64(privateKey);
  const v2ok = signedBy(snapshot({ version: 2, shaRoot: shaRootHasher(REAL_LEAVES) }), privateKey);
  const v1 = signedBy(snapshot(), privateKey);

  const a = await gatewayWithSnapshot(v1, { MNO_ORACLE_PUBKEYS: pub });
  try { assert.equal(await mints(a.g.base), 200, "signed v1 adopts without the flag"); } finally { await a.cleanup(); }

  const b = await gatewayWithSnapshot(v1, { MNO_ORACLE_PUBKEYS: pub, MNO_REQUIRE_SHA_ROOT: "1" });
  try { assert.equal(await mints(b.g.base), 503, "signed v1 refused with the flag"); } finally { await b.cleanup(); }

  const c = await gatewayWithSnapshot(v2ok, { MNO_ORACLE_PUBKEYS: pub, MNO_REQUIRE_SHA_ROOT: "1" });
  try { assert.equal(await mints(c.g.base), 200, "signed v2 adopts with the flag"); } finally { await c.cleanup(); }

  // Tamper the shaRoot AFTER signing: the recompute mismatch and the broken v2 signature both reject.
  const v2tampered = { ...v2ok, shaRoot: shaRootHasher(REAL_LEAVES).replace(/.$/, (ch) => (ch === "0" ? "1" : "0")) };
  const d = await gatewayWithSnapshot(v2tampered, { MNO_ORACLE_PUBKEYS: pub, MNO_REQUIRE_SHA_ROOT: "1" });
  try { assert.equal(await mints(d.g.base), 503, "tampered-shaRoot v2 rejected"); } finally { await d.cleanup(); }
});

test("an unknown snapshot version and a non-string shaRoot both fail closed", async () => {
  // Version 4, not 3. This test named 3 as unknown, and then 3 became a supported version, so its
  // fixture was being refused for missing v3 fields and the unknown-version dispatch it exists to
  // cover was no longer reached at all. A test that passes for a reason its name does not describe
  // is worse than a missing one.
  const unknown = snapshot({ version: 4, shaRoot: shaRootHasher(REAL_LEAVES) });
  const u = await gatewayWithSnapshot(unknown, { MNO_REQUIRE_SHA_ROOT: "1" });
  try { assert.equal(await mints(u.g.base), 503, "unknown version not adopted"); } finally { await u.cleanup(); }

  // A shaRoot as a singleton array must not pass via String() coercion.
  const arr = snapshot({ version: 2, shaRoot: [shaRootHasher(REAL_LEAVES)] });
  const w = await gatewayWithSnapshot(arr, { MNO_REQUIRE_SHA_ROOT: "1" });
  try { assert.equal(await mints(w.g.base), 503, "array shaRoot rejected"); } finally { await w.cleanup(); }
});

test("a snapshot signed by an untrusted key is rejected", async () => {
  const trusted = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const snap = signedBy(snapshot(), attacker.privateKey); // signed, but not by the pinned key
  const { g, cleanup } = await gatewayWithSnapshot(snap, { MNO_ORACLE_PUBKEYS: rawPublicB64(trusted.privateKey) });
  try {
    assert.equal(await mints(g.base), 503);
  } finally {
    await cleanup();
  }
});

test("a signed snapshot with no valid block hash is rejected", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublicB64(privateKey);
  // Signed by the trusted key, but the block hash it would anchor is missing, so the chain anchor the
  // signature is supposed to carry is absent. The gateway rejects it rather than count the signature.
  const snap = signedBy(snapshot({ blockHash: "" }), privateKey);
  const { g, cleanup } = await gatewayWithSnapshot(snap, { MNO_ORACLE_PUBKEYS: pub });
  try {
    assert.equal(await mints(g.base), 503);
  } finally {
    await cleanup();
  }
});

test("a quorum of two requires both pinned signers", async () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const pubs = `${rawPublicB64(a.privateKey)},${rawPublicB64(b.privateKey)}`;
  const one = await gatewayWithSnapshot(signedBy(snapshot(), a.privateKey), { MNO_ORACLE_PUBKEYS: pubs, MNO_ORACLE_QUORUM: "2" });
  try {
    assert.equal(await mints(one.g.base), 503); // only one of two signed
  } finally {
    await one.cleanup();
  }
  const both = await gatewayWithSnapshot(signedBy(snapshot(), a.privateKey, b.privateKey), { MNO_ORACLE_PUBKEYS: pubs, MNO_ORACLE_QUORUM: "2" });
  try {
    assert.equal(await mints(both.g.base), 200);
  } finally {
    await both.cleanup();
  }
});

test("duplicate oracle keys are deduped, so one key cannot satisfy a larger quorum", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublicB64(privateKey);
  // The same key listed twice with quorum 2: deduped to one key, quorum 2 now exceeds the key count,
  // so the gateway refuses to start rather than let one signer be counted twice.
  await assert.rejects(
    startGateway({ MNO_ORACLE_PUBKEYS: `${pub},${pub}`, MNO_ORACLE_QUORUM: "2" }),
    /exited early|did not start/,
  );
});

test("the same key in different base64 spellings is deduped on its decoded bytes, not its string", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const padded = rawPublicB64(privateKey); // standard base64, with padding
  const unpadded = padded.replace(/=+$/, ""); // same 32 bytes, a different string
  assert.notEqual(padded, unpadded);
  // String-level dedup would keep both and let one signer cover quorum 2. Byte-level dedup collapses
  // them to one key, so quorum 2 exceeds the key count and the gateway refuses to start.
  await assert.rejects(
    startGateway({ MNO_ORACLE_PUBKEYS: `${padded},${unpadded}`, MNO_ORACLE_QUORUM: "2" }),
    /exited early|did not start/,
  );
});

test("the gateway refuses to start with an unsigned oracle and no opt-out", async () => {
  await assert.rejects(
    startGateway({ MNO_ALLOW_UNSIGNED_ORACLE: "", MNO_ORACLE_PUBKEYS: "" }),
    /exited early|did not start/,
  );
});


// v3 is the block-bound, ChainLock-gated snapshot. Adding a version and leaving its schema unstated is
// how a new version becomes the WEAKEST one: v3 initially had no rule here at all, so a v3 snapshot
// with no shaRoot and no leaf order passed validation that a v2 would have failed. These drive the
// real gateway, so they exercise validateSnapshot rather than a copy of its logic.
test("a v3 snapshot with no leaf order is rejected, leaving no usable root", async () => {
  const oracle = join(dir, "v3-no-order.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: "a".repeat(64) })), // order absent
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "an unstated leaf order must not be adopted");
  } finally {
    gw.proc.kill();
  }
});

test("a v3 snapshot with an unrecognised leaf order is rejected", async () => {
  // The window keys on this label to hold two orders apart, so a label nothing can interpret makes
  // that separation meaningless. Refused rather than filed under it.
  const oracle = join(dir, "v3-odd-order.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: "a".repeat(64), order: "somethingElse" })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503);
  } finally {
    gw.proc.kill();
  }
});

test("a v3 snapshot with no shaRoot is rejected, exactly as a v2 would be", async () => {
  const oracle = join(dir, "v3-no-sha.json");
  await writeFile(oracle, JSON.stringify(snapshot({ version: 3, order: "proRegTxHash" })));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503);
  } finally {
    gw.proc.kill();
  }
});

// A zkVM deployment requires a snapshot carrying a SHA-256 root. The guard tested `version !== 2`,
// which rejected every v3 snapshot and so made the block-bound read unusable exactly where the dual
// root matters most. The accidental third guarantee in that equality test, that an UNKNOWN version is
// refused too, is kept: the versions are enumerated rather than inferred from a shaRoot being present.
test("a zkVM deployment accepts a v3 snapshot, which carries a shaRoot by schema", async () => {
  const oracle = join(dir, "v3-zkvm.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: shaRootHasher(REAL_LEAVES), order: "proRegTxHash", chainlocked: true })),
  );
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_REQUIRE_SHA_ROOT: "1",
  });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.notEqual(res.status, 503, "a v3 snapshot must be usable on a zkVM deployment");
  } finally {
    gw.proc.kill();
  }
});

test("a zkVM deployment still refuses v1, which carries no shaRoot at all", async () => {
  const oracle = join(dir, "v1-zkvm.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_REQUIRE_SHA_ROOT: "1",
  });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "the downgrade refusal must survive the fix");
  } finally {
    gw.proc.kill();
  }
});

// v1 and v2 signatures do not cover `order` or `chainlocked`, so a snapshot carrying them on those
// versions is claiming something its signature does not authenticate. A compromised host could append
// a unique order string on every refresh while keeping a valid signature, which is how one height came
// to hold a thousand window records. Refused as a hard error rather than silently ignored.
test("a v1 snapshot carrying a leaf order is rejected, not silently ignored", async () => {
  const oracle = join(dir, "v1-with-order.json");
  await writeFile(oracle, JSON.stringify(snapshot({ order: "proRegTxHash" })));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "an unsigned field must not reach the window key");
  } finally {
    gw.proc.kill();
  }
});

test("a v2 snapshot carrying a chainlock claim is rejected", async () => {
  const oracle = join(dir, "v2-with-cl.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 2, shaRoot: shaRootHasher(REAL_LEAVES), chainlocked: true })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "v2 does not sign this claim, so it must not carry it");
  } finally {
    gw.proc.kill();
  }
});

// The chainlock claim is signed, but signing it was never requiring it: a v3 snapshot with the claim
// absent, false, or mistyped still formed a valid signed message (encoding "0") and validateSnapshot
// accepted it, so a v3 could be adopted without making the claim v3 exists to carry.
test("a v3 snapshot with no chainlock claim is rejected", async () => {
  const oracle = join(dir, "v3-no-cl.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: shaRootHasher(REAL_LEAVES), order: "proRegTxHash" })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "absent chainlocked must refuse, not default to accepted");
  } finally {
    gw.proc.kill();
  }
});

test("a v3 snapshot with a mistyped chainlock claim is rejected", async () => {
  // "true" the string is not true the statement. Coercion here would make the weakest producer the
  // one that defines the claim.
  const oracle = join(dir, "v3-string-cl.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: shaRootHasher(REAL_LEAVES), order: "proRegTxHash", chainlocked: "true" })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503);
  } finally {
    gw.proc.kill();
  }
});

test("a v3 snapshot claiming chainlocked false is rejected", async () => {
  // False is not merely unproven, it is the snapshot saying its own anchor is not locked, and v3
  // exists to carry the opposite claim.
  const oracle = join(dir, "v3-false-cl.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({ version: 3, shaRoot: shaRootHasher(REAL_LEAVES), order: "proRegTxHash", chainlocked: false })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503);
  } finally {
    gw.proc.kill();
  }
});

test("a SIGNED unlocked v3 snapshot is refused and the gateway survives it", async () => {
  // The old message form encoded chainlocked false as "0", so an unlocked v3 could carry a VALID
  // signature. This crafts exactly that artifact, the signature computed over the old encoding, and
  // proves two things on a signed deployment: the snapshot is refused (validateSnapshot refuses the
  // claim before signatures are consulted, and snapshotMessage now refuses to even form for it), and
  // the refusal is contained, the gateway keeps answering rather than crashing out of its refresh.
  const kp = generateKeyPairSync("ed25519");
  const snap = snapshot({ version: 3, shaRoot: shaRootHasher(REAL_LEAVES), order: "proRegTxHash", chainlocked: false });
  const oldFormMessage = Buffer.from(
    ["mno-oracle-snapshot-v3", "3", snap.height, snap.blockHash, snap.depth, snap.root, snap.shaRoot, snap.order, "0", snap.ts]
      .map(String)
      .join("\n"),
    "utf8",
  );
  snap.sigs = [{ key: rawPublicB64(kp.privateKey), sig: signSnapshot(oldFormMessage, kp.privateKey) }];
  const oracle = join(dir, "v3-signed-unlocked.json");
  await writeFile(oracle, JSON.stringify(snap));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const first = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(first.status, 503, "a signed unlocked v3 must not be adopted");
    const second = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "bob" });
    assert.equal(second.status, 503, "and the gateway is still answering, the refusal was contained");
  } finally {
    gw.proc.kill();
  }
});

test("a v3 snapshot with a malformed block hash is rejected even with no oracle keys pinned", async () => {
  // A v3 snapshot is a block-bound read, so the block it names must be well formed regardless of
  // deployment mode. Before, only signed deployments checked this (in the signature path), so
  // unsigned mode could adopt a v3 snapshot anchored to nothing.
  const oracle = join(dir, "v3-bad-hash.json");
  await writeFile(
    oracle,
    JSON.stringify(snapshot({
      version: 3,
      shaRoot: shaRootHasher(REAL_LEAVES),
      order: "proRegTxHash",
      chainlocked: true,
      blockHash: "not-a-hash",
    })),
  );
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "an unanchored v3 snapshot must not be adopted in unsigned mode");
  } finally {
    gw.proc.kill();
  }
});

// THE END-TO-END REFRESH-PATH TEST. The coexistence unit tests drive RootWindows directly, which
// proves the rule and not that the refresh path reaches it. This drives two valid snapshots through
// the real path (file source, refresh tick, validateSnapshot, recompute, mayCoexist, adopt) and
// observes the WINDOW through the verify endpoint: a probe with canonical signals, a deliberately
// wrong epoch, and a chosen root fails with "wrong-epoch" only if the root check (which runs first)
// passed, so the failure reason is a window-membership oracle that needs no real proof.
test("two valid snapshots drive the refresh path end to end and both roots stay accepted by the window", async () => {
  const H = 7;
  const BH = "cd".repeat(32);
  const v2Leaves = REAL_LEAVES;
  const v3Leaves = [...REAL_LEAVES].reverse(); // same multiset, different build order
  const V3_ROOT = rootHasher(v3Leaves);
  const badLeaves = ["111", "222", "999"]; // a DIFFERENT multiset, self-consistent on its own
  const BAD_ROOT = rootHasher(badLeaves);

  const oracle = join(dir, "refresh-path.json");
  const writeSnap = (over) => writeFile(oracle, JSON.stringify(snapshot({ height: H, blockHash: BH, ...over })));
  await writeSnap({ version: 2, leaves: v2Leaves, shaRoot: shaRootHasher(v2Leaves) });

  const g = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "1",
    // This test POLLS for a refresh to land, which is not a user pattern. The per-account challenge
    // limit is deliberately small (a human needs a handful of attempts, not dozens), so the polling
    // would trip it. Raised here rather than lowering the production default for a test's benefit.
    MNO_RATE_CHALLENGE_ACCOUNT: "1000",
  });
  // The refresh path reports its rejections on stderr, and the negative phase below synchronizes on
  // that report rather than on a fixed delay, so a tick that never ran cannot read as a rejection.
  let gwLogs = "";
  g.proc.stderr.on("data", (d) => (gwLogs += d));
  const mint = async () => {
    const res = await post(g.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "e2e" });
    assert.equal(res.status, 200);
    return res.body;
  };
  // "wrong-epoch" means the root check passed (the window holds the probed root); the root check
  // runs before the epoch check, so "stale-or-unknown-root" means it does not.
  const windowHolds = async (root) => {
    const ch = await mint();
    const res = await post(g.base, "/v1/verify", {
      nonce: ch.nonce,
      proof: { probe: true },
      publicSignals: signalsFor(ch, { root, epoch: String(Number(ch.epoch) + 1) }),
      account: "e2e",
    });
    assert.equal(res.status, 200);
    if (res.body.reason === "wrong-epoch") return true;
    if (res.body.reason === "stale-or-unknown-root") return false;
    throw new Error(`probe got unexpected reason ${res.body.reason}`);
  };
  const currentRoot = async () => (await mint()).root;

  try {
    assert.equal(await currentRoot(), REAL_ROOT, "the v2 snapshot is adopted at boot");
    assert.equal(await windowHolds(REAL_ROOT), true, "and its root is in the window");

    // The changeover: same height, same block, same leaf multiset, different order. The refresh
    // path must adopt it beside the v2 root, not replace or refuse it.
    await writeSnap({ version: 3, leaves: v3Leaves, shaRoot: shaRootHasher(v3Leaves), root: V3_ROOT, order: "proRegTxHash", chainlocked: true });
    let flipped = false;
    for (let i = 0; i < 40 && !flipped; i += 1) {
      await delay(250);
      flipped = (await currentRoot()) === V3_ROOT;
    }
    assert.ok(flipped, "the refresh path adopted the v3 snapshot");
    assert.equal(await windowHolds(V3_ROOT), true, "the v3 root is accepted by the window");
    assert.equal(await windowHolds(REAL_ROOT), true, "and the v2 root stays accepted beside it during the changeover");

    // The negative twin: a valid-in-isolation v3 at the same height whose leaf SET differs. The
    // refresh path must refuse it, or the coexistence window would be the hole rather than the
    // feature. Synchronize on the gateway REPORTING the rejection, not on a delay: BAD_ROOT is
    // absent from the window either way, so asserting after a fixed wait could pass against
    // unchanged state where no refresh tick ever examined the snapshot.
    await writeSnap({ version: 3, leaves: badLeaves, shaRoot: shaRootHasher(badLeaves), root: BAD_ROOT, order: "proRegTxHash", chainlocked: true });
    let rejected = false;
    for (let i = 0; i < 40 && !rejected; i += 1) {
      await delay(250);
      rejected = gwLogs.includes(`oracle root changed at height ${H}, snapshot rejected`);
    }
    assert.ok(rejected, "the refresh path examined the different-set snapshot and reported rejecting it");
    assert.equal(await windowHolds(BAD_ROOT), false, "and its root is not accepted");
    assert.equal(await currentRoot(), V3_ROOT, "the served root did not flap");
    assert.equal(await windowHolds(REAL_ROOT), true, "and the coexisting v2 root survived the attempt");
  } finally {
    g.proc.kill();
  }
});

// THE BLOCKER FROM THE FOUR-REVIEWER ROUND, driven end to end. Two reviewers found it
// independently: the served snapshot and the root window were separate authorities that aged on
// separate rules, so a record could expire and leave the window populated while the served
// snapshot went null. Two consequences, both reproduced here: /v1/challenge minted against a root
// /v1/dml had no leaves for, and the same-height coexistence guard, being conditional on that
// separate pointer, was SKIPPED entirely, so a snapshot over a different member set could join the
// window beside a surviving one.
test("an uppercase or array block hash is refused on every version, signed or not", async () => {
  // One canonical block-hash schema. The signature path used a case-insensitive regex over
  // String(o.blockHash), so a singleton array coerced through and uppercase passed, while v3
  // demanded lowercase, and mayCoexist compares exactly, so an uppercase v2 record and the
  // lowercase v3 record for the SAME block read as different blocks and the changeover was refused.
  for (const [name, blockHash] of [["upper", "AB".repeat(32)], ["array", ["ab".repeat(32)]]]) {
    const oracle = join(dir, `hash-${name}.json`);
    await writeFile(oracle, JSON.stringify(snapshot({ version: 2, shaRoot: shaRootHasher(REAL_LEAVES), blockHash })));
    const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
    try {
      const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
      assert.equal(res.status, 503, `${name} block hash must be refused, not normalized downstream`);
    } finally {
      gw.proc.kill();
    }
  }
});

test("the signature quorum is judged BEFORE the roots are rebuilt", async () => {
  // Order, not timing, so this is deterministic. The snapshot is broken in TWO ways at once: an
  // untrusted signature AND a root that does not hash from its leaves. Whichever check runs first
  // is the one that logs. The rebuilds are the expensive part, so an unauthenticated host must not
  // be able to buy them: a full leaf set rebuilt before the cheap Ed25519 check stalls the event
  // loop for seconds on every refresh, which is a denial of service against every endpoint.
  const trusted = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const bad = snapshot({ root: "12345" }); // not the recompute of REAL_LEAVES
  const signed = { ...bad, sigs: [{ key: rawPublicB64(attacker.privateKey), sig: signSnapshot(snapshotMessage(bad), attacker.privateKey) }] };
  const oracle = join(dir, "sig-before-rebuild.json");
  await writeFile(oracle, JSON.stringify(signed));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "1", // a refresh must land AFTER the listener below attaches
    MNO_ORACLE_PUBKEYS: rawPublicB64(trusted.privateKey),
  });
  let logs = "";
  gw.proc.stderr.on("data", (d) => (logs += d));
  try {
    await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    for (let i = 0; i < 30 && !logs.includes("rejected"); i += 1) await delay(200);
    assert.match(logs, /signature quorum not met/, "the cheap authentication check decides");
    assert.doesNotMatch(logs, /root mismatch/, "and the expensive rebuild never ran to notice the bad root");
  } finally {
    gw.proc.kill();
  }
});

test("a refresh that throws does not wedge the single-flight guard", async () => {
  // The guard makes a tick a no-op while one is in flight, so a leaked flag would freeze refreshes
  // for the life of the process. The reset lives in a finally, and this drives a failing fetch
  // (missing file) followed by a good one through the real loop.
  const oracle = join(dir, "appears-later.json");
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "1" });
  try {
    const first = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(first.status, 503, "no snapshot to load yet");
    await writeFile(oracle, JSON.stringify(snapshot()));
    let ok = false;
    for (let i = 0; i < 40 && !ok; i += 1) {
      await delay(250);
      ok = (await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" })).status === 200;
    }
    assert.ok(ok, "refreshes resumed after the failing one, so the guard was released");
  } finally {
    gw.proc.kill();
  }
});

// WHAT THIS TEST DOES AND DOES NOT PIN, established by mutation rather than asserted. Restoring the
// separate independently-aged pointer fails it, so the SERVING invariant is genuinely covered.
// Re-adding the old pointer-conditional wrapper around the coexistence guard does NOT fail it,
// because the derived pointer is null only when the window is empty, so the guard is unreachable in
// the skipped state. The guard-skipping half of the blocker is closed BY CONSTRUCTION and cannot be
// reproduced against this architecture, which is why no test here claims to catch it. The
// unconditional coexistence refusal itself is covered by the store tests and the earlier
// end-to-end test.
test("an expired record cannot split the served snapshot from the window", async () => {
  const H = 11;
  const BH = "ef".repeat(32);
  const goodLeaves = REAL_LEAVES;
  const v3Leaves = [...REAL_LEAVES].reverse();
  const V3_ROOT = rootHasher(v3Leaves);
  const badLeaves = ["111", "222", "888"]; // a DIFFERENT member set, self-consistent on its own
  const BAD_ROOT = rootHasher(badLeaves);

  const oracle = join(dir, "split-authority.json");
  const now = Math.floor(Date.now() / 1000);
  const writeSnap = (over) => writeFile(oracle, JSON.stringify(snapshot({ height: H, blockHash: BH, ...over })));

  // The v2 record is stamped comfortably fresh; the v3 record is stamped OLD but still inside the
  // age bound, which is the staggering that made the two authorities disagree. Both pass validation.
  await writeSnap({ version: 2, leaves: goodLeaves, shaRoot: shaRootHasher(goodLeaves), ts: now });
  const g = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "1",
    MNO_ORACLE_MAX_AGE: "20",
    MNO_RATE_CHALLENGE_ACCOUNT: "1000", // polls for an aging boundary, see the note above
  });
  const mint = async () => post(g.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "split" });
  const dml = async () => (await fetch(g.base + "/v1/dml")).json();
  try {
    let ch = await mint();
    assert.equal(ch.status, 200, "the v2 snapshot is adopted");
    let served = await dml();
    assert.equal(served.root, ch.body.root, "the challenge root and the served leaves name one snapshot");

    // The v3 snapshot at the same height, same block, same member set, but stamped 6 seconds older.
    await writeSnap({ version: 3, leaves: v3Leaves, shaRoot: shaRootHasher(v3Leaves), root: V3_ROOT, order: "proRegTxHash", chainlocked: true, ts: now - 13 });
    for (let i = 0; i < 40; i += 1) {
      await delay(250);
      ch = await mint();
      if (ch.status === 200 && ch.body.root === V3_ROOT) break;
    }
    assert.equal(ch.body.root, V3_ROOT, "the older-stamped v3 is adopted and becomes current");

    // Now let the v3 record age past the bound while the v2 record is still fresh. THE INVARIANT:
    // whatever the gateway will mint a challenge against, it must be able to serve leaves for.
    await writeSnap({ version: 3, leaves: badLeaves, shaRoot: shaRootHasher(badLeaves), root: BAD_ROOT, order: "proRegTxHash", chainlocked: true, ts: now + 2 });
    for (let i = 0; i < 48; i += 1) {
      await delay(250);
      ch = await mint();
      served = await dml();
      if (ch.status === 200) {
        assert.equal(
          served.root,
          ch.body.root,
          "a challenge is never minted against a root whose leaves /v1/dml will not serve",
        );
        assert.deepEqual(served.leaves.length > 0, true, "and the served snapshot always carries its leaves");
      }
      assert.notEqual(ch.body.root, BAD_ROOT, "the different-set snapshot never becomes the served root");
    }
    // And it never entered the window at all, whatever the pointer state was along the way.
    const probe = await mint();
    if (probe.status === 200) {
      const res = await post(g.base, "/v1/verify", {
        nonce: probe.body.nonce,
        proof: { probe: true },
        publicSignals: signalsFor(probe.body, { root: BAD_ROOT, epoch: String(Number(probe.body.epoch) + 1) }),
        account: "split",
      });
      assert.equal(res.body.reason, "stale-or-unknown-root", "the different member set is not provable against");
    }
  } finally {
    g.proc.kill();
  }
});

test("an unknown field on a signed snapshot is not retained in the window", async () => {
  // The regression the whole-gateway round found in the previous round's own fix. The padding rides
  // on a snapshot whose signature is genuinely valid, because the signed message covers named fields
  // only, so no signature check can reject it. It must be dropped at adoption instead. A modest
  // payload here proves the property; the reviewer's measured cost was 157 MB across eight records.
  const kp = generateKeyPairSync("ed25519");
  const padded = snapshot({ padding: "x".repeat(200_000) });
  padded.sigs = addSignature(padded, kp.privateKey);
  const oracle = join(dir, "padded.json");
  await writeFile(oracle, JSON.stringify(padded));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const ch = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(ch.status, 200, "the snapshot is legitimately signed and must still be adopted");
    const served = await (await fetch(gw.base + "/v1/dml")).json();
    assert.equal(served.root, ch.body.root, "and still served consistently");
    assert.equal(JSON.stringify(served).includes("xxxxx"), false, "but the padding is not retained or served");
    assert.deepEqual(Object.keys(served).sort(), ["depth", "height", "leaves", "root", "shaRoot"]);
  } finally {
    gw.proc.kill();
  }
});

test("a snapshot carrying many signatures is refused, and a valid one among them is still found", async () => {
  // WHAT THIS PROVES AND WHAT IT CANNOT. The defect was WORK, not verdict: sigs had no length bound
  // and entries' key labels were ignored, so the gateway verified the whole array once per trusted
  // key (a reviewer measured 10,000 invalid checks at about 1.28 s, times the pinned keys, on every
  // refresh). The fix is the key-indexed lookup, which verifies at most one signature per trusted
  // key, plus a length cap as cheap defence in depth.
  //
  // Neither is observable in the response. A large array of non-matching signatures yields 503
  // whether the gateway checked one of them or all of them, so the length cap has NO discriminating
  // test and its mutation passes; that is recorded rather than papered over with a timing assertion
  // that would flake. What IS asserted here is the half that can be: a large array is refused, and
  // a genuinely valid signature buried among many is still found rather than lost to the indexing.
  // DISTINCT key labels, deliberately. A first version reused one label 500 times, which the
  // duplicate-key check rejects, so the test passed with the cap removed and proved nothing about
  // the cap. Distinct labels are exactly the shape that reaches the verification loop.
  const kp = generateKeyPairSync("ed25519");
  const snap = snapshot();
  snap.sigs = Array.from({ length: 500 }, (_, i) => ({
    key: rawPublicB64(generateKeyPairSync("ed25519").privateKey),
    sig: `bogus${i}`,
  }));
  const oracle = join(dir, "many-sigs.json");
  await writeFile(oracle, JSON.stringify(snap));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "no trusted key signed it, so the quorum is unmet");
  } finally {
    gw.proc.kill();
  }

  // The same snapshot, but with the trusted key's real signature buried among the bogus ones and
  // the array back under the cap. The indexing must find it.
  const buried = snapshot();
  buried.sigs = [
    ...Array.from({ length: 20 }, () => ({ key: rawPublicB64(generateKeyPairSync("ed25519").privateKey), sig: "bogus" })),
    ...addSignature(buried, kp.privateKey),
  ];
  const oracle2 = join(dir, "buried-sig.json");
  await writeFile(oracle2, JSON.stringify(buried));
  const gw2 = await startGateway({
    MNO_ORACLE_SOURCE: oracle2,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const res = await post(gw2.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 200, "a valid signature must not be lost among unrelated ones");
  } finally {
    gw2.proc.kill();
  }
});

test("a valid signature still verifies when its key label uses a different base64 spelling", async () => {
  // Indexing by label made spelling load-bearing where it never was before, so a base64url label
  // for the very same key could have made a valid signature invisible. The label is canonicalized.
  const kp = generateKeyPairSync("ed25519");
  const snap = snapshot();
  snap.sigs = addSignature(snap, kp.privateKey);
  snap.sigs[0].key = snap.sigs[0].key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const oracle = join(dir, "b64url-label.json");
  await writeFile(oracle, JSON.stringify(snap));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 200, "a genuinely signed snapshot must still be adopted");
  } finally {
    gw.proc.kill();
  }
});

test("two signatures labelled with one key are refused rather than resolved", async () => {
  const kp = generateKeyPairSync("ed25519");
  const snap = snapshot();
  snap.sigs = addSignature(snap, kp.privateKey);
  snap.sigs.push({ key: snap.sigs[0].key, sig: snap.sigs[0].sig });
  const oracle = join(dir, "dup-key.json");
  await writeFile(oracle, JSON.stringify(snap));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_ORACLE_PUBKEYS: rawPublicB64(kp.privateKey),
  });
  try {
    const res = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(res.status, 503, "picking a winner would be inventing a rule");
  } finally {
    gw.proc.kill();
  }
});

test("an unrecognised MNO_MODE refuses to boot instead of silently running single-tier", async () => {
  // LEAK-SAFE ON THE FAILING PATH. Written first as a bare assert.rejects, which leaves the spawned
  // gateway running whenever the guard is absent, and node --test will not exit while that child
  // holds its port. Under mutation the run hung instead of failing, which is the project's
  // documented orphaned-suite gotcha reproduced by a test meant to catch a config bug. A test whose
  // failure mode is a hang cannot be mutation-checked, so it captures and terminates instead.
  const oracle = join(dir, "mode.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  let started = null;
  try {
    started = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_MODE: "two_tier" });
  } catch (err) {
    assert.match(String(err.message), /MNO_MODE must be one of|gateway exited early/);
    return;
  } finally {
    started?.proc.kill();
  }
  assert.fail("a typo must not boot the opposite implementation and echo the typo to clients");
});

// THE CONTEXT ALLOWLIST. Registration is unauthenticated by design (the proof is the credential)
// and the caller chooses the platform, community, and role that form the context, so the
// once-per-context registration nullifier bounds nothing: a valid masternode holder picks a fresh
// context each time and gets another durable record and another cached tree, without limit. Two
// reviewers reached this independently and one called it a blocker. An allowlist rather than a cap,
// because a cap lets an attacker fill it first and lock out the real communities.
test("a registration for a context this gateway does not serve is refused before the proof", async () => {
  const oracle = join(dir, "allowlist.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const served = contextHash({ platform: "p", communityId: "served", roleId: "r" }).toString();
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_MODE: "two-tier",
    MNO_REGISTER_CONTEXTS: served,
  });
  try {
    const res = await post(gw.base, "/v1/register", {
      platform: "p", communityId: "not-served", roleId: "r", proof: {}, publicSignals: ["1"],
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, "context-not-served");
  } finally {
    gw.proc.kill();
  }
});

test("a registration for a served context passes the allowlist and reaches the proof check", async () => {
  // The guard must have an exit ordinary correct operation reaches. A served context gets past the
  // allowlist and is then refused on its (deliberately bogus) proof, which is a DIFFERENT refusal.
  const oracle = join(dir, "allowlist-ok.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const served = contextHash({ platform: "p", communityId: "served", roleId: "r" }).toString();
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_MODE: "two-tier",
    MNO_REGISTER_CONTEXTS: served,
  });
  try {
    const res = await post(gw.base, "/v1/register", {
      platform: "p", communityId: "served", roleId: "r", proof: {}, publicSignals: ["1"],
    });
    assert.notEqual(res.body.reason, "context-not-served", "the served context is past the allowlist");
  } finally {
    gw.proc.kill();
  }
});

// THE SHARED-BUCKET PROBLEM. A reviewer's reading of the four adapters (not exercised by this test)
// is that each makes the gateway request itself and forwards no originating client address, so the
// gateway sees ONE client for every user behind that adapter and a source-keyed limit is a bucket
// the whole community shares. What this test actually drives is the gateway half: two accounts
// arriving from ONE source address, which is that situation as the gateway experiences it. The
// per-account limit subdivides fairly when a trusted adapter supplies the account; on an
// unauthenticated gateway the caller picks the string, so it is best-effort there.
test("one account exhausting its own limit does not deny challenges to another account", async () => {
  const oracle = join(dir, "rate-fair.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_RATE_CHALLENGE_ACCOUNT: "3",
    MNO_RATE_CHALLENGE: "1000", // the aggregate guard is not what this test is about
  });
  const mint = (account) => post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account });
  try {
    // One account burns its own allowance, from what the gateway sees as a single client.
    assert.equal((await mint("noisy")).status, 200);
    assert.equal((await mint("noisy")).status, 200);
    assert.equal((await mint("noisy")).status, 200);
    assert.equal((await mint("noisy")).status, 429, "its own bucket is spent");

    // The other user, behind the very same adapter and therefore the same source address, is
    // unaffected. Before the per-account limit this returned 429 too.
    assert.equal((await mint("quiet")).status, 200, "a different account keeps its own allowance");
    assert.equal((await mint("quiet")).status, 200);
  } finally {
    gw.proc.kill();
  }
});

test("a rate-limited verify does not consume the one-time nonce it was holding", async () => {
  // Order matters: the limit is checked before the challenge is TAKEN, or a limited caller would
  // lose its nonce and have to mint another, which is the opposite of what a limit should cost.
  const oracle = join(dir, "rate-nonce.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  // A SHORT WINDOW, so the limit can be exhausted and then allowed to lapse inside a test. A first
  // version asserted only that the limited response's `reason` was not "unknown-or-expired-challenge",
  // which a 429 satisfies trivially because a 429 body carries no `reason` at all: the test passed
  // with the check moved AFTER take() and proved nothing. The nonce has to be USED afterwards.
  const gw = await startGateway({
    MNO_ORACLE_SOURCE: oracle,
    MNO_ORACLE_REFRESH: "3600",
    MNO_RATE_VERIFY_ACCOUNT: "1",
    MNO_RATE_WINDOW: "1",
  });
  try {
    const ch = await challenge(gw.base);
    // Spend the one allowed verify on a junk nonce, so the account's allowance is gone.
    await post(gw.base, "/v1/verify", { nonce: randomUUID(), proof: {}, publicSignals: signalsFor(ch), account: "alice" });
    const limited = await post(gw.base, "/v1/verify", {
      nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch), account: "alice",
    });
    assert.equal(limited.status, 429, "the second attempt is refused by the limit");

    // Let the window lapse, then USE the nonce. If the refusal had consumed it, this is 410.
    await delay(1300);
    const after = await post(gw.base, "/v1/verify", {
      nonce: ch.nonce, proof: {}, publicSignals: signalsFor(ch, { root: "999" }), account: "alice",
    });
    assert.equal(after.status, 200, "the nonce survived the refusal and reached the policy checks");
    assert.equal(after.body.reason, "stale-or-unknown-root", "reaching a POLICY refusal proves the nonce was live");
  } finally {
    gw.proc.kill();
  }
});

test("/v1/dml is rate limited like its sibling read endpoint", async () => {
  const oracle = join(dir, "rate-dml.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_RATE_DML: "2" });
  try {
    assert.equal((await fetch(gw.base + "/v1/dml")).status, 200);
    assert.equal((await fetch(gw.base + "/v1/dml")).status, 200);
    assert.equal((await fetch(gw.base + "/v1/dml")).status, 429, "the largest response this gateway serves is bounded");
  } finally {
    gw.proc.kill();
  }
});

test("health reports not-ready in single-tier mode when there is no DML root", async () => {
  // `ok` reported true whenever the clock was sane, so an oracle outage read as healthy while every
  // challenge returned 503 and a readiness probe kept sending users to an instance that could not
  // serve them.
  const oracle = join(dir, "health-none.json");
  await writeFile(oracle, JSON.stringify({ not: "a snapshot" }));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const h = await (await fetch(gw.base + "/v1/health")).json();
    assert.equal(h.dmlRoot, null, "no root was adopted");
    assert.equal(h.ok, false, "so the gateway is not ready");
    assert.equal(h.canChallenge, false);
    assert.equal(h.canVerify, false);
    const ch = await post(gw.base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(ch.status, 503, "and health agrees with what the endpoint actually does");
  } finally {
    gw.proc.kill();
  }
});

test("health reports ready once a root is adopted", async () => {
  const oracle = join(dir, "health-ok.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600" });
  try {
    const h = await (await fetch(gw.base + "/v1/health")).json();
    assert.equal(h.ok, true, "the guard has an exit ordinary operation reaches");
    assert.equal(h.canChallenge, true);
  } finally {
    gw.proc.kill();
  }
});

test("Platform nullifier mode refuses without a schedule assertion, and starts with one", async () => {
  // Both local durable stores refuse to open under a schedule they were not written with. The
  // Platform backend stores only (epoch, contextHash, nf) and the contract has no field that could
  // hold a schedule marker, so there is nothing to compare. Refusing beats shipping a check that
  // cannot check. Both branches are exercised: the refusal, and that the assertion gets PAST it
  // (this deployment then fails later on the absent Platform credentials, which is a DIFFERENT
  // error and is what proves the schedule guard is no longer the thing stopping it).
  const oracle = join(dir, "platform.json");
  await writeFile(oracle, JSON.stringify(snapshot()));
  const base = { MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_STORE: "platform" };

  let refused = null;
  try {
    const g = await startGateway(base);
    g.proc.kill();
    assert.fail("Platform mode must not start without the schedule assertion");
  } catch (err) {
    refused = String(err.message);
  }
  assert.match(refused, /refusing Platform nullifier mode|gateway exited early/);
  assert.match(refused, /MNO_PLATFORM_ASSUME_SCHEDULE/, "the refusal names the way out");

  let withAssertion = null;
  try {
    const g = await startGateway({ ...base, MNO_PLATFORM_ASSUME_SCHEDULE: "1" });
    g.proc.kill();
  } catch (err) {
    withAssertion = String(err.message);
  }
  assert.ok(withAssertion, "no Platform credentials here, so it still cannot start");
  assert.doesNotMatch(
    withAssertion,
    /refusing Platform nullifier mode/,
    "but the schedule guard is no longer what stops it, which is the exit this guard needs",
  );
});

test("two-tier health separates registration readiness from verification readiness", async () => {
  // The modes genuinely differ: a two-tier gateway can verify existing members from its season tree
  // while registration is unavailable because no DML root is adopted. One boolean cannot say that.
  const oracle = join(dir, "health-2t.json");
  await writeFile(oracle, JSON.stringify({ not: "a snapshot" }));
  const gw = await startGateway({ MNO_ORACLE_SOURCE: oracle, MNO_ORACLE_REFRESH: "3600", MNO_MODE: "two-tier" });
  try {
    const h = await (await fetch(gw.base + "/v1/health")).json();
    assert.equal(h.dmlRoot, null, "no DML root, so nobody can register");
    assert.equal(h.canRegister, false);
    assert.equal(h.canChallenge, true, "but existing members still have a members tree to prove against");
    assert.equal(h.ok, true);
  } finally {
    gw.proc.kill();
  }
});
