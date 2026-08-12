// The nullifier and commitment derivation chains, spelled independently in JS so the circuits can
// be differentially checked against them (scripts/check_circuits.sh, the derivation checks).
//
// These are the same chains the circuits compute in circomlib Poseidon:
//   mno_members.circom      nullifier    = Poseidon3(secret, epoch, contextHash)
//   mno_membership.circom   nullifier    = Poseidon3(Poseidon4(privkey limbs), epoch, contextHash)
//   mno_registration.circom regNullifier = Poseidon3(Poseidon4(privkey limbs), season, contextHash)
//   mno_registration.circom commitment   = Poseidon1(secret), also the members-tree leaf
//
// The seam this pins is cross-implementation agreement, circomlibjs (what the prover and the
// members tree use) against circomlib's circuit templates (what the proofs compute), over the
// exact input order, arity, and limb order of each chain. Production depends on that agreement
// already: prover/two_tier.js derives Poseidon(secret) in JS to find its leaf in the members
// tree the gateway built in JS, and the circuit must reproduce both. A disagreement here is a
// member who can never prove, or a spent tag that no longer follows the intended derivation.
//
// What this does not establish: anything about Poseidon itself, or the ECDSA component. The
// chains are checked as wirings of Poseidon, against an independent spelling of the same wiring.

// nullifier chain of the cheap per-epoch members circuit
export function membersNullifier(poseidon, secret, epoch, contextHash) {
  const F = poseidon.F;
  return F.toObject(poseidon([F.e(secret), F.e(epoch), F.e(contextHash)])).toString();
}

// nullifier chain of the key-bearing circuits (membership uses epoch, registration uses season)
export function keyNullifier(poseidon, privkeyLimbs, epochOrSeason, contextHash) {
  const F = poseidon.F;
  const keyHash = poseidon(privkeyLimbs.map((l) => F.e(BigInt(l))));
  return F.toObject(poseidon([keyHash, F.e(epochOrSeason), F.e(contextHash)])).toString();
}

// the member commitment, also the members-tree leaf
export function commitment(poseidon, secret) {
  const F = poseidon.F;
  return F.toObject(poseidon([F.e(secret)])).toString();
}
