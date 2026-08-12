# Contributing

Thanks for working on this. This is an anonymous proof that someone controls a Dash masternode, used
to gate a private community without revealing which node or address. It is a working prototype,
validated on real mainnet data and not yet audited, so the first goal of any change is to keep it
honest and correct rather than fast.

Read `docs/DESIGN.md` and `docs/THREAT_MODEL.md` first for how it works and what it does and does not
protect. `TODO.md` is the prioritized work list, and `docs/HANDOFF.md` is the running log of where
things stand.

## Setup

- Node.js 22.13 or newer (see `package.json` engines).
- `npm ci` for the full toolchain, or `npm ci --omit=optional` for the oracle and gateway only.
- Enable the pre-commit hook once per checkout, since it is not adopted automatically on clone:

  ```bash
  git config core.hooksPath tools/hooks
  ```

  The hook runs the test suite on commits that touch gated paths. Give a commit a generous timeout,
  because the full suite is a couple of minutes and a short timeout stops it mid-gate.

The gateway boots from verification keys committed under `circuits/build`. The cheaper members proving
key and the wasm files come from a checksummed release fetched by `scripts/fetch_keys.sh`, and the two
large proving keys are rebuilt with `scripts/build_proving_key.sh`. See `docs/PROVING_KEY.md`.

## Running it

To stand up a gated community end to end, follow `docs/RUNBOOK.md` (front to back) or the Quickstart in
`README.md`. Direct-node mode (`MNO_DML_SOURCE=node`) reads the masternode list from a Dash node you run
yourself, so no oracle key is trusted.

## Tests and continuous integration

- `npm test` runs the Node test suite.
- `scripts/check_circuits.sh` and `scripts/prove_members.sh` run the circuit checks and a real PLONK
  members prove-and-verify. These need `circom` and are also run in CI.
- A test does not count until it has been watched failing against the defect it claims to cover. For a
  new guard, revert the fix and confirm the test goes red, then restore it.

Continuous integration runs three jobs, and all three must be green before a change lands:

- `checks`, a fast install without optional packages.
- `full`, the complete install that also exercises the platform adapters. A green `checks` alone does
  NOT mean the adapters ran, so watch the `full` job specifically.
- `circuits`, the circom compile and the members prove-and-verify.

After a push, read the run's conclusion rather than assuming it:

```bash
gh run list --limit 1 --json conclusion,status --jq '.[0]'
```

If it is red, fix it before starting the next change. A red CI that nobody reads hides the next failure.

## Making a change

- Branch off `main`, keep each commit one logical change, and open a pull request. The maintainer and
  collaborators may push small changes directly, but a pull request is the norm for anything
  behaviour-changing, so it can be reviewed before it lands.
- A non-trivial change gets an independent review before merge. Fix every blocker and major it raises,
  or push back with a specific reason.
- For a change that touches durability, ordering, canonical encodings, the trust model, or the
  circuits, say in the pull request what invariants it touches and how you checked them. The write-time
  discipline the repository follows is instantiated in `docs/PRECOMMIT_ADOPTION.md`.
- Do not weaken a security invariant without a clear, stated reason. The load-bearing ones are listed
  in `CLAUDE.md` under "Security invariants".

## Style

- Match the surrounding code: its naming, its comment density, its idioms. Comments explain why, not
  what.
- Documentation and commit messages use plain prose. No em-dashes (use commas, parentheses, or separate
  sentences). No semicolons in running prose (they are fine only as list separators). Define each
  acronym at first use.
- Keep the repository free of AI-assistant tool names, and do not add AI co-authorship trailers to
  commits. Hilawe Semunegus is the author.
- Commit and push only your own real changes, and never force-push shared history without asking.

## Where to look

- `docs/DESIGN.md`, `docs/THREAT_MODEL.md`: architecture, and the trust boundaries and accepted limits.
- `TODO.md`: the prioritized backlog and the known residuals.
- `docs/HANDOFF.md`: the current state and the session-to-session log.
- The `REVIEW_FINDINGS_*` files at the repository root: the record of what was wrong and why, kept
  alongside the code.

Questions are welcome as issues. Thanks again.
