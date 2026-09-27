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

test("a registration whose key does not match its declared engine is refused and writes no record", async () => {
  // Five canonical signals, so decoding succeeds and the policy checks pass. The refusal can come from
  // the key-and-engine binding or from the proof-protocol guard, which this vector cannot tell apart.
  // What keeps such a key from being loaded at all is the boot check, tested above.
  const signals = ["1", "2", "3", "7", "5"]; // commitment, regNullifier, root, season, contextHash
  let committed = false;
  const run = (engine, vkey) =>
    verifyRegistration({
      vkey,
      proof: V.groth16.proof,
      publicSignals: signals,
      expected: { rootStore: { isRecent: () => true }, season: "7", contextHash: "5", engine, statement: "derive" },
      registrationStore: { has: async () => false },
      commit: async () => {
        committed = true;
        return { ok: true };
      },
    });
  assert.deepEqual(await run("groth16", V.plonk.vkey), { ok: false, reason: "invalid-proof" });
  assert.deepEqual(await run("plonk", V.groth16.vkey), { ok: false, reason: "invalid-proof" });
  assert.deepEqual(await run("zkvm", V.groth16.vkey), { ok: false, reason: "engine-mismatch" });
  assert.equal(committed, false);
});
