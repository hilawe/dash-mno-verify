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
//   - Serialize every operation globally (see #run). grant and sweep run one at a time, so a member
//     who re-verifies while the sweep is in flight keeps their fresh access instead of having the stale
//     revoke land on top of it, and no operation's whole-map save persists another operation's
//     not-yet-committed record.

// The ledger mechanics live in adapters/common/grant_ledger.js, shared with the other adapters. What
// stays here is what is genuinely Discord's: two grant modes (a role or per-channel overwrites), the
// record shape each needs, and the migration when a renewal switches target. GrantLedger is
// re-exported already carrying those, so the bot and the existing tests use it unchanged.
import { GrantLedger as BaseGrantLedger } from "../common/grant_ledger.js";

// Whether a record authorizes access to the target this bot is CURRENTLY configured for. Liveness
// alone is not enough: a record written for a previous role or channel set can still be live, and
// treating that as a reason to leave someone's access in place would let them keep access to a target
// they never proved for. Used by the startup reconciliation, which has to decide about members it has
// no record of as well as ones it does.
//
// Channel mode requires the record to cover EVERY currently configured channel. A record covering only
// some of them is not authorization for the rest, and the renewal path revokes what it does not carry
// forward, so a partial record here means the member's access is genuinely stale.
export function authorizesTarget(record, isLive, { mode, channels = [], roleId } = {}) {
  if (!record || !isLive || record.mode !== mode) return false;
  return mode === "channel"
    ? channels.length > 0 && channels.every((c) => (record.channels ?? []).includes(c))
    : Boolean(roleId) && String(record.roleId) === String(roleId);
}


export class GrantLedger extends BaseGrantLedger {
  constructor(opts = {}) {
    super({ ...opts, validate: isValidRecord, orphaned: extraTargets });
  }
}
