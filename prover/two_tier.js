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
//   node prover/two_tier.js register --gateway URL --platform discord --community ID --role ID --voting-key WIF
//   node prover/two_tier.js prove    --gateway URL --platform discord --community ID --role ID [--account NAME]
import * as snarkjs from "snarkjs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildPoseidon } from "circomlibjs";
import { wifToPriv, leafFromPriv } from "../common/dml.js";
import { contextHash } from "../common/index.js";

const TREE_DEPTH = 16;
const B = "circuits/build";

function flags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

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
  const priv = wifToPriv(a["voting-key"]);
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

  const secret = BigInt("0x" + randomBytes(31).toString("hex")).toString();
  console.log("generating registration proof (heavy, once per season) ...");
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(
    { privkey: privToLimbs(priv), pathElements, pathIndices, secret, root, season, contextHash: ctx },
    `${B}/mno_registration_js/mno_registration.wasm`,
    `${B}/mno_registration.zkey`
  );

  const out = a["secret-out"] ?? "member.secret.json";
  await writeFile(out, JSON.stringify({ secret, platform: a.platform, community: a.community, role: a.role }));

  const res = await post(`${a.gateway}/v1/register`, {
    platform: a.platform,
    communityId: a.community,
    roleId: a.role,
    proof,
    publicSignals,
  });
  if (!res.ok) {
    console.error("registration rejected:", res.reason ?? res.error);
    process.exit(1);
  }
  console.log(`registered at members-tree index ${res.index}. Secret saved to ${out}, keep it safe.`);
}

async function prove(a) {
  const { secret } = JSON.parse(await readFile(a.secret ?? "member.secret.json", "utf8"));
  const account = a.account ?? "cli-member";

  const ch = await post(`${a.gateway}/v1/challenge`, {
    platform: a.platform,
    communityId: a.community,
    roleId: a.role,
    account,
  });
  if (!ch.nonce) {
    console.error("could not get a challenge:", ch.error);
    process.exit(1);
  }

  // Fetch the members tree for this challenge's context, since each community has its own tree.
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

  const res = await post(`${a.gateway}/v1/verify`, { nonce: ch.nonce, proof, publicSignals, account });
  if (!res.ok) {
    console.error("verification failed:", res.reason);
    process.exit(1);
  }
  console.log(`verified. access granted to ${res.account} for epoch ${res.epoch}.`);
}

const sub = process.argv[2];
const a = flags(process.argv.slice(3));
if (sub === "register") await register(a);
else if (sub === "prove") await prove(a);
else {
  console.error("usage: node prover/two_tier.js <register|prove> --gateway URL --platform P --community ID --role ID [--voting-key WIF]");
  process.exit(1);
}
