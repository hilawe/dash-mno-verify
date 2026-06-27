// Season-scoped, per-context members state for the two-tier flow.
//
// There is one members tree per (season, contextHash), not one per season. A registration is scoped
// to a community, so its commitment belongs only to that community's tree. Keeping a separate tree
// per context is what stops a member who registered for one community from proving membership in
// another that season (review finding B2). Each tree is a cache rebuilt from the durable records for
// its (season, context) bucket, never the source of truth, so a restart loses nothing.
//
// A season boundary clears every context tree at once, so a root from a past season stops being
// accepted and a member must re-register (which re-proves current masternode control). Rollovers and
// member commits run on one serialized queue. That ordering is the fix for the season-rollover
// time-of-check-to-time-of-use race: a rollover can never run between the moment a commit checks the
// season and the moment it appends the member, so a commit can never append to a stale tree or
// publish a stale-season root. The expensive proof verify stays outside this queue (the caller runs
// it first), so a slow verify never stalls challenges and per-epoch verifies.
import { MembersTree } from "./members_tree.js";
import { RootStore } from "./stores.js";

export class SeasonMembers {
  // emptyRoot is the all-empty depth-16 members root, computed once by the caller (the gateway uses
  // its fast hasher, which returns it in O(1)). It is what an empty context serves WITHOUT building
  // and caching a 2**16 tree, so an attacker cannot force unbounded expensive tree builds by varying
  // the context on an unauthenticated read.
  constructor({ store, rootWindow, nowSec, emptyRoot }) {
    this.store = store;
    this.rootWindow = rootWindow;
    this.nowSec = nowSec;
    this.emptyRoot = emptyRoot;
    this.emptyRoots = new RootStore(rootWindow);
    this.emptyRoots.update([{ height: 0, root: emptyRoot, ts: nowSec() }]);
    this.current = null; // current season number, or null before the first ensure()
    this.ctx = new Map(); // contextHash -> { tree, roots }, only contexts that have durable records
    this._op = Promise.resolve(); // the serialization queue, see ensure()/ensureContext()/commit()
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

  // Roll the in-memory state to `season`, discarding every context tree if it changed. A no-op once
  // the season is current, so the accumulated per-context root windows are preserved within a season
  // and only a real rollover resets them (which is what makes a stale-season root stop being
  // accepted). Caller must hold the serial queue.
  _roll(season) {
    if (this.current !== season) {
      this.ctx.clear();
      this.current = season;
    }
  }

  // Build and cache the context tree from the given records, in insertion order. Caller must hold
  // the serial queue. Building a 2**16 tree is expensive, so this runs only for a context that has
  // records or is about to gain one (a commit), never for an arbitrary empty context.
  async _materializeFrom(contextHash, records) {
    const tree = await MembersTree.fromCommitments(records.map((r) => r.commitment));
    const roots = new RootStore(this.rootWindow);
    roots.update([{ height: tree.size(), root: tree.root(), ts: this.nowSec() }]);
    const c = { tree, roots };
    this.ctx.set(contextHash, c);
    return c;
  }

  // Return the cached context tree, building it from the durable records on first use.
  async _materialize(contextHash) {
    return (
      this.ctx.get(contextHash) ??
      (await this._materializeFrom(contextHash, await this.store.forSeasonContext(this.current, contextHash)))
    );
  }

  // Make the in-memory state reflect `season`, rolling over the trees if the season changed.
  ensure(season) {
    season = Number(season);
    return this._serial(() => this._roll(season));
  }

  // Ensure the season is current and, only if `contextHash` has durable records, that its tree is
  // built. An empty context is left unmaterialized, so the read views serve the shared empty root
  // without building a tree. This is what stops an unauthenticated caller from forcing unbounded
  // expensive tree builds by varying the context. Used by the challenge, members, and verify reads.
  ensureContext(season, contextHash) {
    season = Number(season);
    return this._serial(async () => {
      this._roll(season);
      if (this.ctx.has(contextHash)) return;
      const records = await this.store.forSeasonContext(this.current, contextHash);
      if (records.length > 0) await this._materializeFrom(contextHash, records);
    });
  }

  // Commit a verified registration into the context's live tree. appendDurable writes the durable
  // record (the commit point) and returns { duplicate, index }; it runs inside the serialized
  // section so the durable index and the tree position are assigned together and a rollover cannot
  // interleave. Re-checks the season first, so a rollover during the caller's proof verify yields a
  // retry instead of a stale-season publish, and no durable record is written for a season gone by.
  // A registration is authenticated and rate-limited, so materializing the tree here is gated work.
  commit(season, contextHash, commitment, appendDurable) {
    season = Number(season);
    return this._serial(async () => {
      if (this.current !== season) return { ok: false, reason: "season-rolled-retry" };
      const c = await this._materialize(contextHash);
      const res = await appendDurable();
      if (res.duplicate) return { ok: false, reason: "already-registered" };
      c.tree.append(commitment);
      const membersRoot = c.tree.root();
      c.roots.update([{ height: c.tree.size(), root: membersRoot, ts: this.nowSec() }]);
      return { ok: true, index: res.index, membersRoot, size: c.tree.size() };
    });
  }

  // Read-only views of one context's tree. An unmaterialized (empty) context reads as the shared
  // empty members set, so a never-registered context is consistent without building a tree.
  contextCount() {
    return this.ctx.size;
  }
  rootCurrent(contextHash) {
    return this.ctx.get(contextHash)?.roots.current() ?? { height: 0, root: this.emptyRoot, ts: this.nowSec() };
  }
  rootStore(contextHash) {
    return this.ctx.get(contextHash)?.roots ?? this.emptyRoots;
  }
  size(contextHash) {
    return this.ctx.get(contextHash)?.tree.size() ?? 0;
  }
  root(contextHash) {
    return this.ctx.get(contextHash)?.tree.root() ?? this.emptyRoot;
  }
  commitments(contextHash) {
    return this.ctx.get(contextHash)?.tree.commitments ?? [];
  }
}
