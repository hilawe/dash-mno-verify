import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import {
  RegistrationStore,
  MemoryRegistrationBackend,
  FileBackend,
} from "../core/registration_store.js";
import { MembersTree } from "../core/members_tree.js";
import { FIELD_PRIME } from "../common/field.js";

// The registration store is where the two-tier P0 fix lives: one atomic, durable, season- and
// context-scoped record per registration, with the members tree rebuilt from records. These tests
// pin the behavior the gateway relies on, against both backends.

async function withTempFile(run) {
  const dir = await mkdtemp(join(tmpdir(), "mno-reg-"));
  try {
    return await run(join(dir, "registrations.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The same contract must hold for the in-memory and the durable file backend.
for (const [name, makeStore] of [
  ["memory", async () => ({ store: new RegistrationStore(new MemoryRegistrationBackend()) })],
  ["file", async () => withTempFile(async (p) => ({ store: new RegistrationStore(new FileBackend(p)), path: p }))],
]) {
  test(`${name}: records a registration and rejects the duplicate spend`, async () => {
    const { store } = await makeStore();
    await store.ready();

    assert.equal(await store.has(1, "122", "146"), false);
    const first = await store.append({ season: 1, contextHash: "122", regNullifier: "146", commitment: "109", engine: "plonk", statement: "derive" });
    assert.deepEqual(first, { duplicate: false, index: 0 });
    assert.equal(await store.has(1, "122", "146"), true);

    // the same season, context, and registration nullifier is the same spend, even with a
    // different commitment: one voting key registers once per season and context
    const dup = await store.append({ season: 1, contextHash: "122", regNullifier: "146", commitment: "108", engine: "plonk", statement: "derive" });
    assert.equal(dup.duplicate, true);

    const recs = await store.forSeasonContext(1, "122");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].commitment, "109");
  });

  test(`${name}: season, context, and registration nullifier are independent`, async () => {
    const { store } = await makeStore();
    await store.ready();
    await store.append({ season: 1, contextHash: "122", regNullifier: "145", commitment: "107", engine: "plonk", statement: "derive" });
    assert.equal(await store.has(2, "122", "145"), false); // different season
    assert.equal(await store.has(1, "123", "145"), false); // different community
    assert.equal(await store.has(1, "122", "147"), false); // different node
  });

  test(`${name}: indexes are per (season, context) and assigned in insertion order`, async () => {
    const { store } = await makeStore();
    await store.ready();
    const a = await store.append({ season: 5, contextHash: "122", regNullifier: "105", commitment: "118", engine: "plonk", statement: "derive" });
    const b = await store.append({ season: 5, contextHash: "122", regNullifier: "106", commitment: "119", engine: "plonk", statement: "derive" });
    const c = await store.append({ season: 6, contextHash: "122", regNullifier: "107", commitment: "120", engine: "plonk", statement: "derive" });
    assert.deepEqual([a.index, b.index, c.index], [0, 1, 0]);

    // A different community in the same season is a separate bucket, indexed from 0 (review B2).
    const d = await store.append({ season: 5, contextHash: "123", regNullifier: "126", commitment: "121", engine: "plonk", statement: "derive" });
    assert.equal(d.index, 0);

    const s5 = await store.forSeasonContext(5, "122");
    assert.deepEqual(s5.map((r) => r.commitment), ["118", "119"]);
    const s6 = await store.forSeasonContext(6, "122");
    assert.deepEqual(s6.map((r) => r.commitment), ["120"]);
    assert.deepEqual(await store.forSeasonContext(5, "123"), [
      { season: 5, contextHash: "123", regNullifier: "126", commitment: "121", engine: "plonk", statement: "derive", index: 0 },
    ]);
    assert.deepEqual(await store.forSeasonContext(99, "122"), []); // a fresh season starts empty
  });

  test(`${name}: a bucket is bound to one (engine, statement); a mismatch is rejected`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // The first registration declares the bucket (plonk, derive here).
    const first = await store.append({ season: 1, contextHash: "122", regNullifier: "136", commitment: "109", engine: "plonk", statement: "derive" });
    assert.equal(first.duplicate, false);
    assert.deepEqual(await store.declarationFor(1, "122"), { engine: "plonk", statement: "derive" });

    // A later registration for the same bucket under a different statement is a conflict, not written.
    const conflict = await store.append({ season: 1, contextHash: "122", regNullifier: "137", commitment: "110", engine: "zkvm", statement: "custody" });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.declared, { engine: "plonk", statement: "derive" });
    assert.equal(await store.has(1, "122", "137"), false, "the conflicting registration was not stored");

    // A matching later registration is accepted.
    const ok = await store.append({ season: 1, contextHash: "122", regNullifier: "138", commitment: "112", engine: "plonk", statement: "derive" });
    assert.equal(ok.duplicate, false);
    assert.equal(ok.index, 1);

    // A different bucket can declare a different statement.
    const other = await store.append({ season: 1, contextHash: "123", regNullifier: "139", commitment: "113", engine: "zkvm", statement: "custody" });
    assert.equal(other.duplicate, false);
    assert.deepEqual(await store.declarationFor(1, "123"), { engine: "zkvm", statement: "custody" });
  });

  test(`${name}: an impossible engine/statement pair is rejected`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // PLONK supports only derive, so plonk/custody is invalid and never declares a bucket.
    const bad = await store.append({ season: 1, contextHash: "122", regNullifier: "136", commitment: "109", engine: "plonk", statement: "custody" });
    assert.equal(bad.invalid, true);
    assert.equal(await store.declarationFor(1, "122"), null, "no bucket was declared");
  });

  test(`${name}: a new write with no engine/statement fails closed, not a silent legacy default`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // Omitting the declaration on a NEW write is rejected, so a caller that drops the field cannot
    // silently write a plonk/derive record and mislabel a custody registration.
    const noDecl = await store.append({ season: 1, contextHash: "122", regNullifier: "136", commitment: "109" });
    assert.equal(noDecl.invalid, true);
    assert.equal(await store.has(1, "122", "136"), false, "nothing was written");
    const partial = await store.append({ season: 1, contextHash: "122", regNullifier: "137", commitment: "110", engine: "zkvm" });
    assert.equal(partial.invalid, true, "a missing statement also fails closed");
  });

  test(`${name}: seasonHasEngine reports a durable zkVM declaration (the downgrade-rule signal)`, async () => {
    const { store } = await makeStore();
    await store.ready();
    assert.equal(await store.seasonHasEngine(1, "zkvm"), false);
    // A plonk registration in the season does not make it zkvm.
    await store.append({ season: 1, contextHash: "124", regNullifier: "105", commitment: "118", engine: "plonk", statement: "derive" });
    assert.equal(await store.seasonHasEngine(1, "zkvm"), false);
    // A zkvm registration in another context of the same season does.
    await store.append({ season: 1, contextHash: "125", regNullifier: "106", commitment: "119", engine: "zkvm", statement: "custody" });
    assert.equal(await store.seasonHasEngine(1, "zkvm"), true);
    // Scoped to the season: a different season is unaffected.
    assert.equal(await store.seasonHasEngine(2, "zkvm"), false);
  });
}

test("file: registrations survive a restart (durability)", async () => {
  await withTempFile(async (path) => {
    const first = new RegistrationStore(new FileBackend(path));
    await first.ready();
    await first.append({ season: 3, contextHash: "122", regNullifier: "136", commitment: "109", engine: "plonk", statement: "derive" });
    await first.append({ season: 3, contextHash: "122", regNullifier: "137", commitment: "110", engine: "plonk", statement: "derive" });

    // a new gateway process reads the same file and recovers the full set
    const reopened = new RegistrationStore(new FileBackend(path));
    await reopened.ready();
    assert.equal(await reopened.has(3, "122", "136"), true);
    assert.equal(await reopened.has(3, "122", "137"), true);
    const recs = await reopened.forSeasonContext(3, "122");
    assert.deepEqual(recs.map((r) => r.commitment), ["109", "110"]);

    // and the spend set is enforced after the restart, so no member registers twice
    const dup = await reopened.append({ season: 3, contextHash: "122", regNullifier: "136", commitment: "109", engine: "plonk", statement: "derive" });
    assert.equal(dup.duplicate, true);
  });
});

