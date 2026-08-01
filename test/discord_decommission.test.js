import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverwriteType, PermissionsBitField } from "discord.js";

import { runDecommission } from "../adapters/discord/decommission.js";
import { GrantLedger } from "../adapters/discord/grant_ledger.js";

// The decommission pass used to live inside a script that logs in to Discord at import, so no test
// could reach it, and four separate defects survived two review rounds there. Each test below pins one
// of them and fails against the previous behaviour.

const bits = (...n) => new PermissionsBitField(n);
// An overwrite the bot would have created: the three managed bits allowed, unless a deny is named,
// in which case the denied bits move to the deny side. That distinction now matters, because clearing
// takes back what is ALLOWED rather than nulling everything.
const ow = (id, deny = []) => ({
  id,
  type: OverwriteType.Member,
  allow: bits(...["ViewChannel", "SendMessages", "ReadMessageHistory"].filter((b) => !deny.includes(b))),
  deny: bits(...deny),
});
const gone = () => Object.assign(new Error("Unknown Channel"), { status: 404 });

function fakeGuild({ channels = {}, roles = {}, members = [] } = {}) {
  const edits = [];
  const roleOps = [];
  return {
    edits,
    roleOps,
    guild: {
      id: "g1",
      name: "Test",
      roles: { fetch: async (id) => roles[id] ?? null },
      members: { fetch: async () => new Map(members.map((m) => [m.id, m])) },
      channels: {
        fetch: async (id) => {
          if (id === undefined) return new Map(); // the guild-wide scan the role preflight does
          const list = channels[id];
          if (!list) throw gone();
          return {
            id,
            permissionOverwrites: {
              cache: new Map(list.map((o) => [o.id, o])),
              edit: async (userId, patch) => edits.push({ channel: id, userId, patch }),
            },
          };
        },
      },
    },
  };
}

const member = (id, roleIds, roleOps) => ({
  id,
  roles: {
    cache: { has: (r) => roleIds.includes(r) },
    remove: async (r) => roleOps.push([id, r]),
  },
});

