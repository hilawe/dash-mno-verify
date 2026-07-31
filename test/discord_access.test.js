import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverwriteType, PermissionsBitField } from "discord.js";

import { makeAccess } from "../adapters/discord/access.js";
import { GrantLedger } from "../adapters/discord/grant_ledger.js";

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

test("a grant refused on one channel leaves the sibling channel granted, and keeps the record", async () => {
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

test("a grant refused on EVERY channel sends nothing and is not compensated", async () => {
  // The case that made an earlier refusal worse than the bug it fixed. Nothing reached Discord, so
  // there is nothing to take back, and compensating anyway cleared access the member already held.
  const { guild, edits } = fakeGuild({ c1: [overwrite("u1", ["ViewChannel"])] });
  await withLedger(guild, async (ledger) => {
    await assert.rejects(() => ledger.grant("u1", rec(["c1"])), /could not grant/);
    assert.deepEqual(edits, [], "not one write, neither the grant nor a compensating clear");
    assert.equal(ledger.has("u1"), false, "and no record claiming access that does not exist");
  });
});

test("a clean grant applies every channel and keeps its record", async () => {
  const { guild, edits } = fakeGuild({ c1: [], c2: [] });
  await withLedger(guild, async (ledger) => {
    await ledger.grant("u1", rec(["c1", "c2"]));
    assert.deepEqual(edits.map((e) => e.channel), ["c1", "c2"]);
    assert.equal(edits.every((e) => e.patch.ViewChannel === true), true);
    assert.equal(ledger.has("u1"), true);
  });
});

test("revoking past a member's denial clears the clean channel and leaves the denied one alone", async () => {
  // The twin of reconcileGuild's clear helper, which skipped a refusal while this path counted it as a
  // failure. A member carrying a denial holds no access to take back, so treating the refusal as a
  // failure made revokeAccess throw, which kept the record and made the sweep retry it every interval
  // for the life of the deployment.
  const { guild, edits } = fakeGuild({ c1: [], c2: [overwrite("u1", ["ViewChannel"])] });
  const { revokeAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", log: () => {} });

  await revokeAccess("u1", rec(["c1", "c2"])); // must RESOLVE, not throw

  assert.deepEqual(
    edits.map((e) => e.channel),
    ["c1"],
    "the clean channel is cleared and the denied one is never written to",
  );
  assert.equal(edits[0].patch.ViewChannel, null, "cleared to inherit");
});

test("a revoke that genuinely fails still throws, so the record is kept and retried", async () => {
  // The other side of the same decision. Skipping a refusal must not turn into swallowing a real
  // failure, which would drop the record while the access was still live.
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
test("a member left with a live record and no access is repaired from the record", async () => {
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
    const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {} });
    const repaired = await repairAccess("u1", ledger.get("u1"));

    assert.deepEqual(repaired, ["c1"]);
    assert.deepEqual(
      edits.map((e) => ({ channel: e.channel, view: e.patch.ViewChannel })),
      [{ channel: "c1", view: true }],
      "the access the member already proved is applied, without spending another proof",
    );
  });
});

test("the repair is idempotent, so a healthy member costs no Discord write", async () => {
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
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {} });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), [], "already complete, nothing to do");
  assert.deepEqual(edits, [], "and no request sent");
});

test("the repair refuses to reapply over an administrator's exclusion", async () => {
  // A repair must not become a way to override an exclusion. It goes through the same guarded grant.
  const { guild, edits } = fakeGuild({ c1: [overwrite("u1", ["ViewChannel"])] });
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {} });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), [], "refused, so nothing repaired");
  assert.deepEqual(edits, [], "and nothing written");
});

test("the repair reapplies a PARTIAL overwrite, not just a missing one", async () => {
  // A half-applied overwrite is the shape a crash mid-edit leaves. Present but incomplete must count
  // as needing repair, or the member keeps a fraction of what they proved.
  const { guild, edits } = fakeGuild({
    c1: [{ id: "u1", type: OverwriteType.Member, allow: bits("ViewChannel"), deny: bits() }],
  });
  const { repairAccess } = makeAccess({ getGuild: async () => guild, guildId: "g1", managedChannels: ["c1"], log: () => {} });
  assert.deepEqual(await repairAccess("u1", rec(["c1"])), ["c1"]);
  assert.equal(edits.length, 1);
});

test("repair is confined to the channels the bot grants through now", async () => {
  // A record can name a channel the configuration has since dropped. The startup pass reports that as
  // a stale target and refuses to act on it, and repair must not be the one path that quietly does,
  // restoring access an operator removed by hand on a channel the bot has finished with.
  const { guild, edits } = fakeGuild({ current: [], dropped: [] });
  const { repairAccess } = makeAccess({
    getGuild: async () => guild,
    guildId: "g1",
    managedChannels: ["current"],
    log: () => {},
  });
  assert.deepEqual(await repairAccess("u1", rec(["current", "dropped"])), ["current"]);
  assert.deepEqual(edits.map((e) => e.channel), ["current"], "the dropped channel is never written to");
});

test("repair refuses a record belonging to another guild", async () => {
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
