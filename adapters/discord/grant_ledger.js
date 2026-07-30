// The targets in `a` that `b` does not already cover. Used two ways: the new targets a renewal adds
// (extraTargets(record, prev)), and the prior targets a renewal orphans (extraTargets(prev, record)),
// so each can be granted or revoked precisely. Returns null when there is nothing. A mode switch
// (channel to role or back) carries nothing over, so the whole of `a` is extra.
export function extraTargets(a, b) {
  if (a.mode === "channel") {
    const covered = b && b.mode === "channel" ? (b.channels ?? []) : [];
    const channels = (a.channels ?? []).filter((c) => !covered.includes(c));
    return channels.length ? { mode: "channel", channels } : null;
  }
  const coveredRole = b && b.mode === "role" ? b.roleId : null;
  return a.roleId && a.roleId !== coveredRole ? { mode: "role", roleId: a.roleId } : null;
}

// A grant record is valid when it has a finite expiry and the target its mode needs: a non-empty list
// of channel ids for channel mode, a non-empty role id for role mode. Shared by load and grant, so a
// malformed gateway response cannot be written and then never expire (now >= NaN is always false) only
// to break startup on the next load.
export function isValidRecord(r) {
  if (!r || !Number.isFinite(r.expiresAt)) return false;
  const okChannel = r.mode === "channel" && Array.isArray(r.channels) && r.channels.length > 0 && r.channels.every((c) => typeof c === "string" && c.length > 0);
  const okRole = r.mode === "role" && typeof r.roleId === "string" && r.roleId.length > 0;
  return okChannel || okRole;
}

// A persisted ledger of the access the bot has granted, so the expiry sweep is correct across a
// restart (a granted role or channel overwrite outlives the process) and does not race a fresh
// re-verification. The Discord mutations are injected as `apply` and `revoke`, so the ledger logic is
// unit-testable without Discord. A record is { expiresAt, mode, channels, roleId }.
//
// Two properties the inline version did not have:
//   - Persist before applying. A crash between the two then leaves a record with no access, which the
//     sweep harmlessly clears, never access with no record, which would be permanent and untracked.
//   - Serialize the operations on ONE member (see #run in the shared ledger). A member who re-verifies
//     while a sweep is in flight keeps their fresh access instead of having the stale revoke land on
//     top of it. Unrelated members proceed in parallel, and each grant is a single row write, so one
//     member's slow platform call blocks nobody. This used to be one global queue rewriting a whole
//     JSON map, which is what the comment described until the SQLite move made it wrong.

// The ledger mechanics live in adapters/common/grant_ledger.js, shared with the other adapters. What
// stays here is what is genuinely Discord's: two grant modes (a role or per-channel overwrites), the
// record shape each needs, and the migration when a renewal switches target. GrantLedger is
// re-exported already carrying those, so the bot and the existing tests use it unchanged.
import { GrantLedger as BaseGrantLedger } from "../common/grant_ledger.js";

// Whether a record authorizes access to ONE SPECIFIC place the bot grants: a single channel, or the
// configured role. Liveness alone is not enough, because a record written for a previous role or
// channel set can still be live.
//
// This takes ONE channel, not the whole configured set, and that is the fix for a real access loss.
// It used to require the record to cover EVERY configured channel while the caller inspected channels
// one at a time. So adding a second channel to the configuration made every existing member's record
// fail the check on the channel they legitimately held, and the startup pass cleared it. The ledger row
// survived, so the sweep never repaired it, and on a Platform-backed store the member could not
// re-grant until the next epoch. Judge each channel on whether the record covers THAT channel.
export function authorizesTarget(record, isLive, { mode, channel = null, roleId } = {}) {
  if (!record || !isLive || record.mode !== mode) return false;
  return mode === "channel"
    ? Boolean(channel) && (record.channels ?? []).includes(String(channel))
    : Boolean(roleId) && String(record.roleId) === String(roleId);
}


export class GrantLedger extends BaseGrantLedger {
  constructor(opts = {}) {
    super({ ...opts, validate: isValidRecord, orphaned: extraTargets });
  }
}

