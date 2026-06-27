import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistrationStore,
  MemoryRegistrationBackend,
  FileBackend,
} from "../core/registration_store.js";
import { MembersTree } from "../core/members_tree.js";

// The registration store is where the two-tier P0 fix lives: one atomic, durable, season-scoped
// record per registration, with the members tree rebuilt from records. These tests pin the
// behavior the gateway relies on, against both backends.

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
    const first = await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf1", commitment: "c1" });
    assert.deepEqual(first, { duplicate: false, index: 0 });
    assert.equal(await store.has(1, "ctx", "nf1"), true);

    // the same season, context, and registration nullifier is the same spend, even with a
    // different commitment: one masternode registers once per season and context
    const dup = await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf1", commitment: "c-other" });
    assert.equal(dup.duplicate, true);

    const recs = await store.forSeason(1);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].commitment, "c1");
  });

  test(`${name}: season, context, and registration nullifier are independent`, async () => {
    const { store } = await makeStore();
    await store.ready();
    await store.append({ season: 1, contextHash: "ctx", regNullifier: "nf", commitment: "c" });
    assert.equal(await store.has(2, "ctx", "nf"), false); // different season
    assert.equal(await store.has(1, "ctx2", "nf"), false); // different community
    assert.equal(await store.has(1, "ctx", "nf2"), false); // different node
  });

  test(`${name}: indexes are per-season and assigned in insertion order`, async () => {
    const { store } = await makeStore();
    await store.ready();
    const a = await store.append({ season: 5, contextHash: "ctx", regNullifier: "a", commitment: "ca" });
    const b = await store.append({ season: 5, contextHash: "ctx", regNullifier: "b", commitment: "cb" });
    const c = await store.append({ season: 6, contextHash: "ctx", regNullifier: "c", commitment: "cc" });
    assert.deepEqual([a.index, b.index, c.index], [0, 1, 0]);

    const s5 = await store.forSeason(5);
    assert.deepEqual(s5.map((r) => r.commitment), ["ca", "cb"]);
    const s6 = await store.forSeason(6);
    assert.deepEqual(s6.map((r) => r.commitment), ["cc"]);
    assert.deepEqual(await store.forSeason(99), []); // a fresh season starts empty
  });
}

test("file: registrations survive a restart (durability)", async () => {
  await withTempFile(async (path) => {
    const first = new RegistrationStore(new FileBackend(path));
    await first.ready();
    await first.append({ season: 3, contextHash: "ctx", regNullifier: "n1", commitment: "c1" });
    await first.append({ season: 3, contextHash: "ctx", regNullifier: "n2", commitment: "c2" });

    // a new gateway process reads the same file and recovers the full set
    const reopened = new RegistrationStore(new FileBackend(path));
    await reopened.ready();
    assert.equal(await reopened.has(3, "ctx", "n1"), true);
    assert.equal(await reopened.has(3, "ctx", "n2"), true);
    const recs = await reopened.forSeason(3);
    assert.deepEqual(recs.map((r) => r.commitment), ["c1", "c2"]);

    // and the spend set is enforced after the restart, so no member registers twice
    const dup = await reopened.append({ season: 3, contextHash: "ctx", regNullifier: "n1", commitment: "c1" });
    assert.equal(dup.duplicate, true);
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
      await store.append({ season: 7, contextHash: "ctx", regNullifier: `n${i}`, commitment: commitments[i] });
      live.append(commitments[i]);
    }

    // tree as a restart rebuilds it from the durable records, in the persisted order
    const recs = await store.forSeason(7);
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
    await seed.append({ season: 2, contextHash: "ctx", regNullifier: "n1", commitment: "c1" });
    await seed.append({ season: 2, contextHash: "ctx", regNullifier: "n2", commitment: "c2" });

    const fresh = new RegistrationStore(new FileBackend(path));
    const [recs, has1] = await Promise.all([
      fresh.forSeason(2),
      fresh.has(2, "ctx", "n1"),
      fresh.ready(),
      fresh.forSeason(2),
    ]);
    // a double-load would have pushed each record twice
    assert.equal(recs.length, 2);
    assert.equal(has1, true);
    assert.deepEqual((await fresh.forSeason(2)).map((r) => r.index), [0, 1]);
  });
});

test("a different season rebuilds an empty tree (stale-season access cannot carry over)", async () => {
  await withTempFile(async (path) => {
    const store = new RegistrationStore(new FileBackend(path));
    await store.ready();
    await store.append({ season: 10, contextHash: "ctx", regNullifier: "n", commitment: "c" });

    const next = await MembersTree.fromCommitments((await store.forSeason(11)).map((r) => r.commitment));
    const empty = await MembersTree.create();
    assert.equal(next.size(), 0);
    assert.equal(next.root(), empty.root());
  });
});
