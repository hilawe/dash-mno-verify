// The two operations the grant ledger drives: apply the access a record describes, and undo it.
//
// These lived inside bot.js, which logs in to Discord at import, so no test could ever drive them.
// That is exactly why the composition below went unverified for two rounds: the ledger's compensation
// of a failed first grant, and this module's reporting of whether anything reached the platform, are
// only correct TOGETHER, and no test could exercise the pair. Reviewers asked twice for a test that
// runs a real GrantLedger.grant across one denied and one clean channel. This file exists so that test
// can be written.
//
// `getGuild` and `guildId` are injected. Nothing here reads the environment.
import { OverwriteType } from "discord.js";
import { isGone, isNotOurs, managedState, MANAGED_BITS } from "./grant_ledger.js";
import { grantMemberOverwrite, clearManagedAllows, isDenialConflict } from "./permissions.js";

// One short retry inside the request, because a member who has just verified should not wait a whole
// sweep interval for a rate limit or a brief 5xx to clear. A refusal is never retried: it is a
// decision, not a blip, and retrying it would just be a slower refusal.
const RETRY_DELAYS_MS = [250, 1000];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeAccess({
  getGuild,
  guildId,
  managedChannels = null,
  contextHash = null,
  log = () => {},
  now = () => Math.floor(Date.now() / 1000),
}) {
  // The channels this bot grants through NOW. Repair is confined to them, because a record can name a
  // channel the configuration has since dropped, and reapplying there would restore access on a target
  // the startup pass has just finished warning it no longer manages. Null means unrestricted, which is
  // only for callers that have no configured set, and no adapter passes null.
  const managed = managedChannels === null ? null : new Set(managedChannels.map(String));
  // Apply the access a grant record describes. Every channel is attempted independently and real
  // failures are collected, so one bad channel cannot abandon the rest. Under the old bare loop a retry
  // always restarted at the failing channel, so a member never received the channels behind it. Same
  // shape as the decommission loop, which was fixed a commit earlier while this one was left alone.
  //
  // The grant path used to write the managed bits with no denial check at all, which three of the four
  // round 9 reviewers reported as a blocker: setting the bits to true over a member-level deny overrides
  // an exclusion an administrator set by hand, so a member who had been deliberately shut out could walk
  // back in by running /submit. The fourth reviewer called that the intentional ownership claim, but the
  // bot's own design says it refuses a conflict it can see, and the startup quarantine exists precisely
  // to stop granting while a denial is present. A denial that appears after startup is the same conflict
  // with worse timing. grantMemberOverwrite carries the check now.
  async function applyAccess(userId, record) {
    const guild = await getGuild();
    // Only channel records are ever written. A role record can only have come from a version that had
    // role mode, and startup refuses to run at all while one is in the ledger, so reaching this with one
    // means that guard was bypassed rather than that this should handle it.
    if (record.mode !== "channel") {
      throw new Error(
        `refusing to grant ${userId} a ${record.mode} target: this bot only ever grants per-channel ` +
          `access. Take the old target back with npm run discord:decommission.`,
      );
    }
    const failures = [];
    // Whether anything could have reached Discord. The ledger compensates a failed first grant by
    // revoking the whole record, which is right when a write may have landed and wrong when the apply
    // refused a precondition and sent nothing: compensating a refusal used to clear the member's access,
    // so declining to grant took access away. DenialConflict carries `mutated: false` for exactly that,
    // and this used to throw a plain aggregate Error, which erased it before the ledger ever saw it. The
    // flag was dead code across two commits that described it as the thing making the refusal safe.
    let applied = false;
    let onlyRefusals = true;
    const refusedChannels = [];
    for (const chId of record.channels) {
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const ch = await guild.channels.fetch(chId);
          await grantMemberOverwrite(ch, userId);
          applied = true;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // A refusal is a decision. Retrying it produces the same answer more slowly, and the member
          // is excluded either way.
          if (isDenialConflict(e)) break;
          if (attempt < RETRY_DELAYS_MS.length) await wait(RETRY_DELAYS_MS[attempt]);
        }
      }
      if (lastErr) {
        failures.push(`${chId}: ${lastErr.message}`);
        // A fetch failure or a network error is NOT a refusal. Its outcome is unknown, so it counts as
        // possibly-mutated, which keeps the record so reconciliation can repair it.
        if (isDenialConflict(lastErr)) refusedChannels.push(chId);
        else onlyRefusals = false;
      }
    }
    if (failures.length) {
      const err = new Error(`could not grant ${failures.join("; ")}`);
      err.mutated = applied || !onlyRefusals;
      // Whether anything DEFINITELY landed, which is not the same question as `mutated`. `mutated` is
      // "a write may have gone out", deliberately conservative so the ledger compensates when unsure.
      // Telling a member "some of your access was applied" on the strength of it said something had
      // landed when a transient failure alongside a denial produces mutated true and zero successful
      // writes.
      err.applied = applied;
      // Which channels refused, so the caller can tell the member the truth. mutated alone could not:
      // one clean channel plus one denied channel gives mutated true, and the member was told the
      // whole failure was temporary when the denied channel is permanent.
      err.refusedChannels = refusedChannels;
      throw err;
    }
  }

  // A 404 from Discord means the channel, member, or guild is already gone, so there is nothing to
  // revoke and the access cannot still be live. Any other error (a lost permission, an outage) is a real
  // failure that must propagate, so the sweep keeps the record and retries instead of dropping it and
  // stranding live access.


  // Undo exactly what a grant record granted, using the record's own mode and target. Throws on a real
  // failure so the caller can keep the grant and retry.
  // Refuses THIS mutation rather than the process, so the ledger keeps the record and unrelated cleanup
  // continues. A startup gate cannot cover this: revocation acts on the target the RECORD names, which
  // may be a channel dropped from the configuration, one that was briefly unreachable when the gate ran,
  // or a whole other guild.
  //
  // Residual, stated rather than solved: the check reads the cached overwrite, so a denial the cache has
  // not yet seen can still be cleared. There is no compare-and-set for Discord permissions. The
  // difference from the two versions that were rejected is that this REFUSES to touch a conflict instead
  // of trying to preserve it through a rewrite, which is a far smaller claim. The check itself lives in
  // permissions.js now, attached to the mutation, so it cannot be present here and absent elsewhere.
  async function revokeAccess(userId, record) {
    const guild = await getGuild();
    // A record from another guild names access this process cannot reach. Refusing keeps the row, so the
    // access stays tracked instead of being forgotten.
    if (record.guildId && String(record.guildId) !== String(guildId)) {
      throw new Error(
        `record names guild ${record.guildId}, this bot serves ${guildId}. The access is still live there ` +
          `and cannot be reached from here. Decommission it in that guild; the record is kept until then.`,
      );
    }
    // Every channel independently, failures collected and thrown after the loop, so the ledger keeps the
    // record for retry and a blocked channel does not hide the ones behind it.
    //
    // Every call is guarded by isGone, including the removal itself and not just the lookup.
    //
    // A record written before startup validation existed can name a role or channel from another guild.
    // Removal of it fails with Unknown Role or an unowned-channel error forever, and because a renewal
    // revokes the orphaned target BEFORE applying the new one, that member could never be repaired: every
    // re-verification aborted on the same failure and the bad record stayed. An id that this guild does
    // not have is by definition holding no access, so treat it as already gone and let the renewal
    // proceed.
    if (record.mode === "channel") {
      const failures = [];
      for (const chId of record.channels ?? []) {
        let ch;
        try {
          ch = await guild.channels.fetch(chId);
        } catch (e) {
          if (isGone(e)) continue; // genuinely absent from this guild: nothing to take back
          // NOT the same thing: another guild's channel is alive and unreachable, so keep the record.
          failures.push(`${chId}: ${isNotOurs(e) ? "belongs to another guild" : e.message}`);
          continue;
        }
        try {
          // Clears only the bits currently allowed, so it removes what this bot granted and never
          // touches a deny. There is no refusal on this path any more, which is the point: refusing to
          // clear left the allow in place forever and jammed the row, and judging "nothing remains"
          // from explicit allows alone missed access inherited from a role.
          await clearManagedAllows(ch, userId);
        } catch (e) {
          if (!isGone(e)) failures.push(`${chId}: ${e.message}`);
        }
      }
      if (failures.length) throw new Error(`could not revoke ${failures.join("; ")}`);
    } else {
      // A role record from an older version. This bot no longer touches roles at all, and taking one
      // back needs the guild-wide denial scan the decommission command still carries, because removing a
      // role that denies something hands that permission back. Keep the record so the access stays
      // tracked, and say what clears it.
      throw new Error(
        `record names role ${record.roleId}, which this bot no longer manages. Take it back with ` +
          `npm run discord:decommission -- role:${record.roleId} --apply. The record is kept until then.`,
      );
    }
  }

  // CONVERGENCE IN THE OTHER DIRECTION, which is the half that did not exist.
  //
  // Reconciliation removed overwrites from people with no live grant and never created one for a
  // person who had a live grant and no access. That gap was reachable and had no way out. The gateway
  // spends the nullifier when it verifies, and the challenge is one-time, so a member whose apply
  // failed after a successful verification could not prove again in that epoch. They were told to run
  // /verify again, which cannot work, and nothing else would ever fix it. They stayed verified,
  // recorded, and locked out until expiry.
  //
  // Reapplying from the record is not new authority in substance, only in direction. The record was
  // written after a verified proof, it is bound to this guild, and it expires on its own, so a repair
  // can never grant more than the member proved or for longer than they proved it. It goes through the
  // same guarded grant, so it still cannot override an administrator's exclusion.
  //
  // Returns the channels it actually repaired, so a caller can say whether it did anything.
  async function repairAccess(userId, record) {
    if (record?.mode !== "channel") return [];
    // Defence in depth, and BOTH halves of it. The caller already refuses a foreign record and only
    // hands over live ones, but repair is the one operation that GRANTS from a stored record rather
    // than from a fresh proof, so it checks its own authority rather than trusting the call site. The
    // comment used to claim it could never grant longer than the member proved while the expiry check
    // lived only in the caller, which is the argument-that-never-reaches-the-path shape again.
    if (record.guildId && String(record.guildId) !== String(guildId)) return [];
    if (!Number.isFinite(record.expiresAt) || now() >= record.expiresAt) return [];
    // The context too. Repair is the one operation that grants from a stored record rather than a
    // fresh proof, so every dimension of that record's authority is checked here and not left to the
    // caller. A record that cannot say which context it was proved in authorizes nothing.
    if (contextHash !== null && String(record.contextHash ?? "") !== String(contextHash)) return [];
    const guild = await getGuild();
    const repaired = [];
    for (const chId of record.channels ?? []) {
      // Only channels this bot grants through now. A record naming a dropped channel is exactly the
      // stale target the startup pass reports and refuses to act on, and repair must not be the one
      // path that quietly does.
      if (managed !== null && !managed.has(String(chId))) continue;
      let ch;
      try {
        ch = await guild.channels.fetch(chId);
      } catch (e) {
        if (isGone(e) || isNotOurs(e)) continue; // nothing to repair on a channel we cannot reach
        // Not silent. This retries on every sweep, and a PERMANENT failure here, a lost permission
        // for instance, used to retry invisibly forever, so nobody learned the member was still
        // waiting. The pass stays quiet only about what needs no attention.
        log(`repair could not read ${chId} for ${userId}, will retry: ${e.message}`);
        continue;
      }
      const own = [...ch.permissionOverwrites.cache.values()].find(
        (o) => o.type === OverwriteType.Member && String(o.id) === String(userId),
      );
      // Present and already allowing all three managed bits means there is nothing to do. Anything
      // else, including a missing overwrite or a partial one, is repaired.
      if (own && MANAGED_BITS.every((b) => managedState(own).allow.includes(b))) continue;
      try {
        await grantMemberOverwrite(ch, userId);
        repaired.push(chId);
      } catch (e) {
        // A refusal here is correct and permanent: the member is excluded, so the repair must not
        // insist. Anything else is left for the next pass.
        log(`could not reapply ${userId} on ${chId}: ${e.message}`);
      }
    }
    return repaired;
  }

  return { applyAccess, revokeAccess, repairAccess };
}
