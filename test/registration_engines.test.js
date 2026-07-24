// Step 5 spine: the engine-neutral registration claims and core (docs/ZKVM_INTEGRATION.md). Both the
// PLONK and zkVM decoders produce the same five-claim object, and the engine-neutral core runs the
// identical policy pipeline for either, with the crypto check injected. The zkVM journal decoder is
// pinned against the same frozen fixture the guest and Rust vectors reproduce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodePlonkRegistrationClaims,
  decodeZkvmRegistrationClaims,
  verifyRegistrationCore,
  verifyRegistration,
  verifyZkvmRegistration,
  REG_JOURNAL_BYTES,
} from "../core/verifier.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./vectors/zkvm_golden.json", import.meta.url)));

test("the PLONK decoder reads the five-signal array and rejects a non-canonical signal", () => {
  const ok = decodePlonkRegistrationClaims(["10", "11", "12", "13", "14"]);
  assert.deepEqual(ok.claims, { commitment: "10", regNullifier: "11", root: "12", season: "13", contextHash: "14" });
  // "01" is non-canonical as a string (leading zero) but this checks field-canonicality, so use a
  // genuinely out-of-range value: FIELD_PRIME itself is rejected.
  const p = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
  const bad = decodePlonkRegistrationClaims(["1", p, "3", "4", "5"]);
  assert.equal(bad.error, "non-canonical-signal");
});

test("the zkVM decoder parses the frozen 136-byte journal into the same claim shape", () => {
  const journal = Buffer.from(FIXTURE.journalLeftHex, "hex");
  assert.equal(journal.length, REG_JOURNAL_BYTES);
  const { claims } = decodeZkvmRegistrationClaims(journal);
  // commitment and regNullifier are the fixture's decimal field elements.
  assert.equal(claims.commitment, FIXTURE.poseidon1_of_1);
  assert.equal(claims.regNullifier, FIXTURE.rn_d1);
  // root is the SHA-256 tree root as hex, season and context from the fixture.
  assert.equal(claims.root, FIXTURE.rootTwoLeavesHex);
  assert.equal(claims.season, FIXTURE.season);
  assert.equal(claims.contextHash, FIXTURE.contextHash);
});

test("the zkVM decoder rejects a wrong-length journal and a non-canonical field claim", () => {
  assert.equal(decodeZkvmRegistrationClaims(Buffer.alloc(135)).error, "bad-journal-length");
  assert.equal(decodeZkvmRegistrationClaims(Buffer.alloc(137)).error, "bad-journal-length");
  // A journal whose commitment is the field prime (non-canonical) is rejected like the PLONK path.
  const j = Buffer.from(FIXTURE.journalLeftHex, "hex");
  const p = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
  Buffer.from(p.toString(16).padStart(64, "0"), "hex").copy(j, 0); // overwrite commitment
  assert.equal(decodeZkvmRegistrationClaims(j).error, "non-canonical-signal");
});

test("both decoders feed the same engine-neutral core, which runs one policy pipeline", async () => {
  const claims = { commitment: "9", regNullifier: "7", root: "abc", season: "5", contextHash: "3" };
  const expected = { rootStore: { isRecent: (r) => r === "abc" }, season: "5", contextHash: "3", engine: "plonk", statement: "derive" };
  const registrationStore = { has: async () => false };
  let committed = null;
  const commit = async (c) => ((committed = c), { ok: true, index: 0, membersRoot: "R", size: 1 });

  // happy path: injected verify passes, the core commits the decoded claims plus the gateway-chosen
  // engine and statement (which bind the bucket's durable declaration).
  const ok = await verifyRegistrationCore({ claims, verifyProof: async () => true, expected, registrationStore, commit });
  assert.deepEqual(ok, { ok: true, index: 0, membersRoot: "R", size: 1 });
  assert.deepEqual(committed, { season: "5", contextHash: "3", regNullifier: "7", commitment: "9", engine: "plonk", statement: "derive" });

  // a stale root is rejected before the crypto check
  let verifyCalled = false;
  const stale = await verifyRegistrationCore({
    claims: { ...claims, root: "stale" },
    verifyProof: async () => ((verifyCalled = true), true),
    expected, registrationStore, commit,
  });
  assert.equal(stale.reason, "stale-or-unknown-root");
  assert.equal(verifyCalled, false, "policy rejects before the expensive verify");

  // an invalid proof is rejected after policy, before commit
  const bad = await verifyRegistrationCore({ claims, verifyProof: async () => false, expected, registrationStore, commit });
  assert.equal(bad.reason, "invalid-proof");

  // an already-registered nullifier is rejected before the crypto check
  const seen = { has: async () => true };
  let v2 = false;
  const dup = await verifyRegistrationCore({
    claims, verifyProof: async () => ((v2 = true), true), expected, registrationStore: seen, commit,
  });
  assert.equal(dup.reason, "already-registered");
  assert.equal(v2, false);
});

