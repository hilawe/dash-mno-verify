import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultSecretPath,
  findSecretForContext,
  markSecretAccepted,
  readSecretFile,
  resolveSecret,
  writePendingSecret,
} from "../prover/secret_file.js";
import { loadVotingKey } from "../prover/voting_key.js";

// The member secret exists in exactly one place, the member's disk. The gateway keeps only its
// commitment, so overwriting the secret of an accepted registration strands that member for the
// season. These pin the handling that closes that.

// Awaits the callback before cleaning up. Returning fn(dir) directly would delete the directory as
// soon as the promise was created, while the test was still using it.
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-secret-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pending secret is created 0600 and flushed", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "123", contextHash: "ctx" });
    assert.equal(statSync(p).mode & 0o777, 0o600, "the key material must not be world readable");
    const rec = await readSecretFile(p);
    assert.equal(rec.status, "pending");
    assert.equal(rec.secret, "123");
  });
});

// The directory flush is what makes a brand-new secret FINDABLE after a power loss. Losing it costs
// the member the season, because the gateway has already spent the seasonal registration nullifier
// and holds only the commitment. So on creation a real failure has to stop the run before the proof
// is spent, while a filesystem that simply cannot flush a directory handle stays usable. The earlier
// test asserted the mode and contents only, and would have passed with the flush failing silently.
test("creating a pending secret fails the run when the directory flush genuinely fails", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    const openFn = async () => {
      throw Object.assign(new Error("simulated device failure"), { code: "EIO" });
    };
    await assert.rejects(writePendingSecret(p, { secret: "123" }, { openFn }), /simulated device failure/);
  });
});

test("creating a pending secret survives a filesystem that cannot flush a directory", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    const openFn = async () => {
      throw Object.assign(new Error("not supported here"), { code: "EINVAL" });
    };
    await writePendingSecret(p, { secret: "123" }, { openFn });
    assert.equal((await readSecretFile(p)).secret, "123", "the secret must still be written");
  });
});

test("an existing secret is never overwritten", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "first" });
    await assert.rejects(writePendingSecret(p, { secret: "second" }), /EEXIST/);
    assert.equal((await readSecretFile(p)).secret, "first", "the first secret must survive");
  });
});

test("resolveSecret reports fresh, retry, and accepted", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    assert.equal((await resolveSecret(p)).kind, "fresh");

    await writePendingSecret(p, { secret: "s1" });
    const retry = await resolveSecret(p);
    assert.equal(retry.kind, "retry", "a pending file is resumed, not replaced");
    assert.equal(retry.record.secret, "s1", "the retry reuses the same secret");

    await markSecretAccepted(p, { index: 4 });
    const accepted = await resolveSecret(p);
    assert.equal(accepted.kind, "accepted");
    assert.equal(accepted.record.index, 4);
    assert.equal(accepted.record.secret, "s1", "accepting must not disturb the secret");
  });
});

test("a file that is not one of ours is reported rather than guessed at", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    writeFileSync(p, JSON.stringify({ unrelated: true }));
    assert.equal((await resolveSecret(p)).kind, "unknown");
  });
});

test("markSecretAccepted keeps the file 0600", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "s1" });
    await markSecretAccepted(p, { index: 1 });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

test("the default filename separates community, role, and season", () => {
  const a = defaultSecretPath({ platform: "discord", community: "c1", role: "r1", season: 9 });
  const b = defaultSecretPath({ platform: "discord", community: "c2", role: "r1", season: 9 });
  const c = defaultSecretPath({ platform: "discord", community: "c1", role: "r1", season: 10 });
  assert.notEqual(a, b, "a second community must not reuse the first community's file");
  assert.notEqual(a, c, "a new season must not overwrite last season's secret");
  assert.match(a, /^member\.discord\.c1\.r1\.s9\.secret\.json$/);
});

test("the default filename neutralizes path characters from platform ids", () => {
  const p = defaultSecretPath({ platform: "discord", community: "../../etc", role: "r", season: 1 });
  assert.equal(p.includes("/"), false, "a community id must not be able to steer the path");
});

test("findSecretForContext matches on context and prefers an accepted record", async () => {
  await withDir(async (dir) => {
    const pending = join(dir, "member.a.pending.secret.json");
    const accepted = join(dir, "member.a.accepted.secret.json");
    const other = join(dir, "member.b.secret.json");
    await writePendingSecret(pending, { secret: "p", contextHash: "ctx1" });
    await writePendingSecret(accepted, { secret: "a", contextHash: "ctx1" });
    await markSecretAccepted(accepted, {});
    await writePendingSecret(other, { secret: "o", contextHash: "ctx2" });

    assert.equal(await findSecretForContext("ctx1", null, dir), accepted);
    assert.equal(await findSecretForContext("ctx2", null, dir), other);
    assert.equal(await findSecretForContext("ctx3", null, dir), null);
  });
});

