// Fetch a small JSON document a member submitted, with hard limits on size and time.
//
// The Discord and Telegram adapters used to call `(await fetch(url)).json()` on a member's uploaded
// proof.json (review finding F5, 2026-09-27). The gateway's own request-size limit cannot help there,
// because the bot has already downloaded and parsed the file before the gateway sees anything, and a
// platform's upload limit is far larger than a proof. A real proof.json is about 3 KB.
//
// So the declared length is checked first because it is free, and the body is then read in chunks
// and cut off at the same bound, since a server can omit or misstate its length. One deadline covers
// the whole fetch, headers and body, so a response that stalls cannot hold the bot. The reading
// mirrors oracle/node_client.js, which bounds a node's RPC replies the same way.
export const MAX_PROOF_BYTES = 64 * 1024;

export class SubmissionRefused extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.reason = reason; // "too-large" | "timeout" | "http-<status>" | "not-json"
  }
}

export async function fetchJsonCapped(url, { maxBytes = MAX_PROOF_BYTES, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw err?.name === "TimeoutError" ? new SubmissionRefused("timeout") : err;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SubmissionRefused(`http-${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SubmissionRefused("too-large", `declares ${declared} bytes, over the ${maxBytes} cap`);
  }
  const chunks = [];
  let total = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SubmissionRefused("too-large", `over the ${maxBytes} byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof SubmissionRefused) throw err;
    throw err?.name === "TimeoutError" || err?.name === "AbortError" ? new SubmissionRefused("timeout") : err;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SubmissionRefused("not-json");
  }
}
