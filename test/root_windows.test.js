// The Poseidon and SHA-256 DML root views must be structurally in lockstep (docs/ZKVM_INTEGRATION.md
// step 5): a zkVM root check must never see a snapshot the Poseidon check does not, or outlive it.
// RootWindows holds both roots per snapshot in one ring buffer, so eviction and aging drop a
// snapshot's two roots together. These pin that, including the v2-then-v1 case that split two
// independent windows (the full-review blocker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { leafSetCommitment, RootWindows, normalizeSnapshot } from "../core/stores.js";
import { buildConfig } from "../core/config.js";

test("a v2 snapshot is recent in both views; a v1 snapshot only in the Poseidon view", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 10, root: "P10", shaRoot: "S10", ts: 100 });
  w.adopt({ height: 11, root: "P11", shaRoot: null, ts: 110 }); // a v1 snapshot

  assert.equal(w.isRecent("P10"), true);
  assert.equal(w.isRecent("P11"), true);
  assert.equal(w.shaIsRecent("S10"), true);
  assert.equal(w.shaIsRecent("P11"), false, "the v1 Poseidon root is not a SHA-256 root");
  assert.equal(w.shaView().isRecent("S10"), true);
  assert.equal(w.current().root, "P11");
});

test("v2 then repeated v1 cannot leave a stale SHA-256 root past its Poseidon partner's eviction", () => {
  // Window size 2. A v2 at height 10, then two v1 snapshots. The single ring buffer evicts height 10
  // entirely (both its roots) once the window fills, so S10 is NOT recent even though independent
  // windows would have kept it. This is the blocker the paired record fixes.
  const w = new RootWindows(2);
  w.adopt({ height: 10, root: "P10", shaRoot: "S10", ts: 100 });
  w.adopt({ height: 11, root: "P11", shaRoot: null, ts: 110 });
  w.adopt({ height: 12, root: "P12", shaRoot: null, ts: 120 });

  assert.equal(w.isRecent("P10"), false, "height 10 evicted from the Poseidon view");
  assert.equal(w.shaIsRecent("S10"), false, "and its SHA-256 root evicted in lockstep, not lingering");
  assert.equal(w.isRecent("P11"), true);
  assert.equal(w.isRecent("P12"), true);
});

test("aging drops a snapshot's two roots together", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "Pold", shaRoot: "Sold", ts: 100 });
  w.adopt({ height: 2, root: "Pnew", shaRoot: "Snew", ts: 200 });
  w.dropOlderThan(150); // drops ts=100

  assert.equal(w.isRecent("Pold"), false);
  assert.equal(w.shaIsRecent("Sold"), false, "the aged SHA-256 root is dropped with its partner");
  assert.equal(w.isRecent("Pnew"), true);
  assert.equal(w.shaIsRecent("Snew"), true);
});

test("re-adopting a height replaces its record, both roots", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 5, root: "Pa", shaRoot: "Sa", ts: 50 });
  w.adopt({ height: 5, root: "Pb", shaRoot: "Sb", ts: 55 }); // same height, new roots
  assert.equal(w.isRecent("Pa"), false);
  assert.equal(w.shaIsRecent("Sa"), false);
  assert.equal(w.isRecent("Pb"), true);
  assert.equal(w.shaIsRecent("Sb"), true);
  assert.equal(w.current().ts, 55);
});

test("clear empties both views", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "P", shaRoot: "S", ts: 1 });
  w.clear();
  assert.equal(w.current(), null);
  assert.equal(w.isRecent("P"), false);
  assert.equal(w.shaIsRecent("S"), false);
});

// THE v2 TO v3 TRANSITION. The leaf order changed with the block-bound read, so the same set of
// masternodes produces two different roots. Keying the window on height alone meant the new snapshot
// replaced the old one at that height, and every prover still holding a v2 tree was locked out the
// moment the oracle switched.
test("both leaf orders are accepted at one height, so a changeover locks nobody out", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "poseidon-v2", shaRoot: "a".repeat(64), ts: 1000, order: null });
  w.adopt({ height: 100, root: "poseidon-v3", shaRoot: "b".repeat(64), ts: 1001, order: "proRegTxHash" });

  assert.equal(w.isRecent("poseidon-v2"), true, "a prover still holding the old tree can still prove");
  assert.equal(w.isRecent("poseidon-v3"), true, "and so can one that has rebuilt");
  assert.equal(w.shaIsRecent("a".repeat(64)), true);
  assert.equal(w.shaIsRecent("b".repeat(64)), true);
  assert.equal(w.current().root, "poseidon-v3", "the newest adoption is what the gateway publishes");
});

