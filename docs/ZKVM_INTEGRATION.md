# zkVM registration integration design

Status: design reviewed over four adversarial rounds (no statement-soundness hole found) and settled
on its measured numbers. Guest v2 is implemented and measured, the cross-implementation golden vectors
pass, and the cost questions are answered: the production statement fits an 8 GB machine at
`segment_limit_po2 = 19` (4.8 GB measured under an enforced cap, about 86 minutes; see
`docs/REDUCING_PROVING_COST.md`). Settled: the shape (two-tier retained, the zero-knowledge virtual
machine (zkVM) receipt replaces only the registration proof), the statement (derive the key), and the
receipt path (the unwrapped STARK receipt, decided 2026-07-23 on the step-3 measurements, keeping the
no-trusted-setup property), and wallet custody as an opt-in per community and season (decided
2026-07-23, see the two-statements section for why the opt-in cannot be per member). Everything
here is specified against the gateway and circuits as they exist today.

## The shape

The two-tier structure is retained exactly as is, and only the registration proof's engine changes.

- The heavy once-per-season registration proof moves from the PLONK `mno_registration` circuit to a
  RISC Zero receipt. This is where the 2.3 GB proving key lives, and it is the only place, so the
  swap removes the large download entirely. It is also where minutes of proving are acceptable,
  because a member registers once per season.
- The cheap per-epoch members proof, the members tree, the nullifier stores, the challenge flow, and
  every gateway policy check keep their current behavior. The per-epoch proof already has a small
  hosted key and proves in seconds, so moving it to the zkVM would only make members wait minutes
  every epoch for nothing.

## The statement and the claims object

The guest proves the same relation `mno_registration` proves, over the same five semantic values the
gateway reads today: commitment, regNullifier, root, season, contextHash.

The wire representation cannot be the existing `publicSignals` array. `verifyRegistration` requires
all five entries to be canonical BN254 field elements before reading them, and a SHA-256 root (the
next section) is an arbitrary 32-byte digest that frequently exceeds the BN254 modulus, so it can
never pass that gate. The verifier therefore refactors around an engine-neutral claims object, produced by an
engine-specific decoder (the PLONK decoder reads the existing five-signal array and keeps the
canonical-field checks exactly as they are, the zkVM decoder parses the journal bytes). The field
types are fixed as follows:

- commitment: a canonical BN254 field element, decimal string (both engines, it feeds the Poseidon
  members tree).
- regNullifier: a canonical BN254 field element, decimal string (both engines, it is a Poseidon
  output and the unique-index key).
- root: engine-dependent, a canonical BN254 field element as a decimal string for the PLONK engine
  (the Poseidon root), a 64-lowercase-hex string for the zkVM engine (the SHA-256 root).
- season: an unsigned 64-bit integer, decimal string. The zkVM guest reads season as a u64 and the
  journal encodes it as 8 big-endian bytes, so this u64 bound is the binding constraint and must be
  enforced everywhere season is set, in configuration, in snapshot ingestion, in both engine
  decoders, and in the serialized commit. PLONK would accept any canonical field element, so a
  season scheme that ever produced a value above 2^64 - 1 would validate under PLONK but be
  unrepresentable in the zkVM. Season is a small monotonic counter, so u64 is ample, but the bound is
  stated rather than assumed to keep the two engines interchangeable.
- contextHash: a canonical BN254 field element, decimal string (computed by the gateway today, both
  engines).

The policy checks, the duplicate lookup, and the serialized commit all consume the claims object,
so they stay engine-neutral. The gateway also keeps two root stores, the existing Poseidon store and a SHA-256
store filled from the same snapshots, and the root check dispatches on the engine.

Private witness: the voting private key `d`, the fresh high-entropy member `secret`, and the Merkle
authentication path. In-guest computation:

1. `P = d * G` on secp256k1, then `keyID = hash160(compressed P)`, the DML leaf. The `k256` crate's
   scalar parsing accepts exactly `[1, n)`. The circuit's M1 constraint accepts `[0, n)`, so the
   ranges differ at zero only, which no real key occupies, and the zkVM range is the stricter one.
   The integration pins this with tests that a key of `n`, of `n + d`, and of `0` are all rejected
   (the `n + d` vector chosen to still fit 32 bytes).
2. Merkle inclusion of `keyID` in the DML tree under the SHA-256 spec below, where the zkVM has a
   native accelerator.
