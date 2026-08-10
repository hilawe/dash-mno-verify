// The on-chain commitment to the masternode list, and what checking it is worth.
//
// A `protx diff` response carries three things that can be checked against each other: the list
// itself (`mnList`), the block's coinbase special transaction (`cbTx`), and a merkle branch proving
// that coinbase belongs to a block (`cbTxMerkleTree`). The coinbase payload contains
// `merkleRootMNList`, which Dash consensus recomputes and enforces on every block connect
// (`specialtxman.cpp`), so it is the canonical commitment to the DIP4 simplified masternode list.
//
// WHAT THIS MODULE PROVES, and it is worth being exact because the difference decides whether direct
// node mode may be trusted:
//
//   1. The list hashes to the root the COINBASE commits to, not to the convenience copy the node
//      also returns at the top level of the response. A node that returns a list inconsistent with
//      the coinbase it hands over is caught.
//   2. That coinbase is committed by the merkle branch, at index 0, which is what makes it the
//      block's coinbase rather than some other transaction the branch happens to carry.
//   3. The branch reproduces the merkle root written in the block header supplied.
//
// WHAT THIS MODULE DOES NOT PROVE, ON ITS OWN. That the header is the block the node called
// ChainLocked. A Dash block is identified by its X11 hash (`CBlockHeader::GetHash` calls `HashX11`),
// and nothing in THIS file hashes a header, so the three checks above are satisfied by a fabricated
// header, coinbase, and list that agree with each other.
//
// THE CALLER CLOSES THAT. `oracle/diff_snapshot.js` names the header with `common/x11/` and requires
// it to equal the ChainLocked block hash, and requires that hash to meet a proof of work no easier
// than the network's limit. The residuals that remain after both are listed there. This file keeps
// its own boundary narrow on purpose, since it is reachable from anywhere and a caller that skipped
// the header check would be relying on less than it might assume.
//
// The DIP4 entry serialization below was not written from the specification. It was derived by
// reproducing the live mainnet commitment, because a serialization that is subtly wrong produces a
// root that is simply different and no amount of reading catches which field is at fault. Two
// independent confirmations, both against a synced mainnet node on 2026-08-04:
//
//   - height 1,028,162, 14 entries, all nVersion 1 and nType 0, root 3c2a79ec82c1b7ee...
//   - height 2,516,624, 2,971 entries, 1,784 v1 and 1,187 v2, 2,627 regular and 344 evo,
//     root 3687f8f3545e7a4f2db926c46a8fe89015d97926d18164979976a947de75360f
//
// Four earlier attempts failed. The field that broke them was `platformNodeID`, which the RPC
// displays reversed from the byte order it is hashed in, the same convention the transaction hashes
// follow. The 14-entry height is committed as a fixture because it exercises the whole chain at a
// size that can live in the repository; the tip confirmation is recorded here as a measurement,
// since a fixture holding 2,971 entries would not be.
import { createHash } from "node:crypto";
import bs58check from "bs58check";

const sha256 = (b) => createHash("sha256").update(b).digest();
const sha256d = (b) => sha256(sha256(b));
const reversed = (b) => Buffer.from(b).reverse();

// An RPC-displayed uint256 is the reverse of the bytes it is serialized and sorted by.
const internalOrder = (hex) => reversed(Buffer.from(hex, "hex"));