test("re-adopting the SAME order at a height still replaces, rather than accumulating", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "first", ts: 1000, order: "proRegTxHash" });
  w.adopt({ height: 100, root: "second", ts: 1001, order: "proRegTxHash" });
  assert.equal(w.isRecent("first"), false, "a corrected snapshot supersedes, it does not pile up");
  assert.equal(w.isRecent("second"), true);
});

test("the window counts heights, so running two orders does not halve the accepted history", () => {
  const w = new RootWindows(2);
  for (const h of [1, 2, 3]) {
    w.adopt({ height: h, root: `v2-${h}`, ts: h, order: null });
    w.adopt({ height: h, root: `v3-${h}`, ts: h, order: "proRegTxHash" });
  }
  // Two heights kept, both orders at each. Counting records instead would have kept one height.
  assert.equal(w.isRecent("v2-1"), false, "the oldest height is evicted");
  assert.equal(w.isRecent("v2-2"), true);
  assert.equal(w.isRecent("v3-2"), true);
  assert.equal(w.isRecent("v3-3"), true);
});

test("an aged-out v2 root stops being accepted with no switch to remember", () => {
  // The transition is bounded by the ordinary age rule, so nothing has to be turned off later.
  const w = new RootWindows(8);
  w.adopt({ height: 100, root: "old-order", ts: 1000, order: null });
  w.adopt({ height: 101, root: "new-order", ts: 2000, order: "proRegTxHash" });
  w.dropOlderThan(1500);
  assert.equal(w.isRecent("old-order"), false, "it ages out on its own once the oracle stops publishing it");
  assert.equal(w.isRecent("new-order"), true);
});

// COEXISTENCE IS CHECKED, NOT ASSUMED. The transition claim is that a v2 and a v3 root over the same
// masternodes commit to the same leaf set and differ only in build order. The window stored nothing
// that could verify that, so a member present only in a stale, orphaned, or inconsistent set could
// keep proving after the canonical root arrived.
test("two orders coexist only when block and leaf set both match", () => {
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111", "222"]);
  w.adopt({ height: 100, root: "v2", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });

  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET }),
    true,
    "same block, same set, different order: the legitimate pair",
  );
  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: "bb".repeat(32), setCommitment: SET }),
    false,
    "a different block at the same height is a fork, not an ordering change",
  );
  assert.equal(
    w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: leafSetCommitment(["111", "999"]) }),
    false,
    "a different member set is the case this check exists for",
  );
  // REVERSED 2026-08-02 after a four-reviewer round, one blocker and one major on this exact
  // assertion. It used to demand false here, reading "same order twice" as a changed root. That
  // refused an identical republish of a coexisting snapshot, so its freshness never renewed and it
  // aged out while the oracle was still publishing it. The question this check answers is whether
  // the candidate describes the same block and the same member set, and when it does, the answer is
  // yes whether it arrives under the same order or the other one.
  assert.equal(
    w.mayCoexist({ height: 100, order: null, blockHash: BLOCK, setCommitment: SET }),
    true,
    "the same order describing the same block and set is a republish, which must refresh rather than be refused",
  );
});

test("an unanswerable question is answered no", () => {
  // A snapshot carrying no block hash or no commitment cannot be shown to describe the same set, and
  // the safe reading of "cannot tell" is "not allowed".
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  w.adopt({ height: 100, root: "v2", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: null, setCommitment: SET }), false);
  assert.equal(w.mayCoexist({ height: 100, order: "proRegTxHash", blockHash: BLOCK, setCommitment: null }), false);
});

test("a height with nothing in it accepts anything, since there is nothing to disagree with", () => {
  const w = new RootWindows(8);
  assert.equal(w.mayCoexist({ height: 7, order: "proRegTxHash", blockHash: null, setCommitment: null }), true);
});

test("the leaf set commitment ignores order and preserves duplicates", () => {
  // Order independence is the whole point. Duplicate preservation matters because two masternodes can
  // share a voting key, so collapsing them would let a set with a duplicate match one without it.
  assert.equal(leafSetCommitment(["3", "1", "2"]), leafSetCommitment(["1", "2", "3"]));
  assert.notEqual(leafSetCommitment(["1", "1", "2"]), leafSetCommitment(["1", "2"]));
  assert.notEqual(leafSetCommitment(["1", "2"]), leafSetCommitment(["1", "3"]));
  // Numeric, not lexical: "10" must not sort before "9" in a way that differs from another ordering
  // of the same members.
  assert.equal(leafSetCommitment(["10", "9"]), leafSetCommitment(["9", "10"]));
});

