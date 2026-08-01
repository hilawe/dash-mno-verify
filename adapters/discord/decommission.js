// The decommission pass, separated from the command that drives it.
//
// The command logs in to Discord at import, so nothing in it could be imported by a test. That is why
// four separate defects lived here through two review rounds: a retirement gate that skipped the
// ledger whenever nothing was removed, a deleted target that could never be retired, a whole channel
// skipped over one member's exclusion, and a lock taken after the mutations it was documented to
// protect. Every one of them is a property of this function, and every one is now drivable with a fake
// guild and a real ledger.
//
// Everything it touches is injected. It reads no environment and creates no client.
import { OverwriteType } from "discord.js";
import {
  isGone,
  managedState,
  memberDenialsOnGatedChannel,
  roleDenialsAcrossChannels,
  retireTargetTransform,
} from "./grant_ledger.js";
import { clearManagedAllows, removeRole, isDenialConflict } from "./permissions.js";

export async function runDecommission({
  guild,
  target,
  targetArg,
  dryRun,
  confirmGone = false,
  ledger = null,
  botUserId,
  log = () => {},
  warn = () => {},
  err = () => {},
}) {
  // The assertion behind --confirm-target-gone is only accepted for a target the LEDGER names.
  //
  // The flag exists to retire rows for a target that no longer exists on Discord. A typo'd id also
  // does not exist on Discord, and the flag used to accept it, run to completion, and report success
  // having retired nothing, because no row named the typo. Success on a target this command was never
  // tracking teaches an operator that the flag "worked" when nothing happened. If no row names the
  // target, there is nothing the assertion could retire, so it is refused as almost certainly a typo.
  // A row with no guildId belongs to the DATABASE'S BOUND SCOPE, not to whatever guild this process
  // happens to be pointed at.
  //
  // That distinction is the whole reason the binding exists, and reading it the other way undid it.
  // With allowForeignScope the command can open a ledger bound to guild A while configured for guild
  // B. A migrated legacy row carries no guildId, which is expected. Resolving it against B made it
  // look local, so --confirm-target-gone accepted B's not-found as evidence and retired A's row while
  // that access stayed live and unreachable, with its only record gone. Reproduced by two reviewers.
  const boundScope = ledger?.scope?.() ?? null;
  const homeGuild = boundScope ?? guild.id;
  const ours = (r) => (r?.guildId ? String(r.guildId) === String(homeGuild) : String(homeGuild) === String(guild.id));
  const namedInLedger = (chOrRoleId) =>
    (ledger?.all?.() ?? [])
      .filter(ours)
      .some((r) =>
        r?.mode === "role" ? String(r.roleId) === String(chOrRoleId) : (r?.channels ?? []).map(String).includes(String(chOrRoleId)),
      );
  if (confirmGone && !dryRun) {
    const unnamed = target.ids.filter((id) => !namedInLedger(id));
    if (unnamed.length) {
      throw new Error(
        `--confirm-target-gone was given for ${unnamed.join(", ")}, but no ledger record names ` +
          `${unnamed.length === 1 ? "it" : "them"}, so there is nothing the assertion could retire. ` +
          `A deleted target that was never tracked needs no cleanup, which makes this almost ` +
          `certainly a mistyped id. Nothing was changed.`,
      );
    }
  }
  const removed = [];
  const failed = [];
  // What must NOT be retired, tracked precisely rather than as one flag, so a single stuck member does
  // not keep a whole target tracked and a single cleared member does not let a stuck one be forgotten.
  const failedMembers = new Set();
  const failedPairs = new Set();
  const skippedChannels = new Set();
  
  // Name the guild before touching anything. A command that removes access in bulk should say which
  // server it is about to act on, so a wrong DISCORD_GUILD_ID is obvious in the output.
  log(`[decommission] guild ${guild.name} (${guild.id}), target ${targetArg}${dryRun ? ", PREVIEW ONLY" : ""}`);

  if (target.mode === "role") {
    const roleId = target.ids[0];
    // Confirm the role belongs to THIS guild. Role ids are globally unique, so naming a role from
    // another server simply matched nobody, reported zero holders, and exited zero as if it had
    // succeeded, while every real holder kept the role.
    // ONLY a genuine absence counts as absence. This used to catch every error to null, which was
    // survivable while a missing role simply refused, and became a blocker the moment
    // --confirm-target-gone existed: one Discord 500 plus that flag deleted the rows for a role that
    // was still live and still disclosing who holds a masternode. A guard's new exit must not accept a
    // blip as proof the thing is gone.
    let role;
    try {
      role = await guild.roles.fetch(roleId);
    } catch (e) {
      if (!isGone(e)) {
        throw new Error(
          `could not read role ${roleId} (${e.message}). Nothing was changed, and no ledger row was ` +
            `retired, because a failure to look is not evidence of absence. Try again.`,
        );
      }
      role = null;
    }
    if (!role && !confirmGone) {
      throw new Error(
        `role ${roleId} does not exist in ${guild.name} (${guild.id}). Check DISCORD_GUILD_ID and the ` +
          `role id; nothing was changed.\n` +
          `  If the role really was deleted, it holds no access and its ledger rows can be retired:\n` +
          `    npm run discord:decommission -- ${targetArg} --apply --confirm-target-gone`,
      );
    }
    // A confirmed-deleted role holds nothing, so there is nothing to preflight and nobody to remove
    // it from. Fall through to the retirement below, which is the whole point of the flag.
    if (!role) {
      log(`[decommission] role ${roleId} is gone, as asserted. Retiring its ledger rows.`);
    } else {
    // PREFLIGHT. Removing a role that DENIES something hands that permission back, so a command whose
    // purpose is taking access away would grant it. Same check the bot makes before it will start.
    const roleOffenders = roleDenialsAcrossChannels(
      [...(await guild.channels.fetch()).values()].filter(Boolean).map((c) => ({
        id: c.id,
        overwrites: [...(c.permissionOverwrites?.cache?.values() ?? [])],
      })),
      roleId,
    );
    if (roleOffenders.length) {
      throw new Error(
        `role ${role.name} (${roleId}) DENIES ` +
          `${roleOffenders.map((o) => `${o.deny.join("/")} on ${o.channel}`).join(", ")}. Removing it ` +
          `would GRANT those permissions rather than take access away. Nothing was changed. Remove the ` +
          `deny overwrite first, or take the role away by hand knowing what it restores.`,
      );
    }
    let members;
    try {
      members = await guild.members.fetch();
    } catch (e) {
      throw new Error(
        `cannot read the member list (${e.message}). Enable the SERVER MEMBERS INTENT for this ` +
          `application in Discord's developer portal, run this once, and you can turn it off again.`,
      );
    }
    const holders = [...members.values()].filter((m) => m.roles.cache.has(roleId) && m.id !== botUserId);
    log(`[decommission] role ${role.name} (${roleId}): ${holders.length} member(s) hold it`);
    for (const m of holders) {
      if (dryRun) {
        removed.push(m.id);
        continue;
      }
      try {
        await removeRole(guild, m, roleId);
        removed.push(m.id);
      } catch (e) {
        if (isGone(e)) continue; // the member or role went away; nothing left to take back
        failed.push(m.id);
        failedMembers.add(String(m.id));
        err(
          isDenialConflict(e)
            ? `[decommission] REFUSED for ${m.id}: ${e.message} Nothing was changed for this member.`
            : `[decommission] could not remove the role from ${m.id}: ${e.message}`,
        );
      }
    }
    }
  } else {
    for (const chId of target.ids) {
      // Each channel stands alone. An unguarded fetch here meant one bad channel threw out of the
      // whole loop: every channel before it had already been cleared, every channel after it was
      // left untouched, and the summary that would have said so was never printed. The operator saw
      // an error and had no idea how far it had got. This is the same shape as the per-holder catch
      // below and the isGone-and-continue in the bot, neither of which was applied here.
      let ch;
      try {
        ch = await guild.channels.fetch(chId);
      } catch (e) {
        if (isGone(e)) {
          // A typo looks identical to a deleted channel here, and a manual destructive command must
          // not report success for a target it never found. So it still fails by default. What it no
          // longer does is fail with no way forward: a deleted channel can never come back, so its
          // rows were kept forever and the guild binding could never empty.
          if (confirmGone) {
            log(
              `[decommission] channel ${chId} is gone, as asserted. It holds no access, so its ledger ` +
                `rows are retired.`,
            );
            continue; // NOT skipped, so the retirement below covers it
          }
          failed.push(`${chId}/*`);
          skippedChannels.add(String(chId));
          err(
            `[decommission] channel ${chId} is not in ${guild.name} (${guild.id}). Check the id.\n` +
              `  If it really was deleted, it holds no access and its rows can be retired:\n` +
              `    npm run discord:decommission -- ${targetArg} --apply --confirm-target-gone`,
          );
          continue;
        }
        failed.push(`${chId}/*`);
        skippedChannels.add(String(chId));
        err(`[decommission] could not read channel ${chId}: ${e.message}`);
        continue;
      }
      // Member overwrites only. A role overwrite on this channel is the operator's own arrangement.
      const members = [...ch.permissionOverwrites.cache.values()].filter(
        (ow) => ow.type === OverwriteType.Member && ow.id !== botUserId,
      );
      // One excluded member is not a reason to strand everybody else. This used to skip the WHOLE
      // channel when any member carried a denial, which defeated the per-member guard below it and
      // the failedPairs machinery beside that, so one administrator exclusion kept every unrelated
      // holder's stale access alive. It is also the exact twin of a case the permissions tests assert
      // must not happen, where a denial on one member must not block another: that reasoning reached
      // the mutation helper and stopped there.
      //
      // The denial is still honoured, and now it is honoured by clearing only what is allowed rather
      // than by refusing. Refusing left the allow in place forever and kept the row, so a member who
      // was partially denied held that access permanently and jammed every later sweep.
      const denied = memberDenialsOnGatedChannel(members);
      if (denied.length) {
        warn(
          `[decommission] channel ${chId}: ${denied.map((d) => `${d.id} is denied ${d.deny.join("/")}`).join(", ")}. ` +
            `Those members are left alone, because clearing a denial would GRANT access through a ` +
            `role-level allow. Everyone else on this channel is still cleared.`,
        );
      }
      // Preview must not claim it would clear a member it will refuse. It used to warn that denied
      // members are left alone and then count every one of them in `removed`, so the preview and the
      // apply disagreed about the same channel. A destructive command's preview is the only thing an
      // operator checks before running it for real.
      // ONE predicate, both arms. The previous version applied the filter only to the preview, so
      // apply walked every member overwrite and reported members it had made no request for. A
      // fully-denied member has nothing allowed, so clearManagedAllows issues no request, yet apply
      // still counted them as taken back. Preview said one thing and apply reported another, which is
      // the same divergence as before in the opposite direction, and the comment claiming both paths
      // used the same predicate was true of only one of them.
      //
      // Members with nothing allowed are still RETIRED by the transform, correctly: there is nothing
      // of the bot's left on that channel for them.
      const holders = members.filter((m) => managedState(m).allow.length > 0);
      log(`[decommission] channel ${chId}: ${holders.length} per-member overwrite(s)`);
      for (const ow of holders) {
        if (dryRun) {
          removed.push(`${chId}/${ow.id}`);
          continue;
        }
        try {
          await clearManagedAllows(ch, ow.id);
          removed.push(`${chId}/${ow.id}`);
        } catch (e) {
          if (isGone(e)) continue; // already gone
          failed.push(`${chId}/${ow.id}`);
          failedPairs.add(`${chId}/${ow.id}`);
          err(
            isDenialConflict(e)
              ? `[decommission] REFUSED ${ow.id} on ${chId}: ${e.message} Nothing was changed for them.`
              : `[decommission] could not clear ${ow.id} on ${chId}: ${e.message}`,
          );
        }
      }
    }
  }

  // The three bits this bot grants are reset to inherit on every per-member overwrite found,
  // including overwrites an operator added by hand, because a stored overwrite carries no record of
  // who created it. Any OTHER permission on that overwrite is left alone, so this is narrower than
  // "clear the overwrite". That trade is right HERE, at the moment you deliberately decommission a
  // target, and wrong for a bot to make on its own at every restart, which an earlier design did.
  // STOP TRACKING WHAT CAME BACK, and only that.
  //
  // This runs after Discord, never before, because a row retired ahead of a removal that then failed
  // would leave live access with nothing watching it. The two cannot be one transaction, so the order
  // is chosen to fail in the safe direction: a retirement that does not happen leaves a row the sweep
  // will retry, while a removal that does not happen leaves a row that still names it.
  // STOP TRACKING WHAT CAME BACK, and only that.
  //
  // The gate used to be `removed.length`, so a run that removed nobody skipped the ledger entirely.
  // That is not the rare case it sounds like. A role removed by hand after the command refused it, a
  // second run after a first one succeeded, a target with no holders left: all of them reach here
  // with zero removals, and all of them left rows behind that kept the bot permanently unstartable
  // while the command reported success and exited zero. The error text even told the operator to run
  // it again, which produced the same false success forever. That is a guard whose documented exit
  // could not be reached by doing the right thing.
  //
  // There is nothing for that gate to protect. retireTargetTransform already refuses to retire a
  // channel that was skipped or a member whose removal failed, so precision lives there and the only
  // question here is whether Discord was examined at all. Anything that stopped the examination
  // threw out of this block before reaching this line.
  //
  // Still after Discord, never before, because a row retired ahead of a removal that then failed
  // would leave live access with nothing watching it. The two cannot be one transaction, so the order
  // fails in the safe direction.
  if (!dryRun) {
    try {
      const result = ledger.retireAll(
        retireTargetTransform({
          mode: target.mode,
          ids: target.ids,
          // The bound scope, so an unlabelled legacy row is judged by where the DATABASE says it
          // belongs rather than by where this process happens to be pointed.
          guildId: guild.id,
          unlabelledBelongTo: homeGuild,
          failedMembers,
          failedPairs,
          skippedChannels,
        }),
      );
      log(
        `[decommission] ledger: ${result.changed} record(s) no longer name ${targetArg}, ` +
          `${result.deleted} record(s) removed entirely, ${result.remaining} still tracked`,
      );
      if (result.remaining === 0) {
        log(
          `[decommission] the ledger holds nothing now, so it will rebind by itself if you point the ` +
            `bot at a different server.`,
        );
      }
    } catch (e) {
      failed.push("the ledger");
      err(
        `[decommission] Discord access was taken back, but the ledger was NOT updated: ${e.message}\n` +
          `  Those rows still name ${targetArg}, so a later sweep will try to clear those permission ` +
          `bits again. Fix the cause and run this command again. Both halves are safe to repeat, and ` +
          `a second run retires the rows even though it will find nothing left to remove.`,
      );
    }
  }

  // No summary here. The pass reports per-item progress as it goes, and the COMMAND owns the final
  // presentation, because both layers printing it produced every result twice, with the generic footer
  // contradicting the specific inner message on a ledger failure: the inner one correctly said Discord
  // access was taken back while the footer said the failed items still hold access. One voice for the
  // verdict. Tests assert the returned result instead.
  return { removed, failed };
}
