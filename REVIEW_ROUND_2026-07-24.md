# Review round, 2026-07-24 (in flight)

A multi-model adversarial round over the accumulated code. One independent full-access
reviewer (a different model family, able to run the repo) has reviewed; two further
model reviewers are pending. This note is the resume point: what was fixed, what is
confirmed and still to fold, and the triage corrections. Reviewer names are generic on
purpose, since this repository is public.

## Fixes made this round (on this branch, tests 191/191 green)

1. **Context and signal hash: unambiguous v2 encoding** (`common/index.js`, plus
   `test/common_context.test.js`). The old `contextHash` and `signalHash` colon-joined
   their components, so community `a:b` + role `c` shared a preimage with community `a`
   + role `b:c`. Now each is a JSON tuple. The version is bumped to `v2` because every
   derived context value changes. The full-access reviewer confirmed there is no R1CS or
   key change by generating and verifying a proof with the new values under the existing
   committed keys: the circuits take these as opaque field-element public inputs
   (`mno_membership.circom:18,21`, `mno_registration.circom:28`, `mno_members.circom:19`)
   and never reconstruct them from parts. Note the wording: the encoding is now
   unambiguous, the hash itself still collides by pigeonhole.
2. **Privacy documentation** (`docs/THREAT_MODEL.md`, `README.md`). The gateway does
   learn the platform account (the B1 fix binds it into the signal hash and the spend
   record keeps it), so both the threat model and the README table no longer say it
   learns only a nonce. Added the two-tier context-sized anonymity caveat (a
   single-member context gives no anonymity among member commitments) and corrected the
   access-lapse wording (epoch or season re-proof, not instant on sale).

## Confirmed real, still to fold

- **Nullifier durability on restart, raise to P0.** `gateway.js:108` refuses two-tier +
  `MNO_STORE=platform` at boot, and the nullifier store is only the Platform document
  store or an in-memory `Map` (`stores.js:236`), no file backend. So the only bootable
  two-tier config keeps registrations durable but the per-epoch spent-nullifier set in
  memory, and a restart mid-epoch drops it, breaking one-membership-per-epoch (a second
  account can be claimed). Also affects default single-tier memory mode. `PLATFORM.md:3`
  and `DEPLOY.md:150` wrongly say memory is fine for one gateway. Fix: a durable local
  nullifier store (SQLite preferred, unique key `(epoch, contextHash, nullifier)`,
  granting-account commitment, prune old epochs). Memory only behind an explicit
  local-dev flag; a non-local deployment must refuse ephemeral nullifiers.
- **Secret-file handling** (`prover/two_tier.js:91,100`). The member secret is written
  at default `0644` before the `/v1/register` call, so a rejected re-run (same per-season
  registration nullifier) overwrites the accepted secret and strands the member; the WIF
  voting key also arrives on argv. Fix: exclusive `open(path, "wx", 0o600)`, write a
  `pending` record and flush before submit, promote to `accepted` on success, preserve
  (never overwrite) on failure, reuse the pending secret on retry; add `--voting-key-file`
  or stdin and stop recommending `--voting-key <WIF>`.

## New findings from this round (verified against the code, to fold)

- **Time can move state backward.** `seasonNow`/`epochNow` are pure wall-clock and
  `SeasonMembers._roll` (`core/season.js`) accepts any different season including a lower
  one, with old records still on disk. A clock rollback across a season boundary reloads
  an earlier season's members and revives expired credentials. Fix: persist a high-water
  season and epoch and refuse to roll backward or issue challenges for an earlier period.
- **Tree capacity can poison durable state.** `SeasonMembers.commit` writes the durable
  record (`season.js:110`) before `tree.append` (`:116`), and `MembersTree.append`
  (`members_tree.js:41`) has no `2**16` capacity check. Record 65,537 writes durably then
  fails root-building on every reopen. Unlikely at the current DML size but violates the
  durable-commit invariant. Fix: check capacity before the durable append.
- **Hash-encoding cutover** (the v2 migration). The new and old context hashes are
  different nullifier domains, so during a rolling upgrade one credential can get a grant
  in each. Cut over at a season boundary, do not run v1 and v2 behind one service, and
  return the encoding version in challenge and health responses.

## Triage corrections to carry into TODO.md

- The completed M3 item claims a stalled source stops admitting members. That is
  inaccurate: a stalled node republished with a fresh snapshot timestamp keeps being
  accepted. The real mitigation is the (open) direct-node ChainLock item. Correct the M3
  wording.
- `circom-ecdsa` is not only a proving-cost item. Replacement or an independent
  constraint audit is a deployment blocker for any mode that ships a key-bearing Circom
  proof. The zkVM path resolves this for the two-tier registration proof only, not for
  single-tier. Reframe the research item accordingly.
- The Platform item is too narrow. Include the schema migration: the registration
  document lacks `engine` and `statement`, and `membersRoot` and registration ordering
  are not context-scoped (`contract/mno-verify.contract.json`).
- The Matrix "verification in private only" item is stale: the private-room predicate is
  now applied to commands and proof messages. Check it off or rewrite it around the
  configured-room usability issue.
- Telegram and Matrix access expiry is untracked and is a live authorization failure.
  Telegram turns an account-bound verification into a transferable invite link, and
  neither adapter removes access at epoch expiry. Only Discord has a full grant
  lifecycle.
- The product statement needs a freeze decision (owner). The README still says "I
  control one of the masternodes"; the true statement is control of a current voting
  credential, weaker than owner, operator, or collateral control, and in two-tier mode
  membership lasts the season. Decide the subject and rename around it.
- Dependency advisories (npm audit reported highs through `snarkjs` and `ws` via
  `circomlibjs`) and the MIT-versus-GPL question (`circom-ecdsa` is GPL-3.0, the repo is
  MIT, and compiled artifacts are distributed) are not in TODO. Add them to the release
  punch list. CI actions are also not commit-pinned.
- Two follow-up call sites for the v2 encoding: `mno_membership.circom:21` still
  documents the old derivation in a comment (comment-only, no R1CS change), and the RISC
  Zero benchmark host (`research/risc0-registration/host/src/main.rs:208`) hashes the old
  context string. The production guest takes an opaque context field, so guest soundness
  is unaffected, but the bench and any future Rust host need the new encoding plus a
  pinned cross-language vector set (colons, quotes and backslashes, empty strings,
  non-ASCII, Unicode supplementary characters).

## Resume steps

1. Run the two pending model reviewers on the same relay (updated with the confirmations
   above), reconcile against the code.
2. Fold the confirmed items into `TODO.md` with the priorities above (nullifier
   durability is P0).
3. Implement the fixes for the nullifier durable store (#2) and the secret-file handling
   (#9), plus the clock-rollback guard and the tree-capacity check.
4. Then run a fresh full multi-model round over the whole surface before considering it
   done.
