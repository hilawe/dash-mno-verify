// Turn the live Dash deterministic masternode list into a Poseidon Merkle root.
//
// Source of truth is a real Dash node. Two ways to reach one:
//   - local dash-cli on PATH (the default), or
//   - a JSON-RPC endpoint via MNO_RPC_URL (your own dashd, or a provider like GetBlock).
//
// Auth for the RPC endpoint:
//   - MNO_RPC_USER and MNO_RPC_PASS  -> HTTP basic auth (a local dashd's rpcuser/rpcpassword)
//   - MNO_RPC_HEADER="x-api-key: ..." -> a custom header (hosted providers)
//
// The output is reproducible from public chain data, so anyone can recompute the root and
// catch a dishonest oracle. The oracle sees only public data, so it learns nothing private.
//
// The snapshot assembly itself (the consistent-tip read and the tree build) lives in
// oracle/snapshot.js behind an injectable call(), so it is unit-tested without a node.
//
// Usage: node oracle/oracle.js [--out oracle/root.json]
import { execFileSync } from "node:child_process";
import { open, rename, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";
import { createPrivateKey } from "node:crypto";
import { addSignature } from "../common/oracle_sig.js";
import { buildSnapshot } from "./snapshot.js";

const RPC_URL = process.env.MNO_RPC_URL; // set to use JSON-RPC; otherwise local dash-cli
// Neither call path had a deadline. A node that accepts the connection and never answers, or a
// dash-cli that blocks, left the oracle waiting forever, so it never republished, and the gateway
// eventually aged out its last accepted root and refused every verification. Failing the run is the
// better outcome: a supervisor retries it, and the gateway keeps serving the previous root meanwhile.
const CALL_TIMEOUT_MS = Number(process.env.MNO_RPC_TIMEOUT_MS ?? 30_000);
// The mainnet list is a few megabytes of JSON, comfortably past execFileSync's 1 MB default, which
// would fail the read on a full node rather than time out.
const CLI_MAX_BUFFER = Number(process.env.MNO_CLI_MAX_BUFFER ?? 64 * 1024 * 1024);

const { values } = parseArgs({
  options: { out: { type: "string", default: "oracle/root.json" } },
});

async function rpc(method, params = []) {
  const headers = { "content-type": "application/json" };
  if (process.env.MNO_RPC_USER) {
    const cred = `${process.env.MNO_RPC_USER}:${process.env.MNO_RPC_PASS ?? ""}`;
    headers.authorization = "Basic " + Buffer.from(cred).toString("base64");
  }
  if (process.env.MNO_RPC_HEADER) {
    const [k, ...v] = process.env.MNO_RPC_HEADER.split(":");
    headers[k.trim().toLowerCase()] = v.join(":").trim();
  }
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "mno-oracle", method, params }),
    // Covers a server that accepts the connection and then goes quiet, which no HTTP status can.
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC ${method} -> HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

function cli(args) {
  return JSON.parse(
    execFileSync("dash-cli", args, { encoding: "utf8", timeout: CALL_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER }),
  );
}

const call = (method, params) => (RPC_URL ? rpc(method, params) : cli([method, ...params.map(String)]));

const snapshot = await buildSnapshot({ call, log: (msg) => console.error(msg) });

// Sign the snapshot if a key is configured, so the gateway can authenticate the leaf set against a
// pinned oracle key rather than trusting whoever serves the JSON. MNO_ORACLE_SIGNING_KEY is a PKCS8
// PEM, inline or a file path. The signature covers the root, which commits to the leaves. An operator
// running a quorum signs the same snapshot with each oracle and merges the `sigs` entries.
const keyEnv = process.env.MNO_ORACLE_SIGNING_KEY;
if (keyEnv) {
  const pem = keyEnv.includes("BEGIN") ? keyEnv : await readFile(keyEnv, "utf8");
  snapshot.sigs = addSignature(snapshot, createPrivateKey(pem));
}

// Publish through a sibling and rename, the same discipline the grant ledger and the member secret
// already use. A plain in-place write truncates first, so a crash or power loss partway through left
// a half-written snapshot on disk. The gateway keeps serving its previous root, then refuses every
// verification once that root ages out, and no later run repairs the file unless the oracle happens
// to be rerun. Flush the file, rename it, then flush the directory entry that makes the rename
// visible, so the published snapshot is either the old one or the new one and never a torn one.
async function publish(target, body) {
  // Scoped to this process, so two oracles writing the same output cannot consume each other's
  // temporary. Plain "w" rather than an exclusive create: the only file that can be sitting at this
  // name is one THIS pid left behind on an earlier crashed run, and refusing to publish because of it
  // would need a manual cleanup for no gain.
  const tmp = `${target}.${process.pid}.tmp`;
  const fh = await open(tmp, "w", 0o644);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
  // Best effort, as elsewhere: not every filesystem can flush a directory handle, and refusing to
  // publish on that basis would be worse than the residual risk.
  let dir;
  try {
    dir = await open(dirname(target), "r");
    await dir.sync();
  } catch {
    // see above
  } finally {
    await dir?.close().catch(() => {});
  }
}

await publish(values.out, JSON.stringify(snapshot));
console.error(
  `[oracle] ${RPC_URL ? "rpc" : "dash-cli"} height ${snapshot.height}, ${snapshot.leaves.length} ENABLED nodes, ` +
    `root ${snapshot.root.slice(0, 12)}...${snapshot.sigs ? ` signed by ${snapshot.sigs[0].key}` : " (unsigned)"} -> ${values.out}`
);