// THE WINDOW MUST STAY BOUNDED. Keying on height alone guaranteed at most one record per height, and
// adding the order to the key destroyed that guarantee without replacing it. A source that could
// choose the order string could therefore create unlimited records at one height. The replacement is
// that the key is DERIVED from the validated version, so the key space is the size of the version
// enumeration, and the bound is a property of that rather than a counter.
test("a height holds at most one record per known ordering, however many adoptions arrive", () => {
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  // Only two order keys can ever reach adopt, because the gateway derives them from the version.
  for (let i = 0; i < 500; i += 1) {
    w.adopt({ height: 100, root: `legacy-${i}`, ts: i, order: null, blockHash: BLOCK, setCommitment: SET });
    w.adopt({ height: 100, root: `v3-${i}`, ts: i, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET });
  }
  const atHeight = w.snaps.filter((s) => s.height === 100);
  assert.equal(atHeight.length, 2, "1000 adoptions, two orderings, two records");
});

test("the window never exceeds its configured size in heights", () => {
  const w = new RootWindows(3);
  for (let h = 1; h <= 20; h += 1) {
    w.adopt({ height: h, root: `r-${h}`, ts: h, order: null });
  }
  assert.equal(new Set(w.snaps.map((s) => s.height)).size, 3);
});

test("an unknown ordering is refused by the store itself, not just by its caller", () => {
  // Defence in depth, and the reason it matters: the gateway derives the key from the validated
  // version, so only known orderings can arrive today. That is a property of ONE caller. The store's
  // bound depends on the key space, so it enforces the key space itself rather than trusting whoever
  // calls it. With an attacker-chosen key this held a thousand records at one height.
  const w = new RootWindows(8);
  assert.throws(() => w.adopt({ height: 1, root: "r", ts: 1, order: "attacker-chosen" }), /unknown leaf ordering/);
  assert.equal(w.snaps.length, 0, "and nothing was stored on the way to refusing");
});