test("verifyZkvmRegistration decodes the journal, policy-checks, then verifies the receipt", async () => {
  const journal = Buffer.from(FIXTURE.journalLeftHex, "hex");
  // expected uses the SHA-256 root (the fixture's tree root) and the zkVM declaration.
  const expected = {
    rootStore: { isRecent: (r) => r === FIXTURE.rootTwoLeavesHex },
    season: FIXTURE.season,
    contextHash: FIXTURE.contextHash,
    engine: "zkvm",
    statement: "custody",
  };
  const registrationStore = { has: async () => false };
  let committed = null;
  const commit = async (c) => ((committed = c), { ok: true, index: 0, membersRoot: "R", size: 1 });

  // happy path: the injected receipt verifier passes, the core commits the decoded claims.
  let receivedReceipt = null;
  const ok = await verifyZkvmRegistration({
    receipt: { fake: true },
    journalBytes: journal,
    verifyReceipt: async (receipt, jb) => ((receivedReceipt = receipt), jb === journal),
    expected, registrationStore, commit,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(receivedReceipt, { fake: true }, "the receipt verifier saw the receipt");
  assert.equal(committed.regNullifier, FIXTURE.rn_d1);
  assert.equal(committed.engine, "zkvm");
  assert.equal(committed.statement, "custody");

  // an unconfigured verifier fails closed, before any commit.
  const noVerifier = await verifyZkvmRegistration({
    receipt: {}, journalBytes: journal, verifyReceipt: undefined, expected, registrationStore, commit,
  });
  assert.equal(noVerifier.reason, "zkvm-verifier-not-configured");

  // a receipt that does not verify is rejected after the policy checks.
  const badReceipt = await verifyZkvmRegistration({
    receipt: {}, journalBytes: journal, verifyReceipt: async () => false, expected, registrationStore, commit,
  });
  assert.equal(badReceipt.reason, "invalid-proof");

  // a stale root is rejected before the receipt verify.
  let verified = false;
  const stale = await verifyZkvmRegistration({
    receipt: {}, journalBytes: journal,
    verifyReceipt: async () => ((verified = true), true),
    expected: { ...expected, rootStore: { isRecent: () => false } },
    registrationStore, commit,
  });
  assert.equal(stale.reason, "stale-or-unknown-root");
  assert.equal(verified, false);

  // a malformed journal is rejected.
  const shortJournal = await verifyZkvmRegistration({
    receipt: {}, journalBytes: Buffer.alloc(100), verifyReceipt: async () => true, expected, registrationStore, commit,
  });
  assert.equal(shortJournal.reason, "bad-journal-length");

  // each wrapper pins its own engine: the zkVM wrapper rejects a plonk declaration outright, so a
  // mis-wired dispatcher cannot commit a zkVM registration under a PLONK label (and vice versa).
  let committedMismatch = false;
  const wrongEngine = await verifyZkvmRegistration({
    receipt: {}, journalBytes: journal, verifyReceipt: async () => true,
    expected: { ...expected, engine: "plonk", statement: "derive" },
    registrationStore, commit: async () => ((committedMismatch = true), { ok: true }),
  });
  assert.equal(wrongEngine.reason, "engine-mismatch");
  assert.equal(committedMismatch, false, "nothing was committed under the wrong engine");
});

test("the PLONK wrapper rejects a non-plonk engine declaration", async () => {
  const r = await verifyRegistration({
    vkey: {},
    proof: {},
    publicSignals: ["1", "2", "3", "4", "5"],
    expected: { rootStore: { isRecent: () => true }, season: "3", contextHash: "5", engine: "zkvm", statement: "custody" },
    registrationStore: { has: async () => false },
    commit: async () => ({ ok: true }),
    verifyProof: async () => true,
  });
  assert.equal(r.reason, "engine-mismatch");
});
