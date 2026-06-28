import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMembership } from "../core/verifier.js";
import { NullifierStore } from "../core/stores.js";
import { DocumentNullifierStore, MemoryBackend } from "../core/platform_store.js";

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