3. `commitment = Poseidon(secret)` and `regNullifier = Poseidon(Poseidon(d_limbs), season,
   contextHash)`, exactly as the circuit computes them, including the circom-ecdsa limb layout of
   `d` (4 little-endian 64-bit limbs, the same conversion `prover/two_tier.js` performs) fed to a
   4-input Poseidon. Poseidon here means the circomlib parameterization over the BN254 scalar field.

Circomlib-compatible Poseidon in the guest is a hard prerequisite, not a preference with a fallback.
The commitment feeds the PLONK members tree, and `mno_members.circom` recomputes `Poseidon(secret)`
in-circuit, so an incompatible commitment hash would strand every zkVM registrant at their first
per-epoch proof. There is no engine-scoped fallback for it. The candidate implementation is the
light-poseidon crate, validated by work-plan step 1 (cross-implementation golden vectors against
circomlibjs, covering both `Poseidon(secret)` and the 4-limb `Poseidon(d_limbs)` form, pinned in
both test suites). If the crate does not match, the fallback is porting the circomlib constants into
the guest until the vectors pass, not changing the formula.

Matching the nullifier formula bit for bit also means both engines emit identical registration
nullifiers for the same key, season, and context, so the registration store's unique index on
(season, contextHash, regNullifier) deduplicates across engines and a node cannot hold one
membership through each. This holds for the file store today and for the Platform contract's
declared unique index when that backend lands.

## Two statements, derive and wallet custody, and where the opt-in lives

Both statements ship (owner decision, 2026-07-23): derive the key (the default) and wallet custody
(the member signs, the key never enters the prover). Both emit the same five-claim journal, so the
gateway verifies them identically and only needs to accept both guest image identifiers. The measured
cost of custody is time, not memory, and both fit 4.8 GB at po2 19.

The constraint that decides HOW the opt-in works, stated plainly because it is not obvious. The
registration nullifier is `Poseidon(Poseidon(privkey), season, contextHash)`, keyed on the private
key. That key choice is what makes one node yield one nullifier per (season, context) AND keeps the
nullifier unlinkable to the node's public `hash160` leaf. The custody prover does not have the private
key, so it cannot compute this nullifier. The alternatives do not work either: keying on the public
key or `hash160` leaf would let anyone recompute a candidate's nullifier from the public DML and
de-anonymize which node registered, and keying on a signature reintroduces a uniqueness problem,
because an ECDSA signature over a fixed message is not unique unless the circuit also proves the nonce
was generated deterministically (RFC 6979), which is expensive and itself a research problem. So the
derive and custody statements produce DIFFERENT nullifiers for the same node, and no cheap change
makes them match.

The consequence: derive and custody cannot both be allowed for the same (season, contextHash), or one
node could register once through each and hold two memberships, breaking one voting key, one
membership. Therefore the opt-in is per community and season, not per member: a (season, contextHash)
declares its statement (derive or custody), and every member of that community proves with the same
one, so all its nullifiers are comparable and the unique index still holds. This reuses the durable
engine-declaration mechanism (below), extended from engine to statement. An operator who wants to
offer members a choice runs two communities, or accepts that per-member choice within one community
waits on a sound shared-nullifier scheme (the deterministic-signature route above, if the nonce
problem is ever solved cheaply). Recommendation: ship derive as the default statement, let operators
opt a community into custody, and record per-member choice as blocked on the nullifier problem, not as
a near-term feature.

## The SHA-256 DML tree, pinned

Per the no-forced-migration analysis in the cost doc, the guest verifies DML inclusion with SHA-256
to use the zkVM accelerator, while everything Poseidon-facing stays Poseidon. The tree is fixed as
follows, matching the research prototype where it already chose, and tightening where the prototype
was loose:

- Leaf hash: `SHA-256(0x00 || keyID)`, where `keyID` is the 20-byte hash160 exactly as it appears
  in the deterministic masternode list (DML) leaf derivation, big-endian byte order.
- Internal node: `SHA-256(0x01 || left || right)` over the two 32-byte children. The domain bytes
  separate leaves from internal nodes.
- Depth: 16, exactly 16 path elements and 16 direction bits, both lengths enforced.
- Direction bits: each bit MUST be 0 or 1, and any other value is rejected (the prototype's
  "any nonzero means right" tolerance does not carry over). Bit 0 places the current node on the
  left of its sibling, bit 1 places it on the right, matching the circuit's pathIndices convention.
