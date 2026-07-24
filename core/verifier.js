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

  const claimedBySameAccount = async () => {
    const prior = await nullifiers.get(s.epoch, s.contextHash, s.nullifier);
    return prior != null && String(prior.account) === String(expected.account);
  };

  // 5) one voting key, one membership per epoch and context. An already-spent tag is only let through
  //    as an idempotent re-grant for the account that first claimed it, and only with a fresh valid
  //    proof. The has() check rejects an ordinary replay before the expensive proof verify.
  if (await nullifiers.has(s.epoch, s.contextHash, s.nullifier)) {
    if (!(await claimedBySameAccount())) return { ok: false, reason: "already-used" };
    if (!(await verifyProof(vkey, publicSignals, proof))) return { ok: false, reason: "invalid-proof" };
    return { ok: true, nullifier: s.nullifier, epoch: s.epoch, regranted: true };
  }

  // 6) first claim: verify the proof, then record the spend and the granting account together.
  if (!(await verifyProof(vkey, publicSignals, proof))) return { ok: false, reason: "invalid-proof" };

  // With a shared store, a duplicate here means another request recorded the spend first in a race.
  // Re-grant only if that prior claim belongs to this same account, otherwise it is already used.
  const dup = await nullifiers.add(s.epoch, s.contextHash, s.nullifier, { account: expected.account });
  if (dup && dup.duplicate) {
    if (await claimedBySameAccount()) return { ok: true, nullifier: s.nullifier, epoch: s.epoch, regranted: true };
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
// the member on the next rebuild instead of stranding them for the season.
//
// commit({ season, contextHash, regNullifier, commitment }) -> { ok, reason?, index?, membersRoot?, size? }
//
// The engine-neutral core: it runs the identical policy checks, duplicate lookup, and commit for any
// engine. It takes already-decoded `claims`, the engine's crypto check as an injected async
// `verifyProof()`, and `expected.rootStore` (the Poseidon root store for PLONK, the SHA-256 root
// store for the zkVM engine), so the engines differ only outside this function.
export async function verifyRegistrationCore({ claims, verifyProof, expected, registrationStore, commit }) {
  // 0) the caller (the gateway) must name a valid engine and statement, which bind this bucket's
  //    durable declaration. They are gateway-chosen, never taken from the proof, and must be present
  //    and valid, so an engine dispatcher cannot omit them and silently default a custody
  //    registration to derive (which would let the same node re-register under the other statement).
  if (!isValidEngineStatement(expected.engine, expected.statement))
    return { ok: false, reason: "invalid-engine-statement" };

  // 1) the DML root must be one the oracle published recently (engine-specific store)
  if (!expected.rootStore.isRecent(claims.root)) return { ok: false, reason: "stale-or-unknown-root" };
  // 2) the season must be the one being registered
  if (String(claims.season) !== String(expected.season)) return { ok: false, reason: "wrong-season" };
  // 3) the proof must be scoped to this community, platform, and role
  if (String(claims.contextHash) !== String(expected.contextHash)) return { ok: false, reason: "wrong-context" };
  // 4) one voting key registers once per season and context. A cheap read so an obvious replay is
  //    rejected before the expensive proof verify; the durable append in commit is the authority.
  if (await registrationStore.has(claims.season, claims.contextHash, claims.regNullifier))
    return { ok: false, reason: "already-registered" };

  // 5) the proof itself (PLONK verify, or the zkVM receipt verify against the pinned image id)
  if (!(await verifyProof())) return { ok: false, reason: "invalid-proof" };

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
  verifyProof = () => snarkjs.plonk.verify(vkey, publicSignals, proof),
}) {
  const decoded = decodePlonkRegistrationClaims(publicSignals);
  if (decoded.error) return { ok: false, reason: decoded.error };
  return verifyRegistrationCore({ claims: decoded.claims, verifyProof, expected, registrationStore, commit });
}
