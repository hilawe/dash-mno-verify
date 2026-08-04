// A caller for a Dash Core node, over JSON-RPC or the local `dash-cli`, shared by the oracle CLI and
// by the gateway's direct node mode.
//
// It was inline in oracle/oracle.js while only the CLI talked to a node. Direct node mode gives the
// GATEWAY a node to read from, and two copies of a client whose timeouts and buffer limits are
// load-bearing is how the two drift: the CLI already carries a 30 second deadline and a 64 MiB
// buffer, both of which exist because of specific failures, and a second hand-rolled copy would not.
//
// WHY THE DEADLINE EXISTS. Neither call path had one. A node that accepts the connection and never
// answers, or a dash-cli that blocks, left the caller waiting forever. For the oracle that meant it
// never republished and the gateway aged out its last root and refused every verification. Failing
// the call is the better outcome: the caller retries, and meanwhile the gateway keeps serving what
// it already has.
//
// WHY THE BUFFER LIMIT EXISTS, and what it is measured against. execFileSync defaults to 1 MB, which
// a mainnet response exceeds. The largest call this makes is `protx diff 1 <height>`, the whole list
// rather than a delta, MEASURED at 1,828,817 bytes (about 1.74 MiB) for 2,972 masternodes at height
// 2,515,929 on 2026-08-03. The 64 MiB default is therefore about 37x headroom rather than a guess.
import { execFileSync } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

// Build a `call(method, params)` for a node. With `rpcUrl` set it speaks JSON-RPC, otherwise it
// shells out to a local `dash-cli`. Everything is injectable so a test can drive both paths without
// a node, which is the whole reason the snapshot builders take a `call` rather than opening their
// own connection.
export function makeNodeCall({
  rpcUrl = null,
  rpcUser = null,
  rpcPass = "",
  rpcHeader = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  fetchImpl = fetch,
  execImpl = execFileSync,
} = {}) {
  async function rpc(method, params = []) {
    const headers = { "content-type": "application/json" };
    if (rpcUser) {
      headers.authorization = "Basic " + Buffer.from(`${rpcUser}:${rpcPass ?? ""}`).toString("base64");
    }
    if (rpcHeader) {
      const [k, ...v] = String(rpcHeader).split(":");
      headers[k.trim().toLowerCase()] = v.join(":").trim();
    }
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: "mno-oracle", method, params }),
      // Covers a server that accepts the connection and then goes quiet, which no HTTP status can.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`RPC ${method} -> HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  function cli(args) {
    return JSON.parse(execImpl("dash-cli", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer }));
  }

  return (method, params = []) => (rpcUrl ? rpc(method, params) : cli([method, ...params.map(String)]));
}
