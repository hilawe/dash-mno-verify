// In-memory stores for a single-gateway deployment.
//
// For a multi-gateway or durable setup, back the nullifier store with the Dash
// Platform contract in contract/mno-verify.contract.json. Its unique index on
// (epoch, contextHash, nf) makes Platform consensus itself reject a double spend,
// so several gateways can share one tamper-evident spent set. Implement the same
// has/add interface against Platform and pass it in instead of NullifierStore.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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

// One window over adopted DML snapshots, holding BOTH roots per snapshot in a single record, so the
// Poseidon and SHA-256 root views are structurally in lockstep: they share one ring buffer, so
// eviction (the window bound) and aging (dropOlderThan) drop a snapshot's two roots together, and a
// zkVM root check can never see a snapshot the Poseidon check does not, or outlive it. This replaces
// two independent RootStore instances, which could drift when a v2 snapshot was followed by v1 (the
// Poseidon entry advanced while a stale SHA-256 entry lingered past its partner's eviction).
//
// A v1 snapshot carries no shaRoot, so its record has shaRoot: null and the SHA-256 view never
// matches it. isRecent(root) is the Poseidon view (a drop-in for the old RootStore, so the existing
// membership and registration callers are unchanged), and shaIsRecent(shaRoot) is the SHA-256 view.
// An ORDER-INDEPENDENT commitment to a leaf multiset.
//
// This is what makes accepting two roots at one height safe rather than merely convenient. The
// transition claim is that a v2 and a v3 root over the same masternodes commit to the SAME leaf set
// and differ only in build order. That was an assumption, and a reviewer pointed out the window
// stored nothing that could check it: a member present only in a stale, orphaned, or inconsistent set
// could keep proving after the canonical root was adopted.
//
// Sorted so ordering cannot change it, and DUPLICATES ARE PRESERVED, because two masternodes sharing
// a voting key are two members of the set and collapsing them would let a set with a duplicate match
// one without it. Computed by the gateway from the leaves it already recomputes both roots from, so
// it is derived rather than supplied and a source cannot choose it.
export function leafSetCommitment(leaves) {
  const sorted = [...(leaves ?? [])].map(String).sort((a, b) => (a === b ? 0 : a.length === b.length ? (a < b ? -1 : 1) : a.length - b.length));
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

// The only shape a window record retains. Built field by field rather than by deleting the ones we
// dislike, so a property nobody anticipated cannot ride along: an allowlist stays correct when the
// snapshot schema grows, a denylist silently stops being.
//
// It lives here, beside the window that holds the result, rather than in the gateway, because the
// gateway module starts a server when imported and a pure function nobody can import without
// booting a server is a pure function nobody can unit-test. That was not a style preference: the
// regression this prevents (a hostile host padding a validly signed snapshot, measured at 157 MB
// retained across eight records) had two tests that BOTH passed when the normalization was removed,
// because one inspected an HTTP response the handler rebuilds field by field anyway and the other
// fed an already-normalized object straight into the store.
// The exact key set a window record's snapshot may carry. Enumerated so the store can ENFORCE it
// rather than trusting its caller to have normalized, which is what turns this from a convention
// into an invariant.
export const SNAPSHOT_FIELDS = ["version", "height", "blockHash", "depth", "ts", "root", "shaRoot", "leaves"];

export function normalizeSnapshot(o, defaultDepth) {
  return {
    version: o?.version == null ? 1 : o.version,
    height: o.height,
    blockHash: o.blockHash ?? null,
    depth: o.depth ?? defaultDepth,
    ts: o.ts,
    root: String(o.root),
    shaRoot: o.shaRoot ?? null,
    // Copied, not aliased, so nothing downstream can mutate the array the window is holding.
    leaves: [...o.leaves],
  };
}

// The orderings this build understands, and therefore the entire key space of the window.
//
// The bound on records per height is a property of THIS SET, not of a counter. The gateway derives
// the key from the validated snapshot version so only these can arrive, and the assertion below makes
// that a first-run crash rather than a slow leak if a future caller ever passes something else. The
// vector it closes is real and was reproduced: with an attacker-chosen key, one height held a
// thousand records.
const KNOWN_ORDERS = new Set([null, "proRegTxHash"]);

export class RootWindows {
  // `maxLeaves` bounds the TOTAL leaf elements retained across every record, 0 meaning no bound.
  //
  // WHY A SECOND BOUND EXISTS AT ALL. The window's memory was already finite, but only as the product
  // of two limits that know nothing about each other: the height window (8) times the orderings that
  // may coexist (2) times whatever validateSnapshot lets a snapshot carry (2**treeDepth, 65,536).
  // Measured, with a fresh parse per record as the gateway does: 3.1 MiB for 16 records at the live
  // mainnet size of 2,972 leaves, and 64.7 MiB for 16 records at full tree capacity. Nothing is
  // leaking and no attacker chooses those numbers, which is exactly why it went unbounded in the
  // stated sense for so long. This turns the worst case into ONE number an operator sets rather than
  // a figure that has to be recomputed from three unrelated places whenever one of them changes.
  constructor(window = 8, { maxLeaves = 0 } = {}) {
    this.window = window;
    this.maxLeaves = maxLeaves;
    this.snaps = []; // sorted by height ascending, newest last; each { height, root, shaRoot, ts }
  }
  // Adopt one snapshot, keyed by height AND leaf order.
  //
  // THE TRANSITION WINDOW. The leaf order changed with the block-bound read: v2 snapshots order by the
  // collateral outpoint, v3 by proRegTxHash, so the same set of masternodes produces two different
  // roots. Keying on height alone meant a v3 snapshot REPLACED the v2 one at that height, and every
  // prover still holding a v2 tree was locked out the moment the oracle switched, with no way to
  // re-prove until they rebuilt.
  //
  // Both orders now coexist for as long as both are in the window. That is safe rather than a
  // loosening: the two roots commit to the SAME leaf set, differing only in the order the tree was
  // built, so a member proving against either proves membership in the same set. Nothing else about
  // the check changes, and the transition is bounded by the ordinary window and age rules, so a v2
  // root ages out on its own once the oracle stops publishing them. There is no separate switch to
  // remember to turn off.
  // `snapshot` is the whole verified snapshot object, carried in the SAME record as its roots, so
  // one record's root and its leaves are adopted, aged, and evicted together. That is a
  // SAME-INSTANT guarantee about one record, not a promise across requests: a caller that reads the
  // root and then reads the leaves in a later request can straddle a refresh and see two different
  // records. What it removes is the split that existed WITHIN one instant, when the served snapshot
  // and the window were separate variables aged by separate rules and a record whose timestamp was
  // older than another's cleared the snapshot while leaving a root current, so the gateway
  // advertised a root whose leaves it would not hand out.
  adopt({ height, root, shaRoot = null, ts, order = null, blockHash = null, setCommitment = null, snapshot = null }) {
    // THE STORE REFUSES AN UN-NORMALIZED SNAPSHOT, rather than trusting the caller to have passed
    // one. Three reviewers judged the previous arrangement, a test that grepped the call site for a
    // normalizeSnapshot() call, to be a stopgap rather than an invariant, and they were right: it
    // broke on reformatting, and it could not notice the call being present while a different object
    // reached this method. Enforcing here catches every route in, including ones nobody has written
    // yet, and it is the same stance the unknown-ordering throw below takes. The regression it
    // pins is a hostile host padding a validly signed snapshot, measured at 157 MB retained.
    if (snapshot != null) {
      for (const k of Object.keys(snapshot)) {
        if (!SNAPSHOT_FIELDS.includes(k)) {
          throw new Error(
            `RootWindows: snapshot carries the unexpected field ${JSON.stringify(k)}. A record holds ` +
              `only ${SNAPSHOT_FIELDS.join(", ")}, so anything else is an un-normalized object and ` +
              `would be retained at every height, unauthenticated and unbounded.`,
          );
        }
      }
    }
    // Executable invariant, not a comment. An unknown ordering means the key space is no longer
    // bounded by the version enumeration, which is the only thing bounding records per height.
    if (!KNOWN_ORDERS.has(order ?? null)) {
      throw new Error(
        `RootWindows: unknown leaf ordering ${JSON.stringify(order)}. The window's key space is the ` +
          `set of orderings this build knows, and that is what bounds records at one height.`,
      );
    }
    const key = `${height}|${order ?? "legacy"}`;
    const byKey = new Map(this.snaps.map((s) => [`${s.height}|${s.order ?? "legacy"}`, s]));
    // Re-adoption must move the record to the end, not update it in place. Map.set on an existing
    // key keeps its old position, and the height sort below is stable, so an in-place update left
    // current() returning whichever record at the top height happened to be adopted first, not
    // last. The delete makes insertion order equal adoption order, which is what current() reads.
    byKey.delete(key);
    byKey.set(key, {
      height,
      root,
      shaRoot: shaRoot ?? null,
      ts,
      order: order ?? null,
      blockHash: blockHash ?? null,
      setCommitment: setCommitment ?? null,
      snapshot: snapshot ?? null,
    });
    // The window counts HEIGHTS, not records, so running two orders during a changeover does not
    // silently halve how far back the gateway will accept a proof.
    const all = [...byKey.values()].sort((a, b) => a.height - b.height);
    const keptHeights = new Set([...new Set(all.map((s) => s.height))].slice(-this.window));
    this.snaps = all.filter((s) => keptHeights.has(s.height));
    this.#enforceLeafBound();
  }

  // Total leaf elements the window is holding, the quantity the bound is on.
  retainedLeaves() {
    let total = 0;
    for (const s of this.snaps) total += s.snapshot?.leaves?.length ?? 0;
    return total;
  }

  // Drop the OLDEST HEIGHTS, whole, until the retained leaves fit the bound.
  //
  // BY HEIGHT, NOT BY RECORD, which is the same granularity the window trim above uses and for the
  // same reason. A first version of this shifted single records off the front, and during a
  // changeover the front record at the oldest height is the ordering adopted FIRST, so the bound
  // retained the v3 record at that height and evicted its v2 sibling. Reproduced: a prover holding
  // the v2 tree was locked out at a height whose v3 root was still accepted, which is exactly the
  // outcome the coexistence design exists to prevent, and worse, a republished pair made the two
  // roots alternate in and out of acceptance on every refresh tick. The two records describe one
  // block and one leaf multiset, so they leave together or not at all.
  //
  // WHOLE RECORDS rather than just their leaves, because a record's root and its leaves are one
  // thing. Discarding only the leaves of older records is the tempting version, since just
  // current().snapshot is ever served, but current() is the last element and dropOlderThan can
  // remove the newest record (timestamp order is not height order), which makes an older record
  // current. One that became current with its leaves already discarded would advertise a root whose
  // leaves /v1/dml cannot serve, precisely the same-instant split this record design prevents.
  //
  // THE LAST HEIGHT IS NEVER DROPPED, even when its records alone exceed the bound. A window that
  // refused to retain the snapshot it is currently serving would be a guard with no exit reached by
  // ordinary operation: the root would be current with no leaves behind it. The bound governs how
  // much HISTORY is kept, not whether the present is kept.
  #enforceLeafBound() {
    if (!(this.maxLeaves > 0)) return;
    // A loop rather than one pass: a snapshot larger than the ones already held (the list grows, or
    // a re-adoption replaces a small snapshot with a large one at the same key) can put the window
    // several heights over at once.
    while (this.retainedLeaves() > this.maxLeaves) {
      const heights = [...new Set(this.snaps.map((s) => s.height))];
      if (heights.length <= 1) break;
      const oldest = heights[0]; // the array is height-ascending, so this is the oldest height
      this.snaps = this.snaps.filter((s) => s.height !== oldest);
    }
  }
  // The newest snapshot. With two orders at one height during a changeover, the LAST adopted wins,
  // which is the one the oracle is publishing now. That tie-break holds because adopt() re-inserts
  // on re-adoption (insertion order is adoption order) and the height sort is stable. It is pinned
  // by a test rather than a runtime assertion, because the store would have to carry a sequence
  // number purely to assert what the insertion order already encodes.
  current() {
    return this.snaps.at(-1) ?? null;
  }
  // The highest height any retained record describes, which is the adoption floor for a new
  // snapshot. This is deliberately NOT current().height: current() is the last ADOPTED record and a
  // coexisting pair can make those differ. A rollback check keyed on the last adopted record could
  // be skipped entirely whenever that record aged out while a higher one survived, so the floor is
  // asked of the whole window rather than of one pointer into it.
  maxHeight() {
    return this.snaps.length === 0 ? null : Math.max(...this.snaps.map((s) => Number(s.height)));
  }
  // Whether `root` is accepted AND, when maxAgeSeconds is positive, no older than that. One place,
  // so the registration anchor rule is a property of the window rather than a predicate rebuilt at
  // each call site, and so it can be unit-tested directly instead of only through a stubbed
  // predicate. A root the window does not hold has no timestamp and is refused, which is the same
  // answer isRecent would give.
  isEligibleWithin(root, maxAgeSeconds, now) {
    if (!this.isRecent(root)) return false;
    if (!(maxAgeSeconds > 0)) return true;
    const ts = this.tsOf(root);
    if (ts == null) return false;
    // A future-dated record reads as age zero rather than as a negative age. That does NOT make a
    // future stamp free: such a root stays eligible until wall time reaches its timestamp and then
    // gets the full allowance from there, so the real window is the bound PLUS however far ahead it
    // was stamped. What keeps that finite is the separate future-skew bound applied at adoption
    // (oracleFutureSkewSeconds); this clamp only stops a negative age from being compared.
    const age = Math.max(0, now - ts);
    return age <= maxAgeSeconds;
  }
  // The oracle timestamp of the record holding this root, or null if the window does not hold it.
  // Registration needs the AGE of the root it is anchored to, not merely whether it is still
  // accepted: membership lasts one epoch, so a stale-but-windowed root there costs an epoch, while a
  // registration turns the same staleness into the remainder of the current season.
  // The NEWEST timestamp among the records holding this root, not the first one found. One root can
  // legitimately sit at several heights: the root is derived from the leaf set alone, so an
  // unchanged masternode list across two oracle reads produces the same root at two heights, which
  // is ordinary rather than exceptional. Taking the first match (the lowest height, since the window
  // is height-sorted) meant judging a root the oracle republished seconds ago by the timestamp of
  // its oldest appearance, so a stable network would start refusing registrations once that first
  // appearance passed the age bound. That is a guard with no exit reached by ordinary operation.
  tsOf(root) {
    let newest = null;
    for (const s of this.snaps) {
      if (s.root !== root) continue;
      const ts = Number(s.ts);
      if (!Number.isFinite(ts)) continue;
      if (newest == null || ts > newest) newest = ts;
    }
    return newest;
  }
  // Poseidon view. Named isRecent so a RootWindows is a drop-in for the old dmlRoots RootStore.
  isRecent(root) {
    return this.snaps.some((s) => s.root === root);
  }
  // SHA-256 view. A null shaRoot (a v1 snapshot) never matches.
  shaIsRecent(shaRoot) {
    return this.snaps.some((s) => s.shaRoot != null && s.shaRoot === shaRoot);
  }
  // The SHA-256 view as a rootStore for the zkVM registration verify: { isRecent }.
  shaView() {
    return { isRecent: (r) => this.shaIsRecent(r) };
  }
  // Whether a snapshot may join, or refresh, a height already held. The answer is yes ONLY when it
  // describes the same block and commits to the same leaf multiset as every record at that height.
  // A different ordering of that multiset is the changeover pair coexisting, and the SAME ordering
  // is a freshness renewal or an equivalent-set replacement at its own key. Either way the member
  // set a proof is checked against is identical, which is the transition claim, checked rather
  // than assumed.
  //
  // An earlier version also demanded that the ORDERS differ, which read as tighter and wedged the
  // changeover instead: once the newer order was the last adopted, even an identical republish of
  // the older order was refused, so the older root's freshness could never renew while the oracle
  // still published it, and it aged out while actively published, stranding its provers.
  //
  // A null block hash or commitment on either side means the question cannot be answered, so the
  // answer is no. That is asymmetric on purpose: a v1 record (no block hash in its schema) at a
  // height answers no for that height until it ages out, which errs closed.
  mayCoexist({ height, blockHash = null, setCommitment = null }) {
    const atHeight = this.snaps.filter((s) => s.height === height);
    if (atHeight.length === 0) return true; // nothing to disagree with
    return atHeight.every(
      (s) =>
        s.blockHash != null &&
        blockHash != null &&
        String(s.blockHash) === String(blockHash) &&
        s.setCommitment != null &&
        setCommitment != null &&
        String(s.setCommitment) === String(setCommitment),
    );
  }

  clear() {
    this.snaps = [];
  }
  dropOlderThan(cutoffTs) {
    this.snaps = this.snaps.filter((s) => Number(s.ts) >= cutoffTs);
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

// `allowHttp` is the plain-HTTP exception, passed in rather than read from the environment here.
// Reading process.env directly made this the one security-bearing setting a caller's configuration
// could not control: a gateway built for a synthetic environment would still see an ambient
// MNO_ORACLE_ALLOW_HTTP and downgrade its transport. The environment remains the default, so the
// setting behaves exactly as before for a caller that passes nothing.
export async function loadOracle(
  source,
  { timeoutMs = 10_000, maxBytes = 16_000_000, allowHttp = process.env.MNO_ORACLE_ALLOW_HTTP === "1" } = {},
) {
  if (/^https?:\/\//.test(source)) {
    const url = new URL(source);
    // URL keeps the brackets on an IPv6 host, so [::1] is reported as "[::1]", not "::1".
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
    if (url.protocol === "http:" && !loopback && !allowHttp) {
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
      if (declared > maxBytes) {
        // Cancel before throwing. Abandoning the body leaves the connection and its buffers open,
        // and a source declaring an oversized length on every refresh would accumulate them.
        ctrl.abort();
        await res.body?.cancel().catch(() => {});
        throw new Error("oracle response too large");
      }
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
        // EVICT THE OLDEST, DO NOT REFUSE THE NEWEST. This used to return false once the table was
        // full of live windows, which reads as prudent load-shedding and is in fact a global
        // lockout: the keys include caller-supplied strings, so anyone able to invent 50,000 of them
        // inside one window turns the limiter into a machine that denies EVERY caller it has not
        // seen before, which is the outcome a rate limiter exists to prevent.
        //
        // Evicting instead degrades accuracy rather than availability. The cost is that a caller who
        // churns keys can eventually push out someone else's window and hand them a fresh
        // allowance, which is worth far less to an attacker than locking the service, and the
        // source-keyed limiters still bound them. Map iterates in insertion order, so the front is
        // the oldest.
        while (this.hits.size >= this.maxKeys) {
          const oldest = this.hits.keys().next();
          if (oldest.done) break;
          this.hits.delete(oldest.value);
        }
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

  // Would this key be allowed, WITHOUT charging it. Only for allowAll below, which needs to know
  // every answer before it commits to any of them.
  wouldAllow(key) {
    const e = this.hits.get(key);
    if (!e || Date.now() > e.reset) return true; // a fresh window always has room for one
    return e.count + 1 <= this.max;
  }
}

// CHARGE SEVERAL BUCKETS TOGETHER OR NOT AT ALL.
//
// Two limits checked in sequence charge the first even when the second refuses, so a request that
// was never served still costs the caller allowance. Reordering only moves which bucket leaks: the
// account bucket was charged before the shared one, and before that the shared one was charged
// before the account one, and each ordering was fixed into the other. Neither is right, because the
// question is not which to charge first but whether to charge at all.
//
// So ask every bucket first, then charge every bucket only if all of them said yes. Safe to do in
// one pass because this runtime is single-threaded: nothing runs between the asking and the
// charging. Returns true when the request may proceed.
export function allowAll(pairs) {
  for (const [limiter, key] of pairs) {
    if (!limiter.wouldAllow(key)) return false;
  }
  for (const [limiter, key] of pairs) limiter.allow(key);
  return true;
}

// A bounded concurrency gate for the expensive cryptographic verify (the PLONK proof check, or the
// zkVM receipt check). The per-client rate limiter bounds one source, but a distributed flood of
// clients each under their own limit could still spawn unbounded concurrent verifies and exhaust CPU
// and memory (a documented residual). This caps how many run at once (`max`) and how many may wait
// (`maxQueue`); a request that arrives when the queue is full is SHED (run() throws "overloaded") so
// the gateway sheds load instead of growing an unbounded backlog. Only the expensive verify is gated,
// so the cheap policy rejections never consume a slot or a queue place.
export class Semaphore {
  constructor({ max = 4, maxQueue = 256 } = {}) {
    this.max = Math.max(1, max);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.queue = []; // pending resolvers, FIFO
  }
  async run(fn) {
    if (this.active < this.max) {
      this.active += 1; // take a free slot
    } else if (this.queue.length < this.maxQueue) {
      // Wait for a slot to be HANDED to us by release below. active is not re-incremented on
      // wake, because the releasing task transfers its slot rather than freeing it, which avoids
      // a race where a new caller and a woken waiter both claim the same freed slot.
      await new Promise((resolve) => this.queue.push(resolve));
    } else {
      const err = new Error("overloaded");
      err.overloaded = true;
      throw err;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // transfer this slot to the next waiter (active unchanged)
      else this.active -= 1; // no waiter, free the slot
    }
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
// One voting key maps to one membership per epoch and context. The store records the spent tag and,
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
  // Put back a taken challenge that was NOT actually processed (the gateway shed the request under
  // verify overload), so a transient overload does not burn the member's one-time nonce. The original
  // expiry is preserved, unlike put(), so restoring cannot extend a challenge's life under repeated
  // overload. It RESPECTS the maxPending cap (with a sweep first), so the store stays bounded: an
  // earlier cap-bypass let a take/fill/restore cycle grow the store past maxPending, so the cap is
  // enforced here too. Returns false if the challenge expired OR the store is genuinely full; the
  // caller (the gateway) then tells the member to request a new challenge rather than retry the same
  // nonce. Same-nonce retry is thus guaranteed except under a real flood that has filled the store,
  // which is an acceptable, honest degradation.
  restore(nonce, value) {
    if (Date.now() > value.expires) return false;
    if (this.pending.size >= this.maxPending) {
      this.sweep();
      if (this.pending.size >= this.maxPending) return false;
    }
    this.pending.set(nonce, value);
    return true;
  }
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now > v.expires) this.pending.delete(k);
  }
}
