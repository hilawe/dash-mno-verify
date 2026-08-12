// Guard for the gateway URL an adapter or prover connects to. A remote plaintext http:// gateway puts
// the request and its response on the wire in the clear, which for an adapter includes the bearer
// secret and the platform account it vouches for, and for any caller includes the request contents.
// This mirrors the oracle-URL guard in core/stores.js: https is required for a remote host, loopback is
// exempt (the common single-host deployment), and MNO_GATEWAY_ALLOW_HTTP=1 is the explicit opt-out for
// a trusted private network. Returns the url unchanged when it is allowed.
export function assertSafeGatewayUrl(source, { allowHttp = process.env.MNO_GATEWAY_ALLOW_HTTP === "1" } = {}) {
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`gateway URL is not a valid URL: ${JSON.stringify(source)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`gateway URL must be http or https, got ${JSON.stringify(url.protocol)}`);
  }
  // URL keeps the brackets on an IPv6 host, so [::1] is reported as "[::1]", not "::1".
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback && !allowHttp) {
    throw new Error(
      "gateway URL must be https for a remote host; the request travels on it in the clear (for an " +
        "adapter, that includes the bearer secret and the platform account). Set " +
        "MNO_GATEWAY_ALLOW_HTTP=1 only on a trusted private network.",
    );
  }
  return source;
}
