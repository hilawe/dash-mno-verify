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
import { memberDenialsOnGatedChannel, roleDenialsAcrossChannels, managedState } from "./grant_ledger.js";

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

// Which managed bits this member is still ALLOWED on this channel, read from the cached overwrite.
//
// A refusal was being read as proof that the member holds nothing, which is true only when the denial
// covers everything. An overwrite that allows ViewChannel and ReadMessageHistory while denying
// SendMessages is a member who can still see a private channel, and treating that as "nothing to take
// back" let the sweep report success and delete the row while the visibility stayed. Callers that
// refuse a mutation have to ask what survives it.
export function retainedManagedAllows(ch, userId) {
  const own = [...ch.permissionOverwrites.cache.values()].find(
    (o) => o.type === OverwriteType.Member && String(o.id) === String(userId),
  );
  return own ? managedState(own).allow : [];
}

// Refuse if this member's own overwrite on this channel carries a denial on any managed bit.
//
// GRANT ONLY. The clear path stopped calling this when it became "take back what is allowed", because
// there is nothing left for it to refuse: clearing never writes a deny and never lifts one. This
// comment claimed one predicate guarded both mutations, which stopped being true at that change and
// is corrected here rather than in another round.
//
// What it still does is stop a grant writing an allow over an administrator's member-level deny. That
// is worth doing and is not an exclusion guarantee: see the note above the mutations for why this
// adapter cannot enforce an exclusion at all.
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

// ---- the guarded operations ------------------------------------------------------------------
//
// The overwrite type is passed explicitly on every channel edit, because after a restart a raw user id
// is not resolvable to a member from cache and the edit would otherwise throw.

// WHAT THIS BOT CANNOT PROTECT, AND WHY, read this before changing either mutation below.
//
// discord.js `permissionOverwrites.edit()` is a read-modify-write against its own CACHE, inside the
// library. It looks the existing entry up in the cache and hands it to `resolveOverwriteOptions`,
// which rebuilds BOTH bitfields and sends them whole. Verified in 14.26.4. There is no partial update
// on this API and Discord offers no compare-and-set.
//
// So a member-level DENY that the cache has not seen is destroyed by any edit this bot makes on that
// member's entry, whichever bits the patch names. That is true of every design tried here, including
// this one, and no predicate can change it. Three attempts were made before that was understood:
// nulling all three bits (which cleared the deny outright), merging the whole overwrite by hand (the
// same read-modify-write, written out longhand), and refusing to touch an entry carrying any denial
// (which left the access in place forever and still misread inherited allows).
//
// THERE IS CURRENTLY NO WORKING EXCLUSION, and that is the honest statement. A member-level deny is
// not protectable, for the reason above. A ROLE-LEVEL deny is not an answer either, though a previous
// version of this comment said it was: this bot does not edit role entries, which is true and beside
// the point, because `GuildChannel.memberPermissions` applies the member overwrite's ALLOW last, after
// every role deny and role allow. The allow written below outranks the exclusion, which survives
// intact and has no effect. Confusing "does not edit the role entry" with "the role entry still has
// effect" is exactly the mistake that produced the wrong claim.
//
// A real exclusion has to be owned by this bot and checked as part of admission, before it grants. It
// does not exist yet, and nothing below should be read as providing one.
//
// The refresh below shrinks the window for the member-level case from "whenever the cache last
// updated" to the moment before the write. It does not close it, and nothing can.

// Pull the channel's overwrites fresh immediately before deciding and mutating.
//
// Every check in this file reads the cache, and the value of a check made against a cache of unknown
// age is mostly imaginary. Failing to refresh is not fatal: the operation proceeds on what it has,
// which is exactly the old behaviour, because refusing to act when Discord is briefly unreachable
// would turn a blip into an outage.
async function refreshed(ch) {
  try {
    return (await ch.fetch?.(true)) ?? ch;
  } catch {
    return ch;
  }
}

export async function grantMemberOverwrite(ch, userId) {
  const fresh = await refreshed(ch);
  assertNoMemberDenial(fresh, userId, "granting access");
  await fresh.permissionOverwrites.edit(userId, ACCESS, { type: OverwriteType.Member });
}

// Take back only the managed bits that are currently ALLOWED, refusing nothing.
//
// Naming only allowed bits is still the right patch to construct, because it is the smallest change
// that removes what this bot granted, and it keeps the bot from deliberately writing a deny. What it
// does NOT do, contrary to what this comment claimed until the library was read, is keep a deny off
// the wire: `edit` rebuilds and sends both bitfields regardless. See the note above the grant.
//
// Sending nothing when nothing is allowed matters for a second reason now. It is the one case where
// the bot definitely cannot damage a denial, because it makes no request at all.
//
// Returns the bits it cleared, so a caller can say whether there was anything to take back.
export async function clearManagedAllows(ch, userId) {
  const fresh = await refreshed(ch);
  const allowed = retainedManagedAllows(fresh, userId);
  if (allowed.length === 0) return []; // nothing this bot granted is in effect here, so no request
  const patch = Object.fromEntries(allowed.map((bit) => [bit, null]));
  await fresh.permissionOverwrites.edit(userId, patch, { type: OverwriteType.Member });
  return allowed;
}

export async function removeRole(guild, member, roleId) {
  assertRoleOnlyAdds(guild, roleId, "removing the role");
  await member.roles.remove(roleId);
}
