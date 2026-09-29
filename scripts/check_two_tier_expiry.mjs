// End-to-end check of two-tier grant expiry with a REAL members proof (review finding F1, 2026-09-27).
//
// A two-tier grant used to end at its epoch end even when its season ended first, so a grant minted
// just before a season boundary outlived the season whose members tree vouched for it. The unit tests
// in test/grant_expiry.test.js pin the rule. This checks the WIRING: the real gateway, the real
// `prover/two_tier.js prove` command, a real PLONK proof, and the real verify response.
//
// Three scenarios, each in a fresh gateway with its clock set by replacing Date.now in THIS process
// (the prover runs as a child with the real clock, which it does not use):
// - 120 seconds before a season boundary that does not coincide with an epoch boundary. The grant
//   must end AT the season boundary.
// - The contrary control, ten days into a season. The grant must end at its epoch end.
// - The two-tier DEFAULT schedule, with MNO_EPOCH_SECONDS unset, ten days into a season. The epoch
//   defaults to the season (2026-09-29), so the grant must end at the season end. Under a one-week
//   epoch it would end at the epoch end instead, so the expected value tells the two apart.
//
// The member is seeded through the project's own RegistrationStore, as a heavy registration proof
// would have written it, so only the cheap members proof runs. Needs circuits/build/mno_members.zkey
// and mno_members_js/mno_members.wasm (scripts/fetch_keys.sh). Run from the repository root.
// The circuits CI job runs it. It exits nonzero on any failure.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { createGateway } from "../core/gateway.js";
import { buildConfig } from "../core/config.js";
import { RegistrationStore, FileBackend } from "../core/registration_store.js";
import { contextHash, epochNow, seasonNow, scheduleId } from "../common/index.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { releaseProvingThreads } from "../prover/proving_threads.js";

const EPOCH = 7 * 24 * 3600; // an explicit two-tier schedule whose boundaries do not coincide
const SEASON = 90 * 24 * 3600;
const PLATFORM = "test";
const COMMUNITY = "expiry-check";
const ROLE = "members";
const CTX = contextHash({ platform: PLATFORM, communityId: COMMUNITY, roleId: ROLE }).toString();

for (const f of ["circuits/build/mno_members.zkey", "circuits/build/mno_members_js/mno_members.wasm"]) {
  if (!existsSync(f)) {
    console.error(`missing ${f}. Run bash scripts/fetch_keys.sh from the repository root first.`);
    process.exit(1);
  }
}

const poseidon = await buildPoseidon();
const F = poseidon.F;
const dmlRoot = await makeDmlRootHasher();
const realDateNow = Date.now;

