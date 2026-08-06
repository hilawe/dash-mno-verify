import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import {
  RegistrationStore,
  MemoryRegistrationBackend,
  FileBackend,
} from "../core/registration_store.js";
import { MembersTree } from "../core/members_tree.js";

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

    assert.equal(await store.has(1, "ctx", "nf1"), false);
    const first = await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf1", commitment: "c1", engine: "plonk", statement: "derive" });
    assert.deepEqual(first, { duplicate: false, index: 0 });
    assert.equal(await store.has(1, "ctx", "nf1"), true);

    // the same season, context, and registration nullifier is the same spend, even with a
    // different commitment: one voting key registers once per season and context
    const dup = await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf1", commitment: "c-other", engine: "plonk", statement: "derive" });
    assert.equal(dup.duplicate, true);

    const recs = await store.forSeasonContext(1, "ctx");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].commitment, "c1");
  });

  test(`${name}: season, context, and registration nullifier are independent`, async () => {
    const { store } = await makeStore();
    await store.ready();
    await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf", commitment: "c", engine: "plonk", statement: "derive" });
    assert.equal(await store.has(2, "ctx", "nf"), false); // different season
    assert.equal(await store.has(1, "ctx2", "nf"), false); // different community
    assert.equal(await store.has(1, "ctx", "nf2"), false); // different node
  });

  test(`${name}: indexes are per (season, context) and assigned in insertion order`, async () => {
    const { store } = await makeStore();
    await store.ready();
    const a = await store.append({ season: 5, contextHash: "ctx", regNullifier: "a", commitment: "ca", engine: "plonk", statement: "derive" });
    const b = await store.append({ season: 5, contextHash: "ctx", regNullifier: "b", commitment: "cb", engine: "plonk", statement: "derive" });
    const c = await store.append({ season: 6, contextHash: "ctx", regNullifier: "c", commitment: "cc", engine: "plonk", statement: "derive" });
    assert.deepEqual([a.index, b.index, c.index], [0, 1, 0]);

    // A different community in the same season is a separate bucket, indexed from 0 (review B2).
    const d = await store.append({ season: 5, contextHash: "ctx2", regNullifier: "d", commitment: "cd", engine: "plonk", statement: "derive" });
    assert.equal(d.index, 0);

    const s5 = await store.forSeasonContext(5, "ctx");
    assert.deepEqual(s5.map((r) => r.commitment), ["ca", "cb"]);
    const s6 = await store.forSeasonContext(6, "ctx");
    assert.deepEqual(s6.map((r) => r.commitment), ["cc"]);
    assert.deepEqual(await store.forSeasonContext(5, "ctx2"), [
      { season: 5, contextHash: "ctx2", regNullifier: "d", commitment: "cd", engine: "plonk", statement: "derive", index: 0 },
    ]);
    assert.deepEqual(await store.forSeasonContext(99, "ctx"), []); // a fresh season starts empty
  });

  test(`${name}: a bucket is bound to one (engine, statement); a mismatch is rejected`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // The first registration declares the bucket (plonk, derive here).
    const first = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n1", commitment: "c1", engine: "plonk", statement: "derive" });
    assert.equal(first.duplicate, false);
    assert.deepEqual(await store.declarationFor(1, "ctx"), { engine: "plonk", statement: "derive" });

    // A later registration for the same bucket under a different statement is a conflict, not written.
    const conflict = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n2", commitment: "c2", engine: "zkvm", statement: "custody" });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.declared, { engine: "plonk", statement: "derive" });
    assert.equal(await store.has(1, "ctx", "n2"), false, "the conflicting registration was not stored");

    // A matching later registration is accepted.
    const ok = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n3", commitment: "c3", engine: "plonk", statement: "derive" });
    assert.equal(ok.duplicate, false);
    assert.equal(ok.index, 1);

    // A different bucket can declare a different statement.
    const other = await store.append({ season: 1, contextHash: "ctx2", regNullifier: "n4", commitment: "c4", engine: "zkvm", statement: "custody" });
    assert.equal(other.duplicate, false);
    assert.deepEqual(await store.declarationFor(1, "ctx2"), { engine: "zkvm", statement: "custody" });
  });

  test(`${name}: an impossible engine/statement pair is rejected`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // PLONK supports only derive, so plonk/custody is invalid and never declares a bucket.
    const bad = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n1", commitment: "c1", engine: "plonk", statement: "custody" });
    assert.equal(bad.invalid, true);
    assert.equal(await store.declarationFor(1, "ctx"), null, "no bucket was declared");
  });

  test(`${name}: a new write with no engine/statement fails closed, not a silent legacy default`, async () => {
    const { store } = await makeStore();
    await store.ready();
    // Omitting the declaration on a NEW write is rejected, so a caller that drops the field cannot
    // silently write a plonk/derive record and mislabel a custody registration.
    const noDecl = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n1", commitment: "c1" });
    assert.equal(noDecl.invalid, true);
    assert.equal(await store.has(1, "ctx", "n1"), false, "nothing was written");
    const partial = await store.append({ season: 1, contextHash: "ctx", regNullifier: "n2", commitment: "c2", engine: "zkvm" });
    assert.equal(partial.invalid, true, "a missing statement also fails closed");
  });

  test(`${name}: seasonHasEngine reports a durable zkVM declaration (the downgrade-rule signal)`, async () => {
    const { store } = await makeStore();
    await store.ready();
    assert.equal(await store.seasonHasEngine(1, "zkvm"), false);
    // A plonk registration in the season does not make it zkvm.
    await store.append({ season: 1, contextHash: "ctxA", regNullifier: "a", commitment: "ca", engine: "plonk", statement: "derive" });
    assert.equal(await store.seasonHasEngine(1, "zkvm"), false);
    // A zkvm registration in another context of the same season does.
    await store.append({ season: 1, contextHash: "ctxB", regNullifier: "b", commitment: "cb", engine: "zkvm", statement: "custody" });
    assert.equal(await store.seasonHasEngine(1, "zkvm"), true);
    // Scoped to the season: a different season is unaffected.
    assert.equal(await store.seasonHasEngine(2, "zkvm"), false);
  });
}