function withLedger(records, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-dc-"));
  const ledger = new GrantLedger({
    exclusive: false,
    file: join(dir, "grants.db"),
    scope: "g1",
    apply: async () => {},
    revoke: async () => {},
    now: () => 1000,
    log: () => {},
  });
  return (async () => {
    for (const [id, rec] of Object.entries(records)) await ledger.grant(id, rec);
    return await fn(ledger);
  })().finally(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const chanRec = (channels) => ({ expiresAt: 9999, mode: "channel", guildId: "g1", channels });
const roleRec = (roleId) => ({ expiresAt: 9999, mode: "role", guildId: "g1", roleId });

test("a role with zero holders still retires its ledger rows", async () => {
  // THE BLOCKER. Retirement was gated on `removed.length`, so a run that removed nobody skipped the
  // ledger entirely and exited zero. A role removed by hand, or a second run after a successful first
  // one, both land here. The rows survived, the bot refused to start on them forever, and the command
  // reported success every time, which is a guard whose documented exit could not be reached by doing
  // the right thing.
  const { guild, roleOps } = fakeGuild({ roles: { r1: { id: "r1", name: "MNO" } }, members: [] });
  await withLedger({ u1: roleRec("r1") }, async (ledger) => {
    assert.equal(ledger.has("u1"), true);
    const { failed } = await runDecommission({
      guild, target: { mode: "role", ids: ["r1"] }, targetArg: "role:r1",
      dryRun: false, ledger, botUserId: "bot",
    });
    assert.deepEqual(roleOps, [], "nobody held it, so nothing was removed");
    assert.deepEqual(failed, [], "and that is not a failure");
    assert.equal(ledger.has("u1"), false, "the row is retired anyway, which is the whole fix");
  });
});

test("a deleted channel can be retired with an explicit assertion, and not without one", async () => {
  const target = { mode: "channel", ids: ["dead"] };
  // Default: refuses, because a typo looks identical to a deleted channel from here.
  await withLedger({ u1: chanRec(["dead"]) }, async (ledger) => {
    const { failed } = await runDecommission({
      guild: fakeGuild({}).guild, target, targetArg: "channel:dead",
      dryRun: false, ledger, botUserId: "bot",
    });
    assert.deepEqual(failed, ["dead/*"], "an unfound target is not silently treated as success");
    assert.equal(ledger.has("u1"), true, "so its row stays tracked");
  });
  // With the assertion: retired, which is the exit that did not exist.
  await withLedger({ u1: chanRec(["dead"]) }, async (ledger) => {
    const { failed } = await runDecommission({
      guild: fakeGuild({}).guild, target, targetArg: "channel:dead",
      dryRun: false, confirmGone: true, ledger, botUserId: "bot",
    });
    assert.deepEqual(failed, []);
    assert.equal(ledger.has("u1"), false, "a deleted channel holds no access, so nothing needs tracking");
  });
});

test("one denied member does not stop every clean member on the channel being cleared", async () => {
  // The twin of the case test/discord_permissions.test.js asserts for the mutation helper: a denial on
  // one member must not block another. That reasoning reached the helper and not this preflight, which
  // skipped the whole channel and stranded every unrelated holder's stale access.
  const { guild, edits } = fakeGuild({ channels: { c1: [ow("denied", ["ViewChannel"]), ow("clean")] } });
  await withLedger({ denied: chanRec(["c1"]), clean: chanRec(["c1"]) }, async (ledger) => {
    const { removed, failed } = await runDecommission({
      guild, target: { mode: "channel", ids: ["c1"] }, targetArg: "channel:c1",
      dryRun: false, ledger, botUserId: "bot",
    });
    // Both members are handled, and the partially denied one keeps its deny. Clearing only what is
    // allowed means an exclusion is never lifted AND the access is actually taken back, which the
    // refuse-to-touch design failed to do: it left the allow in place permanently.
    assert.deepEqual(edits.map((e) => e.userId).sort(), ["clean", "denied"]);
    const deniedEdit = edits.find((e) => e.userId === "denied");
    assert.equal("ViewChannel" in deniedEdit.patch, false, "the denied bit is left exactly as it was");
    assert.deepEqual(removed.sort(), ["c1/clean", "c1/denied"]);
    assert.deepEqual(failed, []);
    assert.equal(ledger.has("clean"), false);
    assert.equal(ledger.has("denied"), false, "their remaining allows were taken back, so nothing is owed");
  });
});

test("a preview changes nothing on Discord and nothing in the ledger", async () => {
  const { guild, edits } = fakeGuild({ channels: { c1: [ow("u1")] } });
  await withLedger({ u1: chanRec(["c1"]) }, async (ledger) => {
    const { removed } = await runDecommission({
      guild, target: { mode: "channel", ids: ["c1"] }, targetArg: "channel:c1",
      dryRun: true, ledger, botUserId: "bot",
    });
    assert.deepEqual(removed, ["c1/u1"], "it still reports what it would do");
    assert.deepEqual(edits, [], "but sends nothing");
    assert.equal(ledger.has("u1"), true, "and retires nothing");
  });
});

test("a transient role lookup failure retires nothing, even with the gone assertion", async () => {
  // The exit added for a deleted role became a way to forget a live one. Catching every error to null
  // meant one Discord 500 plus --confirm-target-gone deleted the rows for a role that was still live
  // and still disclosing. A failure to look is not evidence of absence.
  const guild = {
    id: "g1",
    name: "Test",
    roles: {
      fetch: async () => {
        throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      },
    },
    members: { fetch: async () => new Map() },
    channels: { fetch: async () => new Map() },
  };
  await withLedger({ u1: roleRec("r1") }, async (ledger) => {
    await assert.rejects(
      () =>
        runDecommission({
          guild, target: { mode: "role", ids: ["r1"] }, targetArg: "role:r1",
          dryRun: false, confirmGone: true, ledger, botUserId: "bot",
        }),
      /could not read role/,
    );
    assert.equal(ledger.has("u1"), true, "the row survives, because nothing proved the role is gone");
  });
});

test("a genuinely absent role is still retired with the assertion", async () => {
  // The exit must still work, or the fix reintroduces the guard with no exit.
  const { guild } = fakeGuild({ roles: {}, members: [] });
  await withLedger({ u1: roleRec("r1") }, async (ledger) => {
    const { failed } = await runDecommission({
      guild, target: { mode: "role", ids: ["r1"] }, targetArg: "role:r1",
      dryRun: false, confirmGone: true, ledger, botUserId: "bot",
    });
    assert.deepEqual(failed, []);
    assert.equal(ledger.has("u1"), false);
  });
});

test("preview predicts exactly the set apply takes back", async () => {
  // A destructive command's preview is the only thing an operator checks before running it for real,
  // so it has to predict apply, not approximate it. Both now use the same question: does this member
  // have anything ALLOWED to take back.
  const { guild, edits } = fakeGuild({ channels: { c1: [ow("denied", ["ViewChannel"]), ow("clean")] } });
  await withLedger({ denied: chanRec(["c1"]), clean: chanRec(["c1"]) }, async (ledger) => {
    const preview = await runDecommission({
      guild, target: { mode: "channel", ids: ["c1"] }, targetArg: "channel:c1",
      dryRun: true, ledger, botUserId: "bot",
    });
    assert.deepEqual(preview.removed.sort(), ["c1/clean", "c1/denied"], "everyone with something to take back");
    assert.deepEqual(edits, [], "and a preview still sends nothing");

    const applied = await runDecommission({
      guild, target: { mode: "channel", ids: ["c1"] }, targetArg: "channel:c1",
      dryRun: false, ledger, botUserId: "bot",
    });
    assert.deepEqual(applied.removed.sort(), preview.removed.sort(), "the same set, however each is ordered");
  });
});

test("confirm-target-gone is refused for a target no ledger record names", async () => {
  // The flag retires rows for a target that no longer exists on Discord. A typo'd id also does not
  // exist on Discord, and the flag used to accept it and report success having retired nothing. If no
  // row names the target, the assertion has nothing to retire and is almost certainly a mistake.
  await withLedger({ u1: chanRec(["real"]) }, async (ledger) => {
    await assert.rejects(
      () =>
        runDecommission({
          guild: fakeGuild({}).guild, target: { mode: "channel", ids: ["typo"] }, targetArg: "channel:typo",
          dryRun: false, confirmGone: true, ledger, botUserId: "bot",
        }),
      /no ledger record names/,
    );
    assert.equal(ledger.has("u1"), true, "and nothing unrelated was touched");
  });
});

test("a foreign-guild row is never retired, even in cleanup mode with the gone assertion", async () => {
  // The cleanup command can open a ledger bound to another guild, because it is the documented exit
  // from that refusal. That bypass came with no check on the ROWS, so it retired a record made in one
  // guild while operating in another, which forgets access that is live and unreachable from here. A
  // bypass has to be narrower than the guard it steps around, not wider.
  const { guild } = fakeGuild({ roles: {}, members: [] });
  const dir = mkdtempSync(join(tmpdir(), "mno-dc-"));
  const ledger = new GrantLedger({
    exclusive: false,
    file: join(dir, "grants.db"),
    scope: "g1",
    apply: async () => {},
    revoke: async () => {},
    now: () => 1000,
    log: () => {},
  });
  try {
    await ledger.grant("ours", { expiresAt: 9999, mode: "role", guildId: "g1", roleId: "r1" });
    await ledger.grant("theirs", { expiresAt: 9999, mode: "role", guildId: "OTHER", roleId: "r1" });

    await runDecommission({
      guild, target: { mode: "role", ids: ["r1"] }, targetArg: "role:r1",
      dryRun: false, confirmGone: true, ledger, botUserId: "bot",
    });

    assert.equal(ledger.has("ours"), false, "this guild's row is retired");
    assert.equal(ledger.has("theirs"), true, "the other guild's row is left exactly alone");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unlabelled legacy row is judged by the ledger's bound scope, not the current guild", async () => {
  // The cleanup escape lets this command open a ledger bound to guild A while configured for guild B.
  // A migrated legacy row carries no guildId, which is expected and is exactly why the binding exists.
  // Resolving it against B made it look local, so --confirm-target-gone accepted B's not-found as
  // evidence and retired A's row while that access stayed live and unreachable in A.
  const { guild } = fakeGuild({ roles: {}, members: [] }); // guild.id is "g1", standing in for B
  const dir = mkdtempSync(join(tmpdir(), "mno-dc-"));
  const file = join(dir, "grants.db");
  const opts = { exclusive: false, apply: async () => {}, revoke: async () => {}, now: () => 1000, log: () => {} };
  try {
    // A database bound to a DIFFERENT guild, holding one legacy row with no guildId.
    const bound = new GrantLedger({ ...opts, file, scope: "OLD" });
    await bound.grant("legacy", { expiresAt: 9999, mode: "role", roleId: "r1" });
    bound.close();

    // Reopened through the cleanup escape while pointed at g1.
    const cleanup = new GrantLedger({ ...opts, file, scope: "g1", allowForeignScope: true });
    assert.equal(cleanup.scope(), "OLD", "the binding is unchanged, which is what makes this the trap");

    await assert.rejects(
      () =>
        runDecommission({
          guild, target: { mode: "role", ids: ["r1"] }, targetArg: "role:r1",
          dryRun: false, confirmGone: true, ledger: cleanup, botUserId: "bot",
        }),
      /no ledger record names/,
      "g1 cannot use OLD's unlabelled row as evidence that r1 is gone",
    );
    assert.equal(cleanup.has("legacy"), true, "and the row survives, because its access is live in OLD");
    cleanup.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