test("file: two concurrent first registrations with different declarations, exactly one wins", async () => {
  await withTempFile(async (path) => {
    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    // Fire a derive and a custody first-registration for the same bucket concurrently. The append
    // mutex serializes them, so exactly one declares the bucket and the other conflicts, reporting
    // the winner's declaration. Both must not be written.
    const [a, b] = await Promise.all([
      store.append({ season: 1, contextHash: "122", regNullifier: "140", commitment: "114", engine: "plonk", statement: "derive" }),
      store.append({ season: 1, contextHash: "122", regNullifier: "141", commitment: "115", engine: "zkvm", statement: "custody" }),
    ]);
    const wins = [a, b].filter((r) => r.duplicate === false);
    const conflicts = [a, b].filter((r) => r.conflict === true);
    assert.equal(wins.length, 1, "exactly one registration is written");
    assert.equal(conflicts.length, 1, "the other conflicts");
    // The loser reports the winner's declaration, and the bucket holds exactly one record.
    const decl = await store.declarationFor(1, "122");
    assert.deepEqual(conflicts[0].declared, decl);
    const recs = await store.forSeasonContext(1, "122");
    assert.equal(recs.length, 1);
  });
});

test("file: a legacy record (no engine/statement) reopens as plonk/derive and rejects custody", async () => {
  await withTempFile(async (path) => {
    // Seed a real legacy JSON-lines record, the pre-declaration shape with no engine/statement.
    await writeFile(path, JSON.stringify({ season: 2, contextHash: "122", regNullifier: "127", commitment: "116", index: 0 }) + "\n");

    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    assert.equal(await store.has(2, "122", "127"), true, "the legacy record loads");
    assert.deepEqual(await store.declarationFor(2, "122"), { engine: "plonk", statement: "derive" });

    // A custody registration into the legacy (derive-declared) bucket is rejected and not written.
    const conflict = await store.append({ season: 2, contextHash: "122", regNullifier: "144", commitment: "117", engine: "zkvm", statement: "custody" });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.declared, { engine: "plonk", statement: "derive" });
    assert.equal(await store.has(2, "122", "144"), false);
    // The file still holds only the legacy record.
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
  });
});

test("a tree rebuilt from records matches sequential registration (no member is stranded)", async () => {
  await withTempFile(async (path) => {
    const commitments = ["111", "222", "333", "444"];

    // tree as the gateway holds it while members register, one append at a time
    const live = await MembersTree.create();
    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    for (let i = 0; i < commitments.length; i++) {
      await store.append({ season: 7, contextHash: "122", regNullifier: String(200 + i), commitment: commitments[i], engine: "plonk", statement: "derive" });
      live.append(commitments[i]);
    }

    // tree as a restart rebuilds it from the durable records, in the persisted order
    const recs = await store.forSeasonContext(7, "122");
    const rebuilt = await MembersTree.fromCommitments(recs.map((r) => r.commitment));

    assert.equal(rebuilt.root(), live.root());
    assert.equal(rebuilt.size(), commitments.length);
  });
});

test("file: concurrent first use loads the records exactly once", async () => {
  await withTempFile(async (path) => {
    // seed two records, then open a fresh backend and hit it from several callers at once
    const seed = new RegistrationStore(new FileBackend(path));
    await seed.ready();
    await seed.append({ season: 2, contextHash: "122", regNullifier: "136", commitment: "109", engine: "plonk", statement: "derive" });
    await seed.append({ season: 2, contextHash: "122", regNullifier: "137", commitment: "110", engine: "plonk", statement: "derive" });

    const fresh = new RegistrationStore(new FileBackend(path));
    const [recs, has1] = await Promise.all([
      fresh.forSeasonContext(2, "122"),
      fresh.has(2, "122", "136"),
      fresh.ready(),
      fresh.forSeasonContext(2, "122"),
    ]);
    // a double-load would have pushed each record twice
    assert.equal(recs.length, 2);
    assert.equal(has1, true);
    assert.deepEqual((await fresh.forSeasonContext(2, "122")).map((r) => r.index), [0, 1]);
  });
});

test("a different season rebuilds an empty tree (stale-season access cannot carry over)", async () => {
  await withTempFile(async (path) => {
    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    await store.append({ season: 10, contextHash: "122", regNullifier: "134", commitment: "107", engine: "plonk", statement: "derive" });

    const next = await MembersTree.fromCommitments((await store.forSeasonContext(11, "122")).map((r) => r.commitment));
    const empty = await MembersTree.create();
    assert.equal(next.size(), 0);
    assert.equal(next.root(), empty.root());
  });
});

// A TORN FINAL LINE IS TOLERATED, ANY OTHER MALFORMED LINE IS NOT. Two reviewers found this
// independently and it reproduces in one command. The file is append-only and each record is one
// line, so an interrupted append can only truncate the LAST line, and that record was never
// reported committed (the caller is told success only after the fsync). Discarding it loses nothing
// a member was promised. A malformed line anywhere else means the file was edited or corrupted, and
// skipping it would silently drop a member who WAS promised their registration.
test("a torn final line is discarded on load, so a crash mid-append does not refuse boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mno-torn-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const good = JSON.stringify({
    season: 0, contextHash: "122", regNullifier: "146", commitment: "11", engine: "plonk", statement: "derive", index: 0,
  });
  await writeFile(path, `${header}\n${good}\n{"season":0,"contextHa`);
  const b = new FileBackend(path, "sch1");
  await b.ready();
  const recs = await b.forSeasonContext(0, "122");
  assert.equal(recs.length, 1, "the complete record before the torn one survives");
  assert.equal(recs[0].regNullifier, "146");
  assert.equal(b.tornTailDiscarded, true, "and the discard is recorded rather than silent");

  // AND THE FILE MUST END ON A RECORD BOUNDARY, not merely parse in memory. A round noted that an
  // off-by-one truncation (to truncateTo + 1) leaves the preceding record without its newline, which
  // the in-memory check does not see; the next append then concatenates `}{` and the boot after that
  // refuses forever. Append and reopen to prove the file is still well-formed.
  await b.append({ season: 0, contextHash: "122", regNullifier: "147", commitment: "22", engine: "plonk", statement: "derive" });
  const reopened = new FileBackend(path, "sch1");
  await reopened.ready(); // must not throw on a concatenated line
  assert.deepEqual(
    (await reopened.forSeasonContext(0, "122")).map((r) => r.regNullifier),
    ["146", "147"],
    "the truncation cut on the record boundary, so the later append and reopen both succeed",
  );
  await rm(dir, { recursive: true, force: true });
});

test("a malformed line in the MIDDLE still refuses, because that is not an interrupted append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mno-mid-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const good = JSON.stringify({
    season: 0, contextHash: "122", regNullifier: "146", commitment: "11", engine: "plonk", statement: "derive", index: 0,
  });
  await writeFile(path, `${header}\n{"broken\n${good}\n`);
  const b = new FileBackend(path, "sch1");
  await assert.rejects(() => b.ready(), /line 2 is not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test("a file ending in a newline has no torn tail, so its last line must parse", async () => {
  // The discriminator is the missing trailing newline. A complete file always ends with one, so a
  // malformed last line in a newline-terminated file is corruption, not an interrupted append.
  const dir = await mkdtemp(join(tmpdir(), "mno-nl-"));
  const path = join(dir, "regs.jsonl");
  await writeFile(path, `${JSON.stringify({ type: "schedule", schedule: "sch1" })}\n{"broken\n`);
  const b = new FileBackend(path, "sch1");
  await assert.rejects(() => b.ready(), /not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test("a COMPLETE record with no trailing newline is terminated, not left to poison the next append", async () => {
  // The half the first repair missed, reproduced by a reviewer. An append can write every byte of a
  // record and stop before its newline. That line PARSES, so it is not an error on read and no
  // truncation was scheduled, and the next append then wrote straight onto the end of it, putting
  // `}{` in the middle of a line and refusing every boot from then on. The record is complete and
  // self-consistent, so it is kept and the line is terminated rather than discarded.
  const dir = await mkdtemp(join(tmpdir(), "mno-nonl-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const rec = (nf, index) => JSON.stringify({
    season: 0, contextHash: "122", regNullifier: nf, commitment: "11", engine: "plonk", statement: "derive", index,
  });
  await writeFile(path, `${header}\n${rec("146", 0)}`); // no trailing newline

  const b = new FileBackend(path, "sch1");
  await b.ready();
  assert.equal(b.tornTailTerminated, true, "the repair happened and is recorded, not silent");
  await b.append({ season: 0, contextHash: "122", regNullifier: "147", commitment: "22", engine: "plonk", statement: "derive" });

  // The reopen is the assertion that matters: the first repair passed a test that only read once.
  const b2 = new FileBackend(path, "sch1");
  await b2.ready();
  const recs = await b2.forSeasonContext(0, "122");
  assert.deepEqual(recs.map((r) => r.regNullifier), ["146", "147"], "both records survive a reopen");
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes.includes("}{"), false, "and no two records ever share a line");
});

test("a normal file ending in a newline is not touched by the repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mno-norm-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const rec = JSON.stringify({
    season: 0, contextHash: "122", regNullifier: "146", commitment: "11", engine: "plonk", statement: "derive", index: 0,
  });
  await writeFile(path, `${header}\n${rec}\n`);
  const before = await readFile(path, "utf8");
  const b = new FileBackend(path, "sch1");
  await b.ready();
  assert.notEqual(b.tornTailTerminated, true, "nothing to repair");
  assert.equal(await readFile(path, "utf8"), before, "the file is byte-identical");
});

