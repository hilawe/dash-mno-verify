// In-memory stores for a single-gateway deployment.
//
// For a multi-gateway or durable setup, back the nullifier store with the Dash
// Platform contract in contract/mno-verify.contract.json. Its unique index on
// (epoch, contextHash, nf) makes Platform consensus itself reject a double spend,
// so several gateways can share one tamper-evident spent set. Implement the same
// has/add interface against Platform and pass it in instead of NullifierStore.
import { readFile } from "node:fs/promises";

// Recent-roots ring buffer. The gateway accepts any root the oracle published in the
// last `window` snapshots, which gives members a window to prove against a fresh root.
export class RootStore {
  constructor(window = 8) {
    this.window = window;
    this.roots = []; // sorted by height ascending, newest last; each { height, root, ts }
  }
  update(list) {
    const byHeight = new Map(this.roots.map((r) => [r.height, r]));
    for (const r of list) byHeight.set(r.height, r);
    this.roots = [...byHeight.values()]
      .sort((a, b) => a.height - b.height)
      .slice(-this.window);
  }
  current() {
    return this.roots.at(-1) ?? null;
  }
  isRecent(root) {
    return this.roots.some((r) => r.root === root);
  }
  // Drop every accepted root. Used to stop serving a root once its source has gone stale, so
  // current() and isRecent() both fall back to "no root" until a fresh one is accepted.
  clear() {
    this.roots = [];
  }
  // Drop every root whose own timestamp is older than the cutoff. The freshness bound has to apply
  // to each root the window will still accept, not only the newest, or a removed node could prove
  // against an aged-out root that newer snapshots kept in the window.
  dropOlderThan(cutoffTs) {
    this.roots = this.roots.filter((r) => Number(r.ts) >= cutoffTs);
  }
}

// Load a published oracle snapshot from a URL or a local file.
//
// A URL source is fetched over the network, so it is hardened against a hostile or unreachable
// source: plain http is refused for anything but loopback (a man-in-the-middle could otherwise swap
// the root), the fetch has a timeout so a hung source cannot stall the refresh loop, and the body
// is size-capped so a huge response cannot exhaust memory. The caller (the gateway) then recomputes
// the root from the leaves, which catches an inconsistent or corrupted snapshot. It does NOT
// authenticate the leaf set, so a compromised source can still publish a forged but self-consistent
// snapshot. Closing that needs signed or Platform-published roots (the leaf-authentication follow-up
// in TODO.md).
// Read a fetch response body, aborting once it crosses maxBytes. Streaming the read means the cap
// bounds memory even when the source omits or lies about content-length, or sends a compressed body
// that inflates past the declared size; res.text() would buffer the whole thing first.
async function readCapped(res, maxBytes, ctrl) {
  if (!res.body) {
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("oracle response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      ctrl.abort();
      throw new Error("oracle response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadOracle(source, { timeoutMs = 10_000, maxBytes = 16_000_000 } = {}) {
  if (/^https?:\/\//.test(source)) {
    const url = new URL(source);
    // URL keeps the brackets on an IPv6 host, so [::1] is reported as "[::1]", not "::1".
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback && process.env.MNO_ORACLE_ALLOW_HTTP !== "1") {
      throw new Error(
        "oracle URL must be https; set MNO_ORACLE_ALLOW_HTTP=1 only on a trusted private network",
      );
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(source, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`oracle fetch failed: ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("oracle response too large");
      const text = await readCapped(res, maxBytes, ctrl);
      return JSON.parse(text);
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`oracle fetch timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return JSON.parse(await readFile(source, "utf8"));
}

// Fixed-window per-client rate limiter for the unauthenticated endpoints. It does not stop a
// distributed flood (that needs the adapter-only authentication tracked as a P1 item), but it caps
// what one source can spend on minting nonces or driving PLONK verifies. Keys are swept on a timer;
// the key map is bounded so the limiter itself cannot be turned into the memory-exhaustion vector.
export class RateLimiter {
  constructor({ windowSeconds = 60, max = 60, maxKeys = 50_000 } = {}) {
    this.windowMs = windowSeconds * 1000;
    this.max = max;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> { count, reset }
  }
  allow(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now > e.reset) {
      if (!e && this.hits.size >= this.maxKeys) {
        this.sweep();
        if (this.hits.size >= this.maxKeys) return false; // table full of live windows, shed load
      }
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    return e.count <= this.max;
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (now > e.reset) this.hits.delete(k);
  }
}

// Nullifier (claim) store interface, shared with DocumentNullifierStore (core/platform_store.js) and
// enforced by test/nullifier_store_contract.test.js. The verifier depends on all three:
//   has(epoch, contextHash, nf)            -> boolean              whether the tag is spent
//   get(epoch, contextHash, nf)            -> { account } | null   the claim record, or null when a
//                                                                  store does not persist the account
//                                                                  (no idempotent re-grant there)
//   add(epoch, contextHash, nf, { account }) -> { duplicate }      record once, duplicate on a re-add
//
// One masternode maps to one membership per epoch and context. The store records the spent tag and,
// with it, the account that first claimed it. That account, and only that account, may re-verify and
// re-grant the same tag within the epoch if its adapter failed after the spend but before applying
// the grant (idempotent grants). A different account that hits the same tag is rejected, so one
// masternode still maps to one account per epoch and context. Keeping the spend and the account in
// one record is the point: there is no second store that could fall out of step with this one. The
// Platform-backed store (core/platform_store.js) shares the spent set across gateways; it does not
// yet persist the account, so re-grant is a memory-mode property for now (see its get()).
export class NullifierStore {
  constructor() {
    this.claims = new Map(); // `epoch:contextHash:nf` -> { account }
  }
  #key(epoch, contextHash, nf) {
    return `${epoch}:${contextHash}:${nf}`;
  }
  has(epoch, contextHash, nf) {
    return this.claims.has(this.#key(epoch, contextHash, nf));
  }
  // The claim record for a spent tag, or null. Carries the account that first claimed it.
  get(epoch, contextHash, nf) {
    return this.claims.get(this.#key(epoch, contextHash, nf)) ?? null;
  }
  add(epoch, contextHash, nf, record = {}) {
    const key = this.#key(epoch, contextHash, nf);
    if (this.claims.has(key)) return { duplicate: true };
    this.claims.set(key, { account: record.account });
    return { duplicate: false };
  }
}

// Pending challenges, keyed by the one-time nonce. A challenge ties a nonce to the
// account that requested it, so a proof made for one account cannot grant another.
export class ChallengeStore {
  constructor(ttlSeconds = 600, maxPending = 100_000) {
    this.ttl = ttlSeconds * 1000;
    this.maxPending = maxPending;
    this.pending = new Map();
  }
  // Returns false when the store is full, so the gateway can shed load rather than let the map grow
  // without bound. A full sweep of expired entries is tried first, so the cap only bites under a
  // genuine flood of live challenges, not a backlog of stale ones.
  put(nonce, value) {
    if (this.pending.size >= this.maxPending) {
      this.sweep();
      if (this.pending.size >= this.maxPending) return false;
    }
    this.pending.set(nonce, { ...value, expires: Date.now() + this.ttl });
    return true;
  }
  // One-time use: taking a challenge consumes it.
  take(nonce) {
    const v = this.pending.get(nonce);
    if (!v) return null;
    this.pending.delete(nonce);
    if (Date.now() > v.expires) return null;
    return v;
  }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now > v.expires) this.pending.delete(k);
  }
}