test("current() is the last ADOPTED record at the top height, including on re-adoption", () => {
  // The changeover flap, at the STORE contract level. Map.set on an existing key updates in place,
  // keeping its old position, and the height sort is stable, so before the fix a legacy record
  // re-adopted AFTER the v3 one stayed first in the array and current() reported v3, violating its
  // own docstring ("the LAST adopted wins"). No live gateway path is known to reach this today,
  // because the refresh path's mayCoexist refuses a same-order re-adoption at a held height, so
  // the divergence was latent. The store enforces its documented contract itself rather than
  // relying on that property of one caller, the same defence-in-depth stance as the unknown-order
  // throw below.
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  w.adopt({ height: 100, root: "legacy-root", ts: 1, order: null, blockHash: BLOCK, setCommitment: SET });
  w.adopt({ height: 100, root: "v3-root", ts: 2, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.current().root, "v3-root", "last adopted wins after the switch");
  w.adopt({ height: 100, root: "legacy-root", ts: 3, order: null, blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.current().root, "legacy-root", "and wins again when the legacy order is re-adopted");
  assert.equal(w.snaps.filter((s) => s.height === 100).length, 2, "still one record per ordering");
});

test("a same-order republish refreshes its record instead of being refused as a conflict", () => {
  // The wedge. mayCoexist also demanded that the ORDERS differ, which read as tighter and was
  // looser in effect: once v3 was adopted beside v2, an identical republish of the v2 snapshot was
  // refused, so its freshness never renewed and it aged out WHILE THE ORACLE WAS STILL PUBLISHING
  // IT, stranding exactly the provers the coexistence window exists to protect.
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  w.adopt({ height: 100, root: "legacy-root", ts: 10, order: null, blockHash: BLOCK, setCommitment: SET });
  w.adopt({ height: 100, root: "v3-root", ts: 11, order: "proRegTxHash", blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.mayCoexist({ height: 100, blockHash: BLOCK, setCommitment: SET }), true, "an identical-set republish is admissible");
  w.adopt({ height: 100, root: "legacy-root", ts: 20, order: null, blockHash: BLOCK, setCommitment: SET });
  const legacy = w.snaps.find((s) => s.order === null && s.height === 100);
  assert.equal(legacy.ts, 20, "the republish renewed the record's freshness");
  assert.equal(w.snaps.filter((s) => s.height === 100).length, 2, "and did not add a record");
});

test("a different leaf set at a held height is still refused, whatever its order", () => {
  // The narrowing must not have widened. Same block, DIFFERENT set, both orders.
  const w = new RootWindows(8);
  const BLOCK = "aa".repeat(32);
  const SET = leafSetCommitment(["111"]);
  const OTHER = leafSetCommitment(["111", "222"]);
  w.adopt({ height: 100, root: "legacy-root", ts: 10, order: null, blockHash: BLOCK, setCommitment: SET });
  assert.equal(w.mayCoexist({ height: 100, blockHash: BLOCK, setCommitment: OTHER }), false, "different set, other order");
  assert.equal(w.mayCoexist({ height: 100, blockHash: "bb".repeat(32), setCommitment: SET }), false, "different block");
  assert.equal(w.mayCoexist({ height: 100, blockHash: BLOCK, setCommitment: null }), false, "unanswerable is refused");
});

test("maxHeight is the window's own rollback floor, asked of every retained record", () => {
  // The rollback check keyed on a SEPARATE last-adopted pointer that aged on its own rules, so when
  // that pointer expired while a higher record survived, the check was skipped entirely and a
  // lower-height snapshot could be adopted beside the higher one. Asking the window removes the
  // pointer from the question.
  //
  // A first draft of this test asserted that current() could name a lower height than maxHeight().
  // It cannot: adopt() sorts by height, so current() is always at the top height and the two agree
  // whenever the window is non-empty. The assertion was rewritten rather than kept, because a test
  // asserting a state the code cannot reach proves nothing while looking like coverage. What
  // maxHeight() is really worth is that it answers from the records rather than from a pointer, and
  // that it is defined when a pointer would be missing.
  const w = new RootWindows(8);
  assert.equal(w.maxHeight(), null, "an empty window has no floor, so nothing is refused for being below it");
  w.adopt({ height: 200, root: "high", ts: 5, order: null });
  w.adopt({ height: 100, root: "low", ts: 6, order: null });
  assert.equal(w.maxHeight(), 200, "the floor is the highest retained height, not the last adopted one");
  assert.equal(w.current().height, 200, "and current() agrees, because adoption sorts by height");
  w.dropOlderThan(6); // the height-200 record is the older one and ages out first
  assert.equal(w.maxHeight(), 100, "the floor follows the records, so it falls when the top one ages out");
});

test("normalizeSnapshot drops an unknown field, and is testable without booting a gateway", () => {
  // THE TEST THAT ACTUALLY OBSERVES THE THING. Two earlier tests claimed this coverage and neither
  // had it: one inspected the /v1/dml response, whose handler rebuilds a five-field object anyway
  // and so omits padding whatever the window holds, and the other passed an ALREADY normalized
  // object into adopt(). Both stayed green with the normalization removed from the refresh path.
  // A reviewer named the mutation; this is the assertion that fails under it.
  const hostile = {
    version: 3, height: 5, blockHash: "ab".repeat(32), depth: 16, ts: 99,
    root: "123", shaRoot: "c".repeat(64), leaves: ["1", "2"],
    padding: "x".repeat(50_000),
    sigs: [{ key: "k", sig: "s" }],
  };
  const clean = normalizeSnapshot(hostile, 16);
  assert.deepEqual(Object.keys(clean).sort(), [
    "blockHash", "depth", "height", "leaves", "root", "shaRoot", "ts", "version",
  ]);
  assert.equal("padding" in clean, false, "the field a signature never covered is not retained");
  assert.equal("sigs" in clean, false, "and the signatures have no consumer after adoption");
  clean.leaves.push("999");
  assert.deepEqual(hostile.leaves, ["1", "2"], "the leaves are copied, not aliased");
});

test("a record retains only the normalized snapshot fields, not whatever the source sent", () => {
  // A REGRESSION FROM THE PREVIOUS ROUND'S FIX, caught by the next round. Moving the snapshot into
  // the window record fixed a real split, and retained the parsed object as it arrived. Snapshot
  // validation does not reject unknown properties and the signed message ignores them, so a host
  // holding no signing key could append a large field to a legitimately signed snapshot and have it
  // held at every height in the window. A reviewer measured 157 MB of resident growth from eight
  // padded records. The store is not where that is fixed, but this pins the shape it receives.
  const w = new RootWindows(8);
  const normalized = { version: 2, height: 1, blockHash: null, depth: 16, ts: 5, root: "r", shaRoot: null, leaves: ["1"] };
  w.adopt({ height: 1, root: "r", ts: 5, order: null, snapshot: normalized });
  assert.deepEqual(Object.keys(w.current().snapshot).sort(), [
    "blockHash", "depth", "height", "leaves", "root", "shaRoot", "ts", "version",
  ]);
});

// THE REGISTRATION ANCHOR AGE RULE, tested directly rather than through a stubbed predicate. A
// membership proof against a stale-but-windowed root costs one epoch; a registration proof against
// the same root buys the remainder of the season. The rule lives here so it is one implementation
// with one test, not a predicate rebuilt at each call site.
test("isEligibleWithin enforces the configured age, and zero means the window's own rule", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "r", ts: 1000, order: null });

  assert.equal(w.isEligibleWithin("r", 0, 9_999_999), true, "zero disables the age rule entirely");
  assert.equal(w.isEligibleWithin("r", 600, 1500), true, "500s old, inside a 600s bound");
  assert.equal(w.isEligibleWithin("r", 600, 1600), true, "exactly 600s old is still inside");
  assert.equal(w.isEligibleWithin("r", 600, 1601), false, "601s old is outside");
  assert.equal(w.isEligibleWithin("missing", 600, 1500), false, "a root the window does not hold");
  assert.equal(w.isEligibleWithin("missing", 0, 1500), false, "and still refused with no age rule");
});

