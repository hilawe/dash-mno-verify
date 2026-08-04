import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// discord.js is an OPTIONAL dependency. CI installs with `npm ci --omit=optional` to prove the
// oracle and gateway run without the adapter toolchain, and these files imported it at the top
// level, so they did not skip there, they FAILED to load. That is why CI was red for four days
// while every local run was green: the local checkout has the optional packages installed.
// Imported dynamically so the absence is a skip with a stated reason. The full-install CI job
// is what actually exercises these tests.
let discord;
let makeAccess;
let GrantLedger;
try {
  discord = await import("discord.js");
  // The adapter modules import discord.js themselves, so they have to load inside the same guard.
  // Guarding only the test's own import left these three files still failing to LOAD, which is a
  // reminder that a dependency is absent for everything downstream of it, not just where it is named.
  ({ makeAccess } = await import("../adapters/discord/access.js"));
  ({ GrantLedger } = await import("../adapters/discord/grant_ledger.js"));
} catch {
  discord = null;
}
const OPT = discord ? {} : { skip: "discord.js is an optional dependency and is not installed" };
const { OverwriteType, PermissionsBitField } = discord ?? {};


// THE COMPOSITION, which is where the defect was and which nothing could reach before.
//
// The ledger compensates a failed first grant by revoking the whole record. That is right when a write
// may have landed and wrong when the apply refused a precondition and sent nothing, because
// compensating a refusal clears access the member already held, so declining to grant takes access
// away. DenialConflict carries `mutated: false` for exactly that, and applyAccess used to wrap it in a
// plain aggregate Error, which erased the flag before the ledger ever saw it. Two commits described
// that flag as the thing making the refusal safe while it was dead code.
//
// Neither half is wrong on its own. Only the pair is, which is why these functions had to leave
// bot.js: that file logs in to Discord at import, so no test could drive them.

const bits = (...n) => new PermissionsBitField(n);
const overwrite = (id, deny = [], allow = []) => ({
  id,
  type: OverwriteType.Member,
  allow: bits(...allow),
  deny: bits(...deny),
});

// A fake guild recording every permission edit, so the assertions are about calls made to Discord
// rather than about which error came back.
function fakeGuild(channels) {
  const edits = [];
  return {
    edits,
    guild: {
      channels: {
        fetch: async (id) => {
          const ch = channels[id];
          if (!ch) throw Object.assign(new Error("Unknown Channel"), { status: 404 });
          return {
            id,
            permissionOverwrites: {
              cache: new Map(ch.map((o) => [o.id, o])),
              edit: async (userId, patch) => {
                edits.push({ channel: id, userId, patch });
              },
            },
          };
        },
      },
    },
  };
}

