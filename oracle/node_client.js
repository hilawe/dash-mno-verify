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
// WHY THE BUFFER LIMIT EXISTS, and what it is measured against. execFile defaults to 1 MB, which
// a mainnet response exceeds. The largest call this makes is `protx diff 1 <height>`, the whole list
// rather than a delta, MEASURED at 1,828,817 bytes (about 1.74 MiB) for 2,972 masternodes at height
// 2,515,929 on 2026-08-03. The 64 MiB default is therefore about 37x headroom rather than a guess.
//
// THE COMMAND-LINE PATH RUNS ASYNCHRONOUSLY. It used execFileSync, which blocks the entire event loop
// for the subprocess duration. In the gateway's direct-node mode the refresh timer issues these calls
// on the request-serving loop, so a slow or hung dash-cli froze every challenge and verify until it
// returned, up to the timeout. An internal assurance round reproduced that. execFile promisified keeps
// the same deadline (the timeout option) and the same buffer cap while yielding to the loop.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

// Build a `call(method, params)` for a node. With `rpcUrl` set it speaks JSON-RPC, otherwise it
// shells out to a local `dash-cli`. Everything is injectable so a test can drive both paths without
// a node, which is the whole reason the snapshot builders take a `call` rather than opening their
// own connection.
// Read a response body under a hard byte cap, counting RECEIVED BYTES rather than string units so a
// multibyte payload is measured correctly. Stops reading and destroys the stream the moment the cap is
// crossed, rather than discovering the size after buffering it.
async function readCapped(res, maxBytes, method) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`RPC ${method}: response exceeded the ${maxBytes} byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function makeNodeCall({
  rpcUrl = null,
  rpcUser = null,
  rpcPass = "",
  rpcHeader = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  fetchImpl = fetch,
  execImpl = execFileAsync,
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
    // BOUNDED THE SAME WAY THE COMMAND-LINE PATH IS. `maxBuffer` has capped the dash-cli path since it
    // was written, and the HTTP path had no equivalent: res.json() buffers and parses whatever the node
    // sends, so a buggy or hostile one could exhaust memory or block the event loop before a single DML
    // check ran. The refresh timer calls this, so it is reachable on an ordinary schedule.
    //
    // The declared length is checked first because it is free, and then the body is read in chunks so a
    // response that lies about its length, or omits one entirely, is cut off at the same bound rather
    // than being trusted. The stream is cancelled on the way out, since abandoning it leaves the
    // connection and its buffers open and a source that does this every refresh would accumulate them.
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBuffer) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`RPC ${method}: response declares ${declared} bytes, over the ${maxBuffer} cap`);
    }
    const text = await readCapped(res, maxBuffer, method);
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`RPC ${method}: response was not JSON`);
    }
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  async function cli(args) {
    const { stdout } = await execImpl("dash-cli", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer });
    // dash-cli prints a JSON value for object, array, number, and boolean results, but a BARE string for
    // a string result (getblockhash and getbestblockhash return the hash with no quotes), which is not
    // valid JSON. Parse when the output is JSON, and fall back to the trimmed raw string otherwise, so a
    // string result is returned as-is rather than throwing. This matches the RPC path, which returns the
    // JSON-RPC result value directly (a string stays a string there).
    const out = stdout.trim();
    // Empty output is a node error (a command that produced nothing), not a valid string result. Reject
    // it, so a real failure surfaces here rather than flowing on as a stable "" that the snapshot builder
    // would compare and carry. Every method the oracle calls returns a non-empty hash, number, or object.
    if (out === "") throw new Error(`dash-cli ${args[0] ?? ""} returned no output`);
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  }

  return (method, params = []) => (rpcUrl ? rpc(method, params) : cli([method, ...params.map(String)]));
}
