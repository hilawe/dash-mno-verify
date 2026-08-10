import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMembership, verifyRegistration } from "../core/verifier.js";
import { NullifierStore } from "../core/stores.js";
import { DocumentNullifierStore, MemoryBackend } from "../core/platform_store.js";
import { FIELD_PRIME } from "../core/dml_root.js";

// Idempotent grants: the account that first spends a membership tag may re-verify and re-grant it
// within the epoch (its adapter died after the spend but before applying the grant), while a second
// account that hits the same tag is rejected. The spend and the granting account live in one record,
// so there is no second store to fall out of step. The proof check is stubbed here, so these exercise
// the spend, claim, and re-grant control flow without building a real PLONK proof.

// publicSignals layout: [nullifier, root, epoch, contextHash, signalHash].
const SIGNALS = ["111", "222", "7", "333", "444"];
const baseExpected = (account) => ({
  rootStore: { isRecent: () => true },
  epoch: "7",
  contextHash: "333",
  signalHash: "444",
  account,
});

const args = (account, { nullifiers, verifyProof = () => true }) => ({
  vkey: {},
  proof: {},
  publicSignals: SIGNALS,
  nullifiers,
  verifyProof,
  expected: baseExpected(account),
});

test("A7: a nullifier read that fails BEFORE the spend tags the error beforeSpend, so the caller can restore the nonce", async () => {
  // A transient store read failure (a SQLite read error, a Platform round-trip blip) before the
  // irreversible nullifier spend must not burn the member's one-time challenge. verifyMembership tags
  // such an error so the gateway restores the nonce rather than returning a client error with it spent.
  const throwingRead = {
    has: async () => {
      throw new Error("transient store read failure");
    },
    get: async () => null,
    add: async () => ({ duplicate: false }),
  };
  await assert.rejects(
    () => verifyMembership(args("alice", { nullifiers: throwingRead })),
    (err) => {
      assert.equal(err.beforeSpend, true, "a pre-spend read failure is tagged restorable");
      return /transient store read failure/.test(err.message);
    },
  );
});

test("A7: a failure AT the spend is NOT tagged beforeSpend, so the nonce is not restored (fail closed)", async () => {
  // The spend (nullifiers.add) is the irreversible step. If it throws, the tag may have landed, so the
  // error must stay uncertain and the nonce must not be restored, or a second grant could be issued.
  const spendFails = {
    has: async () => false, // no prior spend, so the flow reaches add()
    get: async () => null,
    add: async () => {
      throw new Error("uncertain spend");
    },
  };
  await assert.rejects(
    () => verifyMembership(args("alice", { nullifiers: spendFails })),
    (err) => {
      assert.notEqual(err.beforeSpend, true, "the spend's own failure is not marked restorable");
      return /uncertain spend/.test(err.message);
    },
  );
});

test("first verify spends the tag and records the granting account in one record", async () => {
  const nullifiers = new NullifierStore();
  const r = await verifyMembership(args("alice", { nullifiers }));
  assert.equal(r.ok, true);
  assert.ok(!r.regranted, "the first claim is not a re-grant");
  assert.equal(nullifiers.has("7", "333", "111"), true);
  assert.deepEqual(nullifiers.get("7", "333", "111"), { account: "alice" });
});

test("the same account re-verifies and re-grants on the spent tag", async () => {
  const nullifiers = new NullifierStore();
  await verifyMembership(args("alice", { nullifiers }));
  const again = await verifyMembership(args("alice", { nullifiers }));
  assert.equal(again.ok, true);
  assert.equal(again.regranted, true);
});

test("a different account is rejected on the spent tag", async () => {
  const nullifiers = new NullifierStore();
  await verifyMembership(args("alice", { nullifiers }));
  const mallory = await verifyMembership(args("mallory", { nullifiers }));
  assert.equal(mallory.ok, false);
  assert.equal(mallory.reason, "already-used");
});

