// End-to-end check of the Groth16 candidate with REAL proofs, before its circuits are frozen for the
// setup ceremony (docs/CEREMONY.md).
//
// It needs a key set for the two heavy circuits in MNO_CIRCUIT_DIR (default circuits/build/dev, built by
// scripts/groth16_dev_keys.sh, DEVELOPMENT ONLY) and the unchanged members artifacts in circuits/build
// (scripts/fetch_keys.sh). It checks, each by running the real thing:
//
//   1. the members circuit and its committed key are unchanged from main (git), and its proving key
//      still matches the published checksum
//   2. single-tier admission through a real gateway and the real `prover/prover.js`, a Groth16 proof
//   3. two-tier registration through a real gateway and the real `prover/two_tier.js register`, a
//      Groth16 proof under the default 900 s registration-root age limit, timed, then the unchanged
//      recurring members flow (`two_tier.js prove`, PLONK) verified by the same gateway
//   4. a private key of 0 is refused by both heavy circuits, with a key-1 contrary control on the same
//      input builder
//   5. purpose separation on real circuit outputs: for one key and context with the epoch number equal
//      to the season number, the single-tier and registration nullifiers differ, and neither equals the
//      members nullifier of a member who chose secret = Poseidon(privkey limbs)
//   6. every proof verifies under its own key and is refused under each of the others
//
// Run from the repository root. Takes a few minutes. Exits nonzero on any failure.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import bs58check from "bs58check";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { createGateway } from "../core/gateway.js";
import { buildConfig } from "../core/config.js";
import { verifyWithKey } from "../core/verifier.js";
import { contextHash, epochNow, seasonNow } from "../common/index.js";
import { KEY_ZERO_LEAF, leafFromPriv } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { merklePathFor } from "../common/merkle_path.js";
import { releaseProvingThreads } from "../prover/proving_threads.js";

const HEAVY = process.env.MNO_CIRCUIT_DIR ?? "circuits/build/dev";
const B = "circuits/build";
const run = promisify(execFile);
const PLATFORM = "test";
const COMMUNITY = "groth16-candidate";
const ROLE = "members";
const CTX = contextHash({ platform: PLATFORM, communityId: COMMUNITY, roleId: ROLE }).toString();
const REGISTER_ROOT_MAX_AGE = 900; // the default, stated so the check says what it ran under

const files = {
  membershipWasm: `${HEAVY}/mno_membership_js/mno_membership.wasm`,
  membershipZkey: `${HEAVY}/mno_membership.zkey`,
  membershipVkey: `${HEAVY}/mno_membership_vkey.json`,
  registrationWasm: `${HEAVY}/mno_registration_js/mno_registration.wasm`,
  registrationZkey: `${HEAVY}/mno_registration.zkey`,
  registrationVkey: `${HEAVY}/mno_registration_vkey.json`,
  membersWasm: `${B}/mno_members_js/mno_members.wasm`,
  membersZkey: `${B}/mno_members.zkey`,
  membersVkey: `${B}/mno_members_vkey.json`,
};
for (const f of Object.values(files)) {
  if (!existsSync(f)) {
    console.error(`missing ${f}. Build the heavy keys with scripts/groth16_dev_keys.sh and fetch the members artifacts with scripts/fetch_keys.sh.`);
    process.exit(1);
  }
}
const vkeys = {
  membership: JSON.parse(readFileSync(files.membershipVkey, "utf8")),
  registration: JSON.parse(readFileSync(files.registrationVkey, "utf8")),
  members: JSON.parse(readFileSync(files.membersVkey, "utf8")),
};

const poseidon = await buildPoseidon();
const F = poseidon.F;
const dmlRoot = await makeDmlRootHasher();
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

// A fresh random voting key, its WIF, its limbs, and its leaf.
function newKey() {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  let d;
  do d = BigInt("0x" + randomBytes(32).toString("hex")); while (d === 0n || d >= N);
  const priv = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  const wif = bs58check.encode(Buffer.concat([Buffer.from([0xcc]), priv, Buffer.from([0x01])]));
  const limbs = [0n, 1n, 2n, 3n].map((i) => ((d >> (64n * i)) & ((1n << 64n) - 1n)).toString());
  return { priv, wif, limbs, leaf: leafFromPriv(priv).toString() };
}
const key = newKey();
const otherLeaves = [newKey().leaf, newKey().leaf];
const leaves = [otherLeaves[0], key.leaf, otherLeaves[1]];

