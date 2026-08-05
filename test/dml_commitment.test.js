// The on-chain commitment to the masternode list, checked against captured mainnet blocks.
//
// These vectors are real. `test/vectors/dml_commitment_mainnet_1028162.json` is a whole `protx diff`
// response plus the block header, 14 entries at a height where every entry was still nVersion 1 and
// nType 0, so the complete chain (list to coinbase to merkle branch to header) fits in the
// repository. `test/vectors/sml_entry_serialization.json` carries one entry of each other shape from
// the chain tip, where the list is 2,971 entries and far too large to commit; those entries take
// part in the root that build reproduced, which is what makes their expected bytes authoritative
// rather than a restatement of this implementation.
//
// WHAT THESE TESTS DO NOT ESTABLISH, said here so a reader of the suite is not misled: nothing here
// proves a header belongs to the chain. A Dash block is identified by its X11 hash and this build
// implements no X11, so a fabricated header, coinbase, and list that agree with each other satisfy
// every assertion below. The module says the same in its own header comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import bs58check from "bs58check";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cbTxCommitment,
  headerMerkleRoot,
  merkleRootFromLeaves,
  partialMerkleTree,
  serviceBytes,
  smlEntryBytes,
  smlMerkleRoot,
  verifyDmlCommitment,
  votingKeyId,
} from "../oracle/dml_commitment.js";