test("a future-dated record reads as age zero, which is grace the skew bound has to cover", () => {
  // Stated as it behaves, not as it would be convenient. Clamping stops a negative age being
  // compared; it does NOT make a future stamp free. Such a root is eligible until wall time reaches
  // its timestamp and then gets the full allowance from there, so the real window is the bound plus
  // however far ahead it was stamped, and what keeps that finite is the separate future-skew bound
  // applied at adoption.
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "future", ts: 5000, order: null });
  assert.equal(w.isEligibleWithin("future", 600, 1000), true, "far before its own timestamp, still eligible");
  assert.equal(w.isEligibleWithin("future", 600, 5600), true, "and still eligible 600s past it");
  assert.equal(w.isEligibleWithin("future", 600, 5601), false, "the allowance runs from the timestamp");
});

test("a root republished at a later height is judged by its NEWEST appearance", () => {
  // One root legitimately sits at several heights: the root comes from the leaf set alone, so an
  // unchanged masternode list across two oracle reads produces the same root twice. Judging it by
  // the oldest appearance meant a stable network started refusing registrations once that first
  // appearance passed the bound, which is a guard with no exit reached by ordinary operation.
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "same", ts: 1000, order: null });
  w.adopt({ height: 2, root: "same", ts: 2000, order: null });
  assert.equal(w.tsOf("same"), 2000, "the newest, not the first found");
  assert.equal(w.isEligibleWithin("same", 600, 2500), true, "republished 500s ago, so it is eligible");
  assert.equal(w.isEligibleWithin("same", 600, 2700), false, "and ages from that republish");
});

test("a non-numeric timestamp is refused rather than compared", () => {
  const w = new RootWindows(8);
  w.adopt({ height: 1, root: "bad-ts", ts: "not-a-number", order: null });
  assert.equal(w.isEligibleWithin("bad-ts", 600, 1000), false, "an uncomparable age is not a fresh one");
  assert.equal(w.isEligibleWithin("bad-ts", 0, 1000), true, "but with no age rule the window still accepts it");
});

test("the store REFUSES an un-normalized snapshot, so this is an invariant not a convention", () => {
  // REPLACES A SOURCE-TEXT TRIPWIRE. The previous version of this test read core/gateway.js and
  // grepped for a normalizeSnapshot() call, because that module starts a server on import and could
  // not be exercised. Three reviewers independently judged that a stopgap rather than an invariant:
  // it broke on reformatting and could not notice the call being present while a different object
  // reached adopt(). Enforcing the shape in the store catches every route in, including ones nobody
  // has written yet, and needs no knowledge of who the caller is.
  const w = new RootWindows(8);
  const hostile = { ...normalizeSnapshot({ height: 1, ts: 5, root: "r", leaves: ["1"] }, 16), padding: "x".repeat(1000) };
  assert.throws(
    () => w.adopt({ height: 1, root: "r", ts: 5, order: null, snapshot: hostile }),
    /unexpected field "padding"/,
  );
  assert.equal(w.snaps.length, 0, "and nothing was stored on the way to refusing");

  // The exit ordinary operation takes: a normalized snapshot is accepted.
  w.adopt({ height: 1, root: "r", ts: 5, order: null, snapshot: normalizeSnapshot({ height: 1, ts: 5, root: "r", leaves: ["1"] }, 16) });
  assert.equal(w.current().snapshot.leaves.length, 1);
});