- Empty slots: the empty leaf is the 20-byte zero string, so the empty-leaf hash is
  `SHA-256(0x00 || 0x00^20)`, and empty subtrees fold up through the internal-node rule, mirroring
  the Poseidon tree's zero-padding structure.
- Wire encoding of the root: raw 32 bytes inside the guest journal (the appendix layout), and
  64 lowercase hex characters everywhere it is text, meaning JSON snapshots, HTTP requests, and the
  decoded claims object. The journal is a fixed-width byte record, so it carries the raw bytes, not
  the hex, and a decoder that expected 64 ASCII bytes there would reject every valid 136-byte
  journal.

The same ordered leaves produce both roots, and the sort order is the oracle's existing
list-key sort, unchanged.

## The dual-root snapshot and the version rule

- `oracle/snapshot.js` computes both roots from the one sorted leaf list, publishing the existing
  Poseidon root under the existing field and the SHA-256 root under a new field.
- The signed message (`common/oracle_sig.js`) grows the second root, a breaking change to the
  signed byte layout, so the domain string versions to `mno-oracle-snapshot-v2` with the SHA-256
  root appended to the field list, and the snapshot carries an explicit version field.
- The rule that actually prevents a downgrade is deployment-scoped, not signature-scoped: a gateway
  REQUIRES every adopted snapshot to carry the SHA-256 root under a v2 quorum signature whenever
  any context is zkVM-engined, judged by the durable engine declarations of the current season as
  well as the configured intent, and rejects a snapshot lacking either, the same fail-closed
  posture the signature quorum already has. Judging by durable declarations matters because a
  restart after the operator configures a next-season rollback must not accept v1 snapshots while
  current-season zkVM registrations are still the ones being verified. A v1 snapshot therefore
  cannot become current on such a deployment at all. Gateways with no zkVM context, configured or
  declared, keep accepting v1 until they opt in.
- The two roots commit to the same leaves by construction, and the gateway recomputes both on every
  refresh (the M3 discipline applied twice), so no in-circuit bridge proof is needed, exactly as
  the cost doc argues.

## Root freshness against a long proof

A registration proof binds a DML root, and the gateway accepts it only if that root is still within
its recency window (`MNO_ORACLE_MAX_AGE`) at submission. The production statement takes about 77
minutes to prove (the measured default-segment number, and slower still at po2 19), which collides
with that window: a member who starts proving against a fresh root can finish after it has aged out,
and the registration is rejected through no fault of theirs. Widening the window to cover the proof
naively is not free, because the window is also the stale-ownership exposure. A root accepted for
longer means a node that left the DML during that span can still complete a registration against the
root that still listed it.

The policy this design commits to, so it is decided rather than defaulted:

- Bind an explicit issuance time into the registration challenge, and accept a proof only if the
  bound root was current at issuance and the proof arrives within a `MNO_REG_PROOF_MAX_AGE` lease
  that covers proving, queueing, and one retry (a small multiple of the measured proving time, so on
  the order of a few hours, not the per-epoch window).
- Keep the accepted-root window sized to that lease, not longer, and state the exposure plainly: the
  worst case is one lease of stale ownership on the once-per-season registration, which the
  season-boundary re-registration already bounds, and which the per-epoch proof (unchanged, seconds
  to prove) does not share.
- The lease is a registration-only concept. The cheap per-epoch proof keeps the existing short
  freshness window, since it proves in seconds and has no long-proof collision.

This is why the proving-time number is a first-class design input, not just a cost figure: it sets
the lease, and the lease sets the exposure. If the po2 19 or an accelerated-Poseidon result brings
proving well under an hour, the lease and the exposure both shrink accordingly.

## Receipt-path measurements (2026-07-23)

The step-3 numbers are in, and they draw the two candidates sharply.

| | Unwrapped STARK | Wrapped Groth16 |
| --- | --- | --- |
| Receipt size | about 4.8 MB | 769 bytes |
| HTTP request body | about 4.8 MB binary, or 6.4 MB if base64 in JSON | about 0.8 KB, or 1.1 KB base64 |
| Gateway verify time | about 410 ms (Rust), 820 ms (Node subprocess) | about 5 to 14 ms |
| Trusted setup | none (transparent) | reintroduces a circuit-specific Groth16 ceremony |
| Member proving cost | the prove alone (about 86 min, 4.8 GB) | prove plus wrap, about 119 min, docker required, indicative 7.7 GB container peak (see the limitation above) |