function withLedger(guild, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mno-access-"));
  const { applyAccess, revokeAccess } = makeAccess({
    getGuild: async () => guild,
    guildId: "g1",
    log: () => {},
  });
  const ledger = new GrantLedger({
    exclusive: false,
    // Mirrors the bot, which runs repairLiveGrants on the sweep schedule. Keeping a record after an
    // uncertain apply failure is only correct WITH a repair pass, so the harness declares it rather
    // than inheriting a default. Matrix and Telegram deliberately do not set it.
    repairs: true,
    file: join(dir, "grants.db"),
    scope: "g1",
    apply: applyAccess,
    revoke: revokeAccess,
    now: () => 1000,
    log: () => {},
  });
  return Promise.resolve(fn(ledger))
    .finally(() => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

const rec = (channels) => ({ expiresAt: 9999, mode: "channel", guildId: "g1", channels });

test("a grant refused on one channel leaves the sibling channel granted, and keeps the record", OPT, async () => {
  // The reproduction. c1 is clean and c2 carries an administrator's exclusion. The clean channel is
  // granted and must STAY granted: it used to be cleared again immediately by the ledger compensating
  // the whole record, so a member finished verification with no access on a healthy channel.
  const { guild, edits } = fakeGuild({ c1: [], c2: [overwrite("u1", ["ViewChannel"])] });
  await withLedger(guild, async (ledger) => {
    await assert.rejects(() => ledger.grant("u1", rec(["c1", "c2"])), /could not grant/);

    assert.deepEqual(
      edits.map((e) => ({ channel: e.channel, view: e.patch.ViewChannel })),
      [{ channel: "c1", view: true }],
      "one write, the grant on the clean channel. No write to the denied one and no clearing afterwards",
    );
    assert.equal(ledger.has("u1"), true, "the record is kept, so the repair pass can finish the job");
  });
});

test("a grant refused on EVERY channel sends nothing and is not compensated", OPT, async () => {
  // The case that made an earlier refusal worse than the bug it fixed. Nothing reached Discord, so
  // there is nothing to take back, and compensating anyway cleared access the member already held.
  const { guild, edits } = fakeGuild({ c1: [overwrite("u1", ["ViewChannel"])] });
  await withLedger(guild, async (ledger) => {
    await assert.rejects(() => ledger.grant("u1", rec(["c1"])), /could not grant/);
    assert.deepEqual(edits, [], "not one write, neither the grant nor a compensating clear");
    assert.equal(ledger.has("u1"), false, "and no record claiming access that does not exist");
  });
});

test("a clean grant applies every channel and keeps its record", OPT, async () => {
  const { guild, edits } = fakeGuild({ c1: [], c2: [] });
  await withLedger(guild, async (ledger) => {
    await ledger.grant("u1", rec(["c1", "c2"]));
    assert.deepEqual(edits.map((e) => e.channel), ["c1", "c2"]);
    assert.equal(edits.every((e) => e.patch.ViewChannel === true), true);
    assert.equal(ledger.has("u1"), true);
  });
});

test("revoking past a member's denial clears the clean channel and leaves the denied one alone", OPT, async () => {
  // The twin of reconcileGuild's clear helper, which skipped a refusal while this path counted it as a
  // failure. A member carrying a denial holds no access to take back, so treating the refusal as a
  // failure made revokeAccess throw, which kept the record and made the sweep retry it every interval
  // for the life of the deployment.
  const clean = { id: "u1", type: OverwriteType.Member, allow: bits("ViewChannel", "SendMessages", "ReadMessageHistory"), deny: bits() };
  const fullyDenied = { id: "u1", type: OverwriteType.Member, allow: bits(), deny: bits("ViewChannel") };
  const { guild, edits } = fakeGuild({ c1: [clean], c2: [fullyDenied] });
  const { revokeAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });

  await revokeAccess("u1", rec(["c1", "c2"])); // must RESOLVE, not throw

  assert.deepEqual(
    edits.map((e) => e.channel),
    ["c1"],
    "the clean channel's allows are taken back, and the fully denied one has nothing to take back",
  );
  assert.equal(edits[0].patch.ViewChannel, null, "cleared to inherit");
  assert.equal("ViewChannel" in (edits[0].patch ?? {}), true);
});

test("a revoke that genuinely fails throws, rather than being swallowed as a refusal", OPT, async () => {
  // The other side of the same decision. Skipping a refusal must not turn into swallowing a real
  // failure, which would drop the record while the access was still live.
  //
  // The name says only what this asserts. An earlier name promised "the record is kept and retried",
  // which this never checks: it calls revokeAccess directly and never drives a sweep. The ledger-level
  // consequence is covered by the sweep tests in adapter_grant_expiry.test.js.
  const { guild } = fakeGuild({ c1: [] });
  guild.channels.fetch = async () => {
    throw Object.assign(new Error("Discord is down"), { status: 500 });
  };
  const { revokeAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });
  await assert.rejects(() => revokeAccess("u1", rec(["c1"])), /could not revoke/);
});