// THE RETAINED-LEAVES BOUND. The window keeps one record per (height, leaf ordering), each carrying
// the snapshot whose leaves /v1/dml serves, so its memory was the product of three limits that know
// nothing about each other: the window size, the two orderings that coexist during a changeover, and
// the per-snapshot leaf cap. Measured on this build with a fresh parse per record: 16 records hold
// 3.1 MiB at the live mainnet size of 2,972 leaves and 64.7 MiB at full tree capacity. Finite, and
// nobody could say so without recomputing it from three places, which is what the bound fixes.
//
// One test per row of the predicate table written before the guard. The ACCEPTING rows are the point:
// a bound that quietly shortens a working deployment's history, or refuses the snapshot it is
// serving, is worse than the unstated product it replaced.

const leaves = (n, tag = "x") => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const withLeaves = (n, tag) => normalizeSnapshot({ height: 1, ts: 1, root: "r", leaves: leaves(n, tag) }, 16);

test("the bound is silent on the smallest valid window, and on a live-mainnet-sized changeover", () => {
  // Row 1: one small record.
  const small = new RootWindows(8, { maxLeaves: 1000 });
  small.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(3) });
  assert.equal(small.snaps.length, 1);
  assert.equal(small.retainedLeaves(), 3);

  // Row 2, the one that must not regress: eight heights carrying both orderings at the live mainnet
  // size, under THE SHIPPED DEFAULT read from the config rather than a number copied into the test.
  // Writing the number here made the test agree with itself: shrinking the default until it bit a
  // mainnet-sized changeover left this passing, which is the one regression it exists to catch.
  const shipped = buildConfig({}).rootWindowMaxLeaves;
  const live = new RootWindows(8, { maxLeaves: shipped });
  for (let h = 1; h <= 8; h++) {
    for (const order of [null, "proRegTxHash"]) {
      live.adopt({ height: h, root: `r${h}${order}`, ts: h, order, snapshot: withLeaves(2972, `${h}${order}`) });
    }
  }
  assert.equal(live.snaps.length, 16, "a full changeover window at mainnet size is untouched");
  assert.equal(live.retainedLeaves(), 16 * 2972);
});

test("with excess capacity the height window still binds, and with the bound off nothing changes", () => {
  // Row 3: a cap so large it can never fire.
  const roomy = new RootWindows(2, { maxLeaves: 10_000_000 });
  for (let h = 1; h <= 5; h++) roomy.adopt({ height: h, root: `r${h}`, ts: h, order: null, snapshot: withLeaves(10, `h${h}`) });
  assert.equal(roomy.snaps.length, 2, "the height window is what evicted, not the bound");

  // Row 6: disabled, which must behave exactly as before the bound existed. THE ZERO COMES FROM THE
  // CONFIG, not from a literal here: the setting's `min: 0` is what makes 0 a legal value at all, and
  // an external pass removed it and watched every test in this file still pass while
  // MNO_ROOT_WINDOW_MAX_LEAVES=0 failed to boot. A disable switch nobody can reach is not a disable
  // switch.
  assert.equal(buildConfig({ MNO_ROOT_WINDOW_MAX_LEAVES: "0" }).rootWindowMaxLeaves, 0, "0 is a legal setting, meaning no bound");
  const off = new RootWindows(8, { maxLeaves: buildConfig({ MNO_ROOT_WINDOW_MAX_LEAVES: "0" }).rootWindowMaxLeaves });
  for (let h = 1; h <= 8; h++) off.adopt({ height: h, root: `r${h}`, ts: h, order: null, snapshot: withLeaves(65536, `h${h}`) });
  assert.equal(off.snaps.length, 8);
  assert.equal(off.retainedLeaves(), 8 * 65536, "no bound means no eviction, however large the retained set");
});

test("over the bound, the OLDEST records are dropped and the newest are the ones kept", () => {
  // Rows 4 and 5: the cap admits two records while the height window would allow eight.
  const w = new RootWindows(8, { maxLeaves: 250 });
  for (let h = 1; h <= 5; h++) w.adopt({ height: h, root: `r${h}`, ts: h, order: null, snapshot: withLeaves(100, `h${h}`) });

  assert.ok(w.retainedLeaves() <= 250, "the bound holds after every adoption");
  assert.equal(w.snaps.length, 2);
  assert.deepEqual(w.snaps.map((s) => s.height), [4, 5], "the two KEPT records are the newest, not the oldest");
  assert.equal(w.current().root, "r5");
  assert.equal(w.isRecent("r1"), false, "and an evicted root is no longer accepted");
  assert.equal(w.isRecent("r5"), true);
});

