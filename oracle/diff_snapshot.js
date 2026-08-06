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
// Against a BUGGY node, the commitment check below now closes most of it. The list is rebuilt into
// the DIP4 simplified-list commitment and compared against the `merkleRootMNList` carried in the
// block's own coinbase, the coinbase is checked against the merkle branch, and the branch against the
// header. A node whose list does not match what the block committed to is refused.
//
// Against a DISHONEST node, most of it is now closed too. The header is hashed with X11 and must equal
// the block hash the ChainLock named, so the header is the block the node claimed rather than one it
// assembled, and the hash must meet the proof of work the header's own target declares, so inventing a
// block costs mining rather than nothing.
//
// TWO RESIDUALS REMAIN, both narrow and both stated where they are relied on. The target is read from
// the header, so the work proven is work against the difficulty that header claims, not against the
// difficulty the network was at, and a node willing to mine could offer a low-difficulty header.
// Ruling that out means following the header chain to judge the difficulty, which is a light client,
// or verifying the ChainLock signature against the signing quorum. And a node can REPLAY a real old
// block, which passes every check here because it is real; the coinbase height is compared against the
// ChainLock height, but both come from the same node in one read, so that catches an inconsistent
// replay rather than a consistent one.
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
//
// THE TWO ORDERS ARE BOTH BY proRegTxHash AND THEY ARE NOT THE SAME ORDER, which an earlier version
// of this comment ran together. The leaves below are sorted on the DISPLAYED hex, and the on-chain
// commitment in dml_commitment.js sorts on the INTERNAL bytes, which are that hex reversed. Both are
// deterministic and every honest reader reproduces either one, so the tree here is well defined, but
// a reader who assumes the leaf index matches the position in the DIP4 commitment gets a different
// index for nearly every member. The membership proof does not depend on the two agreeing.
import { votingAddressToLeaf } from "../common/dml.js";
import { verifyDmlCommitment } from "./dml_commitment.js";
import { blockHashFromHeader } from "../common/x11/index.js";
import { meetsProofOfWork } from "./proof_of_work.js";
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
  // Check the list against the commitment the block's coinbase carries. On by default, in the same
  // style as every other guard here: a read that skips it is a read that believed the node's list on
  // the node's word. A caller turns it off only to exercise a different boundary, which is what the
  // tests that do so are doing.
  verifyCommitment = true,
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
    // A primitive entry used to reach the `in` operator below and fail with a raw TypeError, which
    // fails closed but does not say the node's response shape was the problem. A null entry falls
    // through to the missing-field refusal, which already names what is absent.
    if (m != null && typeof m !== "object") {
      throw new Error(`oracle: a protx diff entry is ${JSON.stringify(m)}, not an object`);
    }
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
  // 4b. THE ON-CHAIN COMMITMENT, checked over the WHOLE list before anything is filtered out of it.
  //     The coinbase commits to every entry, valid and invalid alike, so verifying the survivors of
  //     the isValid filter would be verifying a different set than the one the chain committed to and
  //     would fail on every real block.
  //
  //     What this establishes and what it does not is spelled out in oracle/dml_commitment.js, and the
  //     short version belongs here too, because a reader of this file is deciding how much to trust
  //     the result. It proves the list, the coinbase, and the header agree with one another, and the
  //     header check below proves the header is the block the ChainLock named and that real work went
  //     into it.
  if (verifyCommitment) {
    const header = await call("getblockheader", [lockedHash, false]);
    if (typeof header !== "string" || !/^[0-9a-f]+$/i.test(header)) {
      throw new Error(
        `oracle: getblockheader returned ${typeof header === "string" ? "a non-hex string" : typeof header}, ` +
          `and the commitment cannot be checked without the header the list is supposed to belong to.`,
      );
    }
    // The two commitment artefacts get the same boundary treatment as every other field of this
    // response. Without it a missing cbTx surfaced as a raw TypeError from the parser, which fails
    // closed but does not say the node's response shape was the problem, the norm this file sets
    // everywhere else.
    for (const [name, value] of [["cbTx", diff?.cbTx], ["cbTxMerkleTree", diff?.cbTxMerkleTree]]) {
      if (typeof value !== "string" || value.length === 0 || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
        throw new Error(
          `oracle: protx diff returned a ${value === undefined ? "missing" : "malformed"} ${name}, and the ` +
            `commitment cannot be checked without it.`,
        );
      }
    }
    // 4c. THE HEADER IS THE BLOCK THE CHAINLOCK NAMED, which is what the rest of this rests on.
    //     Everything above establishes that the list, the coinbase, and this header agree with each
    //     other. Agreeing with each other is cheap: a node can build a header, a coinbase, and a list
    //     that agree in the time it takes to hash them. What is not cheap is making a header whose
    //     X11 hash is a particular value, and that is the check here.
    const named = blockHashFromHeader(header);
    if (named !== lockedHash) {
      throw new Error(
        `oracle: the header the node returned for ${lockedHash} hashes to ${named}. A block is named by ` +
          `the X11 hash of its header, so this is not that block, whatever the node called it.`,
      );
    }

    // 4d. AND REAL WORK WENT INTO IT. Naming the block only says the header is self-consistent with
    //     the hash claimed for it, and a node is free to invent a header and claim its hash. Proof of
    //     work is what makes inventing one expensive: the hash has to fall below the target the
    //     header itself declares.
    //
    //     WHAT THIS DOES NOT ESTABLISH, and it is the residual that remains after all of the above.
    //     The target is read from the header, so the work proven is work against the difficulty THIS
    //     header claims, not against the difficulty the network was actually at. A node willing to
    //     mine could produce a low-difficulty header that passes. Ruling that out means either
    //     following the header chain to judge the difficulty (a light client, and a much larger
    //     piece of work) or verifying the ChainLock signature against the signing quorum. Neither is
    //     started, and a difficulty floor is a configuration decision rather than something to invent
    //     a default for here, since Dash retargets every block and a floor set too high refuses
    //     legitimate blocks.
    //
    //     A node can also REPLAY a real old block, which passes every check here because it is real.
    //     The height the coinbase names is compared against the ChainLock's height below, and both
    //     come from the same node in the same read, so that comparison catches an inconsistent replay
    //     and not a consistent one.
    if (!meetsProofOfWork(header)) {
      throw new Error(
        `oracle: the header for ${lockedHash} does not meet the proof of work its own target declares. ` +
          `A real block cannot fail this, so the node is serving something that was never mined.`,
      );
    }

    const proof = verifyDmlCommitment({
      mnList,
      cbTx: diff?.cbTx,
      cbTxMerkleTree: diff?.cbTxMerkleTree,
      blockHeader: header,
    });
    // The coinbase names the height it was mined at, and it must be the height the ChainLock named.
    //
    // WHAT THIS CATCHES IS THE INCONSISTENT REPLAY, and the distinction matters because an earlier
    // version of this comment claimed more. It catches an old coinbase served under a current
    // ChainLock, which is the mismatch a partly-stale node produces. It does NOT catch a node that
    // moves BOTH: answering getbestchainlock with an old block and then serving that same old block's
    // list, coinbase, and header is internally consistent at every check here, including this one,
    // because both operands come from the same node in the same read. That residual is the same
    // trusted-node residual as the header, and it closes with the same work.
    if (Number(proof.height) !== Number(lockedHeight)) {
      throw new Error(
        `oracle: the coinbase commits to height ${proof.height} but the ChainLock names ${lockedHeight}. ` +
          `Refusing rather than publishing a list from a different block.`,
      );
    }
    log(`[oracle] commitment verified: ${proof.entries} entries hash to ${proof.merkleRootMNList}, committed by the coinbase of block ${lockedHeight}`);
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
    //
    // THE COMMITMENT CHECK IS DELIBERATELY NOT RECORDED HERE. Saying "this list was checked against
    // the block's coinbase" in the artefact was the obvious next step and it is the wrong one: the
    // signed message (common/oracle_sig.js) covers a fixed set of fields, so a claim added beside
    // them travels unauthenticated, and a consumer that trusted it would be trusting whoever served
    // the file rather than whoever signed it. A field that says a security check happened, which
    // anyone can flip, is worse than no field. Recording it properly means extending the signed
    // message, which is a format change and a decision of its own.
    order: "proRegTxHash",
    chainlocked: true,
  };
}
