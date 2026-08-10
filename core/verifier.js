import { readFile } from "node:fs/promises";
import * as snarkjs from "snarkjs";
import { isCanonicalField } from "../common/field.js";
import { isValidEngineStatement } from "./registration_store.js";

// Every public signal must be a canonical field element in [0, FIELD_PRIME). snarkjs reduces a
// non-canonical input mod p during verification, so a proof would still verify, but the gateway keys
// the nullifier (and the registration nullifier) by the raw signal string. Without this check, a
// caller could submit x and x + p as two string-distinct nullifiers that are the same field element,
// and spend a membership or registration twice. Reject up front, before any signal is read or used as
// a key.
function signalsAreCanonical(publicSignals, count) {
  return Array.isArray(publicSignals) && publicSignals.length === count && publicSignals.every(isCanonicalField);
}

// Public-signal layout. snarkjs orders public signals as the circuit's public OUTPUTS
// first, then its public INPUTS in declaration order. For mno_membership.circom:
//   output: nullifier
//   inputs: root, epoch, contextHash, signalHash
// Confirm this against the compiled circuit's public.json before trusting it.
export const SIGNAL_INDEX = {
  nullifier: 0,
  root: 1,
  epoch: 2,
  contextHash: 3,
  signalHash: 4,
};

export async function loadVerificationKey(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function readSignals(publicSignals) {
  return {
    nullifier: publicSignals[SIGNAL_INDEX.nullifier],
    root: publicSignals[SIGNAL_INDEX.root],
    epoch: publicSignals[SIGNAL_INDEX.epoch],
    contextHash: publicSignals[SIGNAL_INDEX.contextHash],
    signalHash: publicSignals[SIGNAL_INDEX.signalHash],
  };
}

// Verify a membership proof against the gateway's current policy.
//
// The four policy checks run before the cryptographic check so a stale, misscoped, or
// replayed proof is rejected cheaply. The `expected` values are ones the gateway itself
// chose or knows, never values taken from the proof. A proof can only assert the
// nullifier and that some valid node authorized it; it can never talk the gateway into
// accepting the wrong root, epoch, context, or challenge.
//
// The nullifier store is also the claim store. Each spent tag records the account that first claimed
// it, so when the tag is already spent, the only caller let through is that same account, re-verifying
// because its adapter died after the spend but before it applied the grant (role, invite, session).
// The re-grant still needs a fresh valid proof, so knowing the account is not enough, and a different
// account is rejected, so one voting key still maps to one account per epoch and context. A store
// whose get() returns null (the Platform-backed store, which does not persist the account) simply
// never re-grants, so a spent tag is already-used there.
//
// verifyProof is injected so the proof check can be stubbed in unit tests. It defaults to PLONK,
// whose verification key comes from a universal trusted setup (the public Hermez Powers of Tau),
// reused across circuits with no per-circuit ceremony.
export async function verifyMembership({
  vkey,
  proof,
  publicSignals,
  expected,
  nullifiers,
  verifyProof = (vk, ps, pf) => snarkjs.plonk.verify(vk, ps, pf),
  gate = (fn) => fn(),
}) {
  // The public signals must be canonical before any of them is read or used as a nullifier key.
  if (!signalsAreCanonical(publicSignals, Object.keys(SIGNAL_INDEX).length))
    return { ok: false, reason: "non-canonical-signal" };
  const s = readSignals(publicSignals);

  // 0) the caller must name the account this verify is for. The claim record keys idempotency on it,
  //    so a missing account would record an ownerless claim that a later ownerless call could match.
  //    The gateway always supplies pending.account (review finding B1); this guards direct callers.
  if (typeof expected.account !== "string" || expected.account === "")
    return { ok: false, reason: "missing-account" };

  // 1) the root must be one the oracle published recently
  if (!expected.rootStore.isRecent(s.root))
    return { ok: false, reason: "stale-or-unknown-root" };

  // 2) the epoch must be the one the gateway is currently issuing
  if (String(s.epoch) !== String(expected.epoch))
    return { ok: false, reason: "wrong-epoch" };

  // 3) the proof must be scoped to this community, platform, and role
  if (String(s.contextHash) !== String(expected.contextHash))
    return { ok: false, reason: "wrong-context" };

  // 4) the proof must be bound to the challenge handed to this account
  if (String(s.signalHash) !== String(expected.signalHash))
    return { ok: false, reason: "wrong-signal" };

  // 4.5) THE PERIOD MUST STILL BE THE ONE THE POLICY CHECKS PASSED IN. Checks 1 through 4 run
  //      BEFORE the expensive proof, and nothing re-read them afterwards, so a proof that finished
  //      after an epoch or season boundary could spend a nullifier and return success against a
  //      period that had already ended, with an expiry in the past. In two-tier mode the verifier
  //      also held a detached root store that a rollover had already cleared. The proof verify is
  //      the only slow step here, so re-asking immediately before the spend closes the whole gap.
  //
  //      Supplied by the caller (the gateway owns the clock and the season), and OPTIONAL so a
  //      direct caller that does not supply it behaves exactly as before rather than failing shut on
  //      an interface it never knew about.
  const periodStillCurrent = async () => {
    if (typeof expected.stillCurrent !== "function") return null;
    const verdict = await expected.stillCurrent();
    // null (or undefined) means the period still holds. ANYTHING ELSE is a refusal reason, compared
    // against null rather than tested for truthiness: an empty-string reason is falsy, so a
    // truthiness test would have read "no longer current, reason unstated" as "still current" and
    // granted. A guard whose failure mode is to pass is worse than no guard.
    if (verdict == null) return null;
    const reason = String(verdict);
    return reason.length > 0 ? reason : "period-changed";
  };

  const claimedBySameAccount = async () => {
    const prior = await nullifiers.get(s.epoch, s.contextHash, s.nullifier);
    return prior != null && String(prior.account) === String(expected.account);
  };

  // 5) one voting key, one membership per epoch and context. An already-spent tag is only let through
  //    as an idempotent re-grant for the account that first claimed it, and only with a fresh valid
  //    proof. The has() check rejects an ordinary replay before the expensive proof verify.
  if (await nullifiers.has(s.epoch, s.contextHash, s.nullifier)) {
    if (!(await claimedBySameAccount())) return { ok: false, reason: "already-used" };
    if (!(await gate(() => verifyProof(vkey, publicSignals, proof)))) return { ok: false, reason: "invalid-proof" };
    // Re-grants are period-checked too. Handing back a grant whose epoch ended is the same defect as
    // issuing one, and the adapter is told it may trust the response without re-checking expiry.
    const staleRegrant = await periodStillCurrent();
    if (staleRegrant !== null) return { ok: false, reason: staleRegrant };
    return { ok: true, nullifier: s.nullifier, epoch: s.epoch, regranted: true };
  }

  // 6) first claim: verify the proof, then record the spend and the granting account together.
  if (!(await gate(() => verifyProof(vkey, publicSignals, proof)))) return { ok: false, reason: "invalid-proof" };

  // BEFORE the spend, not after. The nullifier write is the irreversible step, so a period that
  // moved while the proof ran must refuse here rather than burn the member's one membership for an
  // epoch that has ended.
  const stale = await periodStillCurrent();
  if (stale !== null) return { ok: false, reason: stale };

  // With a shared store, a duplicate here means another request recorded the spend first in a race.
  // Re-grant only if that prior claim belongs to this same account, otherwise it is already used.
  const dup = await nullifiers.add(s.epoch, s.contextHash, s.nullifier, { account: expected.account });
  // The add() itself is an await, and against a shared backend it is a network round trip, so the
  // period can end inside it. Every path from here returns a GRANT, so each one is period-checked.
  // The spend stays recorded either way: for this account it is the same tag it would spend next
  // time, and un-spending on a boundary would need a compensating delete that could itself be
  // interrupted, which is a worse failure than a refused grant.
  // AFTER THE SPEND, ONLY REFUSE FOR REASONS THAT MAKE THE SPENT TAG IRRELEVANT ANYWAY.
  //
  // The tag is keyed by (epoch, contextHash, nullifier). If the EPOCH or SEASON moved, the member's
  // next attempt uses a different key, so refusing costs them nothing they can still use. If the
  // ROOT aged out, the epoch is unchanged, the tag is spent, and no grant was returned. On a store
  // that records the granting account that is recoverable, because the same account can re-verify
  // and be re-granted. On the Platform store it is NOT: the account is deliberately not persisted
  // for privacy, so get() returns null, so no re-grant is possible, and the member is denied for the
  // rest of the epoch by a timing condition they cannot control or observe. A reviewer found that
  // the comment promising "the same tag it would spend next time" was true locally and false there.
  //
  // The root was already checked twice before this point, before the proof and before the spend, so
  // a root that aged out during the store round trip means the member proved against a root the
  // gateway accepted moments earlier. Burning them for that is disproportionate to what it prevents,
  // which is a grant against a root that just left a window bounded by an age rule anyway.
  const after = await periodStillCurrent();
  if (after !== null && after !== "stale-or-unknown-root") return { ok: false, reason: after };
  if (dup && dup.duplicate) {
    if (await claimedBySameAccount()) {
      // The ownership lookup is itself an await, so the period can move inside it too. Every await
      // between the last check and a returned grant needs its own, which is why this sits here
      // rather than being folded into the one above.
      const afterLookup = await periodStillCurrent();
      if (afterLookup !== null && afterLookup !== "stale-or-unknown-root") {
        return { ok: false, reason: afterLookup };
      }
      return { ok: true, nullifier: s.nullifier, epoch: s.epoch, regranted: true };
    }
    return { ok: false, reason: "already-used" };
  }
  return { ok: true, nullifier: s.nullifier, epoch: s.epoch };
}

// Public-signal layout for mno_registration: outputs first (commitment, regNullifier),
// then inputs (root, season, contextHash). Confirm against the compiled public.json.
export const REG_SIGNAL_INDEX = {
  commitment: 0,
  regNullifier: 1,
  root: 2,
  season: 3,
  contextHash: 4,
};

// The engine-neutral registration claims a proof asserts, decoded by a per-engine decoder from that
// engine's proof form (docs/ZKVM_INTEGRATION.md). Both engines produce the SAME five semantic values,
// so the policy checks, the duplicate lookup, and the commit are engine-neutral (verifyRegistrationCore
// below). The engines differ only in how the claims are decoded and how the crypto is checked, and in
// the root's type: a canonical field element (the Poseidon root) for PLONK, a 64-hex SHA-256 root for
// the zkVM engine, each checked against its own root store by the caller.
//
// PLONK decoder: the existing five-signal array, canonical-checked. Returns { claims } or { error }.
export function decodePlonkRegistrationClaims(publicSignals) {
  if (!signalsAreCanonical(publicSignals, Object.keys(REG_SIGNAL_INDEX).length)) {
    return { error: "non-canonical-signal" };
  }
  return {
    claims: {
      commitment: publicSignals[REG_SIGNAL_INDEX.commitment],
      regNullifier: publicSignals[REG_SIGNAL_INDEX.regNullifier],
      root: publicSignals[REG_SIGNAL_INDEX.root],
      season: publicSignals[REG_SIGNAL_INDEX.season],
      contextHash: publicSignals[REG_SIGNAL_INDEX.contextHash],
    },
  };
}

// zkVM decoder: the frozen 136-byte journal (docs/ZKVM_INTEGRATION.md appendix), a single byte slice:
//   commitment (32, big-endian field), regNullifier (32, big-endian field), root (32, the SHA-256
//   tree root), season (8, big-endian u64), contextHash (32, big-endian field).
// The commitment, regNullifier, and contextHash are BN254 field elements, canonical-checked exactly
// like the PLONK signals since the gateway keys the durable record on them. The root is the SHA-256
// root as 64 lowercase hex, an arbitrary 32-byte value (it cannot ride the field-element path, which
// is the whole reason for the engine-neutral claims object). season is a plain u64.
export const REG_JOURNAL_BYTES = 136;
export function decodeZkvmRegistrationClaims(journal) {
  const bytes = journal instanceof Uint8Array ? Buffer.from(journal) : journal;
  if (!Buffer.isBuffer(bytes) || bytes.length !== REG_JOURNAL_BYTES) {
    return { error: "bad-journal-length" };
  }
  const field = (off) => BigInt("0x" + bytes.subarray(off, off + 32).toString("hex")).toString();
  const claims = {
    commitment: field(0),
    regNullifier: field(32),
    root: bytes.subarray(64, 96).toString("hex"),
    season: BigInt("0x" + bytes.subarray(96, 104).toString("hex")).toString(),
    contextHash: field(104),
  };
  // The three field-element claims must be canonical, the same guard the PLONK path applies, so a
  // journal carrying a non-canonical commitment, nullifier, or context cannot double-spend by string
  // aliasing. The root is a SHA-256 hex string, checked for shape not field-canonicality.
  if (![claims.commitment, claims.regNullifier, claims.contextHash].every(isCanonicalField)) {
    return { error: "non-canonical-signal" };
  }
  return { claims };
}

// Verify a two-tier registration proof. On success it commits one durable registration record,
// so one voting key registers exactly one commitment per season and context, and mirrors that
// commitment into the in-memory members tree.
//
// The policy checks and the proof verify run here, with no lock held. The state mutation is
// delegated to `commit`, which the caller serializes against a season rollover (see
// core/season.js): commit writes the durable record (the commit point that spends the
// registration nullifier and records the member commitment in one atomic, deduped write) and
// appends the same commitment to the members tree, in one critical section, so the durable index
// and the tree position are assigned together and a rollover cannot land between them. The members
// tree is only a cache rebuilt from records, so a crash right after the durable write re-derives
// the member on the next RESTART rebuild. Within a running process the cache is not rebuilt on its
// own, so a durable write whose commit threw AFTER it landed (the A2 strand) would leave the member
// out of the cache until a rollover or restart; the already-registered path below reconciles the
// cache through recover() so the retry recovers a stranded member rather than waiting for one.
//
// commit({ season, contextHash, regNullifier, commitment }) -> { ok, reason?, index?, membersRoot?, size? }
//
// The engine-neutral core: it runs the identical policy checks, duplicate lookup, and commit for any
// engine. It takes already-decoded `claims`, the engine's crypto check as an injected async
// `verifyProof()`, and `expected.rootStore` (the Poseidon root store for PLONK, the SHA-256 root
// store for the zkVM engine), so the engines differ only outside this function.
export async function verifyRegistrationCore({ claims, verifyProof, expected, registrationStore, commit, recover, gate = (fn) => fn() }) {
  // 0) the caller (the gateway) must name a valid engine and statement, which bind this bucket's
  //    durable declaration. They are gateway-chosen, never taken from the proof, and must be present
  //    and valid, so an engine dispatcher cannot omit them and silently default a custody
  //    registration to derive (which would let the same node re-register under the other statement).
  if (!isValidEngineStatement(expected.engine, expected.statement))
    return { ok: false, reason: "invalid-engine-statement" };

  // 1) the DML root must be one the oracle published recently (engine-specific store). `rootEligible`
  //    is the caller's tighter rule when it has one, since a registration's anchor may be held to a
  //    stricter age than a membership's (a stale root costs an epoch there, and the remainder of the
  //    season here).
  //    Optional, so a caller that supplies none behaves exactly as before.
  //    A predicate that throws is treated as INELIGIBLE rather than allowed to propagate: it is a
  //    security check, so its failure mode is refusal, and a caller's broken rule must not turn a
  //    registration into a 500 either.
  const rootOk = () => {
    try {
      // BOTH, not either. The window's own rule is the floor and `rootEligible` is an ADDITIONAL
      // tighter rule, which is what the comment above promises. Treating the predicate as a
      // replacement made the contract depend on every caller remembering to re-check recency inside
      // its own predicate, and a caller that forgot would have widened acceptance while reading like
      // it narrowed it.
      if (expected.rootStore.isRecent(claims.root) !== true) return false;
      if (typeof expected.rootEligible !== "function") return true;
      return expected.rootEligible(claims.root) === true;
    } catch {
      return false;
    }
  };
  // 2) the season must be the one being registered
  if (String(claims.season) !== String(expected.season)) return { ok: false, reason: "wrong-season" };
  // 3) the proof must be scoped to this community, platform, and role
  if (String(claims.contextHash) !== String(expected.contextHash)) return { ok: false, reason: "wrong-context" };
  // 4) one voting key registers once per season and context. A cheap read so an obvious replay is
  //    rejected before the expensive proof verify; the durable append in commit is the authority.
  //    RECONCILE THE MEMBERS TREE BEFORE ANSWERING. Normally an already-registered member is also
  //    present in the cached members tree, so answering already-registered is right. But a durable
  //    member can be ABSENT from the cache (the A2 strand: a first commit whose durable write held while
  //    its confirming reread failed skipped the tree append, and this very short-circuit then keeps the
  //    retry from ever reaching commit, so nothing rebuilds the cache until a rollover or restart).
  //    recover() reconciles the context's tree with the durable records, putting a stranded member back
  //    so a later /v1/members read serves them a valid path. It runs no proof verify, since the durable
  //    record is the authority a proof already established, and it rebuilds only when the cache is behind.
  //    Optional, so a caller that supplies no recover behaves exactly as before.
  //
  //    THIS RUNS BEFORE THE ANCHOR-FRESHNESS RULE ON PURPOSE. A re-review of the recovery found that
  //    checking root recency first rejects a stranded member whose DML root has aged out with
  //    stale-or-unknown-root, and that member cannot make a fresh proof if the masternode has since left
  //    the list, so the root rule would permanently deny a durable, already-entitled seasonal membership.
  //    The anchor rule exists to gate a NEW registration buying a season against a stale root; an
  //    already-durable registration bought its season already, so recovering its cache entry does not
  //    depend on current root freshness. Season and context are still checked above, so recovery is
  //    scoped to the right bucket.
  if (await registrationStore.has(claims.season, claims.contextHash, claims.regNullifier)) {
    if (typeof recover === "function") await recover(claims.season, claims.contextHash);
    return { ok: false, reason: "already-registered" };
  }

  // 1) the DML root must be current, checked here for a NEW registration (an already-durable one was
  //    handled above without it). Deferred from the top of the function so the duplicate recovery above
  //    is not blocked by a stale anchor.
  if (!rootOk()) return { ok: false, reason: "stale-or-unknown-root" };

  // 5) the proof itself (PLONK verify, or the zkVM receipt verify against the pinned image id). Run
  //    it through `gate` so the gateway can bound global concurrency of the expensive verify. The
  //    gate wraps ONLY this crypto check, so the cheap policy rejections above never consume a slot.
  if (!(await gate(verifyProof))) return { ok: false, reason: "invalid-proof" };

  // 5.5) THE ANCHOR IS RE-ASKED AFTER THE PROOF, before the durable commit. Check 1 ran before a
  //      verification that takes real time, and the root can age out or be evicted inside it, so
  //      without this a registration could be committed for a season against a root the gateway had
  //      already stopped accepting. Same shape as the membership path's period recheck: a value read
  //      before an await must be read again before the irreversible step.
  //      BUT RECOVER FIRST IF THIS KEY BECAME DURABLE DURING THE PROOF. A concurrent request for the
  //      same key can land and strand the member while this proof verifies, so this request is now
  //      effectively a retry. A third-round review found that returning stale-or-unknown-root here would
  //      leave that member stranded when the anchor also aged out, defeating the rule that an
  //      already-durable member does not depend on anchor freshness. So re-check the duplicate and
  //      recover before applying the anchor rule, the same order as the initial check.
  if (!rootOk()) {
    if (await registrationStore.has(claims.season, claims.contextHash, claims.regNullifier)) {
      if (typeof recover === "function") await recover(claims.season, claims.contextHash);
      return { ok: false, reason: "already-registered" };
    }
    return { ok: false, reason: "stale-or-unknown-root" };
  }

  // 6) the atomic, season-serialized commit. expected.season is the gateway's authoritative season
  //    (equal to claims.season by check 2), used for the season re-check inside commit. The engine
  //    and statement are gateway-chosen (the deployment's engine and the request's declared
  //    statement), never taken from the proof, so the durable declaration binds the bucket to them.
  return commit({
    season: expected.season,
    contextHash: claims.contextHash,
    regNullifier: claims.regNullifier,
    commitment: claims.commitment,
    engine: expected.engine,
    statement: expected.statement,
    // The anchor this proof was checked against, passed through so the caller can re-ask about it
    // inside its own critical section without re-deriving it from an engine-specific signal layout.
    root: claims.root,
  });
}

// The PLONK-facing registration verify, backward-compatible. Decodes the five-signal array to claims,
// then runs the engine-neutral core with the PLONK crypto check. verifyProof is injectable (defaults
// to snarkjs PLONK) so a unit test can drive the policy pipeline without a real proof, mirroring
// verifyMembership. The zkVM registration path (deferred with the live receipt verifier and the
// SHA-256 root store) decodes the journal with decodeZkvmRegistrationClaims and calls
// verifyRegistrationCore with a receipt-verifying verifyProof and the SHA-256 root store.
export async function verifyRegistration({
  vkey,
  proof,
  publicSignals,
  expected,
  registrationStore,
  commit,
  recover,
  verifyProof = () => snarkjs.plonk.verify(vkey, publicSignals, proof),
  gate = (fn) => fn(),
}) {
  // This wrapper is the PLONK engine, so it pins its own engine, and a mismatched declaration from a
  // mis-wired dispatcher is rejected before anything is decoded or committed. Otherwise the zkVM and
  // PLONK wrappers could each commit a record under the other's label, corrupting the durable
  // declaration and the seasonHasEngine downgrade signal.
  if (expected.engine !== "plonk") return { ok: false, reason: "engine-mismatch" };
  const decoded = decodePlonkRegistrationClaims(publicSignals);
  if (decoded.error) return { ok: false, reason: decoded.error };
  return verifyRegistrationCore({ claims: decoded.claims, verifyProof, expected, registrationStore, commit, recover, gate });
}

// The zkVM-facing registration verify, the engine sibling of verifyRegistration. It decodes the
// frozen 136-byte journal from the receipt (untrusted at this point, exactly as the PLONK path reads
// publicSignals before verifying), runs the same engine-neutral core, and its crypto check is the
// injected verifyReceipt: it must confirm the STARK receipt verifies against the pinned guest image
// AND that the receipt's committed journal equals the bytes the claims were decoded from, so a caller
// cannot pair a valid receipt with a different journal. The policy checks (root, season, context,
// duplicate) run on the decoded claims BEFORE the expensive receipt verify, like the PLONK path.
//
// expected.rootStore is the SHA-256 view (dmlRoots.shaView()), so the root claim is checked against
// the SHA-256 window, and expected.engine/statement are the gateway-chosen zkVM declaration.
//
// verifyReceipt(receipt, journalBytes) -> Promise<boolean> is injected because it needs the RISC Zero
// verifier (a pinned r0vm subprocess or a WASM build), which is deferred and artifact-gated. A unit
// test injects a stub. A gateway configured for the zkVM engine must supply a real one or refuse to
// boot (there is no default, so an unconfigured zkVM verify fails closed rather than skips the check).
export async function verifyZkvmRegistration({ receipt, journalBytes, verifyReceipt, expected, registrationStore, commit, recover, gate = (fn) => fn() }) {
  // This wrapper is the zkVM engine, so it pins its own engine (see the PLONK wrapper's note), so a
  // mismatched declaration cannot commit a zkVM registration under a PLONK label.
  if (expected.engine !== "zkvm") return { ok: false, reason: "engine-mismatch" };
  const decoded = decodeZkvmRegistrationClaims(journalBytes);
  if (decoded.error) return { ok: false, reason: decoded.error };
  if (typeof verifyReceipt !== "function") return { ok: false, reason: "zkvm-verifier-not-configured" };
  return verifyRegistrationCore({
    claims: decoded.claims,
    verifyProof: () => verifyReceipt(receipt, journalBytes),
    expected,
    registrationStore,
    commit,
    recover,
    gate,
  });
}
