// Every Discord permission mutation this project makes, with its safety check attached.
//
// WHY THIS MODULE EXISTS
//
// Nine review rounds found the same shape, and round 9 found it in four reviewers at once: a denial
// check applied exactly where the previous reviewer pointed, with the identical mutation a few lines
// away or in a sibling file left unguarded. The check reached `revokeAccess` and missed the grant
// path, the reconciliation clear, and all four role mutations. Adding a fourth and fifth call site by
// hand is the move that has now failed eight times.
//
// So the check and the mutation are one operation here, and there is no way to perform the mutation
// without it. The bot and the decommission command both import these, so a fix cannot reach one
// caller and miss its twin. If a new mutation site is ever needed, it is added here or it does not
// exist.
//
// WHAT IS AND IS NOT CLAIMED
//
// The check reads cached state. Discord offers no compare-and-set for permissions, so a denial the
// cache has not yet seen can still be missed, and that residual is documented rather than solved. The
// claim is narrow and unchanged from the one the project already made: the bot refuses to touch a
// conflict it can SEE. What is new is that every mutation now actually looks.
import { OverwriteType } from "discord.js";
import { memberDenialsOnGatedChannel, roleDenialsAcrossChannels } from "./grant_ledger.js";

// The three permission bits this bot manages on a private channel, as a grant and as a clear.
export const ACCESS = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true };
export const ACCESS_CLEARED = { ViewChannel: null, SendMessages: null, ReadMessageHistory: null };

// A refusal is not a failure, and callers must be able to tell them apart.
//
// The shared ledger compensates a failed first grant by revoking the whole record, which is correct
// for a network failure that may have applied some targets and wrong for a precondition that changed
// nothing. An earlier design refused to grant over a denial without this distinction, and the
// compensating revoke then stripped the member's pre-existing access, so declining to grant took
// access away. That defect is why the refusal was deleted rather than fixed. It comes back here with
// the distinction it needed.
export class DenialConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "DenialConflict";
    // Nothing was sent to Discord, so there is nothing to compensate and nothing to retry against.
    this.mutated = false;
  }
}

export const isDenialConflict = (e) => e instanceof DenialConflict || e?.name === "DenialConflict";

// Refuse if this member's own overwrite on this channel carries a denial on any managed bit.
//
// Clearing a member-level deny lets a role-level allow through, so the clear grants. Setting the
// managed bits to true overrides an exclusion an administrator set by hand. Both directions are the
// same conflict, which is why one predicate guards both mutations rather than each getting its own.
function assertNoMemberDenial(ch, userId, what) {
  const offenders = memberDenialsOnGatedChannel(
    [...ch.permissionOverwrites.cache.values()].filter(
      (ow) => ow.type === OverwriteType.Member && String(ow.id) === String(userId),
    ),
  );
  if (offenders.length) {
    throw new DenialConflict(
      `${ch.id}: ${userId} has an overwrite DENYING ${offenders[0].deny.join(", ")}, so ${what} would ` +
        `override an exclusion this bot did not set. Per-member overwrites on a gated channel belong ` +
        `to this bot. Express the exclusion with a role-level deny, or remove the member overwrite.`,
    );
  }
}

// Refuse if the role denies ANY permission on ANY channel.
//
// This bot never grants a role. Role mode was removed because a role is visible on the member's
// profile card and so discloses who holds a masternode. What remains is the decommission command's
// ability to take an old role back, and that still needs this check: removing a role that DENIES
// something hands that permission back, so a command whose purpose is taking access away would grant
// it. The inversion does not care which bit is denied, since a role denying Connect inverts voice
// access exactly as one denying ViewChannel inverts text access.
//
// This reads `guild.channels.cache` rather than fetching, deliberately. A fetch of every channel
// before every member's role mutation would turn one sweep into hundreds of round trips, and the
// cached read is the same residual the channel path already accepts. The startup scan still does the
// authoritative fetch; this catches what has changed since.
function assertRoleOnlyAdds(guild, roleId, what) {
  const channels = [...(guild.channels?.cache?.values() ?? [])].filter(Boolean).map((ch) => ({
    id: ch.id,
    overwrites: [...(ch.permissionOverwrites?.cache?.values() ?? [])],
  }));
  const offenders = roleDenialsAcrossChannels(channels, roleId);
  if (offenders.length) {
    throw new DenialConflict(
      `role ${roleId} carries a denial on ` +
        `${offenders.map((o) => `${o.channel} (${o.deny.join(", ")})`).join(", ")}, so ${what} would ` +
        `invert it: adding the role would REMOVE access there and removing it would GRANT access. ` +
        `Use a role that only ever adds permissions.`,
    );
  }
}

// ---- the four guarded operations ------------------------------------------------------------------
//
// The overwrite type is passed explicitly on every channel edit, because after a restart a raw user id
// is not resolvable to a member from cache and the edit would otherwise throw.

export async function grantMemberOverwrite(ch, userId) {
  assertNoMemberDenial(ch, userId, "granting access");
  await ch.permissionOverwrites.edit(userId, ACCESS, { type: OverwriteType.Member });
}

export async function clearMemberOverwrite(ch, userId) {
  assertNoMemberDenial(ch, userId, "clearing the managed bits");
  await ch.permissionOverwrites.edit(userId, ACCESS_CLEARED, { type: OverwriteType.Member });
}

export async function removeRole(guild, member, roleId) {
  assertRoleOnlyAdds(guild, roleId, "removing the role");
  await member.roles.remove(roleId);
}