Both paths verified end to end from Node with genuine rejections (wrong image id, corrupt receipt, and
the host also rejects a tampered journal). On size, the unwrapped receipt is 4.8 MB, which is small in
absolute terms for a once-per-season upload to a server, and larger only relative to the gateway's
current `MNO_MAX` request-body cap of 2 MB, which is a configuration default chosen for the small
PLONK-era proofs, not a protocol or network limit. The 6.4 MB figure is the base64 tax of carrying the
receipt in a JSON field; a binary or multipart upload carries the raw 4.8 MB. So the unwrapped path
needs a raised body cap (a one-line config change) and preferably a binary upload, and it warrants a
deliberate choice about how many unauthenticated bytes the registration endpoint parses before the
proof check (bounded by the rate limit and the cap). None of that is a real obstacle. The wrapped path
is tiny and fast to verify but costs the member about 33 extra minutes, a docker dependency, and the
trusted-setup property the transparency argument counts against. Weighed on the properties, the
unwrapped path's only genuine costs are gateway verify time (sub-second) and a config change, so it is
the leaning recommendation, with the wrapped path reserved for a deployment that specifically needs the
tiny fast receipt more than transparency. This is the owner's decision; the measurements frame it, they
do not force it.

## Receipt verification at the gateway, decided: unwrapped STARK

Decided 2026-07-23 (owner), on the step-3 measurements above: the gateway verifies the unwrapped
STARK receipt, not the wrapped Groth16 form. The reasoning is the properties, not the raw sizes. The
unwrapped path keeps the no-trusted-setup transparency the whole cost doc argues for, and its costs
are gateway-side and cheap to absorb: sub-second verification and a receipt of about 4.8 MB, which is
small for a once-per-season upload and larger only than the configurable `MNO_MAX` body default, not
any real limit. The wrapped path would trade that transparency away, reintroducing a circuit-specific
Groth16 ceremony, and would push about 33 extra minutes and a docker dependency onto every member's
prove, to buy a tiny receipt the server does not need. A server absorbs a few-megabyte upload far
more easily than a member absorbs docker and a longer prove, so the balance favors unwrapped.

What the decision commits the gateway to:

- A non-JavaScript STARK verifier the Node gateway invokes, either a pinned-version `r0vm`-based
  subprocess or a WASM build of the verifier, pinned by artifact checksum (not version alone). This
  is the accepted operational cost of transparency.
- A raised `MNO_MAX` request-body cap sized to the receipt, and a binary or multipart receipt upload
  rather than base64 in JSON (which added a needless 33% to the wire size), with the pre-verification
  body size kept deliberate on the registration endpoint since the body is parsed before the proof
  check.
- The verification-binding order below is unchanged, and the wrap-only artifacts (seal, docker) are
  dropped from the shipping path.

A measurement limitation from the comparison is retained for the record. RISC Zero runs its
Groth16 wrap in a docker container in its own cgroup, and it does not expose docker's
`--cgroup-parent`, so on a shared GitHub runner the combined prove-and-wrap peak cannot be enforced
under one 8 GB cgroup or read reliably. The bench therefore reports the host-process peak, the wall
time, and the indicative maximum single docker container `memory.peak` observed, and a definitive capped
wrapped-memory number needs a dedicated runner with a slice-scoped or rootless docker whose whole
process tree is one cgroup. Until that exists, the wrapped candidate's 8 GB fit is not settled, which
is itself an input to the decision (the unwrapped path has no such measurement obstacle).

Step 3 measures, for both candidates: member-side cost (the wrap step's memory under the same 8 GB
cap as the prove where measurable, with the limitation above, and its time), the encoded HTTP request-body size against
the gateway's existing 2 MB limit (raised deliberately or not at all), gateway verification time
(which sets the registration rate limit and a global verification-concurrency bound), and end-to-end
verification FROM NODE, not just from Rust, because the gateway is a Node process. The Node harness
(`research/risc0-registration/scripts/verify_receipt.mjs`) decodes the exact request body, binds the
configured guest image identifier to the exact journal bytes, invokes the real verifier, and rejects
an altered journal or image identifier, so the measured numbers are the gateway's real numbers. The
combined member workflow (prove then wrap, if wrapping) is measured as one run under the cap, not as
two isolated peaks, since the gate number is the workflow's peak.