test("file: registrations survive a restart (durability)", async () => {
  await withTempFile(async (path) => {
    const first = new RegistrationStore(new FileBackend(path));
    await first.ready();
    await first.append({ season: 3, contextHash: "ctx", regNullifier: "n1", commitment: "c1", engine: "plonk", statement: "derive" });
    await first.append({ season: 3, contextHash: "ctx", regNullifier: "n2", commitment: "c2", engine: "plonk", statement: "derive" });

    // a new gateway process reads the same file and recovers the full set
    const reopened = new RegistrationStore(new FileBackend(path));
    await reopened.ready();
    assert.equal(await reopened.has(3, "ctx", "n1"), true);
    assert.equal(await reopened.has(3, "ctx", "n2"), true);
    const recs = await reopened.forSeasonContext(3, "ctx");
    assert.deepEqual(recs.map((r) => r.commitment), ["c1", "c2"]);

    // and the spend set is enforced after the restart, so no member registers twice
    const dup = await reopened.append({ season: 3, contextHash: "ctx", regNullifier: "n1", commitment: "c1", engine: "plonk", statement: "derive" });
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
      store.append({ season: 1, contextHash: "ctx", regNullifier: "nA", commitment: "cA", engine: "plonk", statement: "derive" }),
      store.append({ season: 1, contextHash: "ctx", regNullifier: "nB", commitment: "cB", engine: "zkvm", statement: "custody" }),
    ]);
    const wins = [a, b].filter((r) => r.duplicate === false);
    const conflicts = [a, b].filter((r) => r.conflict === true);
    assert.equal(wins.length, 1, "exactly one registration is written");
    assert.equal(conflicts.length, 1, "the other conflicts");
    // The loser reports the winner's declaration, and the bucket holds exactly one record.
    const decl = await store.declarationFor(1, "ctx");
    assert.deepEqual(conflicts[0].declared, decl);
    const recs = await store.forSeasonContext(1, "ctx");
    assert.equal(recs.length, 1);
  });
});

