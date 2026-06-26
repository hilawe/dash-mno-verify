import { readFile } from "node:fs/promises";
import * as snarkjs from "snarkjs";

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
export async function verifyMembership({ vkey, proof, publicSignals, expected, nullifiers }) {
  const s = readSignals(publicSignals);

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

  // 5) one masternode, one membership per epoch
  if (nullifiers.has(s.epoch, s.contextHash, s.nullifier))
    return { ok: false, reason: "already-used" };

  // 6) the zero-knowledge proof itself. PLONK, so the verification key comes from a
  // transparent universal setup (the public Hermez Powers of Tau), with no per-circuit
  // ceremony.
  const valid = await snarkjs.plonk.verify(vkey, publicSignals, proof);
  if (!valid) return { ok: false, reason: "invalid-proof" };

  nullifiers.add(s.epoch, s.contextHash, s.nullifier);
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

// Verify a two-tier registration proof. On success it appends the member commitment to the
// members tree, so one masternode registers exactly one commitment per season and context.
export async function verifyRegistration({ vkey, proof, publicSignals, expected, regNullifiers, membersTree }) {
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
  // 4) one masternode registers once per season and context
  if (regNullifiers.has(s.season, s.contextHash, s.regNullifier)) return { ok: false, reason: "already-registered" };

  // 5) the proof itself
  const valid = await snarkjs.plonk.verify(vkey, publicSignals, proof);
  if (!valid) return { ok: false, reason: "invalid-proof" };

  regNullifiers.add(s.season, s.contextHash, s.regNullifier);
  const index = membersTree.append(s.commitment);
  return { ok: true, commitment: s.commitment, index, membersRoot: membersTree.root() };
}
