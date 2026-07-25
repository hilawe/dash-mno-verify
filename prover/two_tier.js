// Two-tier prover CLI. Runs on the member's own machine.
//
//   register: prove masternode control once per season. Heavy (it does the secp256k1 and
//             hash160 work), so it needs a machine with several GB of RAM. It saves a
//             secret you keep, and registers your commitment with the gateway.
//
//   prove:    the per-epoch membership proof. Cheap (a few seconds, a small key), so it
//             runs fine on something like a Raspberry Pi. This is the one you run often.
//
// Usage:
//   node prover/two_tier.js register --gateway URL --platform discord --community ID --role ID --voting-key-file key.wif
//   node prover/two_tier.js prove    --gateway URL --challenge challenge.json [--secret PATH] [--out proof.json]
// The voting key may also be piped in with --voting-key-stdin. --voting-key WIF still works but
// leaves the key in shell history and the process list, so it warns.
// The adapter mints challenge.json (it holds the gateway token) and submits the resulting proof.json.
import * as snarkjs from "snarkjs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { wifToPriv, leafFromPriv } from "../common/dml.js";
import { contextHash } from "../common/index.js";
import { loadVotingKey } from "./voting_key.js";
import {
  defaultSecretPath,
  findSecretForContext,
  markSecretAccepted,
  resolveSecret,
  writePendingSecret,
} from "./secret_file.js";

const TREE_DEPTH = 16;
const B = "circuits/build";

function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

// This CLI runs on the member's machine and never holds the adapter secret. It calls only the
// public read endpoints (/v1/dml, /v1/members) and the accountless, proof-authenticated /v1/register.
// The account-bearing endpoints (/v1/challenge, /v1/verify) belong to the adapter: it mints the
// challenge, hands it to the member, and submits the resulting proof. So `prove` consumes a challenge
// and emits a proof file, exactly like the single-tier prover.
const get = async (url) => (await fetch(url)).json();
const post = async (url, body) =>
  (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

function privToLimbs(priv) {
  const d = BigInt("0x" + Buffer.from(priv).toString("hex"));
  const mask = (1n << 64n) - 1n;
  return [0, 1, 2, 3].map((i) => ((d >> (64n * BigInt(i))) & mask).toString());
}

// Build a Merkle path for a leaf at `index`, padding empties with 0. Returns the path and
// the tree root so the caller can confirm it matches what the gateway expects.
function buildPath(poseidon, leavesDec, index) {
  const F = poseidon.F;
  let level = leavesDec.map((x) => F.e(BigInt(x)));
  while (level.length < 2 ** TREE_DEPTH) level.push(F.e(0n));
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon([level[i], level[i + 1]]));
    level = next;
    levels.push(level);
  }
  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let l = 0; l < TREE_DEPTH; l++) {
    pathElements.push(F.toObject(levels[l][idx ^ 1]).toString());
    pathIndices.push(idx & 1);
    idx >>= 1;
  }
  return { pathElements, pathIndices, root: F.toObject(levels.at(-1)[0]).toString() };
}

