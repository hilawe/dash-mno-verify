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
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && !allowHttp) {
    throw new Error(
      "gateway URL must be https for a remote host; the request travels on it in the clear (for an " +
        "adapter, that includes the bearer secret and the platform account). Set " +
        "MNO_GATEWAY_ALLOW_HTTP=1 only on a trusted private network.",
    );
  }
  return source;
}

// URL keeps the brackets on an IPv6 host, so [::1] is reported as "[::1]", not "::1".
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// The gateway address a MEMBER's prover connects to, which is what the instructions an adapter shows
// must name. It is often not the address the adapter itself uses. An adapter on the gateway's own host
// reaches it on loopback, and printing that address told every member to connect to their own
// computer, where no gateway runs (found in the Discord pilot, 2026-09-29). MNO_MEMBER_GATEWAY_URL
// names the member-facing address explicitly and passes the same guard as any gateway URL. Without it,
// a non-loopback adapter address is taken to be reachable by members too, and a loopback one gives
// null, so the adapter shows a placeholder rather than an address that cannot work.
// Capped in length because it is printed twice into every member's instructions, and an address of a
// couple of thousand characters pushed them past Telegram's 4,096 and a Discord section past 2,000.
export const MAX_MEMBER_URL = 256;

export function memberGatewayUrl(adapterGateway, env = process.env) {
  const explicit = env.MNO_MEMBER_GATEWAY_URL;
  if (explicit !== undefined && explicit !== "") {
    if (explicit.length > MAX_MEMBER_URL) {
      throw new Error(`MNO_MEMBER_GATEWAY_URL is ${explicit.length} characters, over the ${MAX_MEMBER_URL} the member instructions allow`);
    }
    return assertSafeGatewayUrl(explicit, { allowHttp: env.MNO_GATEWAY_ALLOW_HTTP === "1" });
  }
  if (adapterGateway.length > MAX_MEMBER_URL) return null;
  return isLoopbackHost(new URL(adapterGateway).hostname) ? null : adapterGateway;
}