test("file: a legacy record (no engine/statement) reopens as plonk/derive and rejects custody", async () => {
  await withTempFile(async (path) => {
    // Seed a real legacy JSON-lines record, the pre-declaration shape with no engine/statement.
    await writeFile(path, JSON.stringify({ season: 2, contextHash: "ctx", regNullifier: "legacy", commitment: "cL", index: 0 }) + "\n");

    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    assert.equal(await store.has(2, "ctx", "legacy"), true, "the legacy record loads");
    assert.deepEqual(await store.declarationFor(2, "ctx"), { engine: "plonk", statement: "derive" });

    // A custody registration into the legacy (derive-declared) bucket is rejected and not written.
    const conflict = await store.append({ season: 2, contextHash: "ctx", regNullifier: "new", commitment: "cN", engine: "zkvm", statement: "custody" });
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.declared, { engine: "plonk", statement: "derive" });
    assert.equal(await store.has(2, "ctx", "new"), false);
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
      await store.append({ season: 7, contextHash: "ctx", regNullifier: `n${i}`, commitment: commitments[i], engine: "plonk", statement: "derive" });
      live.append(commitments[i]);
    }

    // tree as a restart rebuilds it from the durable records, in the persisted order
    const recs = await store.forSeasonContext(7, "ctx");
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
    await seed.append({ season: 2, contextHash: "ctx", regNullifier: "n1", commitment: "c1", engine: "plonk", statement: "derive" });
    await seed.append({ season: 2, contextHash: "ctx", regNullifier: "n2", commitment: "c2", engine: "plonk", statement: "derive" });

    const fresh = new RegistrationStore(new FileBackend(path));
    const [recs, has1] = await Promise.all([
      fresh.forSeasonContext(2, "ctx"),
      fresh.has(2, "ctx", "n1"),
      fresh.ready(),
      fresh.forSeasonContext(2, "ctx"),
    ]);
    // a double-load would have pushed each record twice
    assert.equal(recs.length, 2);
    assert.equal(has1, true);
    assert.deepEqual((await fresh.forSeasonContext(2, "ctx")).map((r) => r.index), [0, 1]);
  });
});

test("a different season rebuilds an empty tree (stale-season access cannot carry over)", async () => {
  await withTempFile(async (path) => {
    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    await store.append({ season: 10, contextHash: "ctx", regNullifier: "n", commitment: "c", engine: "plonk", statement: "derive" });

    const next = await MembersTree.fromCommitments((await store.forSeasonContext(11, "ctx")).map((r) => r.commitment));
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
    season: 0, contextHash: "ctx", regNullifier: "nf1", commitment: "11", engine: "groth16", statement: "st", index: 0,
  });
  await writeFile(path, `${header}\n${good}\n{"season":0,"contextHa`);
  const b = new FileBackend(path, "sch1");
  await b.ready();
  const recs = await b.forSeasonContext(0, "ctx");
  assert.equal(recs.length, 1, "the complete record before the torn one survives");
  assert.equal(recs[0].regNullifier, "nf1");
  assert.equal(b.tornTailDiscarded, true, "and the discard is recorded rather than silent");
  await rm(dir, { recursive: true, force: true });
});

test("a malformed line in the MIDDLE still refuses, because that is not an interrupted append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mno-mid-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const good = JSON.stringify({
    season: 0, contextHash: "ctx", regNullifier: "nf1", commitment: "11", engine: "groth16", statement: "st", index: 0,
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
    season: 0, contextHash: "ctx", regNullifier: nf, commitment: "11", engine: "groth16", statement: "st", index,
  });
  await writeFile(path, `${header}\n${rec("nf1", 0)}`); // no trailing newline

  const b = new FileBackend(path, "sch1");
  await b.ready();
  assert.equal(b.tornTailTerminated, true, "the repair happened and is recorded, not silent");
  await b.append({ season: 0, contextHash: "ctx", regNullifier: "nf2", commitment: "22", engine: "groth16", statement: "st" });

  // The reopen is the assertion that matters: the first repair passed a test that only read once.
  const b2 = new FileBackend(path, "sch1");
  await b2.ready();
  const recs = await b2.forSeasonContext(0, "ctx");
  assert.deepEqual(recs.map((r) => r.regNullifier), ["nf1", "nf2"], "both records survive a reopen");
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes.includes("}{"), false, "and no two records ever share a line");
});

