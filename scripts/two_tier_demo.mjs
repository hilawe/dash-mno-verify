// End-to-end two-tier demo. Register once (a heavy proof of masternode control that emits
// a member commitment), then prove membership per epoch (a cheap proof against the members
// tree). It runs real PLONK proofs through the actual gateway verify functions, so a pass
// means the whole two-tier flow works, not just the circuits in isolation.
//
// Needs the registration and members proving keys in circuits/build (build them first).
// Usage: node scripts/two_tier_demo.mjs
import * as snarkjs from "snarkjs";
import { readFile } from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";
import { leafFromPriv } from "../common/dml.js";
import { contextHash, signalHash } from "../common/index.js";
import { MembersTree } from "../core/members_tree.js";
import { RootStore, NullifierStore } from "../core/stores.js";
import { RegistrationStore, MemoryRegistrationBackend } from "../core/registration_store.js";
import { verifyRegistration, verifyMembership } from "../core/verifier.js";

const TREE_DEPTH = 16;
const B = "circuits/build";

const priv = Uint8Array.from(Buffer.from("00".repeat(31) + "01", "hex"));
const secret = "987654321"; // a real member draws this randomly and keeps it
const season = "1";
const epoch = "1";
const ctx = contextHash({ platform: "demo", communityId: "demo", roleId: "member" }).toString();
const sig = signalHash("demo-nonce", "demo-account").toString();

const poseidon = await buildPoseidon();
const F = poseidon.F;

// DML tree with this node's voting-key hash160 at index 0
const dmlLeaves = [leafFromPriv(priv)];
while (dmlLeaves.length < 2 ** TREE_DEPTH) dmlLeaves.push(0n);
let lvl = dmlLeaves.map((x) => F.e(x));
const dmlLevels = [lvl];
while (lvl.length > 1) {
  const nx = [];
  for (let i = 0; i < lvl.length; i += 2) nx.push(poseidon([lvl[i], lvl[i + 1]]));
  lvl = nx;
  dmlLevels.push(lvl);
}
const dmlRoot = F.toObject(dmlLevels.at(-1)[0]).toString();
const dmlPathE = [];
const dmlPathI = [];
for (let l = 0, idx = 0; l < TREE_DEPTH; l++, idx >>= 1) {
  dmlPathE.push(F.toObject(dmlLevels[l][idx ^ 1]).toString());
  dmlPathI.push(idx & 1);
}

const d = BigInt("0x" + Buffer.from(priv).toString("hex"));
const mask = (1n << 64n) - 1n;
const privkey = [0, 1, 2, 3].map((i) => ((d >> (64n * BigInt(i))) & mask).toString());

// 1) REGISTRATION (heavy, once per season)
console.log("1. registration: proving masternode control, emitting a member commitment ...");
const tReg = Date.now();
const reg = await snarkjs.plonk.fullProve(
  { privkey, pathElements: dmlPathE, pathIndices: dmlPathI, secret, root: dmlRoot, season, contextHash: ctx },
  `${B}/mno_registration_js/mno_registration.wasm`,
  `${B}/mno_registration.zkey`
);
console.log(`   registration proof generated in ${((Date.now() - tReg) / 1000).toFixed(1)}s (heavy, once per season)`);

const dmlRoots = new RootStore(8);
dmlRoots.update([{ height: 1, root: dmlRoot, ts: 0 }]);
const registrationStore = new RegistrationStore(new MemoryRegistrationBackend());
const membersTree = await MembersTree.create();

const regResult = await verifyRegistration({
  vkey: JSON.parse(await readFile(`${B}/mno_registration_vkey.json`, "utf8")),
  proof: reg.proof,
  publicSignals: reg.publicSignals,
  expected: { rootStore: dmlRoots, season, contextHash: ctx },
  registrationStore,
  // Linear demo, no season rollover: the durable record and the tree mirror just run together.
  commit: async ({ season: s, contextHash: c, regNullifier: n, commitment }) => {
    const res = await registrationStore.append({ season: s, contextHash: c, regNullifier: n, commitment });
    if (res.duplicate) return { ok: false, reason: "already-registered" };
    membersTree.append(commitment);
    return { ok: true, index: res.index, membersRoot: membersTree.root(), size: membersTree.size() };
  },
});
console.log("   verifyRegistration:", regResult.ok ? `OK, commitment at index ${regResult.index}` : `FAIL ${regResult.reason}`);
if (!regResult.ok) process.exit(1);

// 2) PER-EPOCH (cheap, every epoch)
console.log("2. per-epoch: proving membership in the members tree ...");
const { pathElements, pathIndices } = membersTree.pathFor(regResult.index);
const tMem = Date.now();
const mem = await snarkjs.plonk.fullProve(
  { secret, pathElements, pathIndices, membersRoot: regResult.membersRoot, epoch, contextHash: ctx, signalHash: sig },
  `${B}/mno_members_js/mno_members.wasm`,
  `${B}/mno_members.zkey`
);
console.log(`   members proof generated in ${((Date.now() - tMem) / 1000).toFixed(1)}s (cheap, every epoch)`);

const membersRoots = new RootStore(8);
membersRoots.update([{ height: 1, root: regResult.membersRoot, ts: 0 }]);

const memResult = await verifyMembership({
  vkey: JSON.parse(await readFile(`${B}/mno_members_vkey.json`, "utf8")),
  proof: mem.proof,
  publicSignals: mem.publicSignals,
  expected: { rootStore: membersRoots, epoch, contextHash: ctx, signalHash: sig, account: "demo-account" },
  nullifiers: new NullifierStore(),
});
console.log("   verifyMembership:", memResult.ok ? `OK, epoch nullifier ${memResult.nullifier.slice(0, 16)}...` : `FAIL ${memResult.reason}`);
if (!memResult.ok) process.exit(1);

console.log("\nTwo-tier flow verified end to end: one heavy registration, then cheap per-epoch proofs.");
