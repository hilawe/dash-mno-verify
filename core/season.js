// Season-scoped members state for the two-tier flow.
//
// The members tree is a cache rebuilt from the durable registration records, never the source of
// truth. A season boundary starts a fresh empty tree, so a root from a past season stops being
// accepted and a member who registered last season must re-register (which re-proves current
// masternode control). A restart loses nothing, because the tree is rebuilt from the records.
//
// Rollovers and member commits run on one serialized queue. That ordering is the fix for the
// season-rollover time-of-check-to-time-of-use race: a rollover can never run between the moment a
// commit checks the season and the moment it appends the member, so a commit can never append to a
// stale tree or publish a stale-season root. The expensive proof verify stays outside this queue
// (the caller runs it first), so a slow verify never stalls challenges and per-epoch verifies.
import { MembersTree } from "./members_tree.js";
import { RootStore } from "./stores.js";

export class SeasonMembers {
  constructor({ store, rootWindow, nowSec }) {
    this.store = store;
    this.rootWindow = rootWindow;
    this.nowSec = nowSec;
    this.tree = null; // current season's members tree, a cache of the durable records
    this.roots = null; // current season's recent-roots window
    this.current = null; // current season number, or null before the first ensure()
    this._op = Promise.resolve(); // the serialization queue, see ensure()/commit()
  }

  // Run fn serialized after any in-flight rollover or commit. The chain is kept alive past a
  // throw so one failed operation does not wedge later ones; the rejection still reaches the
  // caller of this call.
  _serial(fn) {
    const run = this._op.then(fn);
    this._op = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async _rebuild(season) {
    const records = await this.store.forSeason(season);
    this.tree = await MembersTree.fromCommitments(records.map((r) => r.commitment));
    this.roots = new RootStore(this.rootWindow);
    this.roots.update([{ height: this.tree.size(), root: this.tree.root(), ts: this.nowSec() }]);
    this.current = season;
    return records.length;
  }

  // Make the in-memory tree reflect `season`. A no-op once that season is current, so the
  // accumulated root window is preserved within a season and only a real rollover resets it
  // (which is what makes a stale-season root stop being accepted).
  ensure(season) {
    season = Number(season);
    return this._serial(() => (this.current === season ? undefined : this._rebuild(season).then(() => {})));
  }

  // Commit a verified registration into the live tree. appendDurable writes the durable record
  // (the commit point) and returns { duplicate, index }; it runs inside the serialized section so
  // the durable index and the tree position are assigned together and a rollover cannot interleave.
  // Re-checks the season first, so a rollover during the caller's proof verify yields a retry
  // instead of a stale-season publish, and no durable record is written for a season that is gone.
  commit(season, commitment, appendDurable) {
    season = Number(season);
    return this._serial(async () => {
      if (this.current !== season) return { ok: false, reason: "season-rolled-retry" };
      const res = await appendDurable();
      if (res.duplicate) return { ok: false, reason: "already-registered" };
      this.tree.append(commitment);
      const membersRoot = this.tree.root();
      this.roots.update([{ height: this.tree.size(), root: membersRoot, ts: this.nowSec() }]);
      return { ok: true, index: res.index, membersRoot, size: this.tree.size() };
    });
  }

  // Read-only views of the current season's tree, for the challenge, members, and health routes.
  rootCurrent() {
    return this.roots?.current() ?? null;
  }
  rootStore() {
    return this.roots;
  }
  size() {
    return this.tree?.size() ?? 0;
  }
  root() {
    return this.tree?.root() ?? null;
  }
  commitments() {
    return this.tree?.commitments ?? [];
  }
}
