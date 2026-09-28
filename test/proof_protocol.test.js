import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyWithKey, requireProtocol, verifyRegistration } from "../core/verifier.js";
import { releaseProvingThreads } from "../prover/proving_threads.js";

// The proof system is chosen by the verification key the gateway loaded, never by the proof. These run
// real Groth16 and PLONK proofs of a one-constraint circuit (test/protocol/make_vectors.sh), so the
// dispatch and the refusals are exercised on the verifiers themselves.
const V = JSON.parse(readFileSync(new URL("./vectors/proof_protocol.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const accepted = async (vkey, publicSignals, proof) => (await verifyWithKey(vkey, publicSignals, proof).catch(() => false)) === true;

test.after(releaseProvingThreads);

test("contrary: each proof verifies under its own key", async () => {
  assert.equal(await accepted(V.groth16.vkey, V.groth16.publicSignals, V.groth16.proof), true);
  assert.equal(await accepted(V.plonk.vkey, V.plonk.publicSignals, V.plonk.proof), true);
});

test("a proof is refused under a key for the other proof system", async () => {
  assert.equal(await accepted(V.plonk.vkey, V.groth16.publicSignals, V.groth16.proof), false, "Groth16 proof, PLONK key");
  assert.equal(await accepted(V.groth16.vkey, V.plonk.publicSignals, V.plonk.proof), false, "PLONK proof, Groth16 key");
});

test("a proof that claims the key's system without being a proof of it is refused", async () => {
  const relabeled = { ...clone(V.groth16.proof), protocol: "plonk" };
  assert.equal(await accepted(V.plonk.vkey, V.groth16.publicSignals, relabeled), false);
  const relabeledPlonk = { ...clone(V.plonk.proof), protocol: "groth16" };
  assert.equal(await accepted(V.groth16.vkey, V.plonk.publicSignals, relabeledPlonk), false);
});

test("a changed public signal is refused under the right key", async () => {
  assert.equal(await accepted(V.groth16.vkey, ["34"], V.groth16.proof), false);
  assert.equal(await accepted(V.plonk.vkey, ["34"], V.plonk.proof), false);
});

test("a key with an unsupported or missing protocol is an error, not a verdict", async () => {
  assert.throws(() => verifyWithKey({ ...V.groth16.vkey, protocol: "fflonk" }, V.groth16.publicSignals, V.groth16.proof), /not supported/);
  assert.throws(() => verifyWithKey({}, V.groth16.publicSignals, V.groth16.proof), /not supported/);
});

test("the boot check refuses a key for the wrong proof system and names the setting", () => {
  assert.doesNotThrow(() => requireProtocol(V.groth16.vkey, "groth16", "MNO_VKEY", "the single-tier admission circuit"));
  assert.throws(() => requireProtocol(V.plonk.vkey, "groth16", "MNO_VKEY", "the single-tier admission circuit"), /MNO_VKEY holds a "plonk" verification key/);
  assert.throws(() => requireProtocol(V.groth16.vkey, "plonk", "MNO_MEMBERS_VKEY", "the two-tier members circuit"), /MNO_MEMBERS_VKEY/);
});

test("a valid proof relabeled as another system is refused even under its own key", async () => {
  // The only thing refusing this is the proof-protocol guard: snarkjs's Groth16 verifier does not read
  // the label, and without the guard this proof verifies.
  const relabeled = { ...clone(V.groth16.proof), protocol: "plonk" };
  assert.equal(await accepted(V.groth16.vkey, V.groth16.publicSignals, relabeled), false);
});

// The registration path, driven with real proofs of five_signals.circom, which has the registration
// circuit's public-signal shape, so every policy check passes and the verdict comes from the crypto check.
const F5 = V.five;
function register({ engine, vkey, proof, publicSignals }) {
  const committed = [];
  const result = verifyRegistration({
    vkey,
    proof,
    publicSignals,
    expected: { rootStore: { isRecent: () => true }, season: "7", contextHash: "5", engine, statement: "derive" },
    registrationStore: { has: async () => false },
    commit: async (record) => {
      committed.push(record);
      return { ok: true };
    },
  });
  return result.then((r) => ({ r, committed }));
}

test("contrary: a valid Groth16 registration-shaped proof under a Groth16 key registers under groth16", async () => {
  const { r, committed } = await register({ engine: "groth16", ...F5.groth16 });
  assert.deepEqual(r, { ok: true });
  assert.equal(committed.length, 1);
  assert.equal(committed[0].engine, "groth16");
});

test("a valid PLONK proof under its own PLONK key is refused by the groth16 registration path, and nothing is written", async () => {
  // The proof and key agree with each other, so the proof-protocol guard passes them and PLONK would
  // verify them. Only the binding of the registration path to Groth16 keys refuses it.
  const { r, committed } = await register({ engine: "groth16", ...F5.plonk });
  assert.deepEqual(r, { ok: false, reason: "invalid-proof" });
  assert.equal(committed.length, 0);
});

test("the retired plonk engine and the zkvm engine are refused by the circuit registration path before any check", async () => {
  for (const engine of ["plonk", "zkvm"]) {
    const { r, committed } = await register({ engine, ...F5.plonk });
    assert.deepEqual(r, { ok: false, reason: "engine-mismatch" }, engine);
    assert.equal(committed.length, 0);
  }
});
