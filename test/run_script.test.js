import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScript } from "./run_script.mjs";

// The deadline in run_script.mjs has to hold even when bash is waiting on a foreground child and has a
// TERM trap, which is exactly the shape of the download scripts. execFileSync's timeout did not, because
// bash deferred the trap until the child finished on its own.
test("the deadline ends bash AND its foreground child, even with a TERM trap installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-script-"));
  const marker = `${Date.now()}`.slice(-6);
  try {
    const script = join(dir, "stall.sh");
    // A distinctive sleep length makes the child findable afterwards.
    writeFileSync(script, `trap 'exit 143' TERM\nsleep 97.${marker}\n`);
    const started = Date.now();
    const r = await runScript(script, [], { timeoutMs: 300 });
    const took = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.ok(took < 5_000, `resolved in ${took} ms, not after the child's own 97 seconds`);
    let survivors = "";
    try {
      survivors = execFileSync("pgrep", ["-f", `sleep 97.${marker}`], { encoding: "utf8" });
    } catch (e) {
      // Exit status 1 means "no match", the expected outcome. Anything else means pgrep itself could
      // not look, which proves nothing, so it fails the test rather than passing it.
      if (e.status !== 1) throw e;
    }
    assert.equal(survivors.trim(), "", "the foreground child was ended with the group");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