test("a re-grant still requires a fresh valid proof", async () => {
  const nullifiers = new NullifierStore();
  await verifyMembership(args("alice", { nullifiers }));
  const bad = await verifyMembership(args("alice", { nullifiers, verifyProof: () => false }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid-proof");
});

// The race: has() reports unspent, but add() finds another request spent it first. The re-grant rule
// still applies, so only the account on the prior claim is let through.
test("a lost add race re-grants the original account but rejects another", async () => {
  const raced = (account) => ({
    has: () => false,
    get: () => ({ account: "alice" }),
    add: () => ({ duplicate: true }),
  });
  const alice = await verifyMembership(args("alice", { nullifiers: raced() }));
  assert.equal(alice.ok, true);
  assert.equal(alice.regranted, true);
  const mallory = await verifyMembership(args("mallory", { nullifiers: raced() }));
  assert.equal(mallory.ok, false);
  assert.equal(mallory.reason, "already-used");
});

// A nullifier of x and one of x + p are the same field element to snarkjs but distinct strings to the
// store, so a non-canonical signal must be rejected before it is used as a key, or the same masternode
// could spend twice in one epoch. p itself (FIELD_PRIME) is the smallest non-canonical value.
test("a non-canonical public signal is rejected before any spend", async () => {
  const nullifiers = new NullifierStore();
  const bad = { ...args("alice", { nullifiers }), publicSignals: [FIELD_PRIME.toString(), "222", "7", "333", "444"] };
  const r = await verifyMembership(bad);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "non-canonical-signal");
  assert.equal(nullifiers.has("7", "333", FIELD_PRIME.toString()), false, "a non-canonical signal spends nothing");
});

// The registration path shares the canonical-signal guard, and the registration nullifier is keyed by
// its string too, so a non-canonical regNullifier must be rejected before the store or the proof.
test("verifyRegistration rejects a non-canonical public signal before the store or proof", async () => {
  let touched = false;
  const registrationStore = { has: async () => ((touched = true), false) };
  const commit = async () => ((touched = true), { ok: true });
  // REG_SIGNAL_INDEX layout: [commitment, regNullifier, root, season, contextHash]. "01" regNullifier.
  const r = await verifyRegistration({
    vkey: {},
    proof: {},
    publicSignals: ["1", "01", "3", "4", "5"],
    expected: { rootStore: { isRecent: () => true }, season: "3", contextHash: "5", engine: "plonk", statement: "derive" },
    registrationStore,
    commit,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "non-canonical-signal");
  assert.equal(touched, false, "neither the store nor commit was touched");
});

test("a verify with no account is rejected before any spend", async () => {
  const nullifiers = new NullifierStore();
  const r = await verifyMembership(args(undefined, { nullifiers }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-account");
  assert.equal(nullifiers.has("7", "333", "111"), false, "a verify with no account spends nothing");
});

test("policy checks still reject before any spend", async () => {
  const nullifiers = new NullifierStore();
  const wrongSignal = { ...args("alice", { nullifiers }), expected: { ...baseExpected("alice"), signalHash: "999" } };
  const r = await verifyMembership(wrongSignal);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong-signal");
  assert.equal(nullifiers.has("7", "333", "111"), false, "a rejected proof spends nothing");
});

// The Platform-backed store shares the spent set across gateways but does not persist the account
// (writing it would link a platform user to masternode control on a public ledger). So in Platform
// mode a spent tag is plainly already-used: re-grant is a memory-mode property until a privacy-safe
// durable claim lands. This pins that known boundary, including across a simulated gateway restart
// (a new store instance over the same shared backend).
test("Platform-backed store does not re-grant; a spent tag is already-used even across a restart", async () => {
  const backend = new MemoryBackend(); // the shared, durable layer
  const first = await verifyMembership(args("alice", { nullifiers: new DocumentNullifierStore(backend) }));
  assert.equal(first.ok, true);
  const sameGateway = await verifyMembership(args("alice", { nullifiers: new DocumentNullifierStore(backend) }));
  assert.equal(sameGateway.ok, false);
  assert.equal(sameGateway.reason, "already-used");
});

// THE PERIOD MUST STILL HOLD AT THE MOMENT OF THE SPEND. Every policy check runs BEFORE the
// expensive proof and nothing re-read them afterwards, so a proof that finished after an epoch or
// season boundary could spend a nullifier and return success for a period that had already ended,
// handing the adapter a grant whose expiry was already in the past. The proof verify is the only
// slow step, so the gap is exactly as wide as a PLONK verification. These drive it by having the
// stubbed proof cross the boundary itself, which is what a real slow verify does.

test("a period that ends while the proof runs refuses BEFORE the nullifier is spent", async () => {
  const nullifiers = new NullifierStore();
  let ended = false;
  const r = await verifyMembership({
    ...args("alice", { nullifiers, verifyProof: () => { ended = true; return true; } }),
    expected: { ...baseExpected("alice"), stillCurrent: async () => (ended ? "epoch-rolled-over" : null) },
  });
  assert.equal(r.ok, false, "no grant for a period that has ended");
  assert.equal(r.reason, "epoch-rolled-over");
  assert.equal(
    await nullifiers.has("7", "333", "111"),
    false,
    "and the tag is NOT spent, so the member keeps their one membership for the next epoch",
  );
});

test("a re-grant is period-checked too, not just a first spend", async () => {
  // The adapter is told it may trust an ok response without re-checking expiry, so handing back a
  // re-grant whose epoch ended is the same defect as issuing one.
  const nullifiers = new NullifierStore();
  await verifyMembership(args("alice", { nullifiers })); // first spend, period current
  let ended = false;
  const again = await verifyMembership({
    ...args("alice", { nullifiers, verifyProof: () => { ended = true; return true; } }),
    expected: { ...baseExpected("alice"), stillCurrent: async () => (ended ? "season-rolled-over" : null) },
  });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "season-rolled-over");
});

test("a caller that supplies no period check behaves exactly as before", async () => {
  // The hook is optional on purpose: a direct caller that never knew about it must not start
  // failing shut on an interface it does not implement.
  const nullifiers = new NullifierStore();
  const r = await verifyMembership(args("alice", { nullifiers }));
  assert.equal(r.ok, true);
  assert.equal(await nullifiers.has("7", "333", "111"), true);
});

test("a period that still holds grants normally, so the guard has an exit", async () => {
  const nullifiers = new NullifierStore();
  const r = await verifyMembership({
    ...args("alice", { nullifiers }),
    expected: { ...baseExpected("alice"), stillCurrent: async () => null },
  });
  assert.equal(r.ok, true, "ordinary correct operation reaches the exit");
});

test("a period that ends during the nullifier write refuses the grant", async () => {
  // add() is an await, and against a shared backend it is a network round trip, so the period can
  // end inside it. Every path past it returns a grant, so each is checked.
  const nullifiers = new NullifierStore();
  let written = false;
  const wrapped = {
    has: (...a) => nullifiers.has(...a),
    get: (...a) => nullifiers.get(...a),
    add: async (...a) => { const r = await nullifiers.add(...a); written = true; return r; },
  };
  const r = await verifyMembership({
    ...args("alice", { nullifiers: wrapped }),
    expected: { ...baseExpected("alice"), stillCurrent: async () => (written ? "epoch-rolled-over" : null) },
  });
  assert.equal(r.ok, false, "no grant for a period that ended during the write");
  assert.equal(r.reason, "epoch-rolled-over");
  assert.equal(await nullifiers.has("7", "333", "111"), true, "the spend stays recorded, deliberately");
});

test("an empty-string refusal reason is still a refusal, not a grant", async () => {
  // The reason is compared against null, never tested for truthiness. An empty string is falsy, so
  // a truthiness test would have read "no longer current, reason unstated" as "still current".
  const nullifiers = new NullifierStore();
  const r = await verifyMembership({
    ...args("alice", { nullifiers }),
    expected: { ...baseExpected("alice"), stillCurrent: async () => "" },
  });
  assert.equal(r.ok, false, "a guard whose failure mode is to pass is worse than no guard");
  assert.equal(r.reason, "period-changed");
  assert.equal(await nullifiers.has("7", "333", "111"), false);
});

test("a period that ends during the ownership lookup refuses the re-grant", async () => {
  // The last await before a grant. The duplicate branch checks after add(), then awaits
  // claimedBySameAccount(), and the period can move inside THAT. Every await between the last check
  // and a returned grant needs its own check, which is the general rule this case pins.
  // It must be the CONCURRENT-DUPLICATE branch, reached when has() says free but add() reports a
  // duplicate because another request won the race. A first version of this test seeded the tag so
  // has() returned true, which takes the EARLY re-grant branch and never reaches the code under
  // test: the mutation passed and the test proved nothing. has() is forced false here so add() is
  // the thing that discovers the duplicate.
  const nullifiers = new NullifierStore();
  await verifyMembership(args("alice", { nullifiers })); // alice owns the tag
  let lookedUp = false;
  const wrapped = {
    has: async () => false, // pretend the early check saw a free tag
    add: (...a) => nullifiers.add(...a), // ...and the insert discovers otherwise
    get: async (...a) => { const r = await nullifiers.get(...a); lookedUp = true; return r; },
  };
  const r = await verifyMembership({
    ...args("alice", { nullifiers: wrapped }),
    expected: {
      ...baseExpected("alice"),
      // Current until the ownership lookup happens, so only a check placed AFTER it can catch this.
      stillCurrent: async () => (lookedUp ? "epoch-rolled-over" : null),
    },
  });
  assert.equal(r.ok, false, "a re-grant is a grant, so it gets the same treatment");
  assert.equal(r.reason, "epoch-rolled-over");
});

// THE REGISTRATION ANCHOR. A membership proof against a stale-but-windowed root costs one epoch. A
// REGISTRATION proof against the same root buys the REMAINDER OF THE CURRENT SEASON, so a node that
// left the masternode list minutes ago could keep membership for the rest of that season. The root is now re-asked after the proof and the caller may
// impose a tighter age rule than the membership window's.
const regArgs = (over = {}) => ({
  vkey: {},
  proof: {},
  publicSignals: ["1", "2", "3", "4", "5"], // [commitment, regNullifier, root, season, contextHash]
  verifyProof: () => true,
  registrationStore: { has: async () => false },
  commit: async () => ({ ok: true, index: 0, membersRoot: "r", size: 1 }),
  expected: { rootStore: { isRecent: () => true }, season: "4", contextHash: "5", engine: "plonk", statement: "derive" },
  ...over,
});

test("a root that ages out DURING the registration proof does not buy a season", async () => {
  let proved = false;
  let committed = false;
  const r = await verifyRegistration(regArgs({
    verifyProof: () => { proved = true; return true; },
    commit: async () => { committed = true; return { ok: true }; },
    expected: {
      rootStore: { isRecent: () => true },
      season: "4",
      contextHash: "5",
      engine: "plonk",
      statement: "derive",
      // Eligible when asked before the proof, no longer eligible when asked after it.
      rootEligible: () => !proved,
    },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-or-unknown-root");
  assert.equal(committed, false, "and nothing durable was written for the season");
});

test("a tighter registration anchor rule refuses a root the membership window still accepts", async () => {
  const r = await verifyRegistration(regArgs({
    expected: {
      rootStore: { isRecent: () => true }, // the membership window is happy
      season: "4",
      contextHash: "5",
      engine: "plonk",
      statement: "derive",
      rootEligible: () => false, // the registration rule is not
    },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-or-unknown-root");
});

test("an eligible root still registers, so the anchor rule has an exit", async () => {
  const r = await verifyRegistration(regArgs({
    expected: {
      rootStore: { isRecent: () => true },
      season: "4",
      contextHash: "5",
      engine: "plonk",
      statement: "derive",
      rootEligible: () => true,
    },
  }));
  assert.equal(r.ok, true, "ordinary correct registration is unaffected");
});

test("a caller supplying no anchor rule falls back to the membership window exactly as before", async () => {
  const r = await verifyRegistration(regArgs());
  assert.equal(r.ok, true);
  const stale = await verifyRegistration(regArgs({
    expected: { rootStore: { isRecent: () => false }, season: "4", contextHash: "5", engine: "plonk", statement: "derive" },
  }));
  assert.equal(stale.reason, "stale-or-unknown-root");
});

test("the anchor rule is ADDITIONAL to the window, never a replacement for it", async () => {
  // A predicate that says yes cannot rescue a root the window has dropped. Treating the predicate as
  // a replacement made the contract depend on every caller re-checking recency inside its own rule,
  // and a caller that forgot would have widened acceptance while reading like it narrowed it.
  const r = await verifyRegistration(regArgs({
    expected: {
      rootStore: { isRecent: () => false }, // the window says no
      season: "4",
      contextHash: "5",
      engine: "plonk",
      statement: "derive",
      rootEligible: () => true, // and the tighter rule says yes
    },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-or-unknown-root", "the window is the floor");
});

test("a root aging out DURING the spend does not burn the member's epoch", async () => {
  // The tag is keyed by (epoch, context, nullifier). If the epoch or season moved, the next attempt
  // uses a different key and refusing costs nothing. If the ROOT aged out, the epoch is unchanged,
  // the tag is spent, and no grant came back. Locally that is recoverable, because the store records
  // the granting account and the same account can be re-granted. On the Platform store it is not:
  // the account is deliberately not persisted for privacy, so no re-grant is possible and the member
  // is denied for the rest of the epoch by a timing condition they cannot observe. The root was
  // already checked twice before the spend, so refusing a third time here costs more than it saves.
  const nullifiers = new NullifierStore();
  let written = false;
  const wrapped = {
    has: (...a) => nullifiers.has(...a),
    get: (...a) => nullifiers.get(...a),
    add: async (...a) => { const r = await nullifiers.add(...a); written = true; return r; },
  };
  const r = await verifyMembership({
    ...args("alice", { nullifiers: wrapped }),
    expected: {
      ...baseExpected("alice"),
      stillCurrent: async () => (written ? "stale-or-unknown-root" : null),
    },
  });
  assert.equal(r.ok, true, "the grant stands rather than burning an epoch the member cannot recover");
  assert.equal(await nullifiers.has("7", "333", "111"), true);
});

test("a period that ends during the spend is still refused, because the next tag differs", async () => {
  // The other half, so the narrowing above is not mistaken for dropping the check.
  const nullifiers = new NullifierStore();
  let written = false;
  const wrapped = {
    has: (...a) => nullifiers.has(...a),
    get: (...a) => nullifiers.get(...a),
    add: async (...a) => { const r = await nullifiers.add(...a); written = true; return r; },
  };
  const r = await verifyMembership({
    ...args("alice", { nullifiers: wrapped }),
    expected: {
      ...baseExpected("alice"),
      stillCurrent: async () => (written ? "epoch-rolled-over" : null),
    },
  });
  assert.equal(r.ok, false, "an ended epoch still refuses");
  assert.equal(r.reason, "epoch-rolled-over");
});
