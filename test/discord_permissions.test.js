import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OverwriteType, PermissionsBitField } from "discord.js";

import {
  ACCESS,
  ACCESS_CLEARED,
  grantMemberOverwrite,
  clearManagedAllows,
  removeRole,
  DenialConflict,
  isDenialConflict,
} from "../adapters/discord/permissions.js";

// Nine review rounds found the same defect, and every one of them found it because a denial check was
// added at the site the previous reviewer named while the identical mutation survived unguarded
// nearby. Round 9 found it in four reviewers at once, with the check present in one place and absent in
// five others.
//
// The predicate tests in discord_grant_ledger.test.js prove the DETECTORS recognise a denial. They
// cannot prove any mutation calls them, and reviewers pointed that out directly: those tests passed
// while every unguarded site was still there. These tests close that gap from two directions. The
// first group drives each operation and asserts it refuses AND that no call reached Discord. The
// second asserts that no other file can mutate permissions at all, which is what makes the first group
// a statement about the whole adapter rather than about four functions nobody has to use.

const bits = (...names) => new PermissionsBitField(names);

// A per-member overwrite as discord.js presents it, with real bitfields rather than a stub whose has()
// always answers the same way. A placeholder here would pass a test that a bit-sensitive regression
// should fail.
const memberOverwrite = (id, deny = [], allow = []) => ({
  id,
  type: OverwriteType.Member,
  allow: bits(...allow),
  deny: bits(...deny),
});

// A channel that records every edit, so "did not mutate" is an assertion about calls made rather than
// about an error being thrown.
function channelWith(overwrites) {
  const edits = [];
  return {
    edits,
    ch: {
      id: "c1",
      permissionOverwrites: {
        cache: new Map(overwrites.map((o) => [o.id, o])),
        edit: (...args) => {
          edits.push(args);
          return Promise.resolve();
        },
      },
    },
  };
}

function memberWith() {
  const calls = [];
  return {
    calls,
    m: {
      id: "u1",
      roles: {
        add: (r) => (calls.push(["add", r]), Promise.resolve()),
        remove: (r) => (calls.push(["remove", r]), Promise.resolve()),
      },
    },
  };
}

// A guild whose configured role denies something somewhere. The role path reads the channel cache
// rather than fetching, so this is the shape it actually sees.
const guildDenying = (roleId, deny) => ({
  channels: {
    cache: new Map([
      [
        "chan1",
        {
          id: "chan1",
          permissionOverwrites: { cache: new Map([[roleId, { id: roleId, allow: bits(), deny: bits(...deny) }]]) },
        },
      ],
    ]),
  },
});
const guildClean = () => ({ channels: { cache: new Map() } });

// ---- the guards refuse, and refuse without touching Discord ----------------------------------------

test("granting over a member denial refuses and sends nothing", async () => {
  const { ch, edits } = channelWith([memberOverwrite("u1", ["ViewChannel"])]);
  await assert.rejects(() => grantMemberOverwrite(ch, "u1"), isDenialConflict);
  assert.deepEqual(edits, [], "an excluded member must not be granted access by re-verifying");
});

test("clearing takes back only what is ALLOWED, and never touches a deny", async () => {
  // The third design for taking access back. Attempt 1 nulled all three bits, which cleared an
  // administrator's deny as well and let a role-level allow through, so removal granted. Attempt 2
  // merged the whole overwrite, which is read-modify-write against a cache. Attempt 3 refused to touch
  // an overwrite carrying any denial, which left the allow in place permanently and jammed the row.
  //
  // This computes the patch from the bits currently allowed, so a deny is never in it.
  const mixed = {
    id: "u1",
    type: OverwriteType.Member,
    allow: bits("ViewChannel", "ReadMessageHistory"),
    deny: bits("SendMessages"),
  };
  const { ch, edits } = channelWith([mixed]);
  const cleared = await clearManagedAllows(ch, "u1");

  assert.deepEqual(cleared.sort(), ["ReadMessageHistory", "ViewChannel"]);
  assert.equal(edits.length, 1);
  assert.deepEqual(
    edits[0][1],
    { ViewChannel: null, ReadMessageHistory: null },
    "only the allowed bits, and SendMessages is absent so its deny is left exactly as it was",
  );
  assert.equal("SendMessages" in edits[0][1], false, "a deny bit is never written and never cleared");
});

