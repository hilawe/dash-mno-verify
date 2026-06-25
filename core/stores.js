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
}

// Load a published oracle snapshot from a URL or a local file.
export async function loadOracle(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`oracle fetch failed: ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}

// One masternode maps to one membership per epoch. A repeat nullifier is rejected.
export class NullifierStore {
  constructor() {
    this.spent = new Set();
  }
  #key(epoch, contextHash, nf) {
    return `${epoch}:${contextHash}:${nf}`;
  }
  has(epoch, contextHash, nf) {
    return this.spent.has(this.#key(epoch, contextHash, nf));
  }
  add(epoch, contextHash, nf) {
    this.spent.add(this.#key(epoch, contextHash, nf));
  }
}

// Pending challenges, keyed by the one-time nonce. A challenge ties a nonce to the
// account that requested it, so a proof made for one account cannot grant another.
export class ChallengeStore {
  constructor(ttlSeconds = 600) {
    this.ttl = ttlSeconds * 1000;
    this.pending = new Map();
  }
  put(nonce, value) {
    this.pending.set(nonce, { ...value, expires: Date.now() + this.ttl });
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
