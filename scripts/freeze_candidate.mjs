// Record everything the Groth16 setup ceremony depends on in circuits/ceremony/FREEZE.json
// (docs/CEREMONY.md, "What is fixed before anyone contributes").
//
// It refuses to run on a working tree with uncommitted changes, since the freeze names one commit. It
// compiles both heavy circuits with the compiler given in CIRCOM, hashes the r1cs files, reads their
// counts from the r1cs headers, checks the public-signal layout it records against the one the gateway
// decodes (core/verifier.js), and pins the dependencies from package-lock.json and the setup scripts.
//
//   CIRCOM=/path/to/circom-2.2.3 node scripts/freeze_candidate.mjs [--check]
//
// With --check it writes nothing, and exits nonzero if a fresh compile or any pinned value differs from
// the committed FREEZE.json. That is the check a contributor, or CI, runs against the freeze.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as snarkjs from "snarkjs";
import { SIGNAL_INDEX, REG_SIGNAL_INDEX } from "../core/verifier.js";
import { TAG_SINGLE_TIER_ADMISSION, TAG_SEASONAL_REGISTRATION, PURPOSE_LABELS } from "../common/purpose_tags.js";
import { releaseProvingThreads } from "../prover/proving_threads.js";

const CHECK = process.argv.includes("--check");
const CIRCOM = process.env.CIRCOM ?? "circom";
const OUT = "circuits/ceremony/FREEZE.json";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// The public-signal layout snarkjs produces, outputs then public inputs, as each circuit declares them.
// Checked below against the indices the gateway decodes, so the freeze cannot record one layout while
// the gateway reads another.
const LAYOUT = {
  mno_membership: ["nullifier", "root", "epoch", "contextHash", "signalHash"],
  mno_registration: ["commitment", "regNullifier", "root", "season", "contextHash"],
};
const byIndex = (index) => Object.entries(index).sort((a, b) => a[1] - b[1]).map(([k]) => k);
if (JSON.stringify(byIndex(SIGNAL_INDEX)) !== JSON.stringify(LAYOUT.mno_membership)) throw new Error("single-tier layout disagrees with core/verifier.js SIGNAL_INDEX");
if (JSON.stringify(byIndex(REG_SIGNAL_INDEX)) !== JSON.stringify(LAYOUT.mno_registration)) throw new Error("registration layout disagrees with core/verifier.js REG_SIGNAL_INDEX");

if (!CHECK && git("status", "--porcelain").length > 0) {
  console.error("the working tree has uncommitted changes; a freeze names one commit, so commit first");
  process.exit(1);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")).packages;
const dep = (name) => ({ version: lock[`node_modules/${name}`].version, integrity: lock[`node_modules/${name}`].integrity });
const ecdsaPin = readFileSync("scripts/setup_circom_ecdsa.sh", "utf8").match(/CIRCOM_ECDSA_REF:-([0-9a-f]{40})/)[1];
const ptauBlake2b = readFileSync("scripts/fetch_ptau.sh", "utf8").match(/20\) BLAKE2B="([0-9a-f]{128})"/)[1];
const circomVersion = execFileSync(CIRCOM, ["--version"], { encoding: "utf8" }).trim();
const circomPath = execFileSync("which", [CIRCOM], { encoding: "utf8" }).trim();

execFileSync("bash", ["scripts/setup_circom_ecdsa.sh"], { stdio: "ignore" });
const build = mkdtempSync(join(tmpdir(), "freeze-"));
const circuits = {};
try {
  for (const c of Object.keys(LAYOUT)) {
    execFileSync(CIRCOM, [`circuits/${c}.circom`, "--r1cs", "-o", build, "-l", "node_modules", "-l", "circuits/.deps"], { stdio: "ignore" });
    const r1cs = join(build, `${c}.r1cs`);
    const info = await snarkjs.r1cs.info(r1cs, { info() {}, warn() {} });
    circuits[c] = {
      source: `circuits/${c}.circom`,
      r1csSha256: sha256(r1cs),
      constraints: info.nConstraints,
      publicInputs: info.nPubInputs,
      outputs: info.nOutputs,
      privateInputs: info.nPrvInputs,
      publicSignals: LAYOUT[c],
    };
  }
} finally {
  rmSync(build, { recursive: true, force: true });
  await releaseProvingThreads();
}

const freeze = {
  note: "Everything the Groth16 setup ceremony depends on (docs/CEREMONY.md). A change to any value voids every contribution made against it.",
  commit: CHECK ? "(check mode)" : git("rev-parse", "HEAD"),
  compiler: {
    name: "circom",
    version: circomVersion,
    binarySha256: sha256(circomPath),
    // The official v2.2.3 release binaries. Both were run on these circuits and gave byte-identical
    // r1cs (2026-09-27), so a contributor on either platform reproduces the frozen hashes. The asset
    // named circom-macos-amd64 is in fact an arm64 build.
    releaseBinaries: {
      "circom-linux-amd64": "85342c7ff332d948df7c0c50ecf201e6129349aef550ce873f3c811b79fe53a3",
      "circom-macos-amd64": "e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb",
    },
  },
  snarkjs: dep("snarkjs"),
  circomlib: dep("circomlib"),
  circomEcdsa: { repository: "https://github.com/0xPARC/circom-ecdsa", commit: ecdsaPin },
  phaseOne: { file: "powersOfTau28_hez_final_20.ptau", blake2b512: ptauBlake2b },
  purposeTags: {
    singleTierAdmission: { label: PURPOSE_LABELS.singleTierAdmission, value: TAG_SINGLE_TIER_ADMISSION.toString() },
    seasonalRegistration: { label: PURPOSE_LABELS.seasonalRegistration, value: TAG_SEASONAL_REGISTRATION.toString() },
  },
  circuits,
};

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`no ${OUT} to check against`);
    process.exit(1);
  }
  const frozen = JSON.parse(readFileSync(OUT, "utf8"));
  let bad = 0;
  for (const c of Object.keys(LAYOUT)) {
    for (const k of Object.keys(circuits[c])) {
      if (JSON.stringify(frozen.circuits?.[c]?.[k]) !== JSON.stringify(circuits[c][k])) {
        console.error(`MISMATCH ${c}.${k}: frozen ${JSON.stringify(frozen.circuits?.[c]?.[k])}, now ${JSON.stringify(circuits[c][k])}`);
        bad++;
      }
    }
  }
  for (const k of ["snarkjs", "circomlib", "circomEcdsa", "phaseOne", "purposeTags"]) {
    if (JSON.stringify(frozen[k]) !== JSON.stringify(freeze[k])) {
      console.error(`MISMATCH ${k}`);
      bad++;
    }
  }
  if (frozen.compiler?.version !== freeze.compiler.version) {
    console.error(`MISMATCH compiler version: frozen ${frozen.compiler?.version}, now ${freeze.compiler.version}`);
    bad++;
  }
  if (bad) process.exit(1);
  console.log(`the fresh compile matches ${OUT} (${Object.keys(LAYOUT).join(", ")})`);
} else {
  mkdirSync("circuits/ceremony", { recursive: true });
  writeFileSync(OUT, JSON.stringify(freeze, null, 2) + "\n");
  console.log(`wrote ${OUT} for commit ${freeze.commit}`);
}