Whichever candidate wins, verification binding is part of the design, not an implementation detail.
The gateway pins the guest image identifier (and, if wrapping, the wrap verification key and its
checksum, and if unwrapped, the verifier executable or WASM artifact by checksum, not by version
alone) in configuration next to the existing verification keys. The order of operations is: decode
the size-bounded request and parse the journal bytes into the claims object, run the policy checks
against expected values, the cheap duplicate lookup, then the expensive cryptographic verification,
which checks that the receipt's claim binds the pinned image identifier to exactly the journal
bytes the claims were decoded from, then the serialized commit which re-checks season and engine
inside the queue. Decoded claims are working data until that verification step authenticates them,
nothing is granted or stored on their basis earlier, which preserves the existing invariant that
policy runs before cryptography and nothing expensive runs inside the serialized section.

## Engine declaration and cutover

A context's season declares its registration engine, and a season boundary is the only point the
engine can change. Configuration alone cannot carry this, because a restart or a config edit
mid-season would silently switch engines. So the declaration is durable: the first registration
committed for a (season, context) records the engine in the registration record, the store enforces
one engine per (season, context) (a mismatch is rejected inside the same serialized commit that
closes the rollover race), and the configured engine is the intent that seeds the first record.
Existing PLONK registrations remain valid until their season expires and are never migrated, and a
season boundary already empties the members tree, so cutover needs no record surgery. Rollback is
the same mechanism in reverse, flip the configured engine back and it takes effect for the next
season, and an emergency mid-season rollback is deliberately impossible for the same reason a
mid-season switch is.

With the nullifier-identity property above, even a misconfigured deployment that briefly ran both
engines against one (season, context) would be caught by the unique nullifier index, so the durable
engine declaration is the rule and the index is the backstop.

## Member-facing surface

- Discovery: `/v1/challenge` and the health endpoint report the context's engine, and the DML
  endpoint serves both roots, so a member's tooling knows which prover to run without guesswork.
- The member secret: the current two-tier CLI writes a freshly generated secret to disk before it
  knows whether registration was accepted, so a rerun after an accepted registration can overwrite
  the secret that the accepted commitment binds. The fixed ordering, for both engines, accounts for
  the lost-response case (the gateway commits but the acknowledgment never arrives, after which a
  retry is rejected as a duplicate and a discarded secret would be unrecoverable). Write the secret
  to disk atomically BEFORE submitting, never overwrite an existing secret file without an explicit
  flag, reuse the on-disk secret for retries of the same (season, context), and mark it accepted
  once the gateway acknowledges (or once a retry's duplicate rejection confirms the earlier commit
  landed).
- The prove flow replaces the proving-key download step in the member docs with installing the zkVM
  prover runtime, and the registration request carries the receipt in the engine-specific field the
  claims decoder expects.

## Work plan, in order

Protocol bytes are settled before anything is measured against them, so no later step invalidates
an earlier measurement.

Steps 1 through 3 are done (in `research/` and the bench). Steps 4 onward are the shipping
integration and have not started.

1. DONE. Pinned the protocol bytes and the cross-implementation golden vectors (the frozen 136-byte
   journal, the SHA-256 tree spec, the Poseidon forms; `test/vectors/zkvm_golden.json` regenerated
   by circomlibjs and reproduced by light-poseidon).
2. DONE. Guest v2, the five-claim statement, journal asserted against the fixture on CI, measured in
   the bench (4.8 GB at po2 19 under the 8 GB cap, about 86 minutes).
3. DONE. Receipt path measured and decided: the unwrapped STARK receipt (see the receipt section
   above), keeping the no-trusted-setup property.
4. DONE (2026-07-24). Oracle dual-root snapshot: `buildSnapshot` emits `version: 2` and the SHA-256
   `shaRoot` derived from the same leaves (`common/dml_sha_root.js`, pinned against the fixture in
   `test/dml_sha_root.test.js`). The signed message versions to `mno-oracle-snapshot-v2` covering the
   shaRoot, with v1 byte-identical for backward compatibility and neither signature replayable as the
   other (`common/oracle_sig.js`). The gateway recomputes the shaRoot from the leaves alongside the
   Poseidon root, and `MNO_REQUIRE_SHA_ROOT=1` makes a zkVM deployment refuse a v1 (rootless)
   snapshot, the deployment-scoped downgrade rule (`core/gateway.js`, `core/config.js`). The quorum
   signing script recomputes the shaRoot before attesting. Serving the shaRoot to provers and the
   durable-declaration refinement of the require-flag land with step 5.