test("a normal file ending in a newline is not touched by the repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mno-norm-"));
  const path = join(dir, "regs.jsonl");
  const header = JSON.stringify({ type: "schedule", schedule: "sch1" });
  const rec = JSON.stringify({
    season: 0, contextHash: "ctx", regNullifier: "nf1", commitment: "11", engine: "groth16", statement: "st", index: 0,
  });
  await writeFile(path, `${header}\n${rec}\n`);
  const before = await readFile(path, "utf8");
  const b = new FileBackend(path, "sch1");
  await b.ready();
  assert.notEqual(b.tornTailTerminated, true, "nothing to repair");
  assert.equal(await readFile(path, "utf8"), before, "the file is byte-identical");
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
    const record = { season: 1, contextHash: "c", regNullifier: "n1", commitment: "m1", engine: "plonk", statement: "derive" };
    // THE WRITE SUCCEEDED, AND ONLY ITS CONFIRMATION FAILED, so this resolves rather than rejecting.
    // An earlier version of this test asserted a rejection, and two reviewers showed that expectation
    // was the defect rather than the behaviour. Reporting failure for a record that IS durable is
    // wrong twice: the member is refused although they are registered, and the caller never appends
    // the commitment to the live members tree, so the tree serves a root missing a member the store
    // holds on disk until a restart rebuilds it.
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
    const after = await reopened.forSeasonContext(1, "c");
    assert.equal(after.length, 1, "a restart loads one record");
    assert.equal(after[0].commitment, "m1");
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
    const rec = { season: 1, contextHash: "c", regNullifier: "n1", commitment: "m1", engine: "plonk", statement: "derive", index: 0 };
    writeFileSync(path, JSON.stringify(rec) + "\n" + JSON.stringify(rec) + "\n");

    const backend = new FileBackend(path, null, false);
    await backend.ready();
    const recs = await backend.forSeasonContext(1, "c");
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
    const a = { season: 1, contextHash: "c", regNullifier: "n1", commitment: "m1", engine: "plonk", statement: "derive", index: 0 };
    const b = { ...a, commitment: "m2" };
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
    await backend.append({ season: 1, contextHash: "c", regNullifier: "n1", commitment: "m1", engine: "plonk", statement: "derive" });

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
    const recovered = await backendWithFlakyRead.forSeasonContext(1, "c");
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
    const K = { season: 1, contextHash: "c", regNullifier: "nK", commitment: "mK", engine: "plonk", statement: "derive" };
    const M = { season: 1, contextHash: "c", regNullifier: "nM", commitment: "mM", engine: "plonk", statement: "derive" };
    writeFileSync(path, [
      JSON.stringify({ ...K, index: 0 }),
      JSON.stringify({ ...M, index: 0 }),
      JSON.stringify({ ...K, index: 1 }),
      "",
    ].join("\n"));

    const backend = new FileBackend(path, null, false);
    await backend.ready(); // must not throw
    const recs = await backend.forSeasonContext(1, "c");
    assert.equal(recs.length, 2, "two distinct registrations survive, and the repeated one collapsed");
    assert.deepEqual(recs.map((r) => r.regNullifier).sort(), ["nK", "nM"]);
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
    const base = { season: 1, contextHash: "c", regNullifier: "nK", engine: "plonk", statement: "derive" };
    writeFileSync(path, [
      JSON.stringify({ ...base, commitment: "mK", index: 0 }),
      JSON.stringify({ ...base, commitment: "DIFFERENT", index: 1 }),
      "",
    ].join("\n"));
    const backend = new FileBackend(path, null, false);
    await assert.rejects(() => backend.ready(), /different content/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