// THE LOCKOUT, and the repair that ends it.
//
// The gateway spends the nullifier when it verifies and the challenge is one-time, so a member whose
// apply failed after a successful verification cannot prove again in that epoch. Nothing created a
// missing overwrite from a live record, so they stayed verified, recorded, and locked out until
// expiry, while being told to run /verify again, which cannot work.
test("a member left with a live record and no access is repaired from the record", OPT, async () => {
  const { guild, edits } = fakeGuild({ c1: [] });
  // The apply fails the way a transient Discord problem does.
  let broken = true;
  const realFetch = guild.channels.fetch;
  guild.channels.fetch = async (id) => {
    if (broken) throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    return realFetch(id);
  };

  await withLedger(guild, async (ledger) => {
    await assert.rejects(() => ledger.grant("u1", rec(["c1"])), /could not grant/);
    assert.deepEqual(edits, [], "nothing was applied");
    assert.equal(ledger.has("u1"), true, "but the verification is recorded, which is what saves them");
    assert.equal(ledger.live("u1"), true);

    // Discord recovers. The repair pass runs on the sweep schedule.
    broken = false;
    const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {}, now: () => 1000 });
    const repaired = await repairAccess("u1", ledger.get("u1"));

    assert.deepEqual(repaired, ["c1"]);
    assert.deepEqual(
      edits.map((e) => ({ channel: e.channel, view: e.patch.ViewChannel })),
      [{ channel: "c1", view: true }],
      "the access the member already proved is applied, without spending another proof",
    );
  });
});

test("the repair is idempotent, so a healthy member costs no Discord write", OPT, async () => {
  const { guild, edits } = fakeGuild({
    c1: [
      {
        id: "u1",
        type: OverwriteType.Member,
        allow: bits("ViewChannel", "SendMessages", "ReadMessageHistory"),
        deny: bits(),
      },
    ],
  });
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {}, now: () => 1000 });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), [], "already complete, nothing to do");
  assert.deepEqual(edits, [], "and no request sent");
});

test("the repair refuses to reapply over an administrator's exclusion", OPT, async () => {
  // A repair must not become a way to override an exclusion. It goes through the same guarded grant.
  const { guild, edits } = fakeGuild({ c1: [overwrite("u1", ["ViewChannel"])] });
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {}, now: () => 1000 });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), [], "refused, so nothing repaired");
  assert.deepEqual(edits, [], "and nothing written");
});

test("the repair reapplies a PARTIAL overwrite, not just a missing one", OPT, async () => {
  // A half-applied overwrite is the shape a crash mid-edit leaves. Present but incomplete must count
  // as needing repair, or the member keeps a fraction of what they proved.
  const { guild, edits } = fakeGuild({
    c1: [{ id: "u1", type: OverwriteType.Member, allow: bits("ViewChannel"), deny: bits() }],
  });
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {}, now: () => 1000 });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), ["c1"]);
  assert.equal(edits.length, 1);
});

test("repair is confined to the channels the bot grants through now", OPT, async () => {
  // A record can name a channel the configuration has since dropped. The startup pass reports that as
  // a stale target and refuses to act on it, and repair must not be the one path that quietly does,
  // restoring access an operator removed by hand on a channel the bot has finished with.
  const { guild, edits } = fakeGuild({ current: [], dropped: [] });
  const { repairAccess } = makeAccess({
    getGuild: async () => guild,
    guildId: "g1",
    managedChannels: ["current"],
    log: () => {},
    now: () => 1000,
  });
  assert.deepEqual(await repairAccess("u1", rec(["current", "dropped"])), ["current"]);
  assert.deepEqual(edits.map((e) => e.channel), ["current"], "the dropped channel is never written to");
});

test("repair refuses a record belonging to another guild", OPT, async () => {
  const { guild, edits } = fakeGuild({ c1: [] });
  const { repairAccess } = makeAccess({
    getGuild: async () => guild,
    guildId: "g1",
    managedChannels: ["c1"],
    log: () => {},
  });
  const foreign = { expiresAt: 9999, mode: "channel", guildId: "OTHER", channels: ["c1"] };
  assert.deepEqual(await repairAccess("u1", foreign), []);
  assert.deepEqual(edits, [], "repair grants from a stored record, so it checks the guild itself too");
});

