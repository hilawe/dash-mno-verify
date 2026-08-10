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
import { buildPoseidon } from "circomlibjs";
import { MembersTree } from "./members_tree.js";
import { RootStore } from "./stores.js";

export class SeasonMembers {
  // emptyRoot is the all-empty depth-16 members root, computed once by the caller (the gateway uses
  // its fast hasher, which returns it in O(1)). It is what an empty context serves WITHOUT building
  // and caching a 2**16 tree, so an attacker cannot force unbounded expensive tree builds by varying
  // the context on an unauthenticated read.
  // `monotonic` refuses a backward season roll. The gateway sets it, because its clock is guarded
  // and going back would revive lapsed registrations; it is off by default so the rebuild-from-
  // durable-records property stays directly testable.
  // `treeDepth` exists so the capacity boundary can be exercised at a small depth; production uses
  // the MembersTree default, which is the depth the circuits are compiled for.
  constructor({ store, rootWindow, nowSec, emptyRoot, monotonic = false, treeDepth, seasonNow = null, clockRegressed = null }) {
    this.store = store;
    this.monotonic = monotonic;
    this.treeDepth = treeDepth;
    this.rootWindow = rootWindow;
    this.nowSec = nowSec;
    // The AUTHORITATIVE season, read from the guarded clock rather than from this object's cache.
    // `current` only changes when an ensure() runs, and the background rollover runs once a minute,
    // so a commit that compares against the cache alone can append to a season wall time has already
    // left. Optional so the unit tests that drive rollovers explicitly keep working unchanged.
    this.seasonNow = seasonNow;
    // Whether the guarded clock has seen a backward step. A registration writes a durable record
    // scoped to a season number, so committing one while the clock is not trusted writes state
    // under a numbering that may be wrong. Optional, so a unit test that drives seasons explicitly
    // is unaffected.
    this.clockRegressed = clockRegressed;
    this.emptyRoot = emptyRoot;
    this.emptyRoots = new RootStore(rootWindow);
    this.emptyRoots.update([{ height: 0, root: emptyRoot, ts: nowSec() }]);
    this.current = null; // current season number, or null before the first ensure()
    this.ctx = new Map(); // contextHash -> { tree, roots }, only contexts that have durable records
    this._op = Promise.resolve(); // the serialization queue, see ensure()/ensureContext()/commit()
  }

