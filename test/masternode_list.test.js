import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import bs58check from "bs58check";
import { loadMasternodeList, UNCHECKED_LIST_WARNING } from "../prover/masternode_list.js";
import { buildSnapshot, leavesFromMasternodeList } from "../oracle/snapshot.js";
import { hash160ToAddress, leafFromPriv, wifToPriv } from "../common/dml.js";

// Found 2026-09-29. A registration took the masternode list from the gateway on trust, so whoever could
// rewrite that response could serve a partial list and learn from whether the prover went on to
// register whether the member's key was in it. --node-list builds the list from the member's own node.

const addr = (byte) => hash160ToAddress(Buffer.alloc(20, byte));
const outpoint = (n) => `${n.toString(16).padStart(64, "0")}-0`;
const LIST = {
  [outpoint(3)]: { status: "ENABLED", votingaddress: addr(3) },
  [outpoint(1)]: { status: "ENABLED", votingaddress: addr(1) },
  [outpoint(2)]: { status: "POSE_BANNED", votingaddress: addr(2) },
};

function withListFile(list, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mnlist-"));
  const path = join(dir, "mnlist.json");
  writeFileSync(path, JSON.stringify(list));
  return Promise.resolve(fn(path, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a node export gives exactly the leaves and root the oracle would sign for the same list", async () => {
  const snap = await buildSnapshot({
    call: async (m) => (m === "masternodelist" ? LIST : m === "getblockcount" ? 7 : "ab".repeat(32)),
    now: () => 1,
  });
  await withListFile(LIST, async (path) => {
    const got = await loadMasternodeList({ nodeListPath: path, get: () => assert.fail("the gateway must not be asked"), depth: 16 });
    assert.equal(got.source, "node");
    assert.deepEqual(got.leaves, snap.leaves, "same ordered leaves, banned node left out");
    assert.equal(got.root, snap.root, "and the same root, so the gateway can accept it");
  });
});

test("with a node export the gateway's list is never requested, however it is doctored", async () => {
  let asked = 0;
  await withListFile(LIST, async (path) => {
    const got = await loadMasternodeList({ nodeListPath: path, get: async () => (asked++, { leaves: ["1"], root: "1" }), depth: 16 });
    assert.equal(asked, 0);
    assert.notDeepEqual(got.leaves, ["1"]);
  });
});

test("contrary: without a node export the gateway's list is used, with a warning that it is unchecked", async () => {
  const warnings = [];
  const urls = [];
  const got = await loadMasternodeList({
    gateway: "https://gw.example",
    get: async (url) => (urls.push(url), { leaves: ["5"], root: "9" }),
    depth: 16,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(urls, ["https://gw.example/v1/dml"]);
  assert.deepEqual(got, { leaves: ["5"], root: "9", source: "gateway" });
  assert.deepEqual(warnings, [UNCHECKED_LIST_WARNING]);
});

test("a malformed node export is refused with the oracle's own validation", async () => {
  await withListFile({ "not-an-outpoint": { status: "ENABLED", votingaddress: addr(1) } }, async (path) => {
    await assert.rejects(loadMasternodeList({ nodeListPath: path, get: () => {}, depth: 16 }), /is not a txid-index outpoint/);
  });
  assert.throws(() => leavesFromMasternodeList([]), /an array/);
});

// Through the real CLI, against a stub gateway that records what it is asked. No proof is made: the
// voting key is absent from the list the prover uses, so it stops before proving, and which list it
// consulted shows in the requests and the message.
async function runRegister({ extraArgs, dmlLeavesFor }) {
  const seen = [];
  const wif = bs58check.encode(Buffer.concat([Buffer.from([0xcc]), randomBytes(32), Buffer.from([0x01])]));
  const leaf = leafFromPriv(wifToPriv(wif)).toString();
  const dmlLeaves = dmlLeavesFor(leaf);
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") return res.end(JSON.stringify({ season: 1, dmlRoot: "0" }));
    if (req.url === "/v1/dml") return res.end(JSON.stringify({ leaves: dmlLeaves, root: "0" }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "register-cli-"));
  try {
    writeFileSync(join(dir, "voting-key.txt"), wif + "\n", { mode: 0o600 });
    writeFileSync(join(dir, "mnlist.json"), JSON.stringify(LIST));
    const cli = fileURLToPath(new URL("../prover/two_tier.js", import.meta.url));
    const args = ["register", "--gateway", `http://127.0.0.1:${server.address().port}`, "--platform", "p", "--community", "c", "--role", "r", "--voting-key-file", "voting-key.txt", ...extraArgs];
    const out = await promisify(execFile)("node", [cli, ...args], { cwd: dir, timeout: 60_000 }).catch((e) => e);
    return { seen, code: out.code ?? 0, stderr: String(out.stderr ?? "") };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the register CLI with --node-list never requests /v1/dml and ignores a gateway list that holds the key", async () => {
  // The stub's /v1/dml holds the member's key, so a prover that consulted it would go on to prove.
  const run = await runRegister({ extraArgs: ["--node-list", "mnlist.json"], dmlLeavesFor: (leaf) => [leaf] });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /not in your node's masternode list/);
  assert.ok(!run.seen.includes("/v1/dml"), `requests: ${run.seen.join(", ")}`);
});

test("contrary: the register CLI without --node-list requests /v1/dml and warns that it is unchecked", async () => {
  const run = await runRegister({ extraArgs: [], dmlLeavesFor: () => ["1", "2"] });
  assert.equal(run.code, 1);
  assert.ok(run.seen.includes("/v1/dml"));
  assert.match(run.stderr, /using the gateway's masternode list without checking it/);
  assert.match(run.stderr, /not in the masternode list the gateway is using/);
});

test("a missing node export says how to make it, and how to go without", async () => {
  await assert.rejects(
    loadMasternodeList({ nodeListPath: join(tmpdir(), "no-such-mnlist-" + randomBytes(4).toString("hex") + ".json"), get: () => {}, depth: 16 }),
    /was not found\. Export your node's list with: dash-cli masternodelist json > .*leave --node-list out/,
  );
});
