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
  const ids = rest.split(",");
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