test("the voting key loads from a file and warns when it is group readable", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "key.wif");
    writeFileSync(p, "  WIFKEY123\n", { mode: 0o600 });
    const warnings = [];
    assert.equal(await loadVotingKey({ "voting-key-file": p }, { warn: (m) => warnings.push(m) }), "WIFKEY123");
    assert.equal(warnings.length, 0, "a 0600 key file is not worth warning about");

    // chmod explicitly: writeFileSync only applies `mode` when it creates the file.
    chmodSync(p, 0o644);
    await loadVotingKey({ "voting-key-file": p }, { warn: (m) => warnings.push(m) });
    assert.match(warnings.join(" "), /readable by other users/);
  });
});

test("the deprecated argument still works but warns about shell history", async () => {
  const warnings = [];
  const wif = await loadVotingKey({ "voting-key": "WIF" }, { warn: (m) => warnings.push(m) });
  assert.equal(wif, "WIF", "existing members must not be broken mid-season");
  assert.match(warnings.join(" "), /shell history/);
});

test("a file takes precedence over the deprecated argument", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "key.wif");
    writeFileSync(p, "FROMFILE", { mode: 0o600 });
    const wif = await loadVotingKey({ "voting-key-file": p, "voting-key": "FROMARG" }, { warn: () => {} });
    assert.equal(wif, "FROMFILE", "a stale flag must not override the safer form");
  });
});

test("no key at all is a clear error, not a crash", async () => {
  await assert.rejects(loadVotingKey({}, { warn: () => {} }), /no voting key given/);
});

test("the lookup picks the current season's secret, not last season's", async () => {
  // The context hash excludes the season, so after a rollover the directory holds an accepted secret
  // per season for the same community. Choosing by readdir order could hand the prover a commitment
  // that is not in the current members tree, and the proof would simply fail.
  await withDir(async (dir) => {
    const oldS = join(dir, "member.c.s9.secret.json");
    const newS = join(dir, "member.c.s10.secret.json");
    await writePendingSecret(oldS, { secret: "old", contextHash: "ctx", season: "9" });
    await markSecretAccepted(oldS, {});
    await writePendingSecret(newS, { secret: "new", contextHash: "ctx", season: "10" });
    await markSecretAccepted(newS, {});

    assert.equal(await findSecretForContext("ctx", "10", dir), newS);
    assert.equal(await findSecretForContext("ctx", "9", dir), oldS);
  });
});

test("a retry refuses a secret recorded for a different context", async () => {
  // Sanitized filenames can collide across communities, and reusing the secret would publish the same
  // commitment in two contexts and link the member across them.
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "s", contextHash: "ctxA", season: "9" });
    assert.equal((await resolveSecret(p, { contextHash: "ctxB", season: "9" })).kind, "mismatch");
    assert.equal((await resolveSecret(p, { contextHash: "ctxA", season: "10" })).kind, "mismatch");
    assert.equal((await resolveSecret(p, { contextHash: "ctxA", season: "9" })).kind, "retry");
  });
});

test("promotion leaves the secret intact and 0600", async () => {
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "keepme", contextHash: "ctx", season: "9" });
    await markSecretAccepted(p, { index: 3 });
    const rec = await readSecretFile(p);
    assert.equal(rec.secret, "keepme", "promotion must never disturb the secret itself");
    assert.equal(rec.status, "accepted");
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

test("a promotion interrupted before its rename leaves the pending secret readable", async () => {
  // The earlier version of this test was named for a failed write and never injected one, so it
  // proved nothing about the crash it claimed to cover. Promotion writes a sibling and renames, so
  // the state to check is: the original is still whole while the temporary exists.
  await withDir(async (dir) => {
    const p = join(dir, "m.secret.json");
    await writePendingSecret(p, { secret: "keepme", contextHash: "ctx", season: "9" });

    // Stand in for a crash after the sibling is written but before the rename commits.
    writeFileSync(`${p}.${process.pid}.tmp`, "partially written garbage");

    const rec = await readSecretFile(p);
    assert.equal(rec.secret, "keepme", "the only copy of the secret is untouched by an interrupted promotion");
    assert.equal(rec.status, "pending", "and it is still resumable");
    assert.equal((await resolveSecret(p, { contextHash: "ctx", season: "9" })).kind, "retry");
  });
});