test("clearing a fully denied member sends nothing, because there is nothing to take back", async () => {
  const total = {
    id: "u1",
    type: OverwriteType.Member,
    allow: bits(),
    deny: bits("ViewChannel", "SendMessages", "ReadMessageHistory"),
  };
  const { ch, edits } = channelWith([total]);
  assert.deepEqual(await clearManagedAllows(ch, "u1"), []);
  assert.deepEqual(edits, [], "no request, so an excluded member cannot jam the caller either");
});

test("clearing a clean member takes back all three managed bits", async () => {
  const { ch, edits } = channelWith([memberOverwrite("u1", [], ["ViewChannel", "SendMessages", "ReadMessageHistory"])]);
  assert.deepEqual((await clearManagedAllows(ch, "u1")).sort(), ["ReadMessageHistory", "SendMessages", "ViewChannel"]);
  assert.deepEqual(edits[0][1], { ViewChannel: null, SendMessages: null, ReadMessageHistory: null });
});

test("a denial on a DIFFERENT member does not block this member", async () => {
  // The obvious over-correction. A channel-wide refusal would make one excluded member stop everyone
  // else being served, which is the same "guard causes a larger failure" shape as the role exit.
  const { ch, edits } = channelWith([memberOverwrite("someone-else", ["ViewChannel"])]);
  await grantMemberOverwrite(ch, "u1");
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0][1], ACCESS, "the three managed bits are set to allow");
  assert.deepEqual(edits[0][2], { type: OverwriteType.Member }, "explicit type, so a raw id resolves after a restart");
});

test("removing a role that denies ANY bit refuses, not only the three managed ones", async () => {
  // This bot never grants a role, so only removal remains, and only from the decommission command.
  // Removing a role that denies something hands that permission back, so the command whose purpose is
  // taking access away would grant it. A role denying Connect inverts voice access exactly as one
  // denying ViewChannel inverts text access, and an earlier version checked only the managed three.
  for (const bit of ["ViewChannel", "SendMessages", "Connect", "Speak", "ManageMessages"]) {
    const { m, calls } = memberWith();
    await assert.rejects(() => removeRole(guildDenying("r1", [bit]), m, "r1"), isDenialConflict, bit);
    assert.deepEqual(calls, [], `remove must not run, ${bit}`);
  }
});

test("a denial on some OTHER role does not block removing this one", async () => {
  const { m, calls } = memberWith();
  await removeRole(guildDenying("other-role", ["ViewChannel"]), m, "r1");
  assert.deepEqual(calls, [["remove", "r1"]]);
});

test("a clean role is removed normally", async () => {
  const { m, calls } = memberWith();
  await removeRole(guildClean(), m, "r1");
  assert.deepEqual(calls, [["remove", "r1"]]);
});

test("a refusal is distinguishable from a failure, and says nothing was sent", async () => {
  // This distinction is why the earlier refusal was deleted rather than repaired. The ledger
  // compensates a failed first grant by revoking the whole record, which is right for a network
  // failure that may have applied some targets and wrong for a precondition that changed nothing. The
  // compensating revoke then stripped the member's pre-existing access, so declining to grant took
  // access away.
  const e = new DenialConflict("x");
  assert.equal(isDenialConflict(e), true);
  assert.equal(e.mutated, false, "a refusal reports that nothing reached the platform");
  assert.equal(isDenialConflict(new Error("network")), false, "an ordinary failure is not a refusal");
  assert.equal(isDenialConflict(undefined), false);
});

// ---- nothing else may mutate permissions ------------------------------------------------------------

