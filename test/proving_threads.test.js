import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "./run_script.mjs";

// The single-tier prover wrote proof.json on a masternode on 2026-09-26 and then never exited, because
// snarkjs's BN128 curve keeps a pool of worker threads alive. prover/proving_threads.js releases them.
// A real proof needs the 2.3 GB key, which the test runners do not have, so these pin the mechanism
// with the curve alone and then check that every file that proves calls the release.

const REPO = fileURLToPath(new URL("..", import.meta.url));

// Build the multi-threaded curve exactly as a proof does, optionally release it, then fall off the end.
async function runCurveProbe({ release, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "proving-threads-"));
  try {
    const code = [
      'import * as snarkjs from "snarkjs";',
      'import { releaseProvingThreads } from "./prover/proving_threads.js";',
      'await snarkjs.curves.getCurveFromName("bn128");',
      'if (!globalThis.curve_bn128) throw new Error("the curve was not cached, so this probe tests nothing");',
      release ? "await releaseProvingThreads();" : "",
      'console.log("reached the end");',
    ].join("\n");
    writeFileSync(join(dir, "probe.mjs"), code);
    // --input-type=module with -e resolves bare imports from the working directory, which is the repo.
    writeFileSync(join(dir, "run.sh"), `cd "${REPO}" && exec node --input-type=module -e "$(cat "${join(dir, "probe.mjs")}")"\n`);
    return await runScript(join(dir, "run.sh"), [], { timeoutMs });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with the threads released, a process that built the proving curve exits on its own", async () => {
  const r = await runCurveProbe({ release: true, timeoutMs: 15_000 });
  assert.equal(r.timedOut, false, "the process should exit once the threads are released");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /reached the end/);
});

test("control: without the release, the same process does NOT exit, which is the defect", async () => {
  // If this ever exits on its own, snarkjs or ffjavascript changed how the curve is kept, and the test
  // above no longer proves anything about the release. The released path exits in under a second, so a
  // five-second deadline is several times that.
  const r = await runCurveProbe({ release: false, timeoutMs: 5_000 });
  assert.match(r.stdout, /reached the end/, "the script reached its last line");
  assert.equal(r.timedOut, true, "yet the process stayed alive until the deadline ended it");
});

test("releasing when no curve exists does not throw and leaves no curve behind", async (t) => {
  const { releaseProvingThreads } = await import("../prover/proving_threads.js");
  if (globalThis.curve_bn128) {
    t.skip("a curve already exists in this process, so the no-curve path cannot be observed here");
    return;
  }
  await releaseProvingThreads();
  assert.equal(globalThis.curve_bn128 ?? null, null);
});

test("every CLI releases the threads after each proof, and every script after its last", () => {
  // A source-level guard, so a new prover cannot reintroduce the hang unnoticed. It checks shape, not
  // behavior, and the behavior is what the tests above pin.
  const files = [
    ...readdirSync(join(REPO, "prover")).filter((f) => f.endsWith(".js")).map((f) => `prover/${f}`),
    ...readdirSync(join(REPO, "scripts")).filter((f) => /\.(m?js)$/.test(f)).map((f) => `scripts/${f}`),
  ];
  const provers = files.filter((f) => readFileSync(join(REPO, f), "utf8").includes("fullProve("));
  assert.ok(provers.length >= 3, `expected at least the three known provers, found ${provers.join(", ")}`);
  for (const f of provers) {
    const src = readFileSync(join(REPO, f), "utf8");
    const starts = [...src.matchAll(/fullProve\(/g)].map((m) => m.index);
    // The CLIs under prover/ release after EVERY proof, in a finally, so a failed proof releases the
    // threads too. A script may share the threads across its proofs and release once after the last.
    const checked = f.startsWith("prover/") ? starts : starts.slice(-1);
    for (const at of checked) {
      const next = starts.find((s) => s > at) ?? src.length;
      const release = src.indexOf("await releaseProvingThreads()", at);
      assert.ok(release > at && (f.startsWith("prover/") ? release < next : true),
        `${f} proves at offset ${at} without releasing the proving threads before its next proof or the end`);
      if (f.startsWith("prover/")) {
        assert.match(src.slice(at, release), /\}\s*finally\s*\{\s*$/, `${f} must release the threads in a finally after fullProve at offset ${at}`);
      }
    }
  }
});