async function withGateway(dir, env, fn) {
  const nowSec = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, "root.json"), JSON.stringify({ height: 1, blockHash: "ab".repeat(32), depth: 16, root: dmlRoot(leaves), leaves, ts: nowSec }));
  const config = buildConfig({
    MNO_ORACLE_SOURCE: join(dir, "root.json"),
    MNO_ALLOW_UNSIGNED_ORACLE: "1",
    MNO_ALLOW_UNAUTH_GATEWAY: "1",
    MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite"),
    MNO_TIME_MARKS_PATH: join(dir, "time_marks.json"),
    MNO_REG_PATH: join(dir, "registrations.jsonl"),
    ...env,
  });
  const gateway = await createGateway({ config });
  try {
    await gateway.listen(0);
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const post = async (path, body) =>
      (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    return await fn({ base, post, config });
  } finally {
    await gateway.close();
  }
}

const proofs = {};
const dir = mkdtempSync(join(tmpdir(), "groth16-candidate-"));
try {
  // 1. The members circuit and its committed key are unchanged, and its proving key matches the manifest.
  const unchanged = (() => {
    try {
      execFileSync("git", ["diff", "--quiet", "main", "--", "circuits/mno_members.circom", "circuits/merkle.circom", "circuits/build/mno_members_vkey.json"]);
      return true;
    } catch {
      return false;
    }
  })();
  check(unchanged, "members circuit, its Merkle template, and its committed verification key are unchanged from main");
  const manifest = JSON.parse(readFileSync("keys.manifest.json", "utf8"));
  const zkeySha = createHash("sha256").update(readFileSync(files.membersZkey)).digest("hex");
  check(manifest.files.find((f) => f.name === "mno_members.zkey")?.sha256 === zkeySha, "members proving key matches its published sha256");
  check(vkeys.members.protocol === "plonk" && vkeys.membership.protocol === "groth16" && vkeys.registration.protocol === "groth16", "keys: members PLONK, both heavy circuits Groth16");

  // 2. Single-tier admission, gateway and prover CLI.
  writeFileSync(join(dir, "key.wif"), key.wif, { mode: 0o600 });
  await withGateway(dir, { MNO_MODE: "single", MNO_VKEY: files.membershipVkey }, async ({ post }) => {
    const ch = await post("/v1/challenge", { platform: PLATFORM, communityId: COMMUNITY, roleId: ROLE, account: "single-tier" });
    writeFileSync(join(dir, "challenge.json"), JSON.stringify(ch));
    const t0 = Date.now();
    await run("node", ["prover/prover.js", "--challenge", join(dir, "challenge.json"), "--voting-key-file", join(dir, "key.wif"), "--oracle", join(dir, "root.json"), "--out", join(dir, "single.json")], {
      env: { ...process.env, MNO_CIRCUIT_DIR: HEAVY },
      timeout: 600_000,
    });
    const single = JSON.parse(readFileSync(join(dir, "single.json"), "utf8"));
    proofs.single = single;
    const out = await post("/v1/verify", { nonce: single.nonce, proof: single.proof, publicSignals: single.publicSignals, account: "single-tier" });
    check(out.ok === true && single.proof.protocol === "groth16", `single-tier: Groth16 proof accepted by the gateway (prove ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  });

  // 3. Two-tier registration under the default root age limit, then the unchanged members flow.
  await withGateway(dir, { MNO_MODE: "two-tier", MNO_REG_VKEY: files.registrationVkey, MNO_REGISTER_CONTEXTS: CTX, MNO_REGISTER_ROOT_MAX_AGE: String(REGISTER_ROOT_MAX_AGE) }, async ({ base, post, config }) => {
    check(config.registrationEngine === "groth16" && config.registerRootMaxAgeSeconds === REGISTER_ROOT_MAX_AGE, `two-tier: groth16 engine, ${REGISTER_ROOT_MAX_AGE} s registration-root limit`);
    const snapshotTs = JSON.parse(readFileSync(join(dir, "root.json"), "utf8")).ts;
    const t0 = Date.now();
    const reg = await run(
      "node",
      ["prover/two_tier.js", "register", "--gateway", base, "--platform", PLATFORM, "--community", COMMUNITY, "--role", ROLE, "--voting-key-file", join(dir, "key.wif"), "--secret-out", join(dir, "secret.json")],
      { env: { ...process.env, MNO_CIRCUIT_DIR: HEAVY }, timeout: 900_000 },
    );
    const flow = (Date.now() - t0) / 1000;
    const rootAge = Math.floor(Date.now() / 1000) - snapshotTs;
    check(/registered at members-tree index \d+/.test(reg.stdout), `two-tier: registration committed through the gateway, whole flow ${flow.toFixed(1)} s, root age at commit ${rootAge} s of ${REGISTER_ROOT_MAX_AGE}`);

    const ch = await post("/v1/challenge", { platform: PLATFORM, communityId: COMMUNITY, roleId: ROLE, account: "two-tier" });
    writeFileSync(join(dir, "challenge2.json"), JSON.stringify(ch));
    await run("node", ["prover/two_tier.js", "prove", "--gateway", base, "--challenge", join(dir, "challenge2.json"), "--secret", join(dir, "secret.json"), "--out", join(dir, "members.json")], { timeout: 300_000 });
    const members = JSON.parse(readFileSync(join(dir, "members.json"), "utf8"));
    proofs.members = members;
    const out = await post("/v1/verify", { nonce: members.nonce, proof: members.proof, publicSignals: members.publicSignals, account: "two-tier" });
    check(out.ok === true && members.proof.protocol === "plonk", "two-tier: the recurring members PLONK proof is accepted after a Groth16 registration");
  });

  // 4. Key 0 is refused by both heavy circuits. The input puts the key-0 leaf in the tree with a valid
  //    path, so only the key-0 constraint can refuse it. The contrary control builds the same shape of
  //    input for the real key and its leaf.
  const tree = (leaf) => merklePathFor(poseidon, [leaf], 0, 16);
  const baseInputs = (limbs, leaf) => {
    const { pathElements, pathIndices, root } = tree(leaf);
    return {
      membership: { privkey: limbs, pathElements, pathIndices, root, epoch: "230", contextHash: CTX, signalHash: "7" },
      registration: { privkey: limbs, pathElements, pathIndices, root, season: "230", contextHash: CTX, secret: "99" },
    };
  };
  const witnessOk = async (input, wasm) => {
    try {
      await snarkjs.wtns.calculate(input, wasm, { type: "mem" });
      return true;
    } catch {
      return false;
    }
  };
  const zero = baseInputs(["0", "0", "0", "0"], KEY_ZERO_LEAF.toString());
  const real = baseInputs(key.limbs, key.leaf);
  check(!(await witnessOk(zero.membership, files.membershipWasm)) && (await witnessOk(real.membership, files.membershipWasm)), "single-tier circuit: key 0 refused, the same input shape with a real key accepted");
  check(!(await witnessOk(zero.registration, files.registrationWasm)) && (await witnessOk(real.registration, files.registrationWasm)), "registration circuit: key 0 refused, the same input shape with a real key accepted");

  // 5. Purpose separation on real outputs, epoch number = season number = 230, one key and context.
  const sp = await snarkjs.groth16.fullProve(real.membership, files.membershipWasm, files.membershipZkey);
  const rp = await snarkjs.groth16.fullProve(real.registration, files.registrationWasm, files.registrationZkey);
  proofs.single230 = sp;
  proofs.registration = rp;
  const keyHash = F.toObject(poseidon(key.limbs.map((l) => F.e(BigInt(l))))).toString();
  const commitment = F.toObject(poseidon([F.e(BigInt(keyHash))])).toString();
  const mt = merklePathFor(poseidon, [commitment], 0, 16);
  const mp = await snarkjs.plonk.fullProve(
    { secret: keyHash, pathElements: mt.pathElements, pathIndices: mt.pathIndices, membersRoot: mt.root, epoch: "230", contextHash: CTX, signalHash: "7" },
    files.membersWasm,
    files.membersZkey,
  );
  const nfSingle = sp.publicSignals[0];
  const nfReg = rp.publicSignals[1];
  const nfMembers = mp.publicSignals[0];
  check(nfSingle !== nfReg, "one key, epoch number = season number: single-tier and registration nullifiers differ");
  check(nfMembers !== nfSingle && nfMembers !== nfReg, "a member who chose secret = Poseidon(privkey limbs) gets a members nullifier equal to neither");

  // 6. Each proof under each key, accepted only under its own.
  const cases = [
    ["single-tier", sp, vkeys.membership],
    ["registration", rp, vkeys.registration],
    ["members", mp, vkeys.members],
  ];
  for (const [name, p, own] of cases) {
    for (const [keyName, vk] of Object.entries({ "single-tier": vkeys.membership, registration: vkeys.registration, members: vkeys.members })) {
      const ok = (await verifyWithKey(vk, p.publicSignals, p.proof).catch(() => false)) === true;
      check(ok === (vk === own), `${name} proof under the ${keyName} key: ${ok ? "accepted" : "refused"}`);
    }
  }
} catch (err) {
  console.error(err?.stack ?? String(err));
  failures++;
} finally {
  rmSync(dir, { recursive: true, force: true });
  await releaseProvingThreads();
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("all candidate checks passed");
}
