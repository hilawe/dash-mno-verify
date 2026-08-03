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
  // Core's own statement that it has the block the lock names, and only boolean true is that
  // statement. An absent or mistyped field is NOT the statement, so it refuses too: the old check
  // tested only `=== false`, which treated a missing field as an affirmation. These checks run
  // before the hash-shape check on purpose, so a syncing node is diagnosed as syncing, the specific
  // and actionable fact, rather than as whatever else is also wrong with its answer.
  if (lock.known_block === false) {
    throw new Error(
      `oracle: the node reports a ChainLock at ${lockedHeight} for a block it does not have. It is ` +
        `still syncing, so its masternode list cannot be trusted to describe that block.`,
    );
  }
  if (lock.known_block !== true) {
    throw new Error(
      `oracle: getbestchainlock returned known_block ${JSON.stringify(lock.known_block)}. Only boolean ` +
        `true says the node has verified the locked block, so anything else refuses.`,
    );
  }
  // The hash this whole read pins to must be a well-formed block hash, in the lowercase hex Core
  // emits. It becomes the snapshot's signed blockHash and the comparison anchor below, so a
  // malformed one would thread through everything downstream. (lockedHash is already known to be a
  // string, the first guard above refuses anything else, so the regex is testing shape, not type.)
  if (!/^[0-9a-f]{64}$/.test(lockedHash)) {
    throw new Error(`oracle: getbestchainlock returned a malformed block hash: ${JSON.stringify(lockedHash)}`);
  }

  // 2. The list AT that block. baseBlock 1 asks for everything rather than a delta.
  const diff = await call("protx", ["diff", 1, lockedHeight]);

  // 3. THE BLOCK-BOUND CHECK, which is the whole point. The response says which block it describes,
  //    and it must be the one chosen above. A tip that moved, a branch swap, or a node answering from
  //    a different chain all fail here rather than being papered over by a retry. The type is checked
  //    before the comparison because the old String() coercion let a singleton array containing the
  //    right hash compare equal, so a mistyped response could pass the one check this read is for.
  if (typeof diff?.blockHash !== "string") {
    throw new Error(
      `oracle: protx diff blockHash is ${diff?.blockHash === null ? "null" : typeof diff?.blockHash}, ` +
        `not a string. A response that cannot state its block plainly is not a block-bound answer.`,
    );
  }
  if (diff.blockHash !== lockedHash) {
    throw new Error(
      `oracle: protx diff described block ${diff.blockHash} but the ChainLock names ${lockedHash}. ` +
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
  // Every entry is validated BEFORE the validity filter, so the boundary judges the list the node
  // actually sent, not the survivors of a filter. A first version checked duplicates after
  // filtering, which let a duplicate pair slip through when one copy was invalid.
  //
  // Presence is not shape, so a mistyped field refuses rather than coercing. Each has its own
  // failure mode when coerced: an isValid of "true" (a string) fails the strict filter below and
  // silently DROPS a valid masternode from the tree, a non-string proRegTxHash makes the sort order
  // undefined, and a non-string votingAddress fails later with an error that does not say the
  // node's response shape was the problem.
  const seenHashes = new Set();
  for (const m of mnList) {
    for (const f of REQUIRED_ENTRY_FIELDS) {
      if (!(f in (m ?? {}))) {
        throw new Error(
          `oracle: a protx diff entry is missing ${f}. This build needs it, and guessing at a partial ` +
            `entry is how a leaf set silently loses or gains a member.`,
        );
      }
    }
    if (typeof m.proRegTxHash !== "string" || !/^[0-9a-f]{64}$/.test(m.proRegTxHash)) {
      throw new Error(
        `oracle: a protx diff entry has a malformed proRegTxHash: ${JSON.stringify(m.proRegTxHash)}. ` +
          `It must be 64 lowercase hex, the transaction id the canonical order sorts by.`,
      );
    }
    if (typeof m.votingAddress !== "string") {
      throw new Error(`oracle: entry ${m.proRegTxHash} has a non-string votingAddress`);
    }
    if (typeof m.isValid !== "boolean") {
      throw new Error(
        `oracle: entry ${m.proRegTxHash} has isValid ${JSON.stringify(m.isValid)}, not a boolean. ` +
          `Coercing would silently drop a valid member or admit a banned one.`,
      );
    }
    // One masternode listed twice has no canonical order and no honest cause, whatever the two
    // copies claim about their validity.
    if (seenHashes.has(m.proRegTxHash)) {
      throw new Error(`oracle: protx diff lists proRegTxHash ${m.proRegTxHash} twice`);
    }
    seenHashes.add(m.proRegTxHash);
  }
  const valid = mnList.filter((m) => m.isValid === true);

  // 5. Canonical DIP4 order, by proRegTxHash. Every honest reader builds the same tree, and it is the
  //    order the on-chain commitment merkleizes in. The entries are validated, deduplicated 64-hex
  //    strings by the boundary above, so the comparison is total.
  valid.sort((a, b) => (a.proRegTxHash < b.proRegTxHash ? -1 : a.proRegTxHash > b.proRegTxHash ? 1 : 0));

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