// The 18 bytes a CService contributes: a 16-byte address in IPv6 form, then the port big-endian.
// An IPv4 address occupies the IPv4-mapped range, which is why the 0xffff sits at offset 10.
export function serviceBytes(service) {
  const out = Buffer.alloc(18);
  const s = String(service);
  // BRACKETS ARE STRUCTURAL, not optional. A review found the old code stripped an optional "[" or
  // "]" and then chose the branch by whether the host contained a colon, so a bracketless "::1:9999"
  // and an unmatched "[::1:9999" both parsed as an IPv6 service. An IPv6 service MUST be "[host]:port"
  // and an IPv4 one MUST be "host:port" with no brackets and no colons, which is the form Dash Core
  // emits and the only form that disambiguates the port colon from the address colons.
  let host, portStr, isV6;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0 || s[close + 1] !== ":") {
      throw new Error(`malformed IPv6 service ${JSON.stringify(service)}, expected "[host]:port"`);
    }
    host = s.slice(1, close);
    portStr = s.slice(close + 2);
    isV6 = true;
    if (!host.includes(":")) throw new Error(`bracketed host is not IPv6 in ${JSON.stringify(service)}`);
  } else {
    const split = s.lastIndexOf(":");
    if (split < 0) throw new Error(`service ${JSON.stringify(service)} has no port`);
    host = s.slice(0, split);
    portStr = s.slice(split + 1);
    isV6 = false;
    if (host.includes(":")) throw new Error(`IPv6 service must be bracketed as "[host]:port" in ${JSON.stringify(service)}`);
  }
  // A PLAIN DECIMAL PORT, so "+9999", "0x270f", and "9.9" (which Number() would coerce) are refused.
  if (!/^\d{1,5}$/.test(portStr)) throw new Error(`service port is not a plain decimal in ${JSON.stringify(service)}`);
  const port = Number(portStr);
  if (port > 0xffff) throw new Error(`service port out of range in ${JSON.stringify(service)}`);
  if (isV6) {
    // ONE ABBREVIATION AT MOST. "::" may appear once in an IPv6 address, and splitting on it without
    // saying so took the first two parts and silently discarded the rest, so "2001::1::2" parsed as
    // "2001::1" and encoded bytes for an address nobody wrote. Found by a test written for the
    // group-validation fix, which is the useful kind of accident.
    const parts = host.split("::");
    if (parts.length > 2) throw new Error(`malformed IPv6 host in ${JSON.stringify(service)}, more than one "::"`);
    const compressed = parts.length === 2;
    // EACH GROUP IS VALIDATED, not coerced, and an EMPTY group is malformed. parseInt("gg", 16) is NaN
    // and the mask turned that into zero, so "gg" and "0" once produced identical bytes. An empty
    // group (from a stray ":::" or a leading/trailing single ":") is malformed the same way, and is
    // rejected here rather than filtered away, which is what let "1:::2" silently parse as "1::2". The
    // only legal empty side is the whole of one side of a "::", handled by treating "" as no groups.
    const groupsOf = (side) => {
      if (side === "") return [];
      const gs = side.split(":");
      for (const g of gs) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
          throw new Error(`malformed IPv6 group ${JSON.stringify(g)} in ${JSON.stringify(service)}`);
        }
      }
      return gs;
    };
    const h = groupsOf(parts[0]);
    const t = compressed ? groupsOf(parts[1]) : [];
    // THE GROUP COUNT IS EXACT, which is what F5 closed. Without "::" an address is fully written and
    // must carry exactly eight groups: the old code accepted fewer and padded them, so "1:2:3:4:5:6:7"
    // silently became "...:7:0". With "::" the abbreviation must stand for at least one zero group, so
    // the written groups must be seven or fewer: the old code accepted eight beside a "::", so
    // "1:2:3:4:5:6:7:8::" produced bytes IDENTICAL to the canonical "1:2:3:4:5:6:7:8".
    //
    // WHAT THIS DOES NOT DO, stated so the boundary is not over-claimed: it does not enforce a single
    // CANONICAL IPv6 spelling. Leading zeros ("::01"), uppercase hex, and the expanded versus
    // compressed forms are all valid representations of one address, they all encode to the same
    // CORRECT bytes, and Dash Core is documented to emit both compressed and expanded forms, so
    // refusing them would refuse a real service. The guarantee here is that a structurally malformed
    // service is refused and that the byte encoding is correct for the address a valid spelling names,
    // not that one address has exactly one accepted spelling.
    if (!compressed && h.length !== 8) {
      throw new Error(`malformed IPv6 host in ${JSON.stringify(service)}, needs exactly eight groups without "::"`);
    }
    if (compressed && h.length + t.length > 7) {
      throw new Error(`malformed IPv6 host in ${JSON.stringify(service)}, "::" must replace at least one group`);
    }
    const groups = compressed ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    groups.forEach((g, n) => out.writeUInt16BE(parseInt(g, 16), n * 2));
  } else {
    const octets = host.split(".");
    if (octets.length !== 4) throw new Error(`malformed IPv4 host in ${JSON.stringify(service)}`);
    out.writeUInt16BE(0xffff, 10);
    octets.forEach((o, n) => {
      // PLAIN DECIMAL, 0 to 255, no leading zeros. Number() would coerce "1e0", "+1", and "0x1" to
      // integers in range, so "1e0.2.3.4" and "1.2.3.4" once encoded to the same bytes. A strict
      // decimal literal is the octet spelling Dash Core emits.
      if (!/^(0|[1-9]\d{0,2})$/.test(o) || Number(o) > 255) {
        throw new Error(`malformed IPv4 octet ${JSON.stringify(o)} in ${JSON.stringify(service)}`);
      }
      out[12 + n] = Number(o);
    });
  }
  out.writeUInt16BE(port, 16);
  return out;
}

