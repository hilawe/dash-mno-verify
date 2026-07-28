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

// A target is a mode plus its ids, written as a stable string so it can be compared and stored. Ids
// are deduplicated and sorted, because the set is what matters: `c1,c2` and `c2,c1` are the same
// target, and treating them as different triggers a second destructive pass over nothing.
export function targetKey(mode, ids) {
  return `${mode}:${[...new Set(ids.filter(Boolean))].sort().join(",")}`;
}

// STRICT. An earlier version returned null for anything it did not recognise and the caller silently
// dropped it, so a corrupted history entry meant a target was never swept while the pass still
// recorded itself successful, and members holding access there kept it invisibly. A malformed target
// is now a startup failure naming the offending value, because the alternative is losing track of
// access without anyone being told.
export function parseTargetKey(key) {
  const [mode, rest = ""] = String(key).split(":");
  const ids = rest.split(",").filter(Boolean);
  if ((mode !== "channel" && mode !== "role") || ids.length === 0) {
    throw new Error(
      `malformed reconciliation target ${JSON.stringify(key)}. Expected "role:<id>" or ` +
        `"channel:<id>[,<id>...]". Fix or remove it; ignoring it would silently leave access unswept.`,
    );
  }
  return { mode, ids };
}

// What this startup has to look at, split into two very different jobs.
//
//   `current` is the target the bot grants through now. It is scanned on EVERY startup, and a member
//   is left alone only if they hold a live grant matching it. This is what finds access left live by a
//   process terminated between Discord accepting a request and acting on it, which is the whole reason
//   the pass exists and is invisible to the ledger by definition.
//
//   `retire` is every target the bot USED to grant through and has not finished cleaning. There is no
//   authorization to check, because the bot no longer grants there at all, so every member overwrite
//   or role holder it finds is cleared. Once a target has been cleaned it is dropped from the pending
//   set and never touched again: continuing to treat a retired channel as bot-owned would strip access
//   an operator later granted there by hand, and would grow the set without bound.
export function planSweep({ current, pending = [], records = [] }) {
  const cur = parseTargetKey(current);
  const currentRoles = new Set(cur.mode === "role" ? cur.ids : []);
  const currentChannels = new Set(cur.mode === "channel" ? cur.ids : []);
  const retireRoles = new Set();
  const retireChannels = new Set();

  const owe = (key) => {
    const { mode, ids } = parseTargetKey(key);
    for (const id of ids) {
      if (mode === "role" ? currentRoles.has(id) : currentChannels.has(id)) continue; // still current
      (mode === "role" ? retireRoles : retireChannels).add(id);
    }
  };
  for (const key of pending) owe(key);
  // The ledger's own records name targets this bot granted through under an older configuration, which
  // is how a repoint is noticed even when no marker recorded it.
  for (const r of records) {
    if (r?.mode === "role" && r.roleId && !currentRoles.has(String(r.roleId))) retireRoles.add(String(r.roleId));
    for (const c of r?.mode === "channel" ? r.channels ?? [] : []) {
      if (!currentChannels.has(String(c))) retireChannels.add(String(c));
    }
  }
  return {
    current: { roles: [...currentRoles].sort(), channels: [...currentChannels].sort() },
    retire: { roles: [...retireRoles].sort(), channels: [...retireChannels].sort() },
  };
}