  // ONE POSEIDON FOR THE WHOLE SEASON MANAGER, built on first use and reused for every tree it
  // materializes. buildPoseidon() is expensive and was being paid per tree: twenty trees cost 4.8
  // seconds with fresh instances against 40 milliseconds with one shared, a 120x difference measured
  // here. The injectable parameter existed and production simply never passed it, so a comment
  // claiming the seam "lets callers stop paying buildPoseidon per tree" was describing a benefit
  // nothing collected. A reviewer with execution access found that by timing it; reading the code
  // shows the parameter exists, not that nobody uses it.
  async #poseidon() {
    if (!this._poseidon) this._poseidon = await buildPoseidon();
    return this._poseidon;
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
    // Under `monotonic`, never roll backwards. The gateway's TimeGuard already refuses to serve on a
    // backward clock, so reaching here with an earlier season means something bypassed it, and
    // rebuilding a past season's trees would revive registrations meant to have lapsed. Staying put
    // is the safe direction: it serves a root nobody can prove against rather than one that grants
    // access. It is off by default because rebuilding an arbitrary season from the durable records is
    // a real property of this class (the tree is a cache, not the source of truth) and is worth
    // exercising directly; only the gateway, which owns a monotonic clock, turns it on.
    if (this.monotonic && this.current != null && season < this.current) {
      throw new Error(`refusing to roll the members tree back from season ${this.current} to ${season}`);
    }
    if (this.current !== season) {
      this.ctx.clear();
      this.current = season;
    }
  }

  // Build and cache the context tree from the given records, in insertion order. Caller must hold
  // the serial queue. Building a 2**16 tree is expensive, so this runs only for a context that has
  // records or is about to gain one (a commit), never for an arbitrary empty context.
  async _materializeFrom(contextHash, records) {
    const tree = this.treeDepth
      ? await MembersTree.fromCommitments(records.map((r) => r.commitment), this.treeDepth, await this.#poseidon())
      : await MembersTree.fromCommitments(records.map((r) => r.commitment), undefined, await this.#poseidon());
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

  // Rebuild a context's tree from durable records, KEEPING the context's existing RootStore rather than
  // starting a fresh one. The difference from _materializeFrom matters: _materializeFrom builds a new
  // RootStore for a first materialization, where there is no prior window to keep, but a mid-season
  // reconciliation (recoverMember below) runs while a context has already served roots to challenges. A
  // fresh store would discard those roots, so a challenge minted against a still-live root would be
  // refused and an in-flight verification holding the store object would read it as a season rollover.
  // Reusing the existing store and appending the new root retains prior roots up to the window and keeps
  // the object identity, so neither happens. Caller must hold the serial queue.
  async _rebuildTreePreservingRoots(contextHash, records) {
    const existing = this.ctx.get(contextHash);
    const tree = this.treeDepth
      ? await MembersTree.fromCommitments(records.map((r) => r.commitment), this.treeDepth, await this.#poseidon())
      : await MembersTree.fromCommitments(records.map((r) => r.commitment), undefined, await this.#poseidon());
    const roots = existing ? existing.roots : new RootStore(this.rootWindow);
    roots.update([{ height: tree.size(), root: tree.root(), ts: this.nowSec() }]);
    const c = { tree, roots };
    this.ctx.set(contextHash, c);
    return c;
  }

  // Reconcile a context's cached members tree with its durable records. The tree is a cache, and within
  // a running season a durable registration can end up ABSENT from it: the A2 strand, where a first
  // commit's durable write held while its confirming reread failed, so append rejected, commit's tree
  // append was skipped, and the retry then short-circuits at the store's duplicate check (verifier.js,
  // registrationStore.has) BEFORE commit() runs, so nothing rebuilds the cache until a rollover or
  // restart. This is the mid-season rebuild that strand needs, triggered from the verifier's
  // already-registered path. It rebuilds ONLY when the cache is behind the durable records, preserving
  // the root window, and it never re-verifies a proof, since the durable record is the authority that a
  // proof already established.
  // The rebuild-if-behind core, shared by recoverMember (which wraps it in the serial queue) and by
  // commit's duplicate branch (already inside the queue). A commit only ever appends, never removes, so
  // the cache is behind exactly when it holds fewer members than the durable records; an unmaterialized
  // context with durable records (size 0) is behind too. Anything else needs no rebuild, so an ordinary
  // replay pays only one durable read. Rebuilds preserve the root window. Caller MUST hold the serial
  // queue and have confirmed the season is current.
  async _reconcileIfBehind(contextHash) {
    const records = await this.store.forSeasonContext(this.current, contextHash);
    const cachedSize = this.ctx.get(contextHash)?.tree.size() ?? 0;
    if (records.length > cachedSize) {
      await this._rebuildTreePreservingRoots(contextHash, records);
      return true;
    }
    return false;
  }

  recoverMember(season, contextHash) {
    season = Number(season);
    return this._serial(async () => {
      // DO NOT ROLL. Recovery must never drive the cache backward: a rollover queued ahead of this call
      // may have advanced the cache past this request's season while it waited, and _roll(oldSeason)
      // would throw under monotonic (a re-review reproduced that surfacing as a misleading HTTP 400). If
      // the cache season no longer matches, the member's season has ended and there is nothing to recover
      // into the live tree, so answer season-rolled rather than rolling or throwing.
      if (this.current !== season) return { rebuilt: false, reason: "season-rolled" };
      const rebuilt = await this._reconcileIfBehind(contextHash);
      return { rebuilt, size: this.ctx.get(contextHash)?.tree.size() ?? 0 };
    });
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
  commit(season, contextHash, commitment, appendDurable, regNullifier) {
    season = Number(season);
    return this._serial(async () => {
      if (this.current !== season) return { ok: false, reason: "season-rolled-retry" };
      let c = await this._materialize(contextHash);
      // RECONCILE THE CACHE BEFORE IT IS USED FOR CAPACITY OR POSITION. The members tree is a cache that
      // can lag the durable records (the A2 strand: a prior commit's durable write held while its commit
      // threw before the tree append). A commit that appends onto a lagging cache assigns the commitment a
      // tree position BELOW the durable index the store hands back, so the served tree and a restart
      // rebuild diverge, and the capacity guard under-counts. A third-round review reproduced both. So
      // reconcile first (rebuilding only on a real deficit and preserving the root window), which also
      // recovers a member a concurrent retry stranded, then re-acquire the context because the rebuild
      // replaces the object. See docs/MEMBERS_TREE_RECONCILIATION.md.
      await this._reconcileIfBehind(contextHash);
      c = this.ctx.get(contextHash) ?? c;
      // A DURABLE DUPLICATE NEEDS NO SLOT AND NO WRITE. Checked by the registration nullifier, the SAME
      // identity RegistrationStore.has() and the durable append use, so it catches a retry regardless of
      // the commitment it carries and does NOT mistake a distinct registration that happens to share a
      // member secret (a different nullifier, same commitment) for a duplicate. A fifth-round review found
      // that an earlier commitment-based form did both. Running it before the capacity check and the
      // durable write means a retry at the full-tree boundary, or one whose anchor aged while it waited in
      // the queue, is answered already-registered rather than members-tree-full or stale-or-unknown-root.
      // Read-only: it creates no durable record. Guarded on regNullifier being supplied, so a caller that
      // omits it falls through to the durable append's own duplicate signal, as before.
      if (regNullifier != null && (await this.store.has(this.current, contextHash, regNullifier))) {
        return { ok: false, reason: "already-registered" };
      }
      // Capacity is checked BEFORE the durable write, because the durable record is the commit
      // point. Writing it first and then failing to append would leave a bucket that can never be
      // materialized again, so the order here is the whole point of the check.
      if (c.tree.full()) {
        return { ok: false, reason: "members-tree-full", capacity: c.tree.capacity() };
      }
      // RE-READ THE CLOCK HERE, immediately before the durable write and after every await above.
      // The cached check at the top compares the caller's season with this object's CACHE, and the
      // cache only moves when an ensure() runs, with the background rollover firing once a minute,
      // so a registration that started before a boundary and finished after it passed and appended a
      // record for a season that had ended. Two reviewers reproduced that independently.
      //
      // The position matters as much as the check. A first draft put this before
      // `_materialize()`, which itself awaits and can take seconds on a first-use context, so the
      // season could end inside that await and the guard would have looked correct while proving
      // nothing. The durable record is the commit point, so the check belongs against it and
      // nothing else. Refusing costs the caller a retry.
      if (this.seasonNow != null) {
        const live = Number(this.seasonNow());
        if (live !== season) return { ok: false, reason: "season-rolled-retry", live };
      }
      // AND the clock has to be trustworthy at all. seasonNow() above observes both periods, so by
      // this point a backward step of either kind has been seen; this is what acts on it. Without it
      // a regression that moved the epoch but not the season passed every check here and the record
      // was written under a numbering the gateway had already stopped trusting.
      if (this.clockRegressed != null && this.clockRegressed()) {
        return { ok: false, reason: "clock-regressed" };
      }
      const res = await appendDurable();
      if (res.duplicate) {
        // A duplicate means this registration is already durable. The reconcile above ran before this
        // write, so a member a concurrent retry stranded (its record durable, its commit thrown before
        // the tree append) is already back in the tree by now, and this branch just reports the replay.
        return { ok: false, reason: "already-registered" };
      }
      // A bucket bound to a different (engine, statement), or an impossible engine/statement pair:
      // no durable record was written, so nothing is appended to the tree either.
      if (res.conflict) return { ok: false, reason: "statement-mismatch", declared: res.declared };
      if (res.invalid) return { ok: false, reason: "invalid-engine-statement" };
      // The durable writer refused because the anchor stopped being eligible while this commit
      // waited in the queue. No record was written, so nothing is appended to the tree either.
      if (res.staleRoot) return { ok: false, reason: "stale-or-unknown-root" };
      // FAIL CLOSED ON AN UNRECOGNISED RESULT. Every branch above names a refusal, and what follows
      // mutates the tree, so a result shape this function does not understand must not fall through
      // into the append: that is how a tree gains a member with no durable record behind it, which
      // no rebuild can reproduce and nothing can revoke.
      if (!Number.isInteger(res.index)) {
        return { ok: false, reason: "durable-write-unrecognised" };
      }
      // THE DURABLE INDEX AND THE TREE POSITION MUST AGREE. After the reconcile above the tree holds every
      // durable record that predates this write, so the count the store assigned (res.index) equals the
      // tree size. If they ever diverge, fail closed rather than appending at a slot a restart would
      // rebuild differently, the leaf-order divergence the reconcile exists to prevent.
      if (res.index !== c.tree.size()) {
        return { ok: false, reason: "index-tree-mismatch" };
      }
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
    // A COPY. This used to hand out the tree's own array, which was harmless while the root was
    // recomputed from it on every read: an out-of-band mutation was picked up by the next rebuild.
    // The root is now cached and maintained only by append(), so a caller that sorted or spliced
    // this array would leave /v1/members returning a commitment list that does not hash to the
    // membersRoot in the same response, every prover-built path would fail with no error anywhere,
    // and only a restart would reconcile it. Two reviewers reached this independently. No caller
    // mutates it today; the copy is what stops the next one from having to know that.
    return [...(this.ctx.get(contextHash)?.tree.commitments ?? [])];
  }
}
