// Build a DML snapshot from a BLOCK-BOUND read, gated on ChainLock.
//
// WHY THIS EXISTS ALONGSIDE buildSnapshot
//
// The existing read calls `masternodelist json`, which returns the list at the node's current tip and
// says nothing about which block it describes. That forced the bracket-and-retry in snapshot.js, and
// left a residual that bracketing cannot close: an A -> B -> A reorg entirely inside one read window
// looks identical to no reorg at all, so the signed block hash can name one branch while the list came
// from the other.
//
// `protx diff` names the block hash it describes. So the read stops being "the list, plus a hope about
// which block it came from" and becomes "the list this node SAYS is at this block", which the caller
// can compare against a hash it chose in advance.
//
// WHAT THAT IS AND IS NOT WORTH, stated precisely, because an earlier version of this comment claimed
// it closed the residual outright and that is false.
//
// Against an HONEST node it closes the A -> B -> A ambiguity, which is a real gain: an accidental
// reorg inside the read window now produces a mismatch and a refusal instead of a silently torn
// snapshot. That is the failure the old bracketing could not detect at all.
//
// Against a DISHONEST OR BUGGY node it closes nothing. One server answers the ChainLock query,
// `known_block`, `diff.blockHash`, AND `mnList`. It can return matching hashes alongside an arbitrary
// list, and reading the lock first does not stop the same server choosing both answers. This is a
// TRUSTED-NODE read, not a chain-authenticated one, and the pinned signer trust it was meant to
// replace is still doing work until the commitment check exists.
//
// The commitment check is what would make it chain-authenticated: verify the header, verify the
// coinbase inclusion proof, decode `merkleRootMNList`, rebuild the simplified-list commitment from
// these entries, and compare. `protx diff` already carries the coinbase transaction and its merkle
// branch, so the material is here, and none of it is verified yet.
//
// CHAINLOCK IS THE GATE, and it is doing real work rather than being belt-and-braces. A ChainLocked
// block cannot be reorged away, so pinning the read to one removes the reorg question entirely rather
// than narrowing it. Waiting one confirmation does NOT achieve this and is not a substitute.
//
// LEAF ORDERING CHANGES, AND THAT CHANGES THE ROOT. The old read ordered leaves by the collateral
// outpoint, because that is what keys `masternodelist json`. The collateral outpoint is not a field of
// the DIP4 simplified entry (it is not committed on chain), so it is absent here, and the canonical
// order for these entries is `proRegTxHash`. Aligning with DIP4's own order is the right direction,
// since the eventual commitment check merkleizes in exactly that order, but the same set of
// masternodes now produces a DIFFERENT root. That is a version bump and a transition, not a drop-in.
import { votingAddressToLeaf } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { makeShaDmlRootHasher, leafToKeyId } from "../common/dml_sha_root.js";

export const TREE_DEPTH = 16;

// The fields this build reads from a simplified entry, named here so a node whose response shape
// differs fails loudly at the boundary rather than silently producing a short or wrong leaf set.
const REQUIRED_ENTRY_FIELDS = ["proRegTxHash", "votingAddress", "isValid"];

export async function buildDiffSnapshot({
  call,
  depth = TREE_DEPTH,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  // 1. The best ChainLock. This is the block the read is pinned to, chosen BEFORE the list is read so
  //    the node cannot pick a convenient one.
  const lock = await call("getbestchainlock", []);
  const lockedHash = lock?.blockhash;
  const lockedHeight = lock?.height;
  if (typeof lockedHash !== "string" || !Number.isInteger(lockedHeight)) {
    throw new Error(
      "oracle: getbestchainlock did not return a block hash and height. A ChainLock is what makes this " +
        "read safe from reorgs, so there is no degraded mode here.",
    );
  }
  // A node that reports a ChainLock it has not verified is not usable for this. `known_block` is
  // Core's own statement that it has the block the lock names.
  if (lock.known_block === false) {
    throw new Error(
      `oracle: the node reports a ChainLock at ${lockedHeight} for a block it does not have. It is ` +
        `still syncing, so its masternode list cannot be trusted to describe that block.`,
    );
  }

  // 2. The list AT that block. baseBlock 1 asks for everything rather than a delta.
  const diff = await call("protx", ["diff", 1, lockedHeight]);

  // 3. THE BLOCK-BOUND CHECK, which is the whole point. The response says which block it describes,
  //    and it must be the one chosen above. A tip that moved, a branch swap, or a node answering from
  //    a different chain all fail here rather than being papered over by a retry.
  if (String(diff?.blockHash) !== String(lockedHash)) {
    throw new Error(
      `oracle: protx diff described block ${diff?.blockHash} but the ChainLock names ${lockedHash}. ` +
        `Refusing rather than publishing a list that may belong to another branch.`,
    );
  }

  const mnList = diff?.mnList;
  if (!Array.isArray(mnList)) {
    throw new Error("oracle: protx diff returned no mnList array");
  }

  // 4. isValid IS the validity filter here, and it is part of the on-chain commitment. A PoSe-banned
  //    node is still IN the list carrying isValid false, so membership alone is not validity. This is
  //    the same set the old read selected with status ENABLED.
  const valid = mnList.filter((m) => {
    for (const f of REQUIRED_ENTRY_FIELDS) {
      if (!(f in (m ?? {}))) {
        throw new Error(
          `oracle: a protx diff entry is missing ${f}. This build needs it, and guessing at a partial ` +
            `entry is how a leaf set silently loses or gains a member.`,
        );
      }
    }
    return m.isValid === true;
  });

  // 5. Canonical DIP4 order, by proRegTxHash. Every honest reader builds the same tree, and it is the
  //    order the on-chain commitment merkleizes in.
  valid.sort((a, b) => (String(a.proRegTxHash) < String(b.proRegTxHash) ? -1 : 1));

  const realLeaves = valid.map((m) => {
    const leaf = votingAddressToLeaf(m.votingAddress);
    // The empty-leaf value pads unused slots, so a real leaf equal to it would vanish from the
    // inclusion boundary. Unreachable for an honest hash160, so it means corrupted or crafted input.
    if (leaf === 0n) {
      throw new Error(`oracle: voting address for ${m.proRegTxHash} decodes to the empty-leaf value`);
    }
    return leaf;
  });

  const rootFromLeaves = await makeDmlRootHasher(depth);
  const shaRootFromKeyIds = makeShaDmlRootHasher(depth);
  const leaves = realLeaves.map((x) => x.toString());

  log(`[oracle] chainlocked height ${lockedHeight}, ${leaves.length} valid nodes, block-bound read`);

  return {
    // v3: a block-bound, ChainLock-gated read ordered by proRegTxHash. The version exists because the
    // ORDER changed, so a v3 root differs from a v2 root over the identical set of masternodes. A
    // gateway must not treat the two as interchangeable.
    version: 3,
    height: lockedHeight,
    blockHash: lockedHash,
    depth,
    ts: now(),
    root: rootFromLeaves(leaves),
    shaRoot: shaRootFromKeyIds(realLeaves.map((x) => leafToKeyId(x))),
    leaves,
    // What this snapshot's ordering and validity claims rest on, recorded rather than implied, so a
    // verifier reading the JSON alone can tell which rules produced this leaf set.
    order: "proRegTxHash",
    chainlocked: true,
  };
}