test("a COMPLETE, newline-terminated record is barriered on load before has() trusts it (A1)", async () => {
  // The internal assurance round's confirmed blocker. #appendOne writes JSON.stringify(record) + "\n"
  // as one appendFile and then a SEPARATE fh.sync(), so a force-termination between those two awaits
  // leaves a record that is complete AND newline-terminated but whose bytes never had a successful
  // barrier behind them. On restart the torn-tail branches do not fire (the line parses and the file
  // ends in a newline), so before this fix the record was remembered and has() answered true for bytes
  // a power loss could still drop. writeFile below simulates that state: a complete newline-terminated
  // file whose data blocks were never fsync'd. The load must force the file before it trusts the tail.
  const dir = await mkdtemp(join(tmpdir(), "mno-a1-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const rec = JSON.stringify({
    season: 0, contextHash: "122", regNullifier: "146", commitment: "11", engine: "plonk", statement: "derive", index: 0,
  });
  await writeFile(path, `${header}\n${rec}\n`); // complete, newline-terminated, never barriered

  const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
  let fileSyncs = 0;
  const backend = new FileBackend(path, "sch1", false, {
    open: async (p, ...rest) => {
      const fh = await realOpen(p, ...rest);
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") {
            return async () => {
              if (p === path) fileSyncs += 1; // count only barriers of the FILE, not the directory flush
              await target.sync();
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
    readFile: async (...args) => realReadFile(...args),
  });
  await backend.ready();

  assert.equal(await backend.has({ season: 0, contextHash: "122", regNullifier: "146" }), true, "the record loads");
  assert.ok(fileSyncs >= 1, "load forced the file's data blocks before trusting the newline-terminated tail");
});

// F3 FROM THE INDEPENDENT SECURITY REVIEW: a successful write followed by a sync or close error can
// duplicate the registration. The bytes reach the file, the caller is told the write failed, the
// in-memory index never learns the record exists, a retry appends it again, and a restart loads both
// and puts one commitment into the members tree twice, which changes the root.
//
// Driven by faulting the real file handle rather than by reasoning about it, so the sequence the
// finding describes is the sequence that runs.

test("a sync error after the bytes land does not let a retry write the registration twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-f3-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const { open: realOpen } = await import("node:fs/promises");

    // Fault the NEXT sync only. Every byte of the record has been written by the time sync runs, so
    // this is exactly the uncertain write: durable on disk, reported to the caller as a failure.
    let faultArmed = true;
    const faultingOpen = async (...args) => {
      const fh = await realOpen(...args);
      if (!faultArmed) return fh;
      faultArmed = false;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") {
            return async () => {
              throw new Error("simulated sync failure");
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };

    const backend = new FileBackend(path, null, false, { open: faultingOpen });
    await backend.ready();
    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "plonk", statement: "derive" };
    // THE RETRY BARRIER IS WHAT MAKES THIS A SUCCESS, not the fact that the bytes are visible. The
    // fault is armed once, so the recovery path reopens the file and its sync SUCCEEDS, which is what
    // establishes durability. An earlier version reported success merely because a reread found the
    // record, and a reviewer showed that is wrong at the root: readFile() can see dirty page-cache
    // data that never reached stable storage, and a failed sync is exactly when visibility and
    // durability differ. See the case below for what happens when the barrier does not hold.
    const first = await backend.append(record);
    assert.equal(first.duplicate, false, "the record landed, so this is a commit and not a duplicate");
    assert.equal(first.index, 0, "and it carries the index the record on disk actually has");

    // THE RETRY IS THE POINT. It must not append a second copy.
    const retry = await backend.append(record);
    assert.equal(retry.duplicate, true, "the retry sees the record that actually landed rather than writing it again");

    const records = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type !== "schedule");
    assert.equal(records.length, 1, `the file holds one registration, not ${records.length}`);

    // And a restart rebuilds the same single-member tree, which is the harm the finding named.
    const reopened = new FileBackend(path, null, false);
    await reopened.ready();
    const after = await reopened.forSeasonContext(1, "107");
    assert.equal(after.length, 1, "a restart loads one record");
    assert.equal(after[0].commitment, "130");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that already holds a duplicate loads deterministically rather than doubling a member", async () => {
  // The safety net, for a file written by a build without the reread above. Two identical records for
  // one key collapse to the first, so the members tree rebuilds the same way every time.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-dup-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const rec = { season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "plonk", statement: "derive", index: 0 };
    writeFileSync(path, JSON.stringify(rec) + "\n" + JSON.stringify(rec) + "\n");

    const backend = new FileBackend(path, null, false);
    await backend.ready();
    const recs = await backend.forSeasonContext(1, "107");
    assert.equal(recs.length, 1, "the duplicate collapsed, so the commitment appears once");
    assert.equal(recs[0].index, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two records for one key that DISAGREE are refused, because neither can be chosen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-conflict-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const a = { season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "plonk", statement: "derive", index: 0 };
    const b = { ...a, commitment: "131" };
    writeFileSync(path, JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");

    const backend = new FileBackend(path, null, false);
    await assert.rejects(() => backend.ready(), /repeats registration key .* with different content/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reload that fails leaves the store as usable as it was, rather than wedging it", async () => {
  // Two reviewers reproduced this independently. The first version of the reread emptied the index and
  // memoized the load promise BEFORE reading, so a read that failed left the store with no index and a
  // rejected promise that ready() would never replace, because it only rebuilds when the promise is
  // falsy and a rejected promise is truthy. Every later call threw that same stale error for the rest
  // of the process lifetime.
  const dir = mkdtempSync(join(tmpdir(), "reg-reload-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const backend = new FileBackend(path, null, false);
    await backend.ready();
    await backend.append({ season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "plonk", statement: "derive" });

    // A read failure during a reload, then the file becomes readable again.
    let failNextRead = true;
    const realReadFile = readFile;
    const backendWithFlakyRead = new FileBackend(path, null, false, {
      readFile: async (...args) => {
        if (failNextRead) {
          failNextRead = false;
          throw Object.assign(new Error("simulated read failure"), { code: "EIO" });
        }
        return realReadFile(...args);
      },
    });
    await assert.rejects(() => backendWithFlakyRead.ready(), /simulated read failure/);

    // The store must recover on the next call rather than repeating the stale error forever.
    const recovered = await backendWithFlakyRead.forSeasonContext(1, "107");
    assert.equal(recovered.length, 1, "the index rebuilt once the file was readable again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a duplicate written at a different index still loads, because the index is not the registration", async () => {
  // A reviewer reproduced this exact file from an honest interrupted write on an older build. K's
  // bytes land, the sync errors, the in-memory index never learns it, a DIFFERENT registration M
  // succeeds and takes position 0, and the member's retry for K then computes index 1. The file holds
  // K at 0, M at 0, and K at 1.
  //
  // Comparing the stored index as part of identity made that file unloadable, so the gateway refused
  // to start on state that is perfectly recoverable, which is the opposite of what the duplicate
  // handling is for. The index is a position this process assigned, not part of what the registration
  // means, and the four identity fields plus the commitment are what decide whether admitting both
  // would admit the same member twice.
  const dir = mkdtempSync(join(tmpdir(), "reg-dupidx-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const K = { season: 1, contextHash: "107", regNullifier: "142", commitment: "132", engine: "plonk", statement: "derive" };
    const M = { season: 1, contextHash: "107", regNullifier: "143", commitment: "133", engine: "plonk", statement: "derive" };
    writeFileSync(path, [
      JSON.stringify({ ...K, index: 0 }),
      JSON.stringify({ ...M, index: 0 }),
      JSON.stringify({ ...K, index: 1 }),
      "",
    ].join("\n"));

    const backend = new FileBackend(path, null, false);
    await backend.ready(); // must not throw
    const recs = await backend.forSeasonContext(1, "107");
    assert.equal(recs.length, 2, "two distinct registrations survive, and the repeated one collapsed");
    // NOT SORTED. This assertion used to sort the nullifiers, which checked membership as a set and
    // was blind to the thing that actually matters here. The bucket's ORDER is what the members root
    // commits to, and a fresh pass showed the load rebuilding [K, M] where the live tree had been
    // [M, K], a different root, so every member's path stopped verifying at the next restart.
    // K's LAST record carries index 1, which is the position the writer finally assigned it.
    assert.deepEqual(
      recs.map((r) => `${r.regNullifier}@${r.index}`),
      ["143@0", "142@1"],
      "the bucket rebuilds in recorded leaf order, which is the order the live tree had",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("but two records sharing a key while disagreeing on the registration are still refused", async () => {
  // The other half. Differing content under one key is corruption this cannot resolve, and picking
  // one would be inventing an answer, so the refusal stays.
  const dir = mkdtempSync(join(tmpdir(), "reg-dupbad-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const base = { season: 1, contextHash: "107", regNullifier: "142", engine: "plonk", statement: "derive" };
    writeFileSync(path, [
      JSON.stringify({ ...base, commitment: "132", index: 0 }),
      JSON.stringify({ ...base, commitment: "102", index: 1 }),
      "",
    ].join("\n"));
    const backend = new FileBackend(path, null, false);
    await assert.rejects(() => backend.ready(), /different content/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when the durability barrier ALSO fails, the write is reported as the failure it is", async () => {
  // The blocker a different-family review found. Success after an uncertain write requires a
  // successful durability barrier, and a reread cannot stand in for one: seeing the bytes proves they
  // are in the page cache, not that they survived. Here every sync fails, so nothing establishes
  // durability and the caller must be told the write failed rather than being handed an index for a
  // record that a crash could still lose.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-nosync-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const { open: realOpen } = await import("node:fs/promises");
    const alwaysFailsSync = async (...args) => {
      const fh = await realOpen(...args);
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") return async () => { throw new Error("the disk is not answering"); };
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
    const backend = new FileBackend(path, null, false, { open: alwaysFailsSync });
    await backend.ready();
    await assert.rejects(
      () => backend.append({ season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "plonk", statement: "derive" }),
      /the disk is not answering/,
      "no barrier held, so the write is uncertain and says so",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery will not claim another writer's record as this write", async () => {
  // Recovery used to search by (season, context, regNullifier) alone, so a record another writer had
  // put there under the same key was reported as THIS caller's successful write. The caller would
  // then append its own commitment to the live members tree while the durable file held a different
  // one, and a restart would rebuild from the other. The backend is documented single-writer and
  // nothing enforces that, so the comparison is what makes the claim true rather than merely likely.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-compete-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const { open: realOpen } = await import("node:fs/promises");

    const ours = { season: 1, contextHash: "107", regNullifier: "136", commitment: "104", engine: "plonk", statement: "derive" };
    const theirs = { ...ours, commitment: "103", index: 0 };

    // The append fails BEFORE writing anything, and a competing record for the same key appears in
    // the file meanwhile, which is what a second writer would produce.
    let armed = true;
    const failWriteThenPlantTheirs = async (...args) => {
      if (armed) {
        armed = false;
        writeFileSync(path, JSON.stringify(theirs) + "\n");
        throw new Error("simulated append failure");
      }
      return realOpen(...args);
    };
    const backend = new FileBackend(path, null, false, { open: failWriteThenPlantTheirs });
    await backend.ready();

    const res = await backend.append(ours);
    assert.equal(res.duplicate, true, "the key is taken by a record that is not ours, so this write did not win");
    assert.notEqual(res.index, 0, "and it is certainly not reported as a commit at index 0");

    const held = await backend.forSeasonContext(1, "107");
    assert.equal(held.length, 1);
    assert.equal(held[0].commitment, "103", "the durable view is the other writer's, which is what the caller must act on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed recovery read leaves no public view answering from stale state", async () => {
  // The gap a folder-access review found in the first version of the stale flag: it was checked only
  // by the append, so after a retry barrier had made a record durable and only the recovery READ
  // failed, every public method still answered from the old maps. seasonHasEngine is the one that
  // matters most, because it is the zkVM downgrade signal, so the store could report no zkVM
  // registration while the file durably held one.
  //
  // The sequence is the reviewer's: a successful initial load, an uncertain append whose retry sync
  // SUCCEEDS (so the record is genuinely durable), a failed recovery read, then every public read.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-stale-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { FileBackend } = await import("../core/registration_store.js");
    const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");

    let failNextSync = true;
    let failNextRead = false;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        if (!failNextSync) return fh;
        failNextSync = false;
        return new Proxy(fh, {
          get(target, prop) {
            if (prop === "sync") return async () => { throw new Error("simulated sync failure"); };
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
      readFile: async (...args) => {
        if (failNextRead) {
          failNextRead = false;
          throw Object.assign(new Error("simulated recovery read failure"), { code: "EIO" });
        }
        return realReadFile(...args);
      },
    });
    await backend.ready();

    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "130", engine: "zkvm", statement: "custody" };
    failNextRead = true; // the recovery READ fails, after the retry sync has already succeeded
    await assert.rejects(() => backend.append(record), /simulated sync failure/, "the append reports the uncertain write");

    // The record IS in the file at this point, so every public view must either reflect it or refuse.
    // Answering "no" from the old maps is the one outcome that is not allowed.
    assert.equal(await backend.has(record), true, "has() reconciled rather than answering from the stale view");
    assert.equal(await backend.seasonHasEngine(1, "zkvm"), true, "and the zkVM downgrade signal is not silently false");
    assert.equal((await backend.forSeasonContext(1, "107")).length, 1);
    assert.ok(await backend.declarationFor(1, "107"), "and the declaration is visible");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a syntactically valid record that is not a registration is refused at load", async () => {
  // Parsing as JSON says only that the bytes were syntactically valid. A folder-access review pointed
  // out what that lets in: corruption reaching the member cache, a bucket bound to an impossible
  // engine and statement, or a tree materialization failing later instead of the file being refused
  // where an operator can act on it.
  const cases = [
    [{ season: "one", contextHash: "107", regNullifier: "134", commitment: "128", index: 0 }, /season/],
    [{ season: 1, contextHash: "", regNullifier: "134", commitment: "128", index: 0 }, /contextHash/],
    [{ season: 1, contextHash: "107", regNullifier: "134", commitment: "128", index: -1 }, /index/],
    [{ season: 1, contextHash: "107", regNullifier: "134", commitment: "128", index: 0, engine: "plonk", statement: "custody" }, /not a valid pair/],
    [{ season: 1, contextHash: "107", regNullifier: "134", commitment: "128", index: 0, engine: "__proto__", statement: "derive" }, /not a valid pair/],
    [[1, 2, 3], /not an object/],
  ];
  for (const [bad, pattern] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "mno-reg-shape-"));
    const path = join(dir, "registrations.jsonl");
    try {
      writeFileSync(path, JSON.stringify(bad) + "\n");
      const backend = new FileBackend(path, null, false);
      await assert.rejects(() => backend.ready(), pattern, JSON.stringify(bad));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a non-canonical field element is refused at load, not left to fail at tree materialization (F4)", async () => {
  // F4 FROM THE SIXTH-ROUND REVIEW. contextHash, regNullifier, and commitment are canonical BN254
  // field elements, but the loader only checked that they were non-empty strings, so a `commitment`
  // of "not-a-field" passed FileBackend.ready() and threw only later, when the context's members tree
  // first converted it to a BigInt, moving the failure off the boot path the loader exists to guard.
  // The verifier canonical-checks these before it writes, so a non-canonical value reaches the file
  // only by corruption or hand-editing, and the loader is the last place that catches it. Each of the
  // three fields, and each way a value can be non-canonical, must be refused at load.
  const base = { season: 1, contextHash: "11", regNullifier: "12", commitment: "13", engine: "plonk", statement: "derive", index: 0 };
  // Every way a value can be non-canonical, applied to EACH of the three field-element fields, plus
  // the range boundary. A weaker per-field check, or one that skips the range, would pass a
  // field-scoped subset; running the whole matrix is what pins that all three are fully checked.
  const badValues = [
    "not-a-field", // letters
    13, // a number, not a string
    "013", // a leading zero aliases "13"
    "0x1f", // hex, not decimal
    ["13"], // an array that coerces to a decimal
    FIELD_PRIME.toString(), // exactly the field prime, out of range (the largest canonical is p-1)
    (FIELD_PRIME + 1000n).toString(), // a larger out-of-range decimal
  ];
  for (const field of ["contextHash", "regNullifier", "commitment"]) {
    for (const value of badValues) {
      const bad = { ...base, [field]: value };
      const dir = mkdtempSync(join(tmpdir(), "mno-reg-f4-"));
      const path = join(dir, "registrations.jsonl");
      try {
        writeFileSync(path, JSON.stringify(bad) + "\n");
        await assert.rejects(
          () => new FileBackend(path, null, false).ready(),
          new RegExp(`${field}.*canonical`),
          `${field} = ${JSON.stringify(value)} must be refused`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("append refuses a non-canonical field, so the store never writes a file it would later refuse", async () => {
  // A review of F4 found the asymmetry: the loader validated canonical fields but the append path only
  // stringified them, so a caller could write a file the same store rejects on the next restart.
  // Append now upholds the durable-format invariant. Checked on both backends, since the check lives
  // in RegistrationStore above the backend.
  for (const backend of [new MemoryRegistrationBackend(), new FileBackend(join(mkdtempSync(join(tmpdir(), "reg-appendcanon-")), "r.jsonl"))]) {
    const store = new RegistrationStore(backend);
    await store.ready();
    const ok = { season: 1, contextHash: "11", regNullifier: "12", commitment: "13", engine: "plonk", statement: "derive" };
    for (const field of ["contextHash", "regNullifier", "commitment"]) {
      const res = await store.append({ ...ok, [field]: "not-a-field" });
      assert.equal(res.invalid, true, `append refuses a non-canonical ${field}`);
      assert.equal(res.field, field);
    }
    // A number coerces to a canonical decimal and is accepted, so the durable form is a canonical string.
    const good = await store.append({ ...ok, commitment: 13 });
    assert.notEqual(good.invalid, true, "a value that stringifies to a canonical decimal is accepted");
  }
});

test("a legacy record with no engine or statement still loads, because the format promises it will", async () => {
  // The fields were added later and declarationOfRecord reads their absence as the plonk/derive
  // default. A first version of the shape check demanded them outright, which would have refused every
  // pre-existing file at boot: a guard with no exit for state the format says it keeps reading.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-legacy-shape-"));
  const path = join(dir, "registrations.jsonl");
  try {
    writeFileSync(path, JSON.stringify({ season: 1, contextHash: "107", regNullifier: "134", commitment: "128", index: 0 }) + "\n");
    const backend = new FileBackend(path, null, false);
    await backend.ready();
    assert.deepEqual(await backend.declarationFor(1, "107"), { engine: "plonk", statement: "derive" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Arm the stale flag the way production does: an uncertain append whose retry barrier makes the
// record durable, followed by a recovery read that fails. Returns the backend, the durable record,
// and a counter of the reads the injected layer has served, so a test can reason about how many
// reconciliations ran without reaching into private state.
async function staleStoreWithDurableRecord(path) {
  const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
  const state = { reads: 0 };
  let failNextSync = true;
  const backend = new FileBackend(path, null, false, {
    open: async (...args) => {
      const fh = await realOpen(...args);
      if (!failNextSync) return fh;
      failNextSync = false;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") return async () => { throw new Error("simulated sync failure"); };
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
    readFile: async (...args) => {
      state.reads += 1;
      // Read 1 is the initial load. Read 2 is the recovery read inside the append's catch, and
      // failing it is what marks the store behind the file.
      if (state.reads === 2) throw Object.assign(new Error("simulated recovery read failure"), { code: "EIO" });
      return realReadFile(...args);
    },
  });
  await backend.ready();
  const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "1", engine: "zkvm", statement: "custody" };
  await assert.rejects(() => backend.append(record), /simulated sync failure/);
  return { backend, record, state };
}

test("concurrent callers of a stale store share ONE reconciliation", async () => {
  // The defect a fresh full review found. Reconciliation was not single-flight, so two public calls
  // that both found the store behind the file each ran their own reload over the SAME shared maps.
  // Each captured its own "prior" pair to roll back to, and the one that failed restored a snapshot
  // taken before the one that succeeded had installed anything.
  //
  // This asserts the mechanism rather than one interleaving, because the harm depends on which
  // reload finishes last and that is not something a test should race for. One reconciliation for
  // concurrent callers has no last-one-wins to lose.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-single-flight-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { backend, record, state } = await staleStoreWithDurableRecord(path);
    const before = state.reads;
    const answers = await Promise.all([
      backend.has(record),
      backend.seasonHasEngine(1, "zkvm"),
      backend.forSeasonContext(1, "107"),
      backend.declarationFor(1, "107"),
    ]);
    assert.equal(
      state.reads - before,
      1,
      `four concurrent callers of a stale store must reconcile once, not ${state.reads - before} times`,
    );
    assert.equal(answers[0], true, "has() reflects the durable record");
    assert.equal(answers[1], true, "and the zkVM downgrade signal is not silently false");
    assert.equal(answers[2].length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// REMOVED 2026-08-09: "a failed reconciliation cannot leave a stale view marked fresh". It tried to
// force TWO concurrent reconciliations (hold the first, let a second overtake it), which is the
// interleaving that the single-clear-site and generation-guard rework of finding 1 makes
// unreachable: concurrent callers share ONE reconciliation, so the second never runs, the held one
// is never settled by another, and the test's own machinery dereferenced a null. It was flaky under
// the rework (one failure in five runs) because it depended on an exact read-index numbering the
// rework perturbed. A fixture the system cannot emit proves nothing (playbook rule 2's corollary),
// and the property it aimed at is covered without the racing: "concurrent callers of a stale store
// share ONE reconciliation" pins single-flight, and "a reread cannot turn a failed durability
// barrier into an apparent commit" pins that a failed reconciliation refuses rather than answers
// from a view it did not establish.

test("no public view answers from the old maps while an uncertain write is still recovering", async () => {
  // The blocker an independent review raised against the first version of the single-flight fix.
  // The two tests above both begin AFTER the stale flag is already set, so they prove single-flight
  // from a stale start and say nothing about how the store gets there.
  //
  // The gap was the recovery window itself. An append whose first sync fails may already have put
  // the record on disk, and the retry barrier and the reconciliation call after it are both awaits.
  // The flag used to be set only when the recovery load SETTLED, so a reader landing in between
  // found it false and `ready()` already fulfilled, and answered from the old maps: has false,
  // forSeasonContext empty, declarationFor null, and seasonHasEngine false for a durable zkVM
  // record, which is the downgrade signal reading backwards.
  //
  // The window is held open here rather than raced for. Waiting longer only gives a regression more
  // opportunity to answer wrongly, so this cannot become flaky in the direction of a false pass.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-window-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
    let firstSync = true;
    let reads = 0;
    let releaseRecoveryRead;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        if (!firstSync) return fh;
        firstSync = false;
        return new Proxy(fh, {
          get(target, prop) {
            if (prop === "sync") return async () => { throw new Error("simulated sync failure"); };
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
      readFile: async (...args) => {
        reads += 1;
        // Read 1 is the initial load. Read 2 is the recovery reconciliation, held open.
        if (reads === 2) return new Promise((resolve) => { releaseRecoveryRead = () => resolve(realReadFile(...args)); });
        return realReadFile(...args);
      },
    });
    await backend.ready();

    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "1", engine: "zkvm", statement: "custody" };
    const appending = backend.append(record).then(() => {}, () => {}); // settles after the release

    // Real filesystem work resolves on the threadpool, which outlasts a burst of setImmediate turns.
    for (let i = 0; i < 400 && reads < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(reads >= 2, "the append never reached its recovery read, so the window was never open");
    assert.ok(
      readFileSync(path, "utf8").includes('"regNullifier":"136"'),
      "the record must already be durable, or this is not the window under test",
    );

    const answered = {};
    const track = (label, p) =>
      p.then(
        () => { answered[label] ??= "answered"; },
        () => { answered[label] ??= "refused"; },
      );
    const queries = [
      track("has", backend.has(record)),
      track("seasonHasEngine", backend.seasonHasEngine(1, "zkvm")),
      track("forSeasonContext", backend.forSeasonContext(1, "107")),
      track("declarationFor", backend.declarationFor(1, "107")),
    ];
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));

    // Refusing is allowed. Answering from a view that predates a durable record is not.
    assert.deepEqual(
      Object.entries(answered).filter(([, how]) => how === "answered"),
      [],
      "a public view answered from the old maps while an uncertain write was still recovering",
    );

    releaseRecoveryRead();
    await Promise.all(queries);
    await appending;

    // And once the reconciliation lands, every view reflects the durable record.
    assert.equal(await backend.has(record), true);
    assert.equal(await backend.seasonHasEngine(1, "zkvm"), true);
    assert.equal((await backend.forSeasonContext(1, "107")).length, 1);
    assert.deepEqual(await backend.declarationFor(1, "107"), { engine: "zkvm", statement: "custody" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync failure marks the view behind the file before close() is even awaited", async () => {
  // The window a re-check found after the previous fix. The flag was set in the OUTER catch, and a
  // `finally` runs before that catch, so a sync failure reached `await fh.close()` with the record
  // already durable and the flag still clear. Holding close open showed all four public views
  // denying a registration that was on disk.
  //
  // This opens the EARLIER window deliberately. The recovery-read test above cannot see this one: by
  // the time its held read begins, the retry barrier has run and the flag is long since set, so a
  // mutant that merely moves the assignment down to the reconciliation call still passes it. That
  // was demonstrated, not assumed.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-close-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
    let firstHandle = true;
    let releaseClose;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        if (!firstHandle) return fh;
        firstHandle = false;
        return new Proxy(fh, {
          get(target, prop) {
            // A REAL sync, then an error. This is the shape that matters: the bytes genuinely reach
            // stable storage and the caller is still told the write failed.
            if (prop === "sync") {
              return async () => {
                await target.sync();
                throw new Error("simulated sync failure after a real barrier");
              };
            }
            // Held so the window between the failure and the close stays open and measurable.
            if (prop === "close") {
              return () => new Promise((resolve) => { releaseClose = () => resolve(target.close()); });
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
      readFile: async (...args) => realReadFile(...args),
    });
    await backend.ready();

    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "1", engine: "zkvm", statement: "custody" };
    const appending = backend.append(record).then(() => {}, () => {});

    for (let i = 0; i < 400 && !releaseClose; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(releaseClose, "the append never reached close(), so the window was never open");
    assert.ok(
      readFileSync(path, "utf8").includes('"regNullifier":"136"'),
      "the record must already be durable, or this is not the window under test",
    );

    // Answering is allowed here, unlike the held-read case above: the reconciliation read is NOT
    // held, so a reader that reconciles can legitimately finish and answer. What is not allowed is
    // DENYING a record that is already durable. Refusing is also fine.
    const denials = [];
    const track = (label, p, isDenial) =>
      p.then(
        (v) => { if (isDenial(v)) denials.push(`${label} denied a durable record`); },
        () => {},
      );
    const queries = [
      track("has", backend.has(record), (v) => v === false),
      track("seasonHasEngine", backend.seasonHasEngine(1, "zkvm"), (v) => v === false),
      track("forSeasonContext", backend.forSeasonContext(1, "107"), (v) => v.length === 0),
      track("declarationFor", backend.declarationFor(1, "107"), (v) => v == null),
    ];
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
    await Promise.all(queries);

    assert.deepEqual(denials, [], "a public view denied a durable record between the sync failure and the close");

    releaseClose();
    await appending;
    assert.equal(await backend.has(record), true);
    assert.equal(await backend.seasonHasEngine(1, "zkvm"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reread cannot turn a failed durability barrier into an apparent commit", async () => {
  // The finding a re-check raised after the stale-marking fixes. This file already argues on the
  // WRITE path that a reread cannot establish durability, because readFile() returns dirty
  // page-cache data and a failed sync is exactly when visibility and durability differ. The
  // reconciliation path was still doing it. With both barriers failing, the append rejected and
  // marked the view stale, and the next reader reloaded, found the bytes in cache, installed the
  // record and cleared the flag, with nothing ever forced to stable storage.
  //
  // The harm is not confined to this store. The retry is then refused as `already-registered` by
  // the cheap read in verifier.js while season.js never appended the commitment, so the member
  // holds a spent registration nullifier and is absent from the live members tree.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-barrier-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
    let barriersAttempted = 0;
    let barriersSucceeded = 0;
    let syncsFail = true;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        return new Proxy(fh, {
          get(target, prop) {
            if (prop === "sync") {
              return async () => {
                barriersAttempted += 1;
                if (syncsFail) throw Object.assign(new Error("simulated barrier failure"), { code: "EIO" });
                await target.sync();
                barriersSucceeded += 1;
              };
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
      readFile: async (...args) => realReadFile(...args),
    });
    await backend.ready();

    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "1", engine: "zkvm", statement: "custody" };
    await assert.rejects(() => backend.append(record), /simulated barrier failure/);
    assert.equal(barriersSucceeded, 0, "no barrier may have succeeded, or this is not the case under test");
    // The bytes ARE visible, which is precisely what must not be mistaken for a commit.
    assert.ok(readFileSync(path, "utf8").includes('"regNullifier":"136"'), "the bytes are visible in the file");

    // Every public view must refuse rather than reporting the unbarriered record as registered.
    await assert.rejects(() => backend.has(record), /simulated barrier failure/);
    await assert.rejects(() => backend.seasonHasEngine(1, "zkvm"), /simulated barrier failure/);
    await assert.rejects(() => backend.forSeasonContext(1, "107"), /simulated barrier failure/);
    await assert.rejects(() => backend.declarationFor(1, "107"), /simulated barrier failure/);

    // And it must keep refusing rather than settling into a false answer.
    await assert.rejects(() => backend.seasonHasEngine(1, "zkvm"), /simulated barrier failure/);

    // Once the storage recovers, a barrier succeeds and the record is legitimately visible.
    syncsFail = false;
    assert.equal(await backend.has(record), true);
    assert.equal(await backend.seasonHasEngine(1, "zkvm"), true);
    assert.ok(barriersSucceeded > 0, "the recovery must go through a barrier that actually succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unbarriered write cannot be laundered into a commit during the awaited close", async () => {
  // The major a fresh full pass found after the barrier work landed. The inner catch marked #stale
  // but left #unbarriered to the outer catch, which is the same one-await-too-late defect the inner
  // catch exists to fix, one flag over. During the awaited close a reader began reconciling, saw
  // #unbarriered still false, SKIPPED the barrier, installed page-cache bytes and cleared #stale.
  const dir = mkdtempSync(join(tmpdir(), "mno-reg-launder-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen, readFile: realReadFile } = await import("node:fs/promises");
    let releaseClose;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        return new Proxy(fh, {
          get(target, prop) {
            // No sync EVER performs a real barrier, so nothing here reaches stable storage.
            if (prop === "sync") return async () => { throw Object.assign(new Error("barrier failure"), { code: "EIO" }); };
            if (prop === "close" && !releaseClose) {
              return () => new Promise((resolve) => { releaseClose = () => resolve(target.close()); });
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
      readFile: async (...args) => realReadFile(...args),
    });
    await backend.ready();

    const record = { season: 1, contextHash: "107", regNullifier: "136", commitment: "1", engine: "zkvm", statement: "custody" };
    const appending = backend.append(record).then(() => {}, () => {});
    for (let i = 0; i < 400 && !releaseClose; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(releaseClose, "the append never reached close(), so the window was never open");
    assert.ok(readFileSync(path, "utf8").includes('"regNullifier":"136"'), "the bytes are visible, which is the trap");

    // A reader arriving in the window must not be able to establish the record, because no barrier
    // has succeeded and a read cannot supply one.
    const racing = backend.has(record).then((v) => v, () => "refused");
    releaseClose();
    await appending;
    assert.notEqual(await racing, true, "a read during the close window laundered an unbarriered write into a commit");
    await assert.rejects(() => backend.seasonHasEngine(1, "zkvm"), /barrier failure/, "and it must keep refusing afterwards");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file the base revision produces still loads, rather than refusing an upgrade", async () => {
  // A version of the leaf-order repair refused any bucket whose positions were not exactly 0..n-1.
  // Healthy buckets always are. The files this repair exists for are not, and a fresh round showed
  // the refusal turning an upgrade into an outage.
  //
  // Under the base revision K writes at index 0 and its barriers fail, M then writes successfully at
  // index 0, and M's sync also makes K's earlier bytes durable. The file legitimately holds two
  // DISTINCT records both claiming position 0. That is not a duplicate key and nothing collapses.
  // The base revision reopens it, so this one must too, and after exactly the storage failure this
  // whole repair is about.
  const dir = mkdtempSync(join(tmpdir(), "reg-upgrade-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const K = { season: 1, contextHash: "107", regNullifier: "142", commitment: "7", engine: "plonk", statement: "derive" };
    const M = { season: 1, contextHash: "107", regNullifier: "143", commitment: "9", engine: "plonk", statement: "derive" };
    writeFileSync(path, [JSON.stringify({ ...K, index: 0 }), JSON.stringify({ ...M, index: 0 }), ""].join("\n"));

    const backend = new FileBackend(path, null, false);
    await backend.ready(); // must not throw
    const recs = await backend.forSeasonContext(1, "107");
    // Ties keep file order, so this rebuilds what the base revision rebuilt rather than a new order.
    assert.deepEqual(recs.map((r) => r.regNullifier), ["142", "143"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt duplicate is refused rather than replacing a valid record", async () => {
  // Fresh-round finding. The last-occurrence-wins collapse replaced the stored record without
  // validating the replacement, and sameRegistrationRecord treats an empty engine as equal to an
  // absent one and a numeric commitment as equal to its decimal string. So a corrupt duplicate
  // slipped past the identity check and overwrote a valid record, binding the bucket to an empty
  // engine or handing a number to the members tree. Validation now runs ahead of the duplicate
  // branch, so both routes into the index pass the same check.
  //
  // Assert REFUSAL directly, not a property of what loaded: a mutation that admits the record with a
  // different declaration would pass a softer assertion.
  const dir = mkdtempSync(join(tmpdir(), "reg-corruptdup-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const K = { season: 1, contextHash: "107", regNullifier: "142", commitment: "7", engine: "plonk", statement: "derive" };
    // Case one: engine "" compares equal to absent engine, but is not a valid engine.
    writeFileSync(path, [JSON.stringify({ ...K, index: 0 }), JSON.stringify({ ...K, engine: "", index: 0 }), ""].join("\n"));
    await assert.rejects(() => new FileBackend(path, null, false).ready(), /not a usable registration record/);

    // Case two: a numeric commitment compares equal to its decimal string, but is not a string.
    writeFileSync(path, [JSON.stringify({ ...K, index: 0 }), JSON.stringify({ ...K, commitment: 7, index: 0 }), ""].join("\n"));
    await assert.rejects(() => new FileBackend(path, null, false).ready(), /not a usable registration record/);

    // Control: an IDENTICAL valid duplicate still collapses and loads, so validation did not turn
    // the legitimate recovery case into a refusal.
    writeFileSync(path, [JSON.stringify({ ...K, index: 0 }), JSON.stringify({ ...K, index: 0 }), ""].join("\n"));
    const b = new FileBackend(path, null, false);
    await b.ready();
    assert.equal((await b.forSeasonContext(1, "107")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed torn-tail truncate does not arm a later load into deleting a repaired record", async () => {
  // Fresh-round finding. `_truncateTo` was instance state nulled only on a successful truncate, so a
  // failed truncate left the offset armed, and a later load over a file an operator had since
  // repaired applied the stale offset and deleted a good record. The offset is now a per-load local.
  //
  // truncate is injectable for the same reason open and readFile are: the recovery path is defined
  // by a filesystem failure a test cannot otherwise drive.
  const dir = mkdtempSync(join(tmpdir(), "reg-armed-trunc-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { truncate: realTruncate } = await import("node:fs/promises");
    const A = { season: 1, contextHash: "107", regNullifier: "140", commitment: "1", engine: "plonk", statement: "derive", index: 0 };
    // A complete record, then a torn (unparseable) tail with no trailing newline.
    writeFileSync(path, JSON.stringify(A) + "\n" + "{ torn");

    let truncateFails = true;
    const backend = new FileBackend(path, null, false, {
      truncate: async (...a) => {
        if (truncateFails) throw Object.assign(new Error("simulated truncate failure"), { code: "EPERM" });
        return realTruncate(...a);
      },
    });
    await assert.rejects(() => backend.ready(), /simulated truncate failure/, "the first load fails IN the repair");

    // The operator repairs the file to two complete records, cleanly terminated.
    const B = { season: 1, contextHash: "107", regNullifier: "141", commitment: "2", engine: "plonk", statement: "derive", index: 1 };
    writeFileSync(path, [JSON.stringify(A), JSON.stringify(B), ""].join("\n"));
    truncateFails = false; // storage recovered

    await backend.ready(); // must not apply any stale offset

    // Assert on IDENTITY and on disk, not on a count or a no-throw: a stale offset would have deleted
    // B, so the surviving record set and the file itself are what pin the property.
    assert.deepEqual((await backend.forSeasonContext(1, "107")).map((r) => r.regNullifier), ["140", "141"]);
    assert.ok(readFileSync(path, "utf8").includes('"regNullifier":"141"'), "B is still on disk, not truncated away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bucket that mixes engine/statement declarations is refused at load", async () => {
  // Fresh-round finding. The loader validated each record's engine/statement pair individually but
  // never checked that a (season, contextHash) bucket's records AGREE. A query reads only the first
  // record, so a bucket mixing PLONK and zkVM made seasonHasEngine report the wrong downgrade signal
  // while the file durably held a zkVM registration. The append path already refuses a second
  // declaration; the loader now enforces the same coherence.
  const dir = mkdtempSync(join(tmpdir(), "reg-mixeddecl-"));
  const path = join(dir, "registrations.jsonl");
  try {
    writeFileSync(path, [
      JSON.stringify({ season: 1, contextHash: "1", regNullifier: "1", commitment: "1", engine: "plonk", statement: "derive", index: 0 }),
      JSON.stringify({ season: 1, contextHash: "1", regNullifier: "2", commitment: "2", engine: "zkvm", statement: "custody", index: 1 }),
      "",
    ].join("\n"));
    await assert.rejects(() => new FileBackend(path, null, false).ready(), /already declared|One bucket holds one declaration/);

    // Control: one declaration across the bucket loads, and seasonHasEngine reports it correctly.
    writeFileSync(path, [
      JSON.stringify({ season: 1, contextHash: "1", regNullifier: "1", commitment: "1", engine: "zkvm", statement: "custody", index: 0 }),
      JSON.stringify({ season: 1, contextHash: "1", regNullifier: "2", commitment: "2", engine: "zkvm", statement: "custody", index: 1 }),
      "",
    ].join("\n"));
    const b = new FileBackend(path, null, false);
    await b.ready();
    assert.equal(await b.seasonHasEngine(1, "zkvm"), true, "the durable zkVM registration is reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a complete unterminated record is barriered before the store treats it as committed", async () => {
  // Fresh-round finding. The case-b repair (a complete record with no trailing newline) added the
  // newline with a plain appendFile and never synchronized, then installed the record and answered
  // has() true. Its bytes were written by a process that died before its own newline, so no
  // successful fsync need sit behind them, and a power failure before a later sync could lose a
  // record the store had treated as committed. The repair now forces the bytes to disk, adds the
  // delimiter, and forces again.
  const dir = mkdtempSync(join(tmpdir(), "reg-repairbarrier-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen } = await import("node:fs/promises");
    const A = { season: 1, contextHash: "1", regNullifier: "1", commitment: "1", engine: "plonk", statement: "derive", index: 0 };
    writeFileSync(path, JSON.stringify(A)); // complete record, NO trailing newline

    // Record the ORDER of operations, not just a count. A round noted that `sync(); sync();
    // appendFile()` would satisfy a bare count while forcing nothing before the newline, so the
    // sequence must show a barrier BEFORE the delimiter is written and one AFTER.
    const ops = [];
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        return new Proxy(fh, {
          get(target, prop) {
            if (prop === "sync") return async () => { ops.push("sync"); return target.sync(); };
            if (prop === "appendFile") return async (...a) => { ops.push("append"); return target.appendFile(...a); };
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    await backend.ready();
    // The existing bytes are forced BEFORE the delimiter is appended, and the delimiter is forced AFTER.
    assert.deepEqual(ops, ["sync", "append", "sync"], "the repair barriers the record, appends the newline, then barriers again");
    assert.equal(await backend.has(A), true, "and the record is present after the barriered repair");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a header write whose directory flush fails re-runs the flush on the next load", async () => {
  // Fresh-round finding, the second half of the directory-durability defect. fsync of the file does
  // not force its directory entry, and when the header write's directory flush FAILED, ready()
  // rejected and the retry saw the header, so it skipped the whole creation block and never flushed
  // the directory again. The flush now stands outside the header block, gated on a flag set only on
  // success, so a retry redoes it. Only the schedule path has a durable-directory contract, so this
  // uses a schedule and injects the directory open.
  const dir = mkdtempSync(join(tmpdir(), "reg-dirflush-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen } = await import("node:fs/promises");
    let failDirSync = true;
    const dirSyncTargets = [];
    const inject = {
      open: async (...args) => {
        const fh = await realOpen(...args);
        // The directory is opened read-only; that is the handle whose sync we drive. Record the PATH
        // synced, not just a count, because a round noted a count-only assertion passes even if the
        // code syncs the FILE twice instead of the directory.
        if (args[1] === "r") {
          return new Proxy(fh, {
            get(target, prop) {
              if (prop === "sync") {
                return async () => {
                  dirSyncTargets.push(args[0]);
                  if (failDirSync) throw Object.assign(new Error("simulated directory flush failure"), { code: "EIO" });
                  return target.sync();
                };
              }
              const v = target[prop];
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
        }
        return fh;
      },
    };
    const backend = new FileBackend(path, "sched-1", false, inject);
    // First load writes the header, then the directory flush fails, so the whole load rejects.
    await assert.rejects(() => backend.ready(), /simulated directory flush failure/);
    // The header is now on disk. A naive retry would skip creation and never flush the directory.
    failDirSync = false;
    await backend.ready(); // must re-run the flush rather than skip it
    // Retried at least twice (once failing, once succeeding), and every target was the DIRECTORY, not
    // the file, so syncing the file twice cannot satisfy this.
    assert.ok(dirSyncTargets.length >= 2, "the directory flush was retried on the next load, not skipped");
    for (const t of dirSyncTargets) {
      assert.equal(t, dirname(path), `the flush target must be the directory ${dirname(path)}, not ${t}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with a leaf-index GAP is refused, and an accepted tie stays consistent across an append", async () => {
  // Fresh-round finding. The base-revision compatibility fix accepts non-contiguous stored indexes
  // and sorts by them, which is right for a TIE (two records at index 0 from an uncertain-write
  // retry) but wrong for a GAP. A file holding A@0, B@5 in a two-record bucket loads as [A, B], but
  // the next append takes index 2 and pushes to the end, so the live order is [A, B, C@2] while a
  // restart re-sorts to [A, C@2, B@5]. Live and restart disagree, so the served members root stops
  // matching the rebuilt one. The exact bound is max index <= length, so the test drives the BOUNDARY:
  // max == length+1 must refuse (the smallest gap that reorders), max == length must load (a later
  // round showed the stricter < wrongly refused it), and every accepted file's live order must equal
  // its restart order after an append.
  const dir = mkdtempSync(join(tmpdir(), "reg-gap-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const R = (n, i) => ({ season: 1, contextHash: "107", regNullifier: n, commitment: i + "", engine: "plonk", statement: "derive", index: i });
    // Append to a loaded file, then reopen, and return whether the live and restart orders agree.
    const appendAndCompare = async () => {
      const live = new FileBackend(path, null, false);
      await live.ready();
      await live.append({ season: 1, contextHash: "107", regNullifier: "101", commitment: "9", engine: "plonk", statement: "derive" });
      const liveOrder = (await live.forSeasonContext(1, "107")).map((r) => r.regNullifier);
      const restart = new FileBackend(path, null, false);
      await restart.ready();
      const restartOrder = (await restart.forSeasonContext(1, "107")).map((r) => r.regNullifier);
      return { liveOrder, restartOrder };
    };

    // BOUNDARY, refuse: max index length+1 (2 in a two-record bucket) is the smallest gap that reorders.
    writeFileSync(path, [JSON.stringify(R("148", 0)), JSON.stringify(R("149", 3)), ""].join("\n"));
    await assert.rejects(() => new FileBackend(path, null, false).ready(), /gap an append-only store cannot produce|above that count/);

    // BOUNDARY, accept: max index EQUAL to the length. The stricter < refused this; it does not reorder.
    writeFileSync(path, [JSON.stringify(R("148", 0)), JSON.stringify(R("149", 2)), ""].join("\n"));
    const boundary = await appendAndCompare();
    assert.deepEqual(boundary.liveOrder, boundary.restartOrder, "max==length loads and stays consistent across an append");
    assert.deepEqual(boundary.liveOrder, ["148", "149", "101"], "and the append sorts last");

    // The tie (base-revision shape) also loads and stays consistent.
    writeFileSync(path, [JSON.stringify(R("148", 0)), JSON.stringify(R("149", 0)), ""].join("\n"));
    const tie = await appendAndCompare();
    assert.deepEqual(tie.liveOrder, tie.restartOrder, "the tie's live and restart order match after an append");
    assert.deepEqual(tie.liveOrder, ["148", "149", "101"], "and the appended record sorts after the tied pair");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh multi-level directory path forces every new ancestor durable", async () => {
  // Fresh-round finding. Recursive mkdir can create several directory levels, and flushing only the
  // file's immediate directory covers the entries INSIDE it, not the entry naming it in its parent,
  // so a crash could lose the whole path and an acknowledged registration with it. The flush now
  // walks from the file's directory up to the first pre-existing ancestor.
  const base = mkdtempSync(join(tmpdir(), "reg-chain-"));
  const path = join(base, "new-a", "new-b", "registrations.jsonl"); // two missing levels
  const syncedDirs = [];
  try {
    const { open: realOpen } = await import("node:fs/promises");
    const backend = new FileBackend(path, "sched-1", false, {
      open: async (...args) => {
        if (args[1] === "r") syncedDirs.push(args[0]);
        return realOpen(...args);
      },
    });
    await backend.ready();
    // EXACTLY the newly created levels plus the one pre-existing ancestor that names the first new
    // level, and NOTHING above it. Asserting the exact set rather than `includes` rejects a walk that
    // ignores the boundary and syncs to the filesystem root, which a round noted an includes-only
    // assertion would pass and which would fail startup on a system that refuses syncing an unrelated
    // ancestor.
    assert.deepEqual(
      [...syncedDirs].sort(),
      [join(base, "new-a", "new-b"), join(base, "new-a"), base].sort(),
      "the walk flushes the new chain and its naming ancestor, and stops there",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a durable record is visible during a successful close, not only after it", async () => {
  // Fresh-round finding. On the SUCCESS path the record was durable after sync() but #remember ran
  // only after the outer try, so during `await fh.close()` a concurrent read answered from the old
  // maps and denied a registration that was on disk. The existing close-window test covers the
  // FAILURE path (a sync that throws); this covers the success path, where sync succeeds and only the
  // close is held. #remember now runs the moment the record is durable.
  const dir = mkdtempSync(join(tmpdir(), "reg-closevis-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen } = await import("node:fs/promises");
    let releaseClose;
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        return new Proxy(fh, {
          get(target, prop) {
            // Real appendFile and a REAL successful sync, then hold the close.
            if (prop === "close" && !releaseClose) {
              return () => new Promise((resolve) => { releaseClose = () => resolve(target.close()); });
            }
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    await backend.ready();
    const record = { season: 1, contextHash: "107", regNullifier: "134", commitment: "1", engine: "zkvm", statement: "custody" };
    const appending = backend.append(record).then(() => {}, () => {});
    for (let i = 0; i < 400 && !releaseClose; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.ok(releaseClose, "the append never reached close(), so the window was never open");
    assert.ok(readFileSync(path, "utf8").includes('"regNullifier":"134"'), "the record is durable on disk during the window");

    // The record is durable, so a read during the close must not deny it.
    assert.equal(await backend.has(record), true, "has() reflects the durable record during the close");
    assert.equal(await backend.seasonHasEngine(1, "zkvm"), true, "and so does the downgrade signal");

    releaseClose();
    await appending;
    assert.equal((await backend.forSeasonContext(1, "107")).length, 1, "and the record is not doubled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-level directory flush that fails partway is fully retried, not just the leaf", async () => {
  // Fresh-round finding. `#createdDirBoundary` used to be local to one load, so a retry after a
  // partial flush failure saw no newly created directories (they now exist) and flushed only the leaf,
  // losing the ancestor boundary. The boundary is now sticky, so the retry re-flushes the whole chain.
  const base = mkdtempSync(join(tmpdir(), "reg-chainretry-"));
  const path = join(base, "new-a", "new-b", "registrations.jsonl");
  const flushed = [];
  try {
    const { open: realOpen } = await import("node:fs/promises");
    let failTarget = join(base, "new-a"); // fail the flush of the intermediate directory once
    const backend = new FileBackend(path, "sched-1", false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        if (args[1] === "r") {
          return new Proxy(fh, {
            get(target, prop) {
              if (prop === "sync") {
                return async () => {
                  flushed.push(args[0]);
                  if (args[0] === failTarget) { failTarget = null; throw Object.assign(new Error("flush fail"), { code: "EIO" }); }
                  return target.sync();
                };
              }
              const v = target[prop];
              return typeof v === "function" ? v.bind(target) : v;
            },
          });
        }
        return fh;
      },
    });
    await assert.rejects(() => backend.ready(), /flush fail/);
    flushed.length = 0; // watch only the retry
    await backend.ready();
    // The retry re-flushes the WHOLE chain up to the pre-existing ancestor, not just the leaf.
    assert.ok(flushed.includes(join(base, "new-a", "new-b")), "leaf directory re-flushed");
    assert.ok(flushed.includes(join(base, "new-a")), "intermediate directory re-flushed on retry");
    assert.ok(flushed.includes(base), "the pre-existing ancestor is flushed on retry, not skipped");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a repair whose first barrier fails refuses the record rather than trusting it", async () => {
  // Strengthens the repair-barrier coverage the round called weak: an order-only assertion passes a
  // mutation that catches and ignores the sync failures. This drives the FIRST barrier to fail and
  // requires the load to reject, so the unterminated record is not trusted without a durable barrier.
  const dir = mkdtempSync(join(tmpdir(), "reg-repairfail-"));
  const path = join(dir, "registrations.jsonl");
  try {
    const { open: realOpen } = await import("node:fs/promises");
    const A = { season: 1, contextHash: "1", regNullifier: "1", commitment: "1", engine: "plonk", statement: "derive", index: 0 };
    writeFileSync(path, JSON.stringify(A)); // complete record, no trailing newline
    const backend = new FileBackend(path, null, false, {
      open: async (...args) => {
        const fh = await realOpen(...args);
        return new Proxy(fh, {
          get(target, prop) {
            if (prop === "sync") return async () => { throw Object.assign(new Error("repair barrier failed"), { code: "EIO" }); };
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    await assert.rejects(() => backend.ready(), /repair barrier failed/, "the load refuses when the record cannot be barriered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
