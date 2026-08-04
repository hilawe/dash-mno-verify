# Independent Security Review Playbook

## A practical external-like review program for dash-mno-verify

**Date:** August 4, 2026  
**Status:** Working review plan  
**Project state:** Prototype, not professionally audited

## Purpose

This playbook describes a low-cost substitute for a professional security audit. It combines a
frozen review baseline, clean-room reviewers, adversarial testing, circuit analysis tools,
reproducible artifacts, public peer review, and controlled rollout.

This process can improve the project substantially. It cannot provide the same assurance,
specialized judgment, contractual accountability, or reputational signal as an independent
professional audit. The project should describe the result as **independently reviewed**, not
**audited**.

The most effective cost reduction is to review one narrow production configuration rather than
every mode the repository can run.

## Recommended production profile

The first reviewed deployment should use the smallest defensible surface:

- Two-tier membership mode
- Zero-knowledge virtual machine registration once that path is complete
- The small Poseidon-only `mno_members.circom` recurring proof
- SQLite durable state on one gateway
- Authenticated adapters
- A fixed allowlist of served contexts
- Signed deterministic masternode list snapshots, or direct-node mode only after the
  `merkleRootMNList` commitment is verified
- Platform, single-tier Circom, and PLONK registration kept experimental

Reducing the supported profile is more valuable than reviewing several half-finished alternatives.

## Review baseline

Every review round begins by freezing one candidate commit. Record the following in an artifact
manifest:

- Git commit and repository status
- Production configuration and supported adapters
- Circom compiler, Node.js, and package-lock versions
- Exact dependency commits, including `circom-ecdsa` when applicable
- Rank-1 Constraint System hashes
- Witness generator hashes
- Proving-key and verification-key hashes
- Powers of Tau filenames and checksums
- Test commands and expected totals
- Features and deployment modes excluded from review

Reviewers examine that frozen baseline. Fixes go into a separate remediation branch. A reviewer
should never have to chase a moving target.

## Audit packet

Keep the review material in a dedicated directory:

```text
audit/
  SCOPE.md
  SECURITY_SPEC.md
  INVARIANTS.md
  THREAT_MODEL.md
  DEPENDENCIES.md
  ARTIFACTS.json
  KNOWN_LIMITATIONS.md
  reports/
  reproductions/
  remediation/
```

### Security specification

`SECURITY_SPEC.md` is normative. It should state what each proof, root, nullifier, epoch, season,
context, and challenge means. Reviewers should not have to infer the protocol from implementation
comments.

For every proof, document:

- The proposition being proved
- Every private witness value
- Every public input and public output
- Which party chooses each value
- Which gateway check binds each public value to policy
- The expected soundness, completeness, and privacy properties
- The valid ranges and canonical encodings
- The exact hash and Merkle-tree specifications

### Security invariants

At minimum, the invariant catalog should include these claims:

1. One voting key produces at most one membership per epoch and context.
2. One voting key produces at most one registration per season and context.
3. A proof made for one account cannot grant another account.
4. A registration for one context cannot appear in another context's members tree.
5. A stale, unknown, or inconsistent root cannot authorize new state outside the documented grace.
6. A clock rollback cannot reopen an old epoch or season.
7. A crash cannot separate a nullifier spend from the membership or registration it authorizes.
8. Challenge nonces are one-time and cannot be replayed.
9. Every public signal is constrained and checked against a gateway-selected or gateway-known value.
10. Published values do not reveal which masternode, address, or voting key produced a proof.
11. Alternate encodings of one scalar, key, signature, or account do not create distinct identities.
12. A failed or refused request cannot consume unrelated users' allowances or durable claims.

Each invariant should link to its implementation, tests, and review evidence.

## Independent review lanes

Use separate model families where possible. Several agents from one model are useful workers, but
they share blind spots and should not be treated as independent votes.

| Review lane | Required scope |
|---|---|
| Protocol and privacy | Statement design, replay, nullifiers, cross-context behavior, unlinkability |
| Circuit soundness | Constraints, field aliases, limb bounds, public inputs, hashes, Merkle paths |
| State and concurrency | Atomicity, crashes, restarts, clocks, rollover, queues, durable stores |
| Gateway and abuse | Authentication, rate limits, malformed inputs, proof integration, denial of service |
| Trust and deployment | Oracle signatures, direct-node mode, ChainLocks, Platform assumptions, configuration |
| Adapter access | Grants, expiry, repair, revocation, exclusions, partial external failures |
| Build and supply chain | Dependencies, compilers, setup artifacts, reproducibility, licenses, key distribution |

