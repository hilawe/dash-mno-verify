import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileWhole } from "../prover/write_whole.js";

// 2026-09-30. A member could attach proof.json while the prover was still writing it. The file now
// appears only once complete: written under a hidden temporary name, then renamed into place.

test("the content goes to a hidden temporary name, created exclusively, and is renamed onto the target", async () => {
  const ops = [];
  const fs = {
    stat: async () => { const e = new Error("absent"); e.code = "ENOENT"; throw e; },
    writeFile: async (p, _d, o) => ops.push(["write", p, o.flag]),
    chmod: async () => ops.push(["chmod"]),
    rename: async (a, b) => ops.push(["rename", a, b]),
    unlink: async (p) => ops.push(["unlink", p]),
  };
  await writeFileWhole("/work/proof.json", "{}", { fs, suffix: "abc" });
  assert.deepEqual(ops, [
    ["write", "/work/.proof.json.abc.partial", "wx"],
    ["rename", "/work/.proof.json.abc.partial", "/work/proof.json"],
  ], "the target name is never written to directly");
});

test("on a real filesystem the target holds the whole content and no temporary file is left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whole-"));
  try {
    const big = JSON.stringify({ proof: "x".repeat(100_000) });
    await writeFileWhole(join(dir, "proof.json"), big);
    assert.equal(readFileSync(join(dir, "proof.json"), "utf8"), big);
    await writeFileWhole(join(dir, "proof.json"), "{\"second\":true}");
    assert.equal(readFileSync(join(dir, "proof.json"), "utf8"), "{\"second\":true}", "an existing file is replaced whole");
    assert.deepEqual(readdirSync(dir), ["proof.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacing a file its owner made private keeps it private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whole-"));
  try {
    const p = join(dir, "proof.json");
    writeFileSync(p, "old");
    chmodSync(p, 0o600);
    await writeFileWhole(p, "new");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(readFileSync(p, "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping writes in one process never share a temporary file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whole-"));
  try {
    const p = join(dir, "proof.json");
    const a = "a".repeat(200_000), b = "b".repeat(200_000);
    await Promise.all([writeFileWhole(p, a), writeFileWhole(p, b)]);
    const got = readFileSync(p, "utf8");
    assert.ok(got === a || got === b, "the result is one whole write, never a mixture");
    assert.deepEqual(readdirSync(dir), ["proof.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a temporary name already taken is refused and left alone, not deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whole-"));
  try {
    const other = join(dir, ".proof.json.same.partial");
    writeFileSync(other, "another write in progress");
    await assert.rejects(writeFileWhole(join(dir, "proof.json"), "{}", { suffix: "same" }), /EEXIST/);
    assert.equal(readFileSync(other, "utf8"), "another write in progress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed rename removes the temporary file and reports the error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whole-"));
  try {
    mkdirSync(join(dir, "proof.json")); // a directory where the file should go makes the rename fail
    mkdirSync(join(dir, "proof.json", "inside"));
    await assert.rejects(writeFileWhole(join(dir, "proof.json"), "{}"));
    assert.deepEqual(readdirSync(dir), ["proof.json"], "no temporary file left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Source checks, not behavior: both provers would need a full proof run to watch them write, so these
// pin that their proof.json write goes through the helper and nothing writes the file directly.
test("both provers write proof.json through writeFileWhole and nowhere else", () => {
  for (const f of ["../prover/two_tier.js", "../prover/prover.js"]) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
    assert.match(src, /await writeFileWhole\((out|values\.out), JSON\.stringify\(\{ nonce: /, f);
    assert.doesNotMatch(src, /\bwriteFile\(/, `${f} writes a file directly`);
  }
});