// Strip comments before scanning. This codebase describes these calls at length, and describing one is
// not making one. Strings are left alone: a mutation hidden in a string still needs a call to reach
// Discord, and that call is what the rule below sees.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function discordSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) discordSources(full, out);
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("the module boundary catches the common ways a permission mutation escapes it", () => {
  // A TRIPWIRE, and the name says so now. The previous name claimed that outside permissions.js the
  // mutating APIs are only ever read, and that claim is false, which was itself a finding.
  //
  // What it does: every mention of a mutation-capable object outside permissions.js must be
  // immediately followed by a read, `.cache` or `.fetch(`. That catches the accidental reintroduction
  // this component has actually produced eight times, and the evasions reviewers listed: optional
  // chaining, bracket notation, aliasing the receiver, a call split across lines, and a nested
  // directory an earlier version never entered.
  //
  // WHAT IT CANNOT CATCH, stated rather than implied:
  //
  //   ch.permissionOverwrites.cache.get(id).edit(...)   the cache hands back a mutable object
  //   for (const [id, ow] of ch.permissionOverwrites.cache) { ow.edit(...) }   same, via iteration
  //
  // Both pass, because `.cache` is counted as a read and what the cache returns is not tracked. Only a
  // parser that follows values can close that, and adding a parser dependency to this project is a
  // decision rather than a test tweak. Until then this is a tripwire for the accident, not a proof
  // against the determined, and the difference is written down so nobody relies on the stronger one.
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    ...discordSources(join(here, "..", "adapters", "discord")),
    ...discordSources(join(here, "..", "scripts")).filter((f) => /discord_/.test(f)),
  ].filter((f) => !f.endsWith("permissions.js"));

  assert.ok(files.length >= 4, `expected to scan the Discord sources, found ${files.length}`);

  // The allowed continuations are READS, named positively. `.cache` is the local view and `.fetch(`
  // asks Discord for one. Everything else fails, including every mutation verb on either object and
  // every way of taking a reference to it, without this having to know what those verbs are called.
  const READ_ONLY = String.raw`\s*\??\.\s*(cache\b|fetch\s*\()`;
  const RULES = [
    { name: "permissionOverwrites", all: /permissionOverwrites/g, read: new RegExp(`permissionOverwrites${READ_ONLY}`, "g") },
    // The lookbehind keeps a spread out of it. `[...roles]` on a local Set is not a member's role
    // collection, and the previous version of this test flagged exactly that.
    { name: ".roles", all: /(?<!\.)\.\s*roles\b/g, read: new RegExp(String.raw`(?<!\.)\.\s*roles${READ_ONLY}`, "g") },
  ];

  const offenders = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const rule of RULES) {
      const total = (src.match(rule.all) ?? []).length;
      const reads = (src.match(rule.read) ?? []).length;
      if (total > reads) {
        offenders.push(`${file.split("/").slice(-2).join("/")}: ${total - reads} use(s) of ${rule.name} that are not a .cache read`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "every permission change must go through adapters/discord/permissions.js, which carries the " +
      "denial check with it. Reading .cache is fine. Anything else, including taking a reference to " +
      "the object, is how the check reached one caller and missed five.",
  );
});

test("the boundary rule actually rejects the evasions reviewers listed", () => {
  // A checker nobody has tried to break is a checker nobody knows the strength of. Each fixture below
  // is a spelling that passed the previous version.
  const READ_ONLY = String.raw`\s*\??\.\s*(cache\b|fetch\s*\()`;
  const rule = { all: /permissionOverwrites/g, read: new RegExp(`permissionOverwrites${READ_ONLY}`, "g") };
  const violates = (src) => {
    const stripped = stripComments(src);
    return (stripped.match(rule.all) ?? []).length > (stripped.match(rule.read) ?? []).length;
  };

  for (const [label, src] of [
    ["plain call", "ch.permissionOverwrites.edit(id, p);"],
    ["optional chaining", "ch.permissionOverwrites?.edit(id, p);"],
    ["bracket notation", 'ch.permissionOverwrites["edit"](id, p);'],
    ["aliased receiver", "const p = ch.permissionOverwrites;\np.edit(id, x);"],
    ["split across lines", "ch.permissionOverwrites\n  .edit(id, p);"],
    ["code after a block comment", "/* note */ ch.permissionOverwrites.edit(id, p);"],
  ]) {
    assert.equal(violates(src), true, `should be rejected: ${label}`);
  }

  for (const [label, src] of [
    ["cache read", "[...ch.permissionOverwrites.cache.values()]"],
    ["optional cache read", "ch.permissionOverwrites?.cache?.values()"],
    ["a comment describing a call", "// ch.permissionOverwrites.edit(id, p) is what this replaced"],
  ]) {
    assert.equal(violates(src), false, `should be accepted: ${label}`);
  }
});
