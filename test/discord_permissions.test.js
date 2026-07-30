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
  clearMemberOverwrite,
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

test("clearing a member denial refuses and sends nothing", async () => {
  // Clearing a member-level deny lets a role-level allow through, so the removal grants. This is the
  // defect that survived six rounds because everyone asked whether removal removes and nobody asked
  // whether it could grant.
  const { ch, edits } = channelWith([memberOverwrite("u1", ["ViewChannel"])]);
  await assert.rejects(() => clearMemberOverwrite(ch, "u1"), isDenialConflict);
  assert.deepEqual(edits, []);
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

test("a clean overwrite is cleared to inherit, not deleted and not denied", async () => {
  const { ch, edits } = channelWith([memberOverwrite("u1", [], ["ViewChannel"])]);
  await clearMemberOverwrite(ch, "u1");
  assert.deepEqual(edits[0][1], ACCESS_CLEARED);
  assert.deepEqual(Object.values(ACCESS_CLEARED), [null, null, null], "inherit, so no denial is manufactured");
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

test("no Discord source file mutates permissions outside adapters/discord/permissions.js", () => {
  // The structural half, and the reason the tests above are a claim about the adapter rather than about
  // four functions. If the only way to change a permission is through a function that always checks
  // first, then every permission change checks first, including ones written after this test.
  //
  // This is the twin defect turned into an assertion. Eight rounds were spent adding a check at the
  // site a reviewer named while the identical mutation survived a few lines away, and no behavioural
  // test catches that, because the unguarded site is the one nobody thought to write a test for.
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [join(here, "..", "adapters", "discord"), join(here, "..", "scripts")];
  const RAW_MUTATIONS = [
    /permissionOverwrites\s*\.\s*edit\s*\(/,
    /permissionOverwrites\s*\.\s*create\s*\(/,
    /permissionOverwrites\s*\.\s*delete\s*\(/,
    /permissionOverwrites\s*\.\s*set\s*\(/,
    // The receiver form discord.js actually uses, `<member>.roles.add(...)`. A bare `roles.add(...)`
    // is matched by neither, deliberately: staleTargets keeps a local Set named `roles`, and the first
    // run of this test flagged its insertion. The narrower pattern is a strong guard rather than a
    // proof, since assigning `member.roles` to a variable first would slip past it. That is a
    // contrived shape rather than one this code reaches for, and the behavioural tests above cover
    // what the operations do once called.
    /\.\s*roles\s*\.\s*add\s*\(/,
    /\.\s*roles\s*\.\s*remove\s*\(/,
  ];

  const offenders = [];
  let scanned = 0;
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (!/\.(js|mjs)$/.test(name)) continue;
      const path = join(root, name);
      // The one file allowed to mutate, and only Discord scripts are in scope here.
      if (name === "permissions.js") continue;
      if (root.endsWith("scripts") && !name.startsWith("discord_")) continue;
      scanned += 1;
      const src = readFileSync(path, "utf8");
      for (const [i, line] of src.split("\n").entries()) {
        // Comments describe the history of these calls at length, and describing one is not making one.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        for (const re of RAW_MUTATIONS) {
          if (re.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }

  assert.ok(scanned >= 3, `expected to scan the Discord sources, only saw ${scanned} file(s)`);
  assert.deepEqual(
    offenders,
    [],
    "every permission change must go through adapters/discord/permissions.js, which carries the " +
      "denial check with it. A raw call here is how the check reached one caller and missed five.",
  );
});