test("a MIXED denial has its ALLOWS taken back, and its deny left exactly alone", OPT, async () => {
  // Three designs converge here. Refusing to touch this overwrite left the member able to read a
  // private channel forever and jammed the row every sweep. Nulling all three would have cleared the
  // administrator's deny and let a role-level allow through. Clearing only what is allowed does
  // neither.
  const mixed = {
    id: "u1",
    type: OverwriteType.Member,
    allow: bits("ViewChannel", "ReadMessageHistory"),
    deny: bits("SendMessages"),
  };
  const { guild, edits } = fakeGuild({ c1: [mixed] });
  const { revokeAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });

  await revokeAccess("u1", rec(["c1"])); // resolves, so the row can be dropped and the sweep completes

  assert.equal(edits.length, 1);
  assert.deepEqual(Object.keys(edits[0].patch).sort(), ["ReadMessageHistory", "ViewChannel"]);
  assert.equal("SendMessages" in edits[0].patch, false, "the deny is never written and never cleared");
});

test("a TOTAL denial sends nothing, so an excluded member cannot jam the sweep", OPT, async () => {
  const total = {
    id: "u1",
    type: OverwriteType.Member,
    allow: bits(),
    deny: bits("ViewChannel", "SendMessages", "ReadMessageHistory"),
  };
  const { guild, edits } = fakeGuild({ c1: [total] });
  const { revokeAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });
  await revokeAccess("u1", rec(["c1"]));
  assert.deepEqual(edits, [], "nothing allowed, so nothing to take back");
});

test("repair refuses an expired record on its own, not only via its caller", OPT, async () => {
  // The comment claimed repair could never grant longer than the member proved, while the expiry
  // check lived only in the caller. The one operation that grants from a stored record instead of a
  // fresh proof checks its own authority now, in time as well as in guild.
  const { guild, edits } = fakeGuild({ c1: [] });
  const { repairAccess } = makeAccess({
    getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {}, now: () => 10000,
  });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), [], "expiresAt 9999 is behind now 10000");
  assert.deepEqual(edits, [], "nothing written for an expired record");
});

test("a grant reports what DEFINITELY applied, separately from what may have been written", OPT, async () => {
  // `mutated` is deliberately conservative: "a write may have gone out", so the ledger compensates
  // when unsure. It is the wrong question for a member-facing message. A transient failure on one
  // channel alongside a denial on another gives mutated true with zero successful writes, and the
  // member was told some of their access had been applied when none had.
  const denied = { id: "u1", type: OverwriteType.Member, allow: bits(), deny: bits("ViewChannel") };
  const { guild } = fakeGuild({ c1: [denied], c2: [] });
  guild.channels.fetch = async (id) => {
    if (id === "c2") throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    return {
      id,
      permissionOverwrites: {
        cache: new Map([[denied.id, denied]]),
        edit: async () => {},
      },
    };
  };
  const { applyAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });

  const err = await applyAccess("u1", rec(["c1", "c2"])).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "the grant failed");
  assert.equal(err.mutated, true, "a transient failure means a write may have gone out");
  assert.equal(err.applied, false, "but nothing definitely landed, which is the member-facing question");
  assert.deepEqual(err.refusedChannels, ["c1"]);
});

test("repair refuses a record proved in a different context", OPT, async () => {
  // Repair grants from a stored record rather than a fresh proof, so it checks every dimension of that
  // record's authority itself: guild, expiry, configured channels, and context.
  const { guild, edits } = fakeGuild({ c1: [] });
  const { repairAccess } = makeAccess({
    getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"],
    contextHash: "ctx-new", log: () => {}, now: () => 1000,
  });
  const old = { expiresAt: 9999, mode: "channel", guildId: "g1", channels: ["c1"], contextHash: "ctx-old" };
  assert.deepEqual(await repairAccess("u1", old), []);
  assert.deepEqual(edits, [], "nothing reapplied from a record proved somewhere else");
});