// A target is a mode plus its ids, written as a stable string so it can be named on a command line
// and compared. Ids are deduplicated and sorted, because the set is what matters.
export function targetKey(mode, ids) {
  return `${mode}:${[...new Set(ids.filter(Boolean))].sort().join(",")}`;
}

// STRICT, and strict about the WHOLE string. An earlier version destructured only the first two
// colon-separated parts, so `role:a:role:b` quietly became `role:a` and the rest was forgotten, and an
// earlier one before that returned null for anything unrecognised so the caller dropped it silently.
// Both meant a target could go unswept while the operation reported success. A malformed target is a
// hard error naming the value.
export function parseTargetKey(key) {
  const raw = String(key);
  const parts = raw.split(":");
  const bad = (why) => {
    throw new Error(
      `malformed target ${JSON.stringify(raw)}: ${why}. Expected "role:<id>" or ` +
        `"channel:<id>[,<id>...]" with no extra colons and no empty ids.`,
    );
  };
  if (parts.length !== 2) bad(parts.length < 2 ? "no mode separator" : "more than one colon");
  const [mode, rest] = parts;
  if (mode !== "channel" && mode !== "role") bad(`unknown mode ${JSON.stringify(mode)}`);
  // Trim and deduplicate, matching targetKey, which already treats ids as a set. Without this a
  // hand-typed "channel:111, 222" produced the id " 222", which Discord rejects, and "channel:111,111"
  // cleared the same channel twice and double-counted the result.
  const ids = [...new Set(rest.split(",").map((id) => id.trim()))];
  if (ids.length === 0 || ids.some((id) => id === "")) bad("an empty id");
  if (mode === "role" && ids.length !== 1) bad("a role target names exactly one role");
  return { mode, ids };
}

// Targets the ledger's own records name that are NOT the one the bot grants through now. Reported at
// startup so an operator is told cleanup is owed, and never acted on automatically: taking access away
// in bulk is a deliberate act, not something a restart should do on its own. See the decommission
// script.
export function staleTargets(records, { mode, channels = [], roleId } = {}) {
  const current = new Set(mode === "channel" ? channels.map(String) : [String(roleId)]);
  const roles = new Set();
  const chans = new Set();
  for (const r of records ?? []) {
    if (r?.mode === "role" && r.roleId && !(mode === "role" && current.has(String(r.roleId)))) {
      roles.add(String(r.roleId));
    }
    for (const c of r?.mode === "channel" ? r.channels ?? [] : []) {
      if (!(mode === "channel" && current.has(String(c)))) chans.add(String(c));
    }
  }
  return [...[...roles].sort().map((r) => targetKey("role", [r])), ...(chans.size ? [targetKey("channel", [...chans])] : [])];
}

// The three permission bits this bot manages on a private channel.
export const MANAGED_BITS = ["ViewChannel", "SendMessages", "ReadMessageHistory"];

// Which managed bits an overwrite ALLOWS and which it DENIES. `overwrite` is a discord.js
// PermissionOverwrites, or anything exposing allow/deny objects with has().
export function managedState(overwrite) {
  const has = (field, bit) => Boolean(overwrite?.[field]?.has?.(bit));
  return {
    allow: MANAGED_BITS.filter((b) => has("allow", b)),
    deny: MANAGED_BITS.filter((b) => has("deny", b)),
  };
}

// PER-MEMBER OVERWRITES ON A GATED CHANNEL BELONG TO THE BOT. THAT IS THE WHOLE DESIGN NOW.
//
// Two rounds were spent trying to be careful about denials a moderator had set: preserve them when
// clearing, refuse to grant over them. Both attempts produced a defect worse than the one they fixed.
// Preserving denials meant a read-modify-write against a CACHED overwrite, so a denial the cache had
// not seen yet was wiped by the very code written to protect it. Refusing to grant over a denial meant
// the ledger's uncertain-apply cleanup then stripped the member's pre-existing access, so declining to
// grant took access away.
//
// The root problem is structural: the bot cannot do a conditional update against a permission surface
// other people edit concurrently, and Discord offers no compare-and-set. Every careful version was
// wrong in a new way.
//
// So it stops guessing. One per-member overwrite exists per member per channel, the bot claims that
// slot on a gated channel, and if it finds one carrying a denial it refuses to run rather than fight
// whoever set it. Exclusions are expressed with role-level denies, or by not granting. Clearing can
// then be unconditional and correct, because nothing the bot did not create is ever there.
export function memberDenialsOnGatedChannel(overwrites) {
  const offenders = [];
  for (const ow of overwrites ?? []) {
    const deny = managedState(ow).deny;
    if (deny.length) offenders.push({ id: ow.id, deny });
  }
  return offenders;
}