// The 20-byte key id behind a base58check voting address. The address carries a one-byte version
// prefix, which is not part of the key id.
export function votingKeyId(address) {
  const decoded = Buffer.from(bs58check.decode(String(address)));
  if (decoded.length !== 21) throw new Error(`voting address ${JSON.stringify(address)} does not decode to a 20-byte key id`);
  return decoded.subarray(1);
}

// One entry, serialized as consensus hashes it. The version and type fields are NOT written for a
// hash: Dash writes them only on a network stream (`SER_NETWORK`), and `CalcHash` uses `SER_GETHASH`
// (`CSimplifiedMNListEntry` in evo/simplifiedmns.h). The nType that IS written is the one guarded by
// the entry version rather than by the stream type, which is why version 2 entries carry it and
// version 1 entries do not.
// Fixed-width hex, decoded strictly. `Buffer.from(hex, "hex")` stops at the first character it
// cannot read and returns what it managed, so "abc...xyz" silently becomes a SHORTER buffer and every
// field after it shifts. That produces a leaf which is merely different, and the only symptom is a
// commitment mismatch with nothing saying why.
function fixedHex(value, bytes, what) {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${what} must be ${bytes * 2} hex characters, got ${JSON.stringify(value)}`);
  }
  return Buffer.from(value, "hex");
}

// An unsigned integer that must fit the width it is written at. The masks that used to do this
// (`& 0xffff`) turned an out-of-range value into a DIFFERENT in-range one, so an nType of 65536
// serialized exactly like type 0 and a Platform port of 65979 exactly like 443.
function u16Exact(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`${what} must be an integer in 0..65535, got ${JSON.stringify(value)}`);
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

// The entry layouts this build knows how to serialize. An entry outside them is REFUSED rather than
// guessed at: a future version may add fields, and serializing it under today's layout would compute
// a root that does not match and give no indication that the layout, rather than the list, was the
// problem. Refusing names the cause. It also means a network upgrade that introduces a new entry
// version stops direct-node reads until this build learns it, which is the honest failure and is
// recorded in TODO.md rather than hidden here.
const KNOWN_ENTRY_VERSIONS = new Set([1, 2]);
const KNOWN_ENTRY_TYPES = new Set([0, 1]);

export function smlEntryBytes(e) {
  // Checked BEFORE the bytes are assembled, because a guard that runs after the concatenation has
  // already let the wrong-length key into the buffer it was meant to keep out.
  const version = e?.nVersion;
  if (!KNOWN_ENTRY_VERSIONS.has(version)) {
    throw new Error(
      `entry ${e?.proRegTxHash} has nVersion ${JSON.stringify(version)}. This build serializes versions ` +
        `${[...KNOWN_ENTRY_VERSIONS].join(" and ")} only, and guessing a layout it does not know would ` +
        `produce a root that silently fails to match.`,
    );
  }
  const operator = fixedHex(e.pubKeyOperator, 48, `entry ${e.proRegTxHash} operator public key`);
  if (typeof e.isValid !== "boolean") {
    throw new Error(`entry ${e.proRegTxHash} has isValid ${JSON.stringify(e.isValid)}, not a boolean`);
  }
  const parts = [
    reversed(fixedHex(e.proRegTxHash, 32, `entry ${e.proRegTxHash} proRegTxHash`)),
    reversed(fixedHex(e.confirmedHash, 32, `entry ${e.proRegTxHash} confirmedHash`)),
    serviceBytes(e.service),
    operator,
    votingKeyId(e.votingAddress),
    Buffer.from([e.isValid ? 1 : 0]),
  ];
  if (version >= 2) {
    if (!KNOWN_ENTRY_TYPES.has(e.nType)) {
      throw new Error(
        `entry ${e.proRegTxHash} has nType ${JSON.stringify(e.nType)}. This build serializes types ` +
          `${[...KNOWN_ENTRY_TYPES].join(" and ")} only, and a type it does not know may carry fields it ` +
          `would omit.`,
      );
    }
    parts.push(u16Exact(e.nType, `entry ${e.proRegTxHash} nType`));
    // An evo node also commits to where its Platform service answers. platformNodeID is a key id
    // displayed reversed, exactly like the transaction hashes above, which is the detail that broke
    // four earlier attempts at this serialization.
    if (e.nType === 1) {
      parts.push(
        u16Exact(e.platformHTTPPort, `entry ${e.proRegTxHash} platformHTTPPort`),
        reversed(fixedHex(e.platformNodeID, 20, `entry ${e.proRegTxHash} platformNodeID`)),
      );
    }
  }
  return Buffer.concat(parts);
}

// The merkle root over a set of leaves, in the form the block transaction tree uses: pair, hash,
// and duplicate the last element when a level has an odd count.
//
// The duplicate rule is what makes CVE-2012-2459 style mutation possible in the general case. It is
// not exploitable here, because the leaves are entries keyed by proRegTxHash and the sort below
// rejects a duplicated key outright, so a level cannot be made to repeat by the caller.
export function merkleRootFromLeaves(leaves) {
  if (leaves.length === 0) return Buffer.alloc(32);
  let level = leaves.map((l) => Buffer.from(l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    }
    level = next;
  }
  return level[0];
}

// The masternode list root, as the coinbase commits to it. Entries are ordered by proRegTxHash in
// its INTERNAL byte order, which is what Dash's own sort compares (`uint256::Compare` is a memcmp
// over the stored bytes), and that is not the same order as sorting the displayed hex.
export function smlMerkleRoot(mnList) {
  const keyed = mnList.map((e) => ({ e, key: internalOrder(e.proRegTxHash) }));
  keyed.sort((a, b) => Buffer.compare(a.key, b.key));
  for (let i = 1; i < keyed.length; i++) {
    // A repeated registration hash is not something an honest list contains, and admitting one would
    // both make the ordering ambiguous and reopen the tree-mutation question the comment above
    // dismisses. Refuse rather than resolve.
    if (keyed[i].key.equals(keyed[i - 1].key)) throw new Error(`masternode list contains proRegTxHash ${keyed[i].e.proRegTxHash} twice`);
  }
  return merkleRootFromLeaves(keyed.map(({ e }) => sha256d(smlEntryBytes(e))));
}

// A minimal reader for the little-endian, varint-framed encoding the serialized structures use.
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
  }
  #need(n) {
    if (this.at + n > this.buf.length) throw new Error("truncated while reading");
    return n;
  }
  u16() {
    this.#need(2);
    const v = this.buf.readUInt16LE(this.at);
    this.at += 2;
    return v;
  }
  u32() {
    this.#need(4);
    const v = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  // CANONICAL ONLY. The encoding has one shortest form for each value, and a wider form encoding a
  // small number is a second spelling of the same structure. The malleability work on the partial
  // merkle tree established that one commitment must have exactly one accepted encoding, and this
  // reader quietly undercut it: 0xfd 0x05 0x00 and a bare 0x05 both said five. A reviewer with folder
  // access pointed out the contradiction between the claim and the parser.
  varint() {
    this.#need(1);
    const first = this.buf[this.at++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = this.u16();
      if (v < 0xfd) throw new Error(`varint ${v} is written in a wider form than its shortest one`);
      return v;
    }
    if (first === 0xfe) {
      const v = this.u32();
      if (v <= 0xffff) throw new Error(`varint ${v} is written in a wider form than its shortest one`);
      return v;
    }
    this.#need(8);
    const v = this.buf.readBigUInt64LE(this.at);
    this.at += 8;
    if (v <= 0xffffffffn) throw new Error(`varint ${v} is written in a wider form than its shortest one`);
    // A count that cannot be held in a JS number is not something a real structure contains, and
    // silently truncating it would turn a malformed input into a wrong answer.
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("varint too large");
    return Number(v);
  }
  take(n) {
    this.#need(n);
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
}

// The masternode list root the coinbase commits to, read from the coinbase itself. The point of
// parsing rather than reading the response's own `merkleRootMNList` field is that the field is what
// the node says, and the coinbase is what the chain enforces.
export function cbTxCommitment(cbTxHex) {
  const r = new Reader(Buffer.from(cbTxHex, "hex"));
  const nVersion = r.u16();
  const nType = r.u16();
  // Type 5 is the coinbase special transaction. Anything else does not carry this commitment, and
  // reading a payload out of it would be reading whichever bytes happened to be at that offset.
  if (nType !== 5) throw new Error(`expected a coinbase special transaction (type 5), got type ${nType} version ${nVersion}`);
  const inputs = r.varint();
  for (let i = 0; i < inputs; i++) {
    r.take(32); // previous output hash
    r.u32(); // previous output index
    r.take(r.varint()); // script
    r.u32(); // sequence
  }
  const outputs = r.varint();
  for (let i = 0; i < outputs; i++) {
    r.take(8); // value
    r.take(r.varint()); // script
  }
  r.u32(); // lock time
  const payloadBytes = Buffer.from(r.take(r.varint()));
  // THE WHOLE TRANSACTION MUST BE CONSUMED. The parser reads every field of the coinbase, so a
  // well-formed cbTx ends exactly here. Trailing bytes mean the blob is not the canonical transaction:
  // a review found that without this check, appending a byte to a valid cbTx parsed to the same height
  // and masternode root and was accepted. The sibling partialMerkleTree already refuses trailing bytes,
  // and this brings the coinbase parser to the same strictness. End-to-end forgery is separately closed
  // by the X11 block-hash and proof-of-work checks in oracle/diff_snapshot.js, but the parser must not
  // accept a non-canonical transaction as canonical.
  if (r.at !== r.buf.length) {
    throw new Error(
      `coinbase transaction has ${r.buf.length - r.at} trailing byte(s) after its payload; ` +
        `the parser must consume the whole transaction`,
    );
  }
  const payload = new Reader(payloadBytes);
  const payloadVersion = payload.u16();
  const height = payload.u32();
  const merkleRootMNList = reversed(Buffer.from(payload.take(32))).toString("hex");
  return { payloadVersion, height, merkleRootMNList };
}

// Walk a serialized CPartialMerkleTree, returning the root it reproduces and the leaves it marks as
// matched. The traversal is the one the format defines: a bit per visited node saying whether a
// matched leaf lies beneath it, and a hash consumed whenever the walk stops descending.
// No real block holds anywhere near this many transactions, and the bound is what keeps the height
// computation below finite. `nTransactions` is a full 32-bit field read straight off the wire, and
// `1 << height` in JavaScript is a SIGNED 32-bit shift whose count wraps at 32, so for any count at
// or above 2**31 the comparison never becomes true and the loop spins forever. A 39-byte response
// was enough to hang the event loop permanently, which stops every endpoint and not merely the
// refresh, and it arrives from the node before anything has authenticated a single byte.
const MAX_TREE_TRANSACTIONS = 1 << 24;

export function partialMerkleTree(hex) {
  const r = new Reader(Buffer.from(hex, "hex"));
  const nTransactions = r.u32();
  if (nTransactions === 0) throw new Error("partial merkle tree covers no transactions");
  if (nTransactions > MAX_TREE_TRANSACTIONS) {
    throw new Error(`partial merkle tree claims ${nTransactions} transactions, past the ${MAX_TREE_TRANSACTIONS} bound`);
  }
  const hashes = [];
  const nHashes = r.varint();
  for (let i = 0; i < nHashes; i++) hashes.push(Buffer.from(r.take(32)));
  // A PRIORI BOUND ON THE FLAGS, from the tree's own shape. The traversal visits fewer than 2n nodes
  // and reads one bit per visit, so anything past that is slack the walk can never consume. Bounding
  // it here makes an oversized proof a refusal at a fixed cost, rather than something whose cost is
  // whatever the node chose to send. The unused-flags check further down still catches the small
  // padding cases; this is the one that stops a large one from being read at all.
  const maxFlagBytes = Math.ceil((2 * nTransactions + 64) / 8);
  const declaredFlagBytes = r.varint();
  if (declaredFlagBytes > maxFlagBytes) {
    throw new Error(
      `partial merkle tree declares ${declaredFlagBytes} flag bytes for ${nTransactions} transactions, ` +
        `past the ${maxFlagBytes} the traversal could read`,
    );
  }
  const flagBytes = r.take(declaredFlagBytes);
  // READ LAZILY RATHER THAN EXPANDING. Expanding every flag byte into eight numbers up front made the
  // memory cost a multiple of whatever the node sent: a megabyte of flags, most of them never
  // consumed, cost about 198 MB of heap and was accepted. The traversal needs one bit at a time and
  // the count it needs is a property of the tree, not of the buffer.
  const bitAt = (i) => (flagBytes[i >> 3] >> (i & 7)) & 1;
  const totalBits = flagBytes.length * 8;

  let bitsUsed = 0;
  let hashesUsed = 0;
  const matched = [];
  let height = 0;
  while (1 << height < nTransactions) height++;
  // The number of nodes at a level, which decides whether a right sibling exists or the left one is
  // duplicated. Reading past it is how a malformed tree would otherwise reproduce an arbitrary root.
  const widthAt = (h) => Math.floor((nTransactions + (1 << h) - 1) / (1 << h));
  const walk = (h, pos) => {
    if (bitsUsed >= totalBits) throw new Error("partial merkle tree ran out of flag bits");
    const descend = bitAt(bitsUsed++);
    if (h === 0 || !descend) {
      if (hashesUsed >= hashes.length) throw new Error("partial merkle tree ran out of hashes");
      const hash = hashes[hashesUsed++];
      // The POSITION is recorded, not just the hash. A branch carries leaf hashes for the path as
      // well as for the match, so "this txid appears among the leaves" is a weaker statement than it
      // looks: it is satisfied by any transaction the branch happens to include. The coinbase is
      // transaction 0 by definition, so the caller can require that and mean it.
      if (h === 0 && descend) matched.push({ hash, index: pos });
      return hash;
    }
    const left = walk(h - 1, pos * 2);
    const right = pos * 2 + 1 < widthAt(h - 1) ? walk(h - 1, pos * 2 + 1) : left;
    return sha256d(Buffer.concat([left, right]));
  };
  const root = walk(height, 0);
  // EVERYTHING MUST BE CONSUMED, in all three dimensions, because anything left over means one
  // commitment has more than one accepted encoding. That is proof malleability: the same block and
  // the same coinbase could be presented under endlessly many distinct serializations, each accepted.
  // Verified as a real gap before this was added, by appending a spare flag byte and by appending
  // trailing bytes, both of which were accepted with an unchanged root.
  if (hashesUsed !== hashes.length) throw new Error("partial merkle tree left hashes unused");
  // The flags are padded to a byte boundary, so the slack is at most seven bits and every one of them
  // must be zero. A whole spare byte means the encoding carried something the traversal did not need.
  if (Math.ceil(bitsUsed / 8) !== flagBytes.length) throw new Error("partial merkle tree left flag bytes unused");
  for (let i = bitsUsed; i < totalBits; i++) {
    if (bitAt(i)) throw new Error("partial merkle tree has non-zero padding in its flag bits");
  }
  if (r.at !== r.buf.length) throw new Error(`partial merkle tree has ${r.buf.length - r.at} trailing bytes`);
  return { root, matched, nTransactions };
}

// The block header's merkle root, read from the 80-byte header: version, previous block, merkle
// root, time, bits, nonce.
export function headerMerkleRoot(headerHex) {
  const header = Buffer.from(headerHex, "hex");
  if (header.length !== 80) throw new Error(`block header must be 80 bytes, got ${header.length}`);
  return Buffer.from(header.subarray(36, 68));
}

// The three checks, run together, against one `protx diff` response and the header of the block it
// names. Throws with the specific failure rather than returning a boolean, because every one of
// these failing means the node contradicted itself and the caller's only correct response is to
// refuse the snapshot.
//
// The caller supplies the header it fetched BY the block hash it intends to trust. This function
// cannot check that the header is that block (see the note at the top of this file), so the guarantee
// it returns is scoped: the list, the coinbase, and this header agree with one another.
export function verifyDmlCommitment({ mnList, cbTx, cbTxMerkleTree, blockHeader }) {
  const { merkleRootMNList, height, payloadVersion } = cbTxCommitment(cbTx);

  const recomputed = reversed(smlMerkleRoot(mnList)).toString("hex");
  if (recomputed !== merkleRootMNList) {
    throw new Error(`masternode list does not match the coinbase commitment: list hashes to ${recomputed}, coinbase commits to ${merkleRootMNList}`);
  }

  const cbTxid = sha256d(Buffer.from(cbTx, "hex"));
  const tree = partialMerkleTree(cbTxMerkleTree);
  // AT POSITION 0, which is what makes it the coinbase rather than merely a transaction the branch
  // includes. Checking membership alone accepted any transaction present in the branch, and a branch
  // legitimately carries several leaf hashes, so the check its comment described was not the check
  // being made.
  const coinbase = tree.matched.find((m) => m.hash.equals(cbTxid));
  if (!coinbase) {
    throw new Error("the merkle branch does not mark the supplied coinbase as its matched transaction");
  }
  if (coinbase.index !== 0) {
    throw new Error(`the merkle branch places the supplied transaction at index ${coinbase.index}, and a coinbase is index 0`);
  }
  const inHeader = headerMerkleRoot(blockHeader);
  if (!tree.root.equals(inHeader)) {
    throw new Error(`the merkle branch reproduces ${reversed(tree.root).toString("hex")}, but the header commits to ${reversed(inHeader).toString("hex")}`);
  }

  return {
    merkleRootMNList,
    height,
    payloadVersion,
    entries: mnList.length,
    transactionsInBlock: tree.nTransactions,
    // Named so a caller cannot read more into the result than was checked. The header was taken on
    // trust; what is established is that these three artefacts agree.
    headerIdentityVerified: false,
  };
}
