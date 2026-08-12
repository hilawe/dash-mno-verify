import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeGatewayUrl } from "../common/gateway_url.js";

// The rejection cases pass { allowHttp: false } explicitly so they hold regardless of an ambient
// MNO_GATEWAY_ALLOW_HTTP in the runner's environment, which would otherwise flip them to allowed.
test("a remote http gateway is refused, since the request travels on it in the clear", () => {
  assert.throws(() => assertSafeGatewayUrl("http://gateway.example.com:8787", { allowHttp: false }), /must be https/);
});

test("a remote https gateway is allowed", () => {
  assert.equal(
    assertSafeGatewayUrl("https://gateway.example.com"),
    "https://gateway.example.com",
    "the url is returned unchanged when allowed",
  );
});

test("loopback http is allowed, since it never leaves the host", () => {
  for (const u of [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]) {
    assert.equal(assertSafeGatewayUrl(u), u, `${u} should be allowed`);
  }
});

test("a non-loopback IP over http is refused (localhost is the host name, not any private IP)", () => {
  assert.throws(() => assertSafeGatewayUrl("http://192.168.1.10:8787", { allowHttp: false }), /must be https/);
});

test("the explicit opt-in allows remote http for a trusted private network", () => {
  assert.equal(
    assertSafeGatewayUrl("http://gateway.internal:8787", { allowHttp: true }),
    "http://gateway.internal:8787",
  );
});

test("the opt-in reads MNO_GATEWAY_ALLOW_HTTP when the option is not passed", () => {
  const prev = process.env.MNO_GATEWAY_ALLOW_HTTP;
  try {
    process.env.MNO_GATEWAY_ALLOW_HTTP = "1";
    assert.equal(assertSafeGatewayUrl("http://gateway.internal:8787"), "http://gateway.internal:8787");
    process.env.MNO_GATEWAY_ALLOW_HTTP = "0";
    assert.throws(() => assertSafeGatewayUrl("http://gateway.internal:8787"), /must be https/);
  } finally {
    if (prev === undefined) delete process.env.MNO_GATEWAY_ALLOW_HTTP;
    else process.env.MNO_GATEWAY_ALLOW_HTTP = prev;
  }
});

test("a non-http(s) scheme is refused outright", () => {
  assert.throws(() => assertSafeGatewayUrl("ftp://gateway.example.com"), /must be http or https/);
});

test("a malformed url is refused with a clear message", () => {
  assert.throws(() => assertSafeGatewayUrl("not a url"), /not a valid URL/);
});