// A role the bot adds and removes must only ever ADD permissions, and that means ANY denial anywhere,
// not just the three bits channel mode manages.
//
// The inversion does not care which bit is denied. If the role denies Connect on a voice channel, then
// granting it takes voice away and revoking it gives voice back, so a grant revokes and a revocation
// grants exactly as it would for ViewChannel. An earlier version of this checked only the managed
// three, which caught the reviewer's reproduction and would have missed every other permission.
//
// Reads the whole deny bitfield. `toArray()` names the bits when discord.js provides it, so the refusal
// message can tell the operator what to fix rather than printing a number.
export function roleDenialsAcrossChannels(channels, roleId) {
  const offenders = [];
  for (const ch of channels ?? []) {
    for (const ow of ch.overwrites ?? []) {
      if (String(ow.id) !== String(roleId)) continue;
      const bits = ow.deny?.bitfield;
      if (bits === undefined || BigInt(bits) === 0n) continue;
      const named = typeof ow.deny?.toArray === "function" ? ow.deny.toArray() : [String(bits)];
      offenders.push({ channel: ch.id, deny: named });
    }
  }
  return offenders;
}

// "NOT OURS TO ACT ON" is a different thing from "already gone", and conflating them cost a blocker.
//
// GuildChannelUnowned means the id belongs to another guild. Access there is very much alive; this
// process simply cannot reach it. Treating that as gone let a sweep resolve successfully and DELETE the
// ledger row, so after repointing the bot at a different server the records of access still live in the
// old one were quietly discarded and nothing tracked it again. The fix that widened isGone to unblock a
// stuck renewal created that, which is why the two are now separate predicates.
const NOT_OURS_CODES = new Set(["GuildChannelUnowned", "GuildChannelResolve"]);
export const isNotOurs = (e) => NOT_OURS_CODES.has(e?.code);

// "Already gone", so there is nothing to take back. Numeric codes come from the Discord API; the string
// ones are discord.js's own, raised before a request is made.
//
// This lives here, exported, because it existed TWICE: the bot's copy learned the string codes and the
// decommission command's copy did not, so the same input was "gone" in one file and a hard failure in
// the other. Duplicating a predicate is how a fix reaches one site and misses its twin, which is the
// defect this component has produced in every review round. One definition, two importers.
const GONE_CODES = new Set([10003, 10004, 10007, 10011, 10013]);
export const isGone = (e) => e?.status === 404 || GONE_CODES.has(e?.code);

// Records written before records carried a guild id read as null, and this returns nothing for them.
//
// That used to be the hole. "Unknown" was read as "assume ours", so a repointed bot could revoke a
// legacy record against the new guild, receive a not-found that isGone already classified as already
// gone, and delete the row while the access stayed live and untracked in the old guild. Two reviewers
// found it and one reproduced it with a real migrated record.
//
// It is closed at a level this predicate cannot see. The ledger DATABASE is now bound to one guild,
// and an existing unbound ledger holding grants refuses to start until an operator asserts where those
// grants were made. So a record with no guild id belongs to the bound guild by construction, and
// "unknown, assume ours" is now a fact about the database rather than a guess about the record.
//
// This still reports a record naming a DIFFERENT guild, because that is an anomaly the binding does
// not explain: access is live over there, this process cannot touch it, and pretending otherwise
// deletes the only trace of it.
export function foreignGuildRecords(records, guildId) {
  const out = [];
  for (const r of records ?? []) {
    if (r?.guildId && String(r.guildId) !== String(guildId)) out.push({ guildId: String(r.guildId) });
  }
  return out;
}
