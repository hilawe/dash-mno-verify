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
import { isGone, isNotOurs } from "./grant_ledger.js";
import { grantMemberOverwrite, clearMemberOverwrite, isDenialConflict } from "./permissions.js";

export function makeAccess({ getGuild, guildId, log = () => {} }) {
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
    for (const chId of record.channels) {
      try {
        const ch = await guild.channels.fetch(chId);
        await grantMemberOverwrite(ch, userId);
        applied = true;
      } catch (e) {
        failures.push(`${chId}: ${e.message}`);
        // A fetch failure or a network error is NOT a refusal. Its outcome is unknown, so it counts as
        // possibly-mutated and the conservative compensation still runs.
        if (!isDenialConflict(e)) onlyRefusals = false;
      }
    }
    if (failures.length) {
      const err = new Error(`could not grant ${failures.join("; ")}`);
      err.mutated = applied || !onlyRefusals;
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
          await clearMemberOverwrite(ch, userId);
        } catch (e) {
          // A refusal is not a failure here, and this is the twin of the same decision in
          // reconcileGuild's clear helper, which had it and this did not. A member carrying a denial
          // holds no access on that channel, so there is nothing to take back and leaving their
          // overwrite alone is the correct outcome. Counting it as a failure kept the record forever and
          // the sweep retried it every interval for the life of the deployment, which is a guard causing
          // a larger failure than the one it reports.
          if (isDenialConflict(e)) {
            log(`left ${userId} alone on ${chId} while revoking: ${e.message}`);
            continue;
          }
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

  return { applyAccess, revokeAccess };
}
