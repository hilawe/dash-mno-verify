import { readFile } from "node:fs/promises";
import * as snarkjs from "snarkjs";
import { isCanonicalField } from "../common/field.js";

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
// whose verification key comes from a transparent universal setup (the public Hermez Powers of Tau)
// with no per-circuit ceremony.
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
export async function verifyRegistration({ vkey, proof, publicSignals, expected, registrationStore, commit }) {
  // Canonical before any signal is read or used as the registration-nullifier key (see above).
  if (!signalsAreCanonical(publicSignals, Object.keys(REG_SIGNAL_INDEX).length))
    return { ok: false, reason: "non-canonical-signal" };
  const s = {
    commitment: publicSignals[REG_SIGNAL_INDEX.commitment],
    regNullifier: publicSignals[REG_SIGNAL_INDEX.regNullifier],
    root: publicSignals[REG_SIGNAL_INDEX.root],
    season: publicSignals[REG_SIGNAL_INDEX.season],
    contextHash: publicSignals[REG_SIGNAL_INDEX.contextHash],
  };

  // 1) the DML root must be one the oracle published recently
  if (!expected.rootStore.isRecent(s.root)) return { ok: false, reason: "stale-or-unknown-root" };
  // 2) the season must be the one being registered
  if (String(s.season) !== String(expected.season)) return { ok: false, reason: "wrong-season" };
  // 3) the proof must be scoped to this community, platform, and role
  if (String(s.contextHash) !== String(expected.contextHash)) return { ok: false, reason: "wrong-context" };
  // 4) one voting key registers once per season and context. A cheap read so an obvious replay is
  //    rejected before the expensive proof verify; the durable append in commit is the authority.
  if (await registrationStore.has(s.season, s.contextHash, s.regNullifier)) return { ok: false, reason: "already-registered" };

  // 5) the proof itself
  const valid = await snarkjs.plonk.verify(vkey, publicSignals, proof);
  if (!valid) return { ok: false, reason: "invalid-proof" };

  // 6) the atomic, season-serialized commit. expected.season is the gateway's authoritative season
  //    (equal to s.season by check 2), used for the season re-check inside commit.
  return commit({
    season: expected.season,
    contextHash: s.contextHash,
    regNullifier: s.regNullifier,
    commitment: s.commitment,
  });
}