test("a record too large for the whole bound is still retained, because the served root needs its leaves", () => {
  // Row 7, the accepting row. Refusing here would leave current() advertising a root whose leaves
  // /v1/dml cannot serve, which is the same-instant split the record design exists to prevent.
  const w = new RootWindows(8, { maxLeaves: 10 });
  w.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(500, "a") });
  assert.equal(w.snaps.length, 1);
  assert.equal(w.current().root, "r1");
  assert.equal(w.current().snapshot.leaves.length, 500, "the snapshot behind the served root is intact");

  // And a second oversized record replaces rather than accumulates, so the excess is one record, not
  // a growing pile of them.
  w.adopt({ height: 2, root: "r2", ts: 2, order: null, snapshot: withLeaves(500, "b") });
  assert.equal(w.snaps.length, 1);
  assert.equal(w.current().root, "r2");
  assert.equal(w.isRecent("r1"), false);
});

test("eviction under the bound takes each record's root and leaves together", () => {
  // Row 8. A root surviving without the leaves behind it is the failure this whole record design
  // exists to prevent, so the bound must not become a new way to produce it.
  const w = new RootWindows(8, { maxLeaves: 150 });
  w.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(100, "a") });
  w.adopt({ height: 2, root: "r2", ts: 2, order: null, snapshot: withLeaves(100, "b") });

  assert.equal(w.snaps.length, 1, "one record did not fit");
  for (const s of w.snaps) {
    assert.ok(s.snapshot != null, "every surviving record still has its snapshot");
    assert.equal(w.isRecent(s.root), true, "and every surviving root is still accepted");
  }
  assert.equal(w.isRecent("r1"), false, "the evicted root went with its leaves");
});

test("the bound evicts whole HEIGHTS, so a changeover pair is never split", () => {
  // Found by the ordering charter of the three-agent review, and reproduced before it was fixed. The
  // first version shifted single records off the front, and at a shared height the front record is
  // the ordering adopted FIRST, so the bound kept the v3 record at that height and evicted its v2
  // sibling. A prover holding the v2 tree was then locked out at a height whose v3 root was still
  // accepted, which is what the coexistence design exists to prevent.
  const w = new RootWindows(8, { maxLeaves: 4 * 65536 });
  for (const h of [1, 2]) {
    for (const order of [null, "proRegTxHash"]) {
      w.adopt({
        height: h,
        root: `H${h}-${order ? "v3" : "v2"}`,
        ts: h,
        order,
        blockHash: "ab".repeat(32),
        setCommitment: "same",
        snapshot: withLeaves(65536, `${h}${order}`),
      });
    }
  }
  assert.equal(w.snaps.length, 4, "two heights, each carrying a changeover pair, exactly at the bound");

  w.adopt({ height: 3, root: "H3-v3", ts: 3, order: "proRegTxHash", snapshot: withLeaves(65536, "3") });

  assert.equal(
    w.isRecent("H1-v2"),
    w.isRecent("H1-v3"),
    "both orderings at the evicted height leave together, or neither does",
  );
  assert.equal(w.isRecent("H1-v2"), false, "and here they left, since the bound had to evict something");
  assert.equal(w.isRecent("H2-v2"), true, "the surviving height keeps BOTH its orderings");
  assert.equal(w.isRecent("H2-v3"), true);
});

test("one adoption can put the window several heights over, and the bound clears all of it", () => {
  // Found by the tests charter of the three-agent review: every earlier case used equal-sized records,
  // so one eviction per adoption always sufficed and a single pass would have passed every test. A
  // snapshot larger than the ones already held is ordinary (the masternode list grows), and it can
  // put the window over by more than one height at once.
  const w = new RootWindows(8, { maxLeaves: 250 });
  w.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(100, "a") });
  w.adopt({ height: 2, root: "r2", ts: 2, order: null, snapshot: withLeaves(100, "b") });
  assert.equal(w.retainedLeaves(), 200);

  w.adopt({ height: 3, root: "r3", ts: 3, order: null, snapshot: withLeaves(200, "c") });

  assert.ok(w.retainedLeaves() <= 250, `the bound holds after an adoption that overshot it (${w.retainedLeaves()})`);
  assert.deepEqual(w.snaps.map((s) => s.height), [3], "both earlier heights went, not just the oldest one");
});