5. Gateway integration, in progress. DONE (2026-07-24), the engine-neutral spine: `verifyRegistration`
   is refactored into `verifyRegistrationCore` (one policy-check, duplicate-lookup, and commit
   pipeline for any engine) plus per-engine decoders, `decodePlonkRegistrationClaims` (the existing
   five-signal array) and `decodeZkvmRegistrationClaims` (the frozen 136-byte journal, pinned against
   the fixture), with the crypto check injected so the zkVM path reuses the pipeline. The gateway
   serves the `shaRoot` on `/v1/dml`, and the registration endpoint has its own larger body cap
   (`MNO_MAX_REGISTER_BODY_BYTES`) for the receipt while challenge and verify keep the small cap. DONE
   (2026-07-24), the SHA-256 root window: `shaRoots` (a second `RootStore`) is kept in lockstep with
   the Poseidon `dmlRoots` by `updateRootWindows` on adoption and a paired `dropOlderThan` on aging,
   so a zkVM root check sees exactly the snapshots the Poseidon check does, pinned by
   `test/root_windows.test.js`. DONE (2026-07-24), the durable
   per-(season, context) engine-and-statement declaration: `RegistrationStore` records (engine,
   statement) on each record, the first registration in a bucket declares it, and a later append with
   a different declaration is rejected (`statement-mismatch`) inside the serialized append, so a
   bucket is bound to one statement and derive and custody cannot mix (which would allow a double
   registration). An impossible pair (PLONK custody) is rejected, and a legacy record defaults to
   plonk/derive. STILL TO DO in step 5: the live non-JavaScript STARK verifier wired at boot and
   pinned by image-id and artifact checksum (artifact-gated, like the Platform backend), engine
   dispatch selecting the decoder and root store per request, the registration proof lease for root
   freshness, and the verification-concurrency bound. The Platform registration backend, when wired,
   will also need `declarationFor`, `seasonHasEngine`, and the same per-bucket enforcement.

   A full multi-model round over the accumulated step-4-and-step-5 surface (2026-07-24) found three
   cross-slice blockers the per-slice reviews could not see, now folded: (1) the downgrade rule
   consulted only the config flag, so a gateway reopened with durable zkVM registrations and the flag
   unset would accept a v1 snapshot, now the rule also consults `RegistrationStore.seasonHasEngine`;
   (2) the two independent root windows could drift when a v2 snapshot was followed by v1 (the
   Poseidon entry advanced while a stale SHA-256 entry lingered), now one `RootWindows` holds both
   roots per snapshot so eviction and aging are atomic, making lockstep structural (the deferred
   facade, brought forward); (3) `verifyRegistrationCore` did not require gateway-chosen engine and
   statement, so a future dispatcher could omit them and silently default custody to derive, now they
   are required and validated before the proof.
6. Member proving flow and docs, including the secret-file ordering fix, a binary receipt upload,
   and engine discovery.
7. The custody statement guest, the production five-claim form of the benchmark `sig` variant
   (wallet signature verification plus the custody nullifier scheme for its communities), measured
   in the bench like guest v2 and offered as the per-community opt-in. Its nullifier derivation
   needs its own design note first, since it cannot be keyed on the private key the prover does not
   have (a candidate is keying on the secret alone with the signature binding the key to the leaf,
   which changes the uniqueness argument and must be reviewed before implementation).

Steps 4 onward are the shipping integration; nothing ships until step 4. The committed PLONK keys
stay valid throughout, and single-tier mode is unaffected at every step.

## Appendix, frozen protocol bytes (work-plan step 1)

The journal is exactly 136 bytes, committed by the guest as one slice, in this order:

1. commitment, 32 bytes, big-endian field element
2. regNullifier, 32 bytes, big-endian field element
3. root, 32 bytes, the SHA-256 tree root
4. season, 8 bytes, big-endian unsigned integer
5. contextHash, 32 bytes, big-endian field element

The cross-implementation golden vectors (both Poseidon formula forms with the 4x64 little-endian
limb layout, and the SHA-256 tree spec including the empty-leaf construction) are pinned twice, in
`test/zkvm_vectors.test.js` (computed by circomlibjs, the reference the circuits are built against)
and in `research/risc0-registration/vectors/` (reproduced by light-poseidon and sha2 in Rust, run
by the zkvm-vectors CI workflow). A drift on either side fails that side's suite.
