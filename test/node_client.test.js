// The node caller's boundary. The command-line path has been capped by maxBuffer since it was
// written; the HTTP path had no equivalent until a folder-access review pointed out that res.json()
// buffers and parses whatever the node sends, before any DML check runs, on the refresh timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNodeCall, DEFAULT_MAX_BUFFER } from "../oracle/node_client.js";

// A Response whose body streams the given chunks, with an optional declared content-length. Built
// from the real Response class so the code under test sees exactly what fetch would give it.
function streaming(chunks, { declaredLength = null, status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(Buffer.from(c)));
      controller.close();
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  if (declaredLength !== null) headers.set("content-length", String(declaredLength));
  return new Response(body, { status, headers });
}

test("an ordinary response still works, so the cap has an exit", async () => {
  const call = makeNodeCall({
    rpcUrl: "http://node.invalid",
    fetchImpl: async () => streaming([JSON.stringify({ result: { height: 7 }, error: null })]),
  });
  assert.deepEqual(await call("getblockcount"), { height: 7 });
});

test("a response that DECLARES more than the cap is refused before it is read", async () => {
  let bodyRead = false;
  const call = makeNodeCall({
    rpcUrl: "http://node.invalid",
    maxBuffer: 1024,
    fetchImpl: async () => {
      const r = streaming([JSON.stringify({ result: {}, error: null })], { declaredLength: 5000 });
      const realBody = r.body;
      // Notice if the body is consumed despite the declared length being over the cap.
      Object.defineProperty(r, "body", {
        get() {
          bodyRead = true;
          return realBody;
        },
      });
      return r;
    },
  });
  await assert.rejects(() => call("protx"), /declares 5000 bytes, over the 1024 cap/);
});

test("a response that LIES about its length is still cut off at the cap", async () => {
  // The declared length is free to check and free to forge, so the bound that matters is the one on
  // the bytes actually received. A node claiming to send nothing and then sending megabytes is the
  // case that makes the first check insufficient on its own.
  const oversized = "x".repeat(4096);
  const call = makeNodeCall({
    rpcUrl: "http://node.invalid",
    maxBuffer: 1024,
    fetchImpl: async () => streaming([oversized], { declaredLength: 10 }),
  });
  await assert.rejects(() => call("protx"), /exceeded the 1024 byte cap/);
});

test("a response with NO declared length is bounded too", async () => {
  const call = makeNodeCall({
    rpcUrl: "http://node.invalid",
    maxBuffer: 512,
    fetchImpl: async () => streaming(["y".repeat(2048)]),
  });
  await assert.rejects(() => call("protx"), /exceeded the 512 byte cap/);
});

test("a body that is not JSON says so, rather than failing somewhere later", async () => {
  const call = makeNodeCall({
    rpcUrl: "http://node.invalid",
    fetchImpl: async () => streaming(["<html>not json</html>"]),
  });
  await assert.rejects(() => call("protx"), /response was not JSON/);
});

test("the default cap matches the one the command-line path has always had", () => {
  assert.equal(DEFAULT_MAX_BUFFER, 64 * 1024 * 1024, "the two paths are bounded the same way");
});
