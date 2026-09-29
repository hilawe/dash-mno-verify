import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeGatewayUrl, memberGatewayUrl } from "../common/gateway_url.js";
import { memberGuideUrl, DEFAULT_MEMBER_GUIDE_URL } from "../common/prover_instructions.js";

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

// The Discord pilot (2026-09-29). An adapter on the gateway's host reaches it on loopback, and the
// instructions it printed told every member to connect to their own computer.
test("the member-facing gateway is never a loopback address", () => {
  for (const lo of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
    assert.equal(memberGatewayUrl(lo, {}), null, lo);
  }
  assert.equal(memberGatewayUrl("https://gw.example.org", {}), "https://gw.example.org", "a public adapter address is shared");
});

test("MNO_MEMBER_GATEWAY_URL names the member-facing gateway and passes the same guard", () => {
  assert.equal(memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: "https://verify.example.org" }), "https://verify.example.org");
  assert.throws(() => memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: "http://verify.example.org" }), /must be https/);
  assert.equal(
    memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: "http://gw.internal", MNO_GATEWAY_ALLOW_HTTP: "1" }),
    "http://gw.internal",
    "the plaintext opt-out applies here too",
  );
  assert.throws(() => memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: "not a url" }), /not a valid URL/);
  assert.equal(memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: "" }), null, "an empty value is unset");
});

test("the setup guide link defaults to the repository guide, can be overridden or turned off, and must be https", () => {
  assert.equal(memberGuideUrl({}), DEFAULT_MEMBER_GUIDE_URL);
  assert.match(DEFAULT_MEMBER_GUIDE_URL, /^https:\/\/github\.com\/.+\/docs\/MEMBER_GUIDE\.md$/);
  assert.equal(memberGuideUrl({ MNO_MEMBER_GUIDE_URL: "https://example.org/guide" }), "https://example.org/guide");
  assert.equal(memberGuideUrl({ MNO_MEMBER_GUIDE_URL: "" }), null);
  assert.throws(() => memberGuideUrl({ MNO_MEMBER_GUIDE_URL: "http://example.org/guide" }), /must be https/);
  assert.throws(() => memberGuideUrl({ MNO_MEMBER_GUIDE_URL: "nope" }), /not a valid URL/);
});

test("an overlong member gateway address or guide link is refused at start rather than breaking the messages", () => {
  const long = "https://" + "a".repeat(260) + ".example.org";
  assert.throws(() => memberGatewayUrl("http://127.0.0.1:8787", { MNO_MEMBER_GATEWAY_URL: long }), /over the 256/);
  assert.equal(memberGatewayUrl(long, {}), null, "an overlong adapter address is not printed either");
  assert.throws(() => memberGuideUrl({ MNO_MEMBER_GUIDE_URL: long }), /over the 256/);
});
