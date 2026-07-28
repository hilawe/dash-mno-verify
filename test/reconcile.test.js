import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markReconciled, reconciliationDone, requireReconciled, readMarker } from "../adapters/common/reconcile.js";

// The startup gate for adapters that used to admit members and never remove them. It had no direct
// tests, and both of its defects were the kind a direct test catches immediately: the recovery
// command it printed did not satisfy the check it exists to satisfy, and a non-empty ledger skipped
// the check regardless of which target those records belonged to.
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-reconcile-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GROUP = "-1001234567890";
const OTHER = "-1009876543210";
const opts = (marker, extra) => ({
  platform: "Telegram",
  markerPath: marker,
  instructions: "establish a closed state",
  ledgerCovers: false,
  target: GROUP,
  ...extra,
});

// The regression that bricked the only recovery path Telegram has. The operator ran exactly the
// command the refusal printed, it wrote a marker with no target, and the next start refused again
// because the gate compares the marker's target against the configured chat.
test("the recovery command the gate prints records the target the gate checks", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    const err = await requireReconciled(opts(marker)).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "an empty ledger with no marker must refuse to start");
    const detail = err.message.match(/markReconciled\([^,]+,\s*(\{[^}]*\})\s*\)/)?.[1];
    assert.ok(detail, `no markReconciled call found in:\n${err.message}`);
    assert.match(detail, /target:/, "the printed command must record the target");
    assert.ok(detail.includes(GROUP), `the printed command must name ${GROUP}, got ${detail}`);

    // Now do what the command does, and the gate must let the adapter start.
    await markReconciled(marker, { by: "operator", target: GROUP });
    await requireReconciled(opts(marker));
  });
});

test("a marker recorded for one target does not satisfy the gate for another", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    await markReconciled(marker, { by: "operator", target: OTHER });
    assert.equal(await reconciliationDone(marker, GROUP), false);
    await assert.rejects(requireReconciled(opts(marker)), /refusing to start/);
  });
});

test("a marker with no target at all does not satisfy a target-scoped gate", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    await markReconciled(marker, { by: "operator" });
    assert.equal(await reconciliationDone(marker, GROUP), false);
    await assert.rejects(requireReconciled(opts(marker)), /refusing to start/);
  });
});

// The second half of the defect. The gate used to take any non-empty ledger as proof that this
// lifecycle had been running, so pointing the bot at an existing second group skipped reconciliation
// entirely and that group's current members kept access permanently and invisibly.
test("records for a different target do not excuse the gate", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    await assert.rejects(requireReconciled(opts(marker, { ledgerCovers: false })), /refusing to start/);
  });
});

test("records for this target do excuse the gate", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    await requireReconciled(opts(marker, { ledgerCovers: true }));
  });
});

test("a half-written marker refuses to start rather than reading as unreconciled", async () => {
  await withDir(async (dir) => {
    const marker = join(dir, "reconciled.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(marker, '{"reconciled": tr');
    await assert.rejects(reconciliationDone(marker, GROUP), /cannot read the reconciliation marker/);
  });
});

// The marker is the only record of cleanup a bot still owes. An earlier version checked
// `reconciled === true` and nothing else, so a corrupted pending list read as "nothing pending" and
// the bot recorded a successful pass while access it should have cleaned stayed live. Anything
// unreadable has to be a startup failure, never an empty result.
test("readMarker schema-checks rather than failing open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-recon-"));
  const p = join(dir, "m.json");
  try {
    assert.equal(await readMarker(join(dir, "absent.json")), null, "a missing marker is simply absent");

    writeFileSync(p, JSON.stringify({ reconciled: true, pending: ["role:r1"], target: "channel:c1" }));
    assert.deepEqual((await readMarker(p)).pending, ["role:r1"], "a well-formed marker reads back");

    writeFileSync(p, JSON.stringify({ reconciled: false, pending: ["role:r1"] }));
    assert.equal(await readMarker(p), null, "an unfinished marker is not a marker");

    for (const [bad, why] of [
      [JSON.stringify({ reconciled: true, pending: "role:r1" }), "a non-array pending"],
      [JSON.stringify({ reconciled: true, pending: [""] }), "an empty pending entry"],
      [JSON.stringify({ reconciled: true, pending: [{ role: "r1" }] }), "a non-string pending entry"],
      [JSON.stringify({ reconciled: true, target: 7 }), "a non-string target"],
      [JSON.stringify(["not", "an", "object"]), "an array instead of an object"],
      ["{ half written", "a truncated document"],
    ]) {
      writeFileSync(p, bad);
      await assert.rejects(readMarker(p), /marker/i, `should refuse ${why}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