async function register(a) {
  const priv = wifToPriv(await loadVotingKey(a));
  const ctx = contextHash({ platform: a.platform, communityId: a.community, roleId: a.role }).toString();

  const dml = await get(`${a.gateway}/v1/dml`);
  const health = await get(`${a.gateway}/v1/health`);
  const season = String(health.season);

  const myLeaf = leafFromPriv(priv).toString();
  const index = dml.leaves.indexOf(myLeaf);
  if (index < 0) {
    console.error("Your voting key is not in the masternode list the gateway is using.");
    process.exit(1);
  }

  const poseidon = await buildPoseidon();
  const { pathElements, pathIndices, root } = buildPath(poseidon, dml.leaves, index);
  if (root !== dml.root) {
    console.error("The masternode list moved while building the path. Re-run register.");
    process.exit(1);
  }

  // Resolve the secret BEFORE proving, so a crash during the long proof cannot lose it, and so a
  // re-run reuses the secret an earlier attempt already committed to rather than minting a new one.
  const out = a["secret-out"] ?? defaultSecretPath({ platform: a.platform, community: a.community, role: a.role, season });
  const existing = await resolveSecret(out);
  if (existing.kind === "accepted") {
    console.error(
      `${out} holds an accepted registration for this season already (members-tree index ` +
        `${existing.record.index ?? "unknown"}). Registration is once per season, so there is nothing ` +
        `to do. Run the per-epoch prove with --secret ${out}.`,
    );
    process.exit(1);
  }
  if (existing.kind === "unknown") {
    console.error(`${out} exists but is not a secret file this tool wrote. Move it aside and re-run.`);
    process.exit(1);
  }

  let secret;
  if (existing.kind === "retry") {
    secret = existing.record.secret;
    console.log(`resuming the pending registration in ${out} (reusing its secret, not minting a new one)`);
  } else {
    secret = BigInt("0x" + randomBytes(31).toString("hex")).toString();
    await writePendingSecret(out, {
      secret,
      platform: a.platform,
      community: a.community,
      role: a.role,
      season,
      contextHash: ctx,
    });
    console.log(`secret saved to ${out} (mode 600) before proving, so a crash cannot lose it`);
  }

  console.log("generating registration proof (heavy, once per season) ...");
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(
    { privkey: privToLimbs(priv), pathElements, pathIndices, secret, root, season, contextHash: ctx },
    `${B}/mno_registration_js/mno_registration.wasm`,
    `${B}/mno_registration.zkey`
  );

  const res = await post(`${a.gateway}/v1/register`, {
    platform: a.platform,
    communityId: a.community,
    roleId: a.role,
    proof,
    publicSignals,
  });
  if (!res.ok) {
    // The secret file stays exactly as it is. If the gateway actually committed and only the
    // response went missing, the secret still matches the commitment it holds, and re-running
    // resumes from the same pending file instead of minting a secret that would not match.
    console.error("registration rejected:", res.reason ?? res.error);
    console.error(`${out} was kept. Re-run register to retry with the same secret.`);
    process.exit(1);
  }
  await markSecretAccepted(out, { index: res.index, membersRoot: res.membersRoot });
  console.log(`registered at members-tree index ${res.index}. Secret saved to ${out}, keep it safe.`);
}

async function prove(a) {
  // The adapter mints the challenge (it authenticates the platform account and holds the gateway
  // token) and hands challenge.json to the member. This CLI consumes it and never calls the
  // account-bearing endpoints.
  const ch = JSON.parse(await readFile(a.challenge ?? "challenge.json", "utf8"));

  // Secrets are named per (platform, community, role, season), so without an explicit --secret the
  // right one is the one recorded against this challenge's context.
  const secretPath = a.secret ?? (await findSecretForContext(ch.contextHash));
  if (!secretPath) {
    console.error(
      "no member secret found for this challenge's context. Run register first, or pass --secret <path>.",
    );
    process.exit(1);
  }
  const { secret } = JSON.parse(await readFile(secretPath, "utf8"));

  // The members tree for this challenge's context. A public read, so no token and no account.
  const members = await get(`${a.gateway}/v1/members?context=${encodeURIComponent(ch.contextHash)}`);
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const commitment = F.toObject(poseidon([F.e(BigInt(secret))])).toString();
  const index = members.commitments.indexOf(commitment);
  if (index < 0) {
    console.error("Your commitment is not in the members tree yet. Run register first.");
    process.exit(1);
  }

  const { pathElements, pathIndices, root } = buildPath(poseidon, members.commitments, index);
  console.log("generating members proof (cheap, every epoch) ...");
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(
    { secret, pathElements, pathIndices, membersRoot: root, epoch: String(ch.epoch), contextHash: ch.contextHash, signalHash: ch.signalHash },
    `${B}/mno_members_js/mno_members.wasm`,
    `${B}/mno_members.zkey`
  );

  const out = a.out ?? "proof.json";
  await writeFile(out, JSON.stringify({ nonce: ch.nonce, proof, publicSignals }, null, 2));
  console.log(`Wrote ${out}. Submit it through your adapter, which calls /v1/verify. Your secret never left this machine.`);
}

const sub = process.argv[2];
const a = flags(process.argv.slice(3));
if (sub === "register") await register(a);
else if (sub === "prove") await prove(a);
else {
  console.error(
    "usage:\n" +
      "  node prover/two_tier.js register --gateway URL --platform P --community ID --role ID --voting-key-file PATH\n" +
      "  node prover/two_tier.js prove --gateway URL --challenge challenge.json [--secret PATH] [--out proof.json]\n" +
      "\nThe voting key may be given as --voting-key-file PATH (recommended, mode 600), piped in with\n" +
      "--voting-key-stdin, or as --voting-key WIF (discouraged: it lands in shell history).",
  );
  process.exit(1);
}