async function scenario(name, fakeNow, expected, { defaultEpoch = false } = {}) {
  // With MNO_EPOCH_SECONDS unset, the two-tier default is the season length.
  const epochLen = defaultEpoch ? SEASON : EPOCH;
  const dir = mkdtempSync(join(tmpdir(), "expiry-check-"));
  let gateway = null;
  Date.now = () => fakeNow * 1000;
  try {
    const season = seasonNow(SEASON, fakeNow);
    // A snapshot for the gateway to boot on. Its content does not matter to a members proof.
    const leaves = ["1"];
    writeFileSync(join(dir, "root.json"), JSON.stringify({ height: 1, blockHash: "ab".repeat(32), depth: 16, root: dmlRoot(leaves), leaves, ts: fakeNow }));
    writeFileSync(join(dir, "groth16_vkey.json"), JSON.stringify(JSON.parse(readFileSync("test/vectors/proof_protocol.json", "utf8")).groth16.vkey));

    // Seed one member for this season and context, as registration would have.
    const secret = BigInt("0x" + randomBytes(24).toString("hex")).toString();
    const commitment = F.toObject(poseidon([F.e(BigInt(secret))])).toString();
    const store = new RegistrationStore(new FileBackend(join(dir, "registrations.jsonl"), scheduleId(epochLen, SEASON), false));
    const seeded = await store.append({ season, contextHash: CTX, regNullifier: "12345", commitment, engine: "groth16", statement: "derive" });
    if (seeded?.invalid || seeded?.duplicate) throw new Error(`seeding the member failed: ${JSON.stringify(seeded)}`);

    const config = buildConfig({
      MNO_MODE: "two-tier",
      ...(defaultEpoch ? {} : { MNO_EPOCH_SECONDS: String(EPOCH) }),
      MNO_SEASON_SECONDS: String(SEASON),
      MNO_ORACLE_SOURCE: join(dir, "root.json"),
      MNO_ALLOW_UNSIGNED_ORACLE: "1",
      MNO_ALLOW_UNAUTH_GATEWAY: "1",
      MNO_REGISTER_CONTEXTS: CTX,
      // No registration proof runs here (the member is seeded), so the registration key only has to
      // satisfy the boot check that it is Groth16, the default engine, so it is the one-constraint test key.
      MNO_REG_VKEY: join(dir, "groth16_vkey.json"),
      MNO_REG_PATH: join(dir, "registrations.jsonl"),
      MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite"),
      MNO_TIME_MARKS_PATH: join(dir, "time_marks.json"),
    });
    if (config.epochSeconds !== epochLen) throw new Error(`FAIL ${name}: the gateway's epoch is ${config.epochSeconds} s, expected ${epochLen} s`);
    gateway = await createGateway({ config });
    await gateway.listen(0);
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const post = async (path, body) =>
      (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

    const ch = await post("/v1/challenge", { platform: PLATFORM, communityId: COMMUNITY, roleId: ROLE, account: "expiry-check" });
    if (!ch.nonce) throw new Error(`no challenge: ${JSON.stringify(ch)}`);
    writeFileSync(join(dir, "challenge.json"), JSON.stringify(ch));
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ secret }), { mode: 0o600 });

    // Asynchronous on purpose. The gateway runs in THIS process, and the prover fetches the members
    // tree from it, so a synchronous child call would block the very event loop that has to answer.
    await promisify(execFile)(
      "node",
      ["prover/two_tier.js", "prove", "--gateway", base, "--challenge", join(dir, "challenge.json"), "--secret", join(dir, "secret.json"), "--out", join(dir, "proof.json")],
      { timeout: 300_000, killSignal: "SIGKILL" },
    );
    const { nonce, proof, publicSignals } = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
    const out = await post("/v1/verify", { nonce, proof, publicSignals, account: "expiry-check" });

    const epochEnd = (epochNow(epochLen, fakeNow) + 1) * epochLen;
    const line = `${name}: verify ok=${out.ok}, expiresAt=${out.expiresAt}, expected=${expected}, epoch end=${epochEnd}, season end=${(season + 1) * SEASON}`;
    if (out.ok !== true || out.expiresAt !== expected) throw new Error(`FAIL ${line} ${out.reason ?? ""}`);
    console.log(`PASS ${line}`);
  } finally {
    Date.now = realDateNow;
    if (gateway) await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The next season boundary that falls INSIDE an epoch, so capping makes a difference.
let s = seasonNow(SEASON, Math.floor(realDateNow() / 1000));
while (((s + 1) * SEASON) % EPOCH === 0) s++;
const seasonEnd = (s + 1) * SEASON;

try {
  await scenario("120 s before a season boundary", seasonEnd - 120, seasonEnd);
  const mid = s * SEASON + 10 * 24 * 3600;
  await scenario("contrary, ten days into the season", mid, (epochNow(EPOCH, mid) + 1) * EPOCH);
  await scenario("default schedule, ten days into the season", mid, seasonEnd, { defaultEpoch: true });
  console.log("two-tier grant expiry verified with real members proofs");
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  // The in-process gateway's proof verification built snarkjs's curve with worker threads, which keep
  // Node alive after the last line (prover/proving_threads.js). Without this the check passed and then
  // never exited, which a CI step would read as a hang.
  await releaseProvingThreads();
}
