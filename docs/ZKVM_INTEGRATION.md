# zkVM registration integration design

Status: design under review, first draft 2026-07-23, revised the same day after two independent
review rounds (a design-consistency round, then a full multi-reviewer round once guest v2 and the
harness existed). Guest v2 is implemented and measured, the cross-implementation golden vectors pass,
and its statement soundness was reviewed with no malleability path found, but the cost is not settled:
the production statement measured 9.6 GB and 77 minutes at default segments (the three in-guest
Poseidon hashes dominate), failed the 8 GB cap, and the segment-size reruns that decide the fit are in
flight (see `docs/REDUCING_PROVING_COST.md`). What is settled is the shape (two-tier retained, the
zero-knowledge virtual machine (zkVM) receipt replaces only the registration proof) and the statement
(derive the key). What is deliberately NOT settled is the receipt verification path,
which is a gated decision with two candidates measured in work-plan step 3. Everything here is
specified against the gateway and circuits as they exist today.

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
- season: a non-negative integer, decimal string.
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

## Receipt verification at the gateway, a gated decision

Two candidates, decided by measurement in work-plan step 3, not before:

- Wrapped receipt (STARK-to-SNARK, Groth16 over BN254). Verifies in the gateway's existing
  JavaScript stack with a tiny key, zero new operational surface. The cost: RISC Zero's wrap rests
  on a circuit-specific Groth16 setup (their ceremony), which reintroduces exactly the
  trusted-setup dependence the cost doc's transparency argument counts against the current PLONK
  stack. Choosing it means revising that argument honestly, the setup moves from
  "universal, Hermez" to "circuit-specific, RISC Zero's ceremony", and stating the accepted trust.
- Unwrapped STARK receipt, verified by a small verifier the gateway invokes (a pinned-version
  subprocess or a WASM build). Fully transparent, no new setup, at the cost of a non-JavaScript
  component in the deployment and a larger receipt.

Step 3 measures, for both candidates: member-side cost (the wrap step's memory under the same 8 GB
cap as the prove, with the docker cgroup's peak captured separately since RISC Zero runs its Groth16
prover in docker outside the host process, and its time), the encoded HTTP request-body size against
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

1. Pin the protocol bytes and the compatibility vectors. The SHA-256 tree spec above as executable
   test vectors, the journal byte layout, and the Poseidon golden vectors (circomlibjs against
   light-poseidon, both formula forms). This step decides the hard prerequisite and freezes every
   byte the guest will commit to.
2. Guest v2 in the research prototype, the five-claim statement above against the frozen bytes,
   with journal correctness asserted against a circomlibjs-computed expected set, measured in the
   bench (peak memory, proving time).
3. Receipt-path measurement, both candidates: wrap memory and time under the 8 GB cap as one
   combined prove-and-wrap run, receipt sizes, Node-side verification for each, gateway
   verification time. Then decide the candidate, and update the cost doc's trusted-setup section to
   match the decision.
4. Oracle dual-root snapshot, the v2 signed message, and the deployment-scoped snapshot
   requirement at the gateway.
5. Gateway claims-object refactor, the second root store, engine dispatch with the pinned image
   identifier, the durable engine declaration in the registration store, and the measured limits
   (body size, registration rate, verification concurrency).
6. Member proving flow and docs, including the secret-file ordering fix and engine discovery.

Steps 1 through 3 live entirely in `research/` and the bench, so they are cheap to iterate and
nothing ships until step 4. The committed PLONK keys stay valid throughout, and single-tier mode is
unaffected at every step.

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