Run the lanes in two waves if agent capacity is limited. Reviewers initially receive the frozen
source, security specification, deployment profile, and test instructions. They do not receive the
author's rationale or previous findings until their clean-room pass is complete.

## Reviewer charter

Every reviewer receives the same evidence rules:

1. Search for violations of the specification, not only coding mistakes.
2. Treat comments as claims to verify, not evidence.
3. Prefer reachable attacks over hypothetical concerns.
4. Produce a minimal reproduction or adversarial test whenever possible.
5. Search the repository for every instance of a defect shape.
6. Record residual risk when a proposed fix moves rather than closes a boundary.
7. Do not edit the working tree during the review.

Each finding should contain:

- Violated invariant
- Exact source location
- Reachable attack or failure sequence
- Impact and preconditions
- Minimal reproduction
- Severity with justification
- Proposed remediation
- Required regression test

A demonstrated exploit outweighs several reviewers saying that the code looks correct.

## Adjudication and remediation

A separate adjudicator combines the clean-room reports. The adjudicator deduplicates findings,
challenges severity, and records the disposition of rejected items. The author should not be the
sole adjudicator of findings against the author's own work.

Every security fix must pass four gates:

1. A regression test fails before the fix.
2. The regression test passes after the fix.
3. A deliberate mutation that removes or bypasses the fix makes the test fail again.
4. A repository-wide search checks for other instances of the same defect shape.

The original reviewer retests the fix. A different reviewer then inspects the fix itself, because
recent `dash-mno-verify` review rounds repeatedly found defects introduced by the previous round's
remediation.

## Circuit review program

No single tool can establish circuit soundness. Use several independent techniques.

### Static and formal analysis

