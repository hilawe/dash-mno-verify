# Circuit static analysis

A containerized run of circomspect (Trail of Bits) over the project's circom circuits. It exists because
the highest-value, no-specialist move on the cryptographic core is an automated hunt for the bug class
that matters most: under-constrained or unused signals, where a prover could satisfy the constraints with
a witness that does not correspond to a real masternode voting key. circomspect is a static analyzer built
for exactly this, and it is free.

This is a deliberate run, like `tools/x11-reference`, not part of `npm test`. It needs a container
(`colima` plus `docker`) and the fetched circuit dependency.

## What it does and does not establish

It flags patterns a human circuit reviewer looks for first, mechanically and quickly. A clean run is real
evidence that the common under-constraint patterns are absent. It is NOT a soundness certificate: static
analysis cannot prove the constraint system is fully determined (that is what R1CS-level tools such as Ecne
and Picus attempt, component by component), it does not judge whether the specific `circom-ecdsa` templates
are safe as used, and it does not model a novel attack. It raises the tier-1 floor above a structural read;
it does not replace a specialist. See `docs/SECURITY_AUDIT_SCOPE.md` for the full ceiling.

## Run it

    bash tools/circuit-analysis/run.sh                 # prints the report
    bash tools/circuit-analysis/run.sh output/circomspect.txt   # also writes it

The script builds the image (the first build compiles circomspect and is slow), then runs the analyzer
over each top-level circuit and the shared components, with the include search paths mirroring
`scripts/check_circuits.sh` (`-L node_modules -L circuits/.deps`).

## Provenance

The analyzer is fetched from crates.io at the version recorded in `PIN`, not vendored. Passing
`--build-arg CIRCOMSPECT_VERSION=` empty (the default) installs the latest and the build prints what it
resolved to, which is the value to write into `PIN`. Moving the pin is a deliberate commit of its own, the
same discipline `tools/x11-reference` uses for its upstream tag.

## Scope note on the circuits

Both `mno_membership.circom` (single-tier) and `mno_registration.circom` (two-tier registration) include
`circom-ecdsa` and call `ECDSAPrivToPub`, so the unaudited dependency is on the critical path of both
proving designs and cannot be avoided by disabling one path. Its footprint is narrow and identical in both
(`ECDSAPrivToPub` plus `BigLessThan`), which is where the closest attention belongs. `mno_members.circom`
(the per-epoch re-proof) is the only top-level circuit free of it, and it is downstream of a registration
that used it.