test("a window exactly at the bound keeps everything, so the limit is inclusive", () => {
  // Also from the tests charter: no case put retainedLeaves() exactly at maxLeaves, so whether the
  // comparison is > or >= was unpinned, and the stricter one silently drops a height of history at
  // precisely the configured size.
  const w = new RootWindows(8, { maxLeaves: 200 });
  w.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(100, "a") });
  w.adopt({ height: 2, root: "r2", ts: 2, order: null, snapshot: withLeaves(100, "b") });

  assert.equal(w.retainedLeaves(), 200, "exactly at the bound");
  assert.equal(w.snaps.length, 2, "which is within it, not over it");
  assert.equal(w.isRecent("r1"), true);
});

test("re-adopting at an existing key re-checks the bound, since a replacement can be larger", () => {
  // An external pass found this uncovered: every earlier case reached the bound by adopting a NEW
  // height, so a version that enforced the bound only for new keys passed all of them. Re-adoption
  // at an existing (height, ordering) is ordinary, and the replacement can carry more leaves than
  // what it replaces, which puts the window over without any new height arriving.
  const w = new RootWindows(8, { maxLeaves: 250 });
  w.adopt({ height: 1, root: "r1", ts: 1, order: null, snapshot: withLeaves(100, "a") });
  w.adopt({ height: 2, root: "r2", ts: 2, order: null, snapshot: withLeaves(100, "b") });
  assert.equal(w.retainedLeaves(), 200);

  // Same key, a bigger snapshot.
  w.adopt({ height: 2, root: "r2b", ts: 3, order: null, snapshot: withLeaves(240, "c") });

  assert.ok(w.retainedLeaves() <= 250, `the bound holds after a replacement grew (${w.retainedLeaves()})`);
  assert.deepEqual(w.snaps.map((s) => s.height), [2], "the older height went, and the replacement stayed");
  assert.equal(w.current().root, "r2b");

  // And a replacement that SHRINKS does not evict anything it did not need to.
  const w2 = new RootWindows(8, { maxLeaves: 250 });
  w2.adopt({ height: 1, root: "s1", ts: 1, order: null, snapshot: withLeaves(100, "a") });
  w2.adopt({ height: 2, root: "s2", ts: 2, order: null, snapshot: withLeaves(140, "b") });
  w2.adopt({ height: 2, root: "s2b", ts: 3, order: null, snapshot: withLeaves(10, "c") });
  assert.deepEqual(w2.snaps.map((s) => s.height), [1, 2], "a shrinking replacement evicts nothing");
  assert.equal(w2.retainedLeaves(), 110);
});

test("a window configured larger than the leaf bound allows is shortened by the bound, deliberately", () => {
  // The config comment claims the height window binds first at mainnet size. That is true of the
  // DEFAULT window of 8 and not of every window, and MNO_ROOT_WINDOW has no upper limit. An external
  // pass raised it, so the interaction is pinned here rather than left to a comment: an operator who
  // raises MNO_ROOT_WINDOW without raising this bound gets a shorter accepted history than the one
  // configured.
  const shipped = buildConfig({}).rootWindowMaxLeaves;
  const perRecord = 2972; // the live mainnet list

  // The default window: every record of a full changeover survives, which is the claim that matters.
  const byDefault = new RootWindows(buildConfig({}).rootWindow, { maxLeaves: shipped });
  for (let h = 1; h <= 8; h++) {
    for (const order of [null, "proRegTxHash"]) {
      byDefault.adopt({ height: h, root: `d${h}${order}`, ts: h, order, snapshot: withLeaves(perRecord, `${h}${order}`) });
    }
  }
  assert.equal(byDefault.snaps.length, 16, "under the default window the bound is silent");

  // A window of 100 heights at the same list size: the bound binds first and the history is shorter
  // than the operator asked for.
  const wide = new RootWindows(100, { maxLeaves: shipped });
  for (let h = 1; h <= 100; h++) wide.adopt({ height: h, root: `w${h}`, ts: h, order: null, snapshot: withLeaves(perRecord, `w${h}`) });
  assert.ok(wide.snaps.length < 100, "the configured window was not delivered");
  assert.equal(wide.snaps.length, Math.floor(shipped / perRecord), "and what it delivers is exactly what the bound allows");
  assert.equal(wide.current().root, "w100", "the newest is still what is served");
});