- Compile with Circom inspection enabled and retain all warnings.
- Run [Circomspect](https://github.com/trailofbits/circomspect) over the full circuit and dependency
  source tree.
- Run [Picus](https://github.com/Veridise/Picus) against both Circom source and compiled Rank-1
  Constraint System artifacts where the circuits are within tool limits.
- Inspect public inputs, constraint counts, and compiled artifacts with `snarkjs`.
- Record tool versions and complete results, including warnings that were accepted.

Static tools identify known patterns and possible underconstraint. A clean result is evidence, not a
proof of soundness.

### Differential testing

Compare every cryptographic operation against an independent implementation:

- secp256k1 scalar multiplication
- Compressed-public-key encoding
- SHA-256 and RIPEMD-160 composition
- Poseidon commitments and nullifiers
- Merkle roots and authentication paths
- Scalar and field canonicalization
- Public-signal serialization and ordering

Use generated vectors as well as boundary vectors. The reference implementation must not reuse the
same circuit code or constants through a common wrapper.

### Adversarial witnesses

Attempt invalid and noncanonical witnesses deliberately:

- Zero, group-order, and above-order private scalars
- Field aliases and negative-value representations
- Maximum limb values and malformed carries
- Invalid Merkle path indices
- Swapped public inputs
- Roots and leaves from different snapshots
- Reused keys under alternate encodings
- Cross-epoch, cross-season, and cross-context replays

The important question is not whether valid witnesses generate proofs. It is whether any invalid
witness can satisfy the constraints and produce an accepted proof.

## Handling circom-ecdsa

The upstream `circom-ecdsa` project describes its implementation as proof-of-concept code for
demonstration, not a production library. It also states that its tests exercise witness generation
without establishing that only valid witnesses satisfy the constraints.

The lowest-risk low-cost decision is therefore to remove it from the supported production profile.
Complete the zero-knowledge virtual machine registration path, retain the small Poseidon members
circuit, and label these paths experimental:

- `mno_membership.circom`
- `mno_registration.circom`
- Their proving keys, verification keys, and witness generators

If a `circom-ecdsa` path remains in scope, freeze exact commit
`d87eb7068cb35c951187093abe966275c1839ead` and review its transitive templates as first-party code.
Do not list it as an assumed trusted dependency.

At minimum, test:

- Private scalars `0`, `1`, `n-1`, `n`, and `n+1`
- Every limb at `0`, `2^64-1`, `2^64`, and field-wrapped values
- `d` and `d+n` attempts against public keys and nullifiers
- Malformed carries between limbs
- Generator, infinity, zero, and off-curve behavior where reachable
- Every `BigLessThan` boundary
- Agreement with a mature secp256k1 implementation
- Attempts to change intermediate signals while preserving claimed outputs

If nobody involved can competently review non-native secp256k1 arithmetic and Circom constraints,
additional agents do not close the gap. The defensible free solution is to exclude that path from
production.

## Automated gates

### Pre-commit checks

Security-sensitive changes should require:

- Unit and integration tests
- Circuit compilation and inspection
- Static circuit analysis
- Artifact-hash comparison
- Updated invariant and evidence maps
- A write-time self-review
- No unexplained proving-key, verification-key, witness, or R1CS change

Changes under `circuits/`, `common/`, the verifier, gateway, stores, oracle, contract, or key-building
scripts should require an independent clean-room report from another model family.

### Baseline invalidation

Automatically invalidate the reviewed circuit baseline when any of these changes:

- Circuit source
- Compiler version
- Dependency commit
- Setup input
- Public-signal order
- Witness generator
- Verification key
- Proving-system integration

### Nightly checks

Run a clean dependency installation, reproducible circuit build, checksum comparison, static
analysis, property tests, fuzzing, crash injection, concurrency tests, dependency scanning, license
scanning, and the full optional-dependency test suite.

### Release gate

A release candidate must satisfy all of these conditions:

- Every blocker and major is closed or explicitly accepted in writing.
- Original reviewers have retested their findings.
- A separate reviewer has inspected the remediation.
- Artifact hashes match the reviewed baseline.
- The deployment configuration matches the reviewed profile.
- Known residual risks are published.
- Shutdown, recovery, and revocation procedures have been exercised.

## Public peer review

After private clean-room review, publish the specification, frozen commit, artifact hashes, review
reports, reproductions, remediation record, and a short list of focused questions.

Focused requests attract better review than a general request to audit the repository. Examples
include:

- Find a witness that violates canonical scalar uniqueness.
- Find a way to satisfy the Merkle circuit with a nonbinary path index.
- Find a crash point that splits a durable spend from its membership.
- Find two contexts or account encodings that collide or escape scoping.
- Find a forged deterministic masternode list that the selected trust model accepts.

Potential reviewers include Dash developers, Circom and Privacy and Scaling Explorations
contributors, 0xPARC contributors, zero-knowledge security researchers, and university cryptography
or program-analysis groups.

If a small amount of funding becomes available, use focused finding bounties. Pay most for a
reproducible soundness failure, then for privacy failures, durable-state violations, and meaningful
denial-of-service paths.

## Controlled rollout

Even after this review program:

- Describe the release as independently reviewed, not audited.
- Begin with a low-consequence community.
- Support one deployment profile.
- Keep a documented shutdown path.
- Maintain manual recovery and revocation procedures.
- Monitor root changes, clock regressions, proof failures, duplicate claims, and adapter failures.
- Publish limitations prominently.
- Increase the consequences of membership only after operating history and outside peer review.

## Completion criteria

The external-like review round is complete only when:

1. One production profile and one frozen commit are named.
2. The security specification and invariant catalog are complete.
3. Every review lane has submitted a clean-room report.
4. Every accepted blocker and major has a reproduction, remediation, regression test, and retest.
5. Circuit tools and adversarial vectors have run against the compiled artifacts.
6. A clean rebuild reproduces the reviewed hashes.
7. Residual risks and excluded modes are public.
8. The release gate passes without waivers hidden in prose.

Meeting these criteria does not turn the work into a professional audit. It does create a rigorous,
repeatable, and transparent basis for deciding whether the prototype is ready for a limited rollout.

## References

- [0xPARC circom-ecdsa](https://github.com/0xPARC/circom-ecdsa)
- [Trail of Bits Circomspect](https://github.com/trailofbits/circomspect)
- [Veridise Picus](https://github.com/Veridise/Picus)
- [dash-mno-verify threat model](THREAT_MODEL.md)
- [dash-mno-verify design](DESIGN.md)
- [dash-mno-verify pre-commit adoption](PRECOMMIT_ADOPTION.md)