const vector = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./vectors/${name}`, import.meta.url)), "utf8"));
const BLOCK = vector("dml_commitment_mainnet_1028162.json");
const ENTRIES = vector("sml_entry_serialization.json");

test("a real mainnet block: the list, the coinbase, and the header all agree", () => {
  const r = verifyDmlCommitment({
    mnList: BLOCK.mnList,
    cbTx: BLOCK.cbTx,
    cbTxMerkleTree: BLOCK.cbTxMerkleTree,
    blockHeader: BLOCK.blockHeader,
  });
  assert.equal(r.merkleRootMNList, BLOCK.merkleRootMNList, "the root came from the coinbase and matches the one the node reported");
  assert.equal(r.height, BLOCK.height, "and the coinbase names the height the response was taken at");
  assert.equal(r.entries, 14);
  assert.equal(r.headerIdentityVerified, false, "the result does not claim the header was checked against a block hash, because it was not");
});

test("the root is taken from the COINBASE, not from the field the node also reports", () => {
  // The whole point of parsing the coinbase is that the top-level field is what the node says while
  // the coinbase is what the chain enforces. A node that reports one and commits to another is the
  // case this catches, so the check must not be satisfied by the reported field.
  const lying = { ...BLOCK, merkleRootMNList: "00".repeat(32) };
  const r = verifyDmlCommitment({
    mnList: lying.mnList,
    cbTx: lying.cbTx,
    cbTxMerkleTree: lying.cbTxMerkleTree,
    blockHeader: lying.blockHeader,
  });
  assert.equal(r.merkleRootMNList, BLOCK.merkleRootMNList, "the reported field was ignored entirely");
});

test("a list that does not hash to the coinbase commitment is refused", () => {
  // One entry's validity flipped. Nothing else changes, so this is exactly the shape of a node
  // serving a list that is not the one the block committed to.
  const tampered = BLOCK.mnList.map((e, i) => (i === 3 ? { ...e, isValid: !e.isValid } : e));
  assert.throws(
    () => verifyDmlCommitment({ mnList: tampered, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree, blockHeader: BLOCK.blockHeader }),
    /does not match the coinbase commitment/,
  );

  // And a list missing an entry, which is how a node would hide a masternode from the set.
  const shortened = BLOCK.mnList.slice(0, BLOCK.mnList.length - 1);
  assert.throws(
    () => verifyDmlCommitment({ mnList: shortened, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree, blockHeader: BLOCK.blockHeader }),
    /does not match the coinbase commitment/,
  );

  // And an ADDED entry, which is how a node would smuggle one in. Built from a real entry so the
  // shape is one the serializer accepts and only the membership is wrong.
  const withExtra = [...BLOCK.mnList, { ...BLOCK.mnList[0], proRegTxHash: "ff".repeat(32) }];
  assert.throws(
    () => verifyDmlCommitment({ mnList: withExtra, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree, blockHeader: BLOCK.blockHeader }),
    /does not match the coinbase commitment/,
  );
});

test("a coinbase that is not the one the branch marks, or a header the branch does not reproduce, is refused", () => {
  // The branch proves SOME transaction is in the block. Without checking that the matched leaf is the
  // coinbase supplied, a node could prove an unrelated transaction and hand over any coinbase it
  // liked, so this case has to reach that check and no other.
  //
  // THE TAMPERED COINBASE MUST STILL SATISFY THE COMMITMENT CHECK, or it throws one check too early
  // and proves nothing about this one. A first version of this test flipped the last byte, which sits
  // inside the payload and changed the committed root, so it passed on the wrong error entirely. The
  // lock time is the field to move instead: it changes the transaction id while leaving the payload,
  // and therefore the commitment, exactly as it was. It sits immediately before the payload's length
  // prefix, and a version 1 payload is 38 bytes (two for its version, four for the height,
  // thirty-two for the root).
  const bytes = Buffer.from(BLOCK.cbTx, "hex");
  const lockTimeAt = bytes.length - 1 - 38 - 4;
  const moved = Buffer.from(bytes);
  moved[lockTimeAt] ^= 0xff;
  const otherCbTx = moved.toString("hex");
  assert.equal(
    cbTxCommitment(otherCbTx).merkleRootMNList,
    BLOCK.merkleRootMNList,
    "the tampered coinbase still commits to the same list, so the commitment check will pass and the matched-leaf check is what runs",
  );
  assert.notEqual(otherCbTx, BLOCK.cbTx);
  assert.throws(
    () => verifyDmlCommitment({ mnList: BLOCK.mnList, cbTx: otherCbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree, blockHeader: BLOCK.blockHeader }),
    /does not mark the supplied coinbase/,
    "a coinbase the branch does not vouch for is refused, by the check that exists for it",
  );

  // A header from a different block. The branch still reproduces its own root, which no longer
  // matches what this header commits to.
  const otherHeader = BLOCK.blockHeader.slice(0, 72) + "ffffffff" + BLOCK.blockHeader.slice(80);
  assert.throws(
    () => verifyDmlCommitment({ mnList: BLOCK.mnList, cbTx: BLOCK.cbTx, cbTxMerkleTree: BLOCK.cbTxMerkleTree, blockHeader: otherHeader }),
    /the header commits to/,
  );
});

test("every entry shape the tip contains serializes to the bytes it did when the tip was verified", () => {
  // Version 1, version 2, an evo node with its Platform fields, and an IPv6 service. The committed
  // 14-entry block is all version 1 and IPv4, so without these the version 2 and evo branches of the
  // serializer would have no coverage at all.
  //
  // THESE ARE REGRESSION LOCKS, NOT EVIDENCE. The expected bytes came from this implementation, so
  // this comparison cannot tell a right serialization from a wrong one; it can only tell a CHANGED
  // one. What makes the bytes worth locking is a run against a synced mainnet node in which these
  // entries took part in the root the block's coinbase commits to, and that run is not reproducible
  // here because the list is 2,971 entries. The vector records the height and the commands to redo it.
  // The independent evidence in this file is the 14-entry block, which CI re-derives end to end.
  assert.ok(ENTRIES.entries.length >= 3, "the vector carries the shapes the small fixture cannot");
  for (const { entry, serialized } of ENTRIES.entries) {
    assert.equal(
      smlEntryBytes(entry).toString("hex"),
      serialized,
      `entry nVersion=${entry.nVersion} nType=${entry.nType} service=${entry.service}`,
    );
  }
  // The lengths are a property of the shape, and they are what a wrong version guard would change.
  // Lengths are a property of the shape and are what a wrong version guard changes. Collected per
  // entry rather than into a map keyed by shape, because two entries here are v1/t0 and a map
  // silently kept only the last of them.
  const lengths = ENTRIES.entries.map(({ entry, serialized }) => [`v${entry.nVersion}t${entry.nType}`, serialized.length / 2]);
  const expected = { v1t0: 151, v2t0: 153, v2t1: 175 };
  for (const [shape, len] of lengths) {
    assert.equal(len, expected[shape], `${shape} serializes to ${expected[shape]} bytes`);
  }
  assert.ok(lengths.some(([s]) => s === "v2t1"), "the evo shape is present, since it is the longest branch");
  assert.ok(lengths.some(([s]) => s === "v2t0"), "and the plain version 2 shape, which adds only the type");
});

test("an operator key of the wrong length is refused before it can shift every field after it", () => {
  // A short or long key does not throw on its own. It silently moves the voting key id, the validity
  // flag, and everything after them, producing a leaf that is merely different, which surfaces only
  // as a commitment mismatch with no indication of the cause. The guard has to run BEFORE the bytes
  // are assembled, and an earlier version ran after the concatenation, where it gated nothing.
  const good = BLOCK.mnList[0];
  for (const bad of ["", "ab", "ab".repeat(47), "ab".repeat(49)]) {
    assert.throws(
      () => smlEntryBytes({ ...good, pubKeyOperator: bad }),
      /operator public key must be 96 hex characters/,
      `${bad.length / 2} bytes`,
    );
  }
  assert.equal(smlEntryBytes({ ...good, pubKeyOperator: good.pubKeyOperator }).length, 151, "and the real key still serializes");
});

test("a field that would alias another valid encoding is refused rather than masked", () => {
  // Found by an external pass. Every one of these produced VALID-LOOKING bytes identical to some
  // other legitimate entry, so the commitment silently disagreed with no indication why. Masking an
  // out-of-range integer does not reject it, it turns it into a different in-range one.
  const evo = ENTRIES.entries.find(({ entry }) => entry.nType === 1).entry;
  const v1 = BLOCK.mnList[0];

  assert.throws(() => smlEntryBytes({ ...v1, nVersion: undefined }), /nVersion undefined/, "a missing version used to serialize as version 1");
  assert.throws(() => smlEntryBytes({ ...v1, nVersion: 3 }), /This build serializes versions 1 and 2 only/, "a future version is refused, not guessed at");
  assert.throws(() => smlEntryBytes({ ...evo, nType: null }), /nType null/, "a null type used to serialize as type 0");
  assert.throws(() => smlEntryBytes({ ...evo, nType: 65536 }), /nType 65536/, "and 65536 used to serialize as type 0 too");
  assert.throws(() => smlEntryBytes({ ...evo, nType: 2 }), /This build serializes types 0 and 1 only/, "an unknown type may carry fields this build would omit");
  assert.throws(() => smlEntryBytes({ ...evo, platformHTTPPort: evo.platformHTTPPort + 65536 }), /platformHTTPPort/, "a port past 16 bits used to wrap to the same two bytes");
  assert.throws(() => smlEntryBytes({ ...v1, confirmedHash: v1.confirmedHash + "zz" }), /confirmedHash must be 64 hex/, "trailing non-hex used to be discarded silently");
  assert.throws(() => smlEntryBytes({ ...evo, platformNodeID: evo.platformNodeID.slice(0, 20) }), /platformNodeID must be 40 hex/);
  assert.throws(() => smlEntryBytes({ ...v1, isValid: "true" }), /isValid "true", not a boolean/);
});

test("the entry version decides the type field, and the type decides the Platform fields", () => {
  const evo = ENTRIES.entries.find(({ entry }) => entry.nType === 1)?.entry;
  assert.ok(evo, "the vector carries an evo entry");

  // Read as version 1, the same entry must serialize WITHOUT the type and Platform fields, because
  // consensus guards those on the entry's own version rather than on its type.
  const asV1 = smlEntryBytes({ ...evo, nVersion: 1 });
  assert.equal(asV1.length, 151);
  // Read as version 2 but a regular node, the Platform fields go away and the type stays.
  const asRegular = smlEntryBytes({ ...evo, nType: 0 });
  assert.equal(asRegular.length, 153);
  assert.notEqual(smlEntryBytes(evo).toString("hex"), asRegular.toString("hex"));
});

test("entries are ordered by the internal byte order, which is not the displayed order", () => {
  // Dash compares proRegTxHash with a memcmp over the stored bytes, and the RPC displays those bytes
  // reversed. Sorting on the displayed hex produces a different order and therefore a different
  // root, which is a defect that only shows up as a mismatch with no clue where it came from.
  const displayedOrder = [...BLOCK.mnList].sort((a, b) => (a.proRegTxHash < b.proRegTxHash ? -1 : 1));
  const asGiven = BLOCK.mnList.map((e) => e.proRegTxHash);
  assert.notDeepEqual(displayedOrder.map((e) => e.proRegTxHash), asGiven, "the fixture is not already in displayed order, so this case is real");
  // The root is computed from the set, so feeding it in a different input order must not change it.
  assert.deepEqual(smlMerkleRoot(displayedOrder), smlMerkleRoot(BLOCK.mnList), "the sort is internal to the root, not a property of the caller's order");
});

test("a duplicated registration hash is refused rather than ordered arbitrarily", () => {
  const doubled = [...BLOCK.mnList, BLOCK.mnList[0]];
  assert.throws(() => smlMerkleRoot(doubled), /twice/);
});

test("the merkle helpers behave at the shapes the tree actually reaches", () => {
  assert.equal(merkleRootFromLeaves([]).toString("hex"), "00".repeat(32), "an empty list has no commitment");
  const one = Buffer.alloc(32, 7);
  assert.equal(merkleRootFromLeaves([one]).toString("hex"), one.toString("hex"), "a single leaf is its own root");
  // An odd level duplicates its last element, which is what makes a three-leaf tree differ from a
  // four-leaf tree whose last two leaves are equal only in the parent, not in the input.
  const a = Buffer.alloc(32, 1), b = Buffer.alloc(32, 2), c = Buffer.alloc(32, 3);
  assert.deepEqual(merkleRootFromLeaves([a, b, c]), merkleRootFromLeaves([a, b, c, c]));
});

test("the coinbase parser refuses a transaction that is not a coinbase special transaction", () => {
  // Type 0 is an ordinary transaction, which carries no payload at that offset at all. Reading one
  // anyway would return whichever bytes happened to be there.
  const notSpecial = "0300" + "0000" + BLOCK.cbTx.slice(8);
  assert.throws(() => cbTxCommitment(notSpecial), /coinbase special transaction/);
  assert.throws(() => cbTxCommitment("0300"), /truncated/);
});

test("a malformed merkle branch is refused rather than reproducing an arbitrary root", () => {
  assert.throws(() => partialMerkleTree("00000000" + "00" + "00"), /covers no transactions/);
  // Extra hashes the traversal never consumes would let one serialization stand for several trees.
  const tree = BLOCK.cbTxMerkleTree;
  const nHashesAt = 8;
  const count = parseInt(tree.slice(nHashesAt, nHashesAt + 2), 16);
  const withExtra = tree.slice(0, nHashesAt) + (count + 1).toString(16).padStart(2, "0") + tree.slice(nHashesAt + 2, nHashesAt + 2 + count * 64) + "ab".repeat(32) + tree.slice(nHashesAt + 2 + count * 64);
  assert.throws(() => partialMerkleTree(withExtra), /left hashes unused|ran out of/);
});

test("one commitment has exactly one accepted encoding, so a branch cannot be padded or extended", () => {
  // PROOF MALLEABILITY, found by an external pass and reproduced before it was closed. Appending a
  // spare flag byte, or trailing bytes after the serialized tree, was accepted with an unchanged root,
  // so the same block and coinbase could be presented under endlessly many distinct serializations.
  // Nothing was forgeable through it, but an encoding with slack in it is an encoding whose bytes are
  // not the thing they commit to.
  const real = BLOCK.cbTxMerkleTree;
  assert.ok(partialMerkleTree(real).root, "the real branch is accepted");

  // A spare flag byte. The traversal never reads it, which is exactly why it went unnoticed. The
  // offset is derived from the structure rather than counted back from the end: four bytes of
  // transaction count, a hash count, the hashes, then the flag count and the flags.
  const buf = Buffer.from(real, "hex");
  const nHashes = buf[4];
  const flagCountAt = 5 + nHashes * 32;
  assert.ok(buf[flagCountAt] >= 1 && flagCountAt + 1 + buf[flagCountAt] === buf.length, "the offsets describe this fixture");
  const padded = Buffer.concat([
    buf.subarray(0, flagCountAt),
    Buffer.from([buf[flagCountAt] + 1]),
    buf.subarray(flagCountAt + 1),
    Buffer.from([0]),
  ]);
  assert.throws(() => partialMerkleTree(padded.toString("hex")), /left flag bytes unused/);

  // Trailing bytes after a complete tree.
  assert.throws(() => partialMerkleTree(real + "deadbeef"), /trailing bytes/);

  // Padding bits inside the last flag byte must be zero, since the traversal stops before them.
  const lastByte = parseInt(real.slice(-2), 16);
  const dirty = real.slice(0, -2) + (lastByte | 0x80).toString(16).padStart(2, "0");
  assert.throws(() => partialMerkleTree(dirty), /non-zero padding|left flag bytes unused|ran out of/);
});

test("a flag vector larger than the tree could read is refused before it is read", () => {
  // An external pass measured about 198 MB of heap for one megabyte of unused flags, because every
  // byte was expanded into eight numbers before the traversal began.
  //
  // MEASURING THE HEAP IS THE WRONG ASSERTION, and the first version of this test made it: heapUsed
  // depends on when garbage collection happens, so it failed once in three suite runs and passed
  // otherwise. A flaky test is worse than none, because the next real failure gets read as noise. The
  // deterministic property is that the flag count is bounded by the tree's own shape before a single
  // byte is consumed, so an oversized proof is refused at a fixed cost whatever its size.
  const oneTx = "01000000" + "01" + "aa".repeat(32);
  // varint 0xfe means a uint32 little-endian follows, so 1,048,576 is 00 00 10 00.
  const huge = oneTx + "fe" + "00001000" + "00".repeat(64);
  assert.throws(() => partialMerkleTree(huge), /past the .* the traversal could read/);

  // The bound is derived, not arbitrary: one transaction admits a small number of flag bytes and
  // refuses the one past it, and a large tree admits proportionally more.
  const forOneTx = Math.ceil((2 * 1 + 64) / 8);
  assert.throws(
    () => partialMerkleTree(oneTx + (forOneTx + 1).toString(16).padStart(2, "0") + "00".repeat(forOneTx + 1)),
    /past the .* the traversal could read/,
  );
  // And a real proof, which sits far inside the bound, is untouched by it.
  assert.ok(partialMerkleTree(BLOCK.cbTxMerkleTree).root, "the real branch is well within the bound");
});

test("the header must be exactly the 80 bytes a block header is", () => {
  assert.throws(() => headerMerkleRoot(BLOCK.blockHeader.slice(0, 100)), /80 bytes/);
  assert.equal(headerMerkleRoot(BLOCK.blockHeader).length, 32);
});

test("a service and a voting address encode the way consensus reads them", () => {
  // IPv4 sits in the mapped range, so the 0xffff at offset 10 is what distinguishes it from an IPv6
  // address that happens to start with zeroes.
  const v4 = serviceBytes("1.2.3.4:9999");
  assert.equal(v4.length, 18);
  assert.equal(v4.subarray(0, 12).toString("hex"), "00000000000000000000ffff");
  assert.equal(v4.subarray(12, 16).toString("hex"), "01020304");
  assert.equal(v4.readUInt16BE(16), 9999, "the port is big-endian, unlike every other integer here");

  const v6 = serviceBytes("[2001:db8::1]:9999");
  assert.equal(v6.subarray(0, 16).toString("hex"), "20010db8000000000000000000000001");

  assert.throws(() => serviceBytes("1.2.3.4"), /no port/);
  assert.throws(() => serviceBytes("1.2.3:9999"), /malformed IPv4/);
  assert.throws(() => serviceBytes("1.2.3.999:9999"), /malformed IPv4/);
  assert.throws(() => serviceBytes("1.2.3.4:70000"), /port out of range/);

  // The voting address is base58check and the key id is what remains after its version byte.
  const anEntry = BLOCK.mnList[0];
  assert.equal(votingKeyId(anEntry.votingAddress).length, 20);
  // A specific refusal, not merely "something threw". The base58 decode raises on a bad checksum on
  // its own, so /./ passed whether or not the length guard existed at all.
  assert.throws(() => votingKeyId("not-an-address"), /Non-base58|checksum/i, "a malformed address is refused by the decode");
  // A well-formed base58check string of the WRONG length is what the length guard is for, and only it
  // reaches that guard.
  const short = bs58check.encode(Buffer.alloc(10, 7));
  assert.throws(() => votingKeyId(short), /does not decode to a 20-byte key id/);
});

test("a transaction count no real block could hold is refused, not looped on", () => {
  // THE BLOCKER THIS FILE EXISTS TO HAVE CAUGHT. nTransactions is a full 32-bit field off the wire,
  // and `1 << height` in JavaScript is a signed 32-bit shift whose count wraps at 32, so any count at
  // or above 2**31 made the height loop spin forever. Thirty-nine bytes from the node hung the event
  // loop permanently, which stops every endpoint rather than only the refresh, and it arrives before
  // anything has authenticated a byte. Found by an author-side review, reproduced, then bounded.
  const evil = "ffffffff" + "01" + "aa".repeat(32) + "01" + "01";
  assert.equal(evil.length / 2, 39, "the whole hostile input is 39 bytes");
  const started = Date.now();
  assert.throws(() => partialMerkleTree(evil), /past the .* bound/);
  assert.ok(Date.now() - started < 1000, "and it refuses immediately rather than spinning");

  // The bound is on the COUNT, and a count within it is not refused by it. Two transactions, written
  // little-endian as the field is read, walks the tree normally.
  const twoTx = partialMerkleTree("02000000" + "02" + "aa".repeat(32) + "bb".repeat(32) + "01" + "05");
  assert.equal(twoTx.nTransactions, 2, "a workable count is not caught by the bound");
});

test("the branch must place the coinbase at index 0, not merely somewhere in the tree", () => {
  // The mutation an author-side review found surviving: weakening the matched test to accept any leaf
  // left every case passing, because the case named for it supplied a coinbase that appears at NO
  // leaf position, which even a broken check rejects. The attack the comment describes is a
  // transaction that IS in the branch, and that is what this drives.
  const tree = partialMerkleTree(BLOCK.cbTxMerkleTree);
  assert.equal(tree.matched.length, 1, "a real branch marks exactly one transaction");
  assert.equal(tree.matched[0].index, 0, "and in this block that transaction is the coinbase, at index 0");

  // A branch marking a NON-COINBASE transaction, built by hand: two transactions, the second marked.
  // The first hash stands in for the coinbase's sibling, so the tree is well formed and the matched
  // leaf sits at index 1.
  const cbTxid = createHash("sha256").update(createHash("sha256").update(Buffer.from(BLOCK.cbTx, "hex")).digest()).digest();
  const branch = Buffer.concat([
    Buffer.from([2, 0, 0, 0]),
    Buffer.from([2]),
    Buffer.alloc(32, 0xaa), // index 0, not descended into
    cbTxid, // index 1, marked
    Buffer.from([1]),
    // The bits are read least-significant first, in visit order: the root, then index 0, then index
    // 1. So 1 (descend at the root), 0 (index 0 is a plain leaf), 1 (index 1 is the match).
    Buffer.from([0b101]),
  ]);
  const built = partialMerkleTree(branch.toString("hex"));
  assert.deepEqual(built.matched.map((m) => m.index), [1], "the branch really does mark index 1");
  assert.ok(built.matched[0].hash.equals(cbTxid), "and the marked leaf really is the coinbase's id");

  const header = Buffer.from(BLOCK.blockHeader, "hex");
  built.root.copy(header, 36);
  assert.throws(
    () => verifyDmlCommitment({ mnList: BLOCK.mnList, cbTx: BLOCK.cbTx, cbTxMerkleTree: branch.toString("hex"), blockHeader: header.toString("hex") }),
    /index 1, and a coinbase is index 0/,
    "a transaction present in the branch but not at index 0 is not a coinbase",
  );
});
