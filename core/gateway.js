// Platform-neutral verification gateway.
//
// Any adapter (Discord, Telegram, Matrix, a web gate) speaks to these HTTP endpoints. The
// gateway never learns a masternode address, a voting key, or which node proved. It learns
// only a per-account nonce and an unlinkable nullifier.
//
// The account-bearing endpoints (/v1/challenge, /v1/verify) require the adapter bearer token
// (Authorization: Bearer $MNO_ADAPTER_SECRET) when that secret is set, so the account is vouched for
// by a trusted adapter. /v1/register is member-driven and proof-authenticated (no account, no token);
// the read-only endpoints (members, dml, health) are public.
//
// Single mode (MNO_MODE=single):
//   POST /v1/challenge  { platform, communityId, roleId, account }
//        -> { nonce, signalHash, epoch, root, contextHash, epochSeconds, mode }
//        mode is "single" or "two-tier", so the adapter renders the matching local prover command.
//   POST /v1/verify     { nonce, proof, publicSignals, account }  -> { ok, account, epoch, expiresAt }
//        account is the submitter, and must equal the account the challenge was minted for (B1).
//
// Two-tier mode (MNO_MODE=two-tier) adds a heavy seasonal registration and makes the
// per-epoch challenge and verify run against the cheap members tree:
//   POST /v1/register   { platform, communityId, roleId, proof, publicSignals }
//        -> { ok, index, membersRoot, size }
//   GET  /v1/members?context=<hash> -> { membersRoot, size, commitments }  (per-context, for paths)
//
//   GET  /v1/health     -> { ok, mode, root, dmlRoot, season, contexts? }
import { createServer } from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildConfig, MAX_SNAPSHOT_SIGS } from "./config.js";
import { leafSetCommitment, RootWindows, NullifierStore, ChallengeStore, RateLimiter, Semaphore, loadOracle, normalizeSnapshot, allowAll } from "./stores.js";
import { loadVerificationKey, verifyMembership, verifyRegistration, readSignals } from "./verifier.js";
import { SeasonMembers } from "./season.js";
import { makeDmlRootHasher } from "./dml_root.js";
import { shaRootFromLeaves } from "../common/dml_sha_root.js";
import { isCanonicalField } from "../common/field.js";
import { contextHash, signalHash, epochNow, seasonNow, scheduleId } from "../common/index.js";
import { TimeGuard } from "./time_guard.js";
import { snapshotMessage, verifySnapshotSig, snapshotVersion, publicKeyFromRaw, rawPublicB64 } from "../common/oracle_sig.js";
import { buildDiffSnapshot } from "../oracle/diff_snapshot.js";
import { makeNodeCall } from "../oracle/node_client.js";

// BUILDING THE GATEWAY IS A CALL, NOT AN IMPORT. This module used to do all of its work at import
// time: it opened the durable stores, loaded the verification keys, fetched a root, started up to
// five intervals, and bound a listening socket, all as a side effect of anybody reading it. Nothing in
// here could be unit-tested, so every property of a handler had to be proven either through a
// spawned process or one level down in the stores, and one test resorted to grepping this file's
// source text for a call it could not otherwise observe. That was the root cause behind the weak
// tests of the last several sessions rather than a matter of taste.
//
// Everything below is unchanged in order and in effect; it is the same body, now reached by calling
// this. The config is a PARAMETER, defaulting to the process environment read AT CALL TIME rather
// than at import, so a test can boot a gateway for a synthetic environment without touching
// process.env, and both the config validation and the boot refusals are ordinary function behaviour.
// Running `node core/gateway.js` still boots and listens, through the entry point at the bottom of
// this file.
//
// The returned handle owns everything the boot created: the server (not listening), the timers, and
// the stores. `close()` is what a caller uses to give them back, and a test that does not call it
// leaks a durable store handle rather than merely a timer, which is why close() is part of the
// contract rather than a convenience.
//
// A BOOT THAT FAILS RELEASES WHAT IT ALREADY TOOK. The nullifier store is opened well before the
// two-tier refusals, the verification-key loads, and the register-context validation, any of which
// can throw. As a process that was fine, since exiting hands everything back; for a caller that can
// catch the rejection it is not, because there is no handle to close and the open database is
// unreachable. So acquisition and release are one list, and the failing path walks it in reverse.
export async function createGateway(options = {}) {
  const release = [];
  try {
    return await bootGateway(options, release);
  } catch (err) {
    for (const fn of release.reverse()) {
      try {
        await fn();
      } catch {
        // A failed release must not replace the boot failure the caller needs to see.
      }
    }
    release.length = 0;
    throw err;
  }
}

async function bootGateway({ config = buildConfig(process.env) } = {}, release) {
  // Every interval this boot starts, so close() can stop all of them. Collected at the point of
  // creation rather than listed separately, for the same reason the limiter sweep list is derived:
  // a timer that exists is a timer close() stops, with nothing for the next author to remember.
  const timers = [];
  const every = (ms, fn) => {
    const t = setInterval(fn, ms);
    // The listening socket is what holds the process open for a real deployment, so refusing to let
    // a timer do it costs nothing there and means an embedded caller (a test) that forgets close()
    // ends up with a stale timer rather than a process that never exits.
    t.unref();
    timers.push(t);
    return t;
  };
  release.push(() => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
  });

  const twoTier = config.mode === "two-tier";
  const nowSec = () => Math.floor(Date.now() / 1000);
  // Every durable store is stamped with this and refuses to open under a different one, because
  // changing either length renumbers every epoch and season.
  const SCHEDULE = scheduleId(config.epochSeconds, config.seasonSeconds);
  // The context/signal encoding this gateway derives. Returned to clients so a rolling upgrade that
  // mixes v1 and v2 gateways is visible rather than silently minting two membership domains for one
  // community. Cut over at a season boundary; do not run both behind one address.
  const CONTEXT_VERSION = "v2";

  // Fail closed: refuse to start unauthenticated unless the operator explicitly opted in. This keeps
  // a forgotten MNO_ADAPTER_SECRET from silently exposing the account-bearing endpoints to any caller.
  if (!config.adapterSecret && !config.allowUnauthGateway) {
    throw new Error(
      "refusing to start unauthenticated: set MNO_ADAPTER_SECRET so adapters authenticate the account, " +
        "or set MNO_ALLOW_UNAUTH_GATEWAY=1 to run open on purpose (local dev, demos, tests only).",
    );
  }

  // Fail closed on the oracle too: without trusted oracle keys, the gateway would adopt any
  // self-consistent snapshot a source serves, so a forged membership set could grant access. Require
  // pinned keys unless the operator opts into an unsigned oracle on purpose.
  // The signed-snapshot requirement applies to the SNAPSHOT source only. In node mode there is no
  // snapshot and no publisher: the gateway reads the list from a node it is configured to talk to, and
  // that node is the trust anchor. Demanding oracle keys there would be demanding a signature on data
  // nobody published, which is why this is scoped rather than universal.
  if (config.dmlSource === "snapshot" && config.oraclePubkeys.length === 0 && !config.allowUnsignedOracle) {
    throw new Error(
      "refusing to start with an unauthenticated oracle: set MNO_ORACLE_PUBKEYS to the trusted oracle " +
        "public key(s), or MNO_ALLOW_UNSIGNED_ORACLE=1 to trust an unsigned source on purpose (local " +
        "dev, demos, tests, or a trusted private network only).",
    );
  }

  // Monotonic epoch and season. Every period the gateway derives from the clock goes through this, so
  // a backward step cannot quietly rebuild a past season's members tree or reopen an epoch whose spent
  // nullifiers have already been pruned. In ephemeral mode there is no durable state to protect, so
  // the marks stay in memory and vanish with the process.
  // THE CLOCK MARKS ARE DURABLE WHENEVER ANY DURABLE STATE DEPENDS ON THEM, which is not the same
  // question as which nullifier backend is configured. `MNO_STORE=memory` makes the per-epoch spent
  // set ephemeral, and the marks used to follow it. But TWO-TIER MODE opens a file-backed registration
  // store regardless, and that file outlives the process: a gateway could finish season N, restart
  // after the host clock stepped back into season N-1, and rebuild N-1's members tree from those
  // durable records with no mark to notice the regression, so memberships that had ended became usable
  // again. That is the opposite of the stated rule that a past season stops verifying, and the
  // ephemeral-nullifier opt-in never authorized it, because it says nothing about registrations.
  //
  // So the marks are ephemeral only when NOTHING durable depends on them.
  const durableStateExists = config.store !== "memory" || twoTier;
  const timeGuard = new TimeGuard({
    path: durableStateExists ? config.timeMarksPath : null,
    epochSeconds: config.epochSeconds,
    seasonSeconds: config.seasonSeconds,
    nowSec,
  });

  const challenges = new ChallengeStore(config.challengeTtlSeconds, config.maxPendingChallenges);

  // Per-client rate-limit guards on the request-facing endpoints (review finding M5). The
  // account-bearing ones additionally require the adapter bearer token when MNO_ADAPTER_SECRET is set.
  const challengeLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.challengeRateMax });
  const verifyLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.verifyRateMax });
  const registerLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.registerRateMax });
  const membersLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.membersRateMax });
  const dmlLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.dmlRateMax });
  // Checked BEFORE the body is read on the account-bearing endpoints. Moving the shared limiters after
  // the parse (so a refused account could not drain them) left nothing at all guarding the read and
  // parse themselves, which is a worse exposure than the one it fixed: a single source could then
  // stream large bodies and buy JSON parsing without ever reaching a limit. This restores a bound on
  // that phase without re-coupling it to the fairness rule.
  const ingressLimiter = new RateLimiter({ maxKeys: config.rateMaxKeys, windowSeconds: config.rateWindowSeconds, max: config.ingressRateMax });
  // PER-ACCOUNT limiters, applied after the body is read (and after adapter authentication, where a
  // secret is configured) because the account is not known before that. The per-source limiters above
  // stay as the aggregate guard.
  //
  // WHAT THIS IS WORTH, AND UNDER WHAT CONDITION. The account is a string the CALLER sends. It
  // subdivides the shared bucket fairly only when a TRUSTED ADAPTER supplies a stable canonical
  // account, which is the deployment MNO_ADAPTER_SECRET exists to create: there the gateway is the one
  // choosing to believe the adapter, and one user genuinely cannot spend another's allowance. On an
  // unauthenticated gateway (MNO_ALLOW_UNAUTH_GATEWAY) the same caller can simply send a different
  // account string, or rotate spellings, so the per-account limit is best-effort subdivision there and
  // the per-source limit remains the real bound. Stated rather than implied, because a limit that only
  // works under a condition is a limit whose condition has to be written down.
  const accountChallengeLimiter = new RateLimiter({
    maxKeys: config.rateMaxKeys,
    windowSeconds: config.rateWindowSeconds,
    max: config.accountChallengeRateMax,
  });
  const accountVerifyLimiter = new RateLimiter({
    maxKeys: config.rateMaxKeys,
    windowSeconds: config.rateWindowSeconds,
    max: config.accountVerifyRateMax,
  });
  // A rate-limit key whose parts cannot run together: the length prefix makes ("a", "bc") and
  // ("ab", "c") different keys, which the separator alone would not (a separator can appear inside a
  // part). The separator is kept only for readability.
  // One map, named so a caller can observe a particular limiter, and the sweep list is DERIVED from
  // it rather than written beside it. The list previously stood on its own with a comment asking the
  // next author to remember to extend it, which is exactly how three limiters were once left out of
  // the sweep. Deriving it means a limiter that exists is swept, with nothing to remember.
  const LIMITERS = {
    ingress: ingressLimiter,
    challenge: challengeLimiter,
    verify: verifyLimiter,
    register: registerLimiter,
    members: membersLimiter,
    dml: dmlLimiter,
    accountChallenge: accountChallengeLimiter,
    accountVerify: accountVerifyLimiter,
  };
  const ALL_LIMITERS = Object.values(LIMITERS);
  // Named, and exposed on the handle, so a test can drive the sweep the interval drives rather than
  // check that a list contains what a map contains. The wiring is then observable too: the timer the
  // boot starts carries this exact function.
  const sweepLimiters = () => {
    for (const l of ALL_LIMITERS) l.sweep();
  };

  const rateKey = (...parts) => parts.map((p) => `${String(p).length}:${p}`).join("\u0000");
  // Global cap on concurrent expensive verifies, so a distributed flood cannot exhaust CPU or memory
  // with unbounded parallel proof checks. The expensive verify is run inside verifyProofGated, which
  // wraps only the cryptographic check (the policy checks run first, outside the gate), and sheds with
  // an "overloaded" error when the wait queue is full.
  const verifySem = new Semaphore({ max: config.verifyConcurrency, maxQueue: config.verifyQueueMax });
  // Adapter authentication for the account-bearing endpoints. When MNO_ADAPTER_SECRET is set, a
  // caller must present it as a bearer token, so the account on /v1/challenge and /v1/verify is
  // vouched for by an authenticated adapter rather than chosen by any HTTP caller (this is what makes
  // the B1 binding authoritative). The compare is constant-time over sha256 digests so it neither
  // leaks the secret's length nor short-circuits on the first differing byte. The expected digest is
  // computed once at boot. With no secret the gateway fails closed at boot unless explicitly allowed.
  const adapterSecretDigest = config.adapterSecret ? createHash("sha256").update(config.adapterSecret).digest() : null;
  function authorized(req) {
    if (!adapterSecretDigest) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] ?? "");
    if (!m) return false;
    const got = createHash("sha256").update(m[1]).digest();
    return timingSafeEqual(got, adapterSecretDigest);
  }

  // The client key for rate limiting. With MNO_TRUST_PROXY set, the gateway is assumed to sit behind
  // exactly one trusted reverse proxy, which appends the connecting client to X-Forwarded-For. The
  // LAST hop is the address that proxy observed, so it is the one entry the client cannot forge (the
  // left entries are client-supplied and spoofable). Without the flag the header is ignored entirely
  // and the socket address is used. A multi-proxy chain would need a configured trusted-hop count,
  // tracked in TODO.md.
  function clientKey(req) {
    if (config.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (xff) return String(xff).split(",").pop().trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  // The shared Platform registration store is the follow-up to the file-backed path. Fail loudly
  // here, before any Platform connection or key load, rather than fall back to a non-shared store and
  // silently double-grant. Checking up front means a missing optional dependency or incomplete
  // Platform config cannot mask this with an earlier, more confusing error.
  if (twoTier && config.store === "platform") {
    throw new Error(
      "MNO_MODE=two-tier with MNO_STORE=platform is not wired yet. Use the durable file-backed " +
        "registration store (unset MNO_STORE or set MNO_STORE=memory); Platform-backed " +
        "registration records are the next step. See core/registration_store.js and docs/PLATFORM.md.",
    );
  }

  // The per-epoch spent-nullifier set for the membership verify. Durable on one gateway by default
  // (sqlite), shared across gateways on Platform, or ephemeral in memory for local work only.
  // The per-season registration spend lives in the registration store, not here.
  //
  // The memory store is gated behind an explicit opt-in because losing it is not a cosmetic failure:
  // a restart mid-epoch forgets every spend, and the same voting key can then claim a second account
  // in the same epoch, which is precisely the "one voting key, one membership per epoch" guarantee the
  // system exists to provide. Failing closed here matches how the gateway already treats a missing
  // adapter secret and an unsigned oracle.
  if (!["sqlite", "memory", "platform"].includes(config.store)) {
    throw new Error(`MNO_STORE must be one of sqlite, memory, or platform (got "${config.store}").`);
  }
  if (config.store === "memory" && !config.allowEphemeralNullifiers) {
    throw new Error(
      "MNO_STORE=memory keeps the spent-nullifier set in memory, so a restart mid-epoch forgets " +
        "every spend and one voting key can claim a second account in the same epoch. Use the " +
        "durable default (unset MNO_STORE, or MNO_STORE=sqlite), or set " +
        "MNO_ALLOW_EPHEMERAL_NULLIFIERS=1 to accept that for local use.",
    );
  }

  let nullifiers;
  if (config.store === "platform") {
    // THE SCHEDULE CANNOT BE BOUND ON PLATFORM YET, SO PLATFORM MODE REFUSES BY DEFAULT.
    //
    // Epoch and season numbers are derived from the configured lengths, so changing either renumbers
    // every period. Both local durable stores refuse to open under a schedule different from the one
    // they were written with, because reinterpreting old rows under new numbering silently changes
    // what a spent tag means. The Platform backend had no such check: its documents carry only
    // (epoch, contextHash, nf), and the contract has no field that could hold a schedule marker, so
    // there is nothing to compare and a changed schedule would be reinterpreted in silence. Two
    // outcomes, both bad: a tag spent under the old numbering can be re-spendable under the new one,
    // or an immutable Platform record can deny a legitimate claim for a whole epoch.
    //
    // Adding the marker means a contract migration, and the Platform path is not live, so refusing is
    // the honest position rather than shipping a check that cannot check. The override exists for a
    // deployment that knows its shared state was written under this exact schedule, and it is an
    // ASSERTION by the operator, in the same style as the registration file's.
    // F2, AND IT IS A SEPARATE REFUSAL FROM THE SCHEDULE ONE BELOW. An independent security review
    // reproduced this: Platform consensus can ACCEPT the nullifier document while the client sees a
    // timeout or a dropped connection, so the request fails with the tag already spent. Nothing can
    // recover it, because this store deliberately writes no account binding (writing a platform user
    // id into a public document would link that user to masternode control on chain, the exact
    // disclosure the design exists to avoid), so `get()` returns null and the retry with a fresh valid
    // proof is answered already-used. The member loses the epoch through no fault of their own.
    //
    // That breaks the stated rule that a failed request cannot consume a durable claim. Closing it
    // needs an atomically stored, privacy-safe account or operation commitment that an uncertain
    // broadcast can query before deciding whether it won, which is a contract change and a commitment
    // scheme, so it is a decision rather than a patch.
    //
    // UNTIL THEN THE MODE IS OUTSIDE THE SUPPORTED PROFILE, and that is enforced here rather than
    // written in a document nobody reads at deploy time. The opt-in names the finding, so an operator
    // enabling it is saying they know which one they are accepting.
    if (!config.platformAcceptUncertainBroadcast) {
      throw new Error(
        `refusing Platform nullifier mode: an uncertain broadcast can consume a membership claim ` +
          `without granting it. Platform consensus may accept the nullifier document while this ` +
          `client sees a timeout, and because no account binding is stored, the member's retry is ` +
          `refused as already-used and they lose the epoch. This is review finding F2 and it is not ` +
          `fixed. Set MNO_PLATFORM_ACCEPT_UNCERTAIN_BROADCAST=1 to run the mode anyway, accepting ` +
          `that a network failure at the wrong moment costs a member their membership for the epoch.`,
      );
    }
    if (config.platformAssumeSchedule !== SCHEDULE) {
      throw new Error(
        `refusing Platform nullifier mode: the contract's nullifier document cannot carry an ` +
          `epoch/season schedule marker, so this gateway cannot verify that the shared state was ` +
          `written under its own schedule (${SCHEDULE}). Changing MNO_EPOCH_SECONDS or ` +
          `MNO_SEASON_SECONDS renumbers every period, and reinterpreting existing Platform records ` +
          `under new numbering can either re-open a spent tag or permanently deny a legitimate one. ` +
          `Set MNO_PLATFORM_ASSUME_SCHEDULE=${SCHEDULE} to assert BOTH that the existing shared state ` +
          `was written under this schedule AND that every other gateway sharing this contract runs it ` +
          `too. Nothing verifies the second half: the marker is a LOCAL file and the state it protects ` +
          `is SHARED, so two gateways with different local markers can assert incompatible schedules ` +
          `against one contract and neither will notice. Until the contract can carry the declaration, ` +
          `coordinating the schedule across gateways is the operator's job and this setting is where ` +
          `you take that on. The value names the schedule rather than being a bare flag, so an ` +
          `assertion made for one schedule cannot wave a later one through` +
          (config.platformAssumeSchedule ? `, and this one names ${config.platformAssumeSchedule}.` : `.`),
      );
    }
    // THE ASSERTION IS PINNED TO THE SCHEDULE IT WAS MADE FOR. An operator sets the flag once, in an
    // environment file, to get the gateway to boot, and it then stands for every later boot. Left
    // there, a later change to MNO_EPOCH_SECONDS or MNO_SEASON_SECONDS would be waved through by an
    // assertion made about a different schedule entirely, which is the exact silent reinterpretation
    // the refusal above exists to prevent. A reviewer called that a footgun and was right.
    //
    // So the first assertion is RECORDED locally, and a later boot whose schedule differs from the
    // recorded one refuses even with the flag still set. This is a local file, so it does not prove
    // anything about the shared Platform state (only a marker in the contract could, and the contract
    // has no field for it). What it does is stop one operator's own schedule change from passing
    // unnoticed, which is the reachable half of the problem.
    {
      const { readFile, mkdir, open, rename } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      let recorded = null;
      let recordedContract = null;
      try {
        const parsed = JSON.parse(await readFile(config.platformSchedulePath, "utf8"));
        recorded = parsed?.schedule ?? null;
        recordedContract = parsed?.contractId ?? null;
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      // THE MARKER IS BOUND TO THE CONTRACT, not just to the schedule. Without this, pointing the same
      // gateway at a DIFFERENT contract reuses a marker that describes other shared state entirely,
      // and the check passes while comparing against the wrong thing.
      if (recordedContract != null && String(recordedContract) !== String(config.platform.contractId)) {
        throw new Error(
          `refusing Platform nullifier mode: ${config.platformSchedulePath} was written for contract ` +
            `${recordedContract}, but this gateway is configured for ${config.platform.contractId}. ` +
            `That marker describes different shared state, so it cannot vouch for this one. Point ` +
            `MNO_PLATFORM_SCHEDULE_PATH at a per-contract file.`,
        );
      }
      if (recorded != null && String(recorded) !== String(SCHEDULE)) {
        throw new Error(
          `refusing Platform nullifier mode: MNO_PLATFORM_ASSUME_SCHEDULE asserts this gateway's ` +
            `schedule (${SCHEDULE}), but ${config.platformSchedulePath} records that the assertion was ` +
            `first made for ${recorded}. The epoch or season length has changed since, which renumbers ` +
            `every period, so the existing Platform records mean something different now. Point the ` +
            `deployment at fresh Platform state, or delete that file only if you know the shared state ` +
            `was rewritten for the new schedule.`,
        );
      }
      if (recorded == null) {
        // WRITE, FLUSH, RENAME. The marker is the thing a later boot compares against, so a marker
        // half-written by an interruption is worse than no marker: it either refuses a correct
        // schedule or, if the truncation happens to leave parseable JSON, records the wrong one. A
        // temp file in the same directory plus a rename makes the appearance atomic, and the fsync
        // before it is what makes the CONTENT durable rather than merely queued.
        await mkdir(dirname(config.platformSchedulePath), { recursive: true });
        // A UNIQUE TEMP NAME, and the rename is a create-or-lose race rather than a shared file.
        // A fixed `.tmp` path meant two gateways starting together both saw no marker and both wrote
        // the SAME temporary file, so one could be reading or renaming what the other was still
        // writing. The pid and a random suffix make each writer's temp file its own, and since both
        // would write identical content the rename is harmless whoever wins.
        const tmpPath = `${config.platformSchedulePath}.${process.pid}.${randomUUID()}.tmp`;
        const fh = await open(tmpPath, "w");
        try {
          await fh.writeFile(JSON.stringify({ schedule: SCHEDULE, contractId: config.platform.contractId ?? null }) + "\n");
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmpPath, config.platformSchedulePath);
        // AND FLUSH THE DIRECTORY. The temp file's CONTENT was flushed before the rename, but the
        // rename itself is a directory operation, and on a crash before that directory entry is
        // durable the marker can vanish entirely even though its bytes reached the disk. The whole
        // point of the marker is that a LATER boot compares against it, so losing it means the next
        // start silently records a new schedule and the assertion protects nothing. Filesystem
        // behaviour varies, which is why this is done rather than reasoned about.
        const dirHandle = await open(dirname(config.platformSchedulePath), "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
        // RE-READ AFTER THE RACE. Two gateways can both have found no marker and both have written
        // one. They agree only if their schedules agree, so read back what actually landed and refuse
        // if it is not ours. Without this, the loser of the race would carry on believing its own
        // schedule was recorded.
        const landed = JSON.parse(await readFile(config.platformSchedulePath, "utf8"))?.schedule ?? null;
        if (String(landed) !== String(SCHEDULE)) {
          throw new Error(
            `refusing Platform nullifier mode: ${config.platformSchedulePath} records schedule ` +
              `${landed}, not this gateway's ${SCHEDULE}. Another process wrote it first, which means ` +
              `two gateways are pointed at one marker under different schedules.`,
          );
        }
      }
    }
    const { connectPlatform, DocumentNullifierStore } = await import("./platform_store.js");
    const backend = await connectPlatform({
      network: config.platform.network,
      mnemonic: config.platform.mnemonic,
      contractId: config.platform.contractId,
      appName: config.platform.appName,
    });
    nullifiers = new DocumentNullifierStore(backend);
    // The Platform client holds network connections, so it is registered for release the moment it
    // exists, before anything downstream can throw.
    release.push(() => nullifiers.close());
    console.warn(
      `[gateway] shared nullifier state on Dash Platform (${config.platform.contractId}). The schedule ` +
        `(${SCHEDULE}) is ASSERTED by MNO_PLATFORM_ASSUME_SCHEDULE, not verified: nothing on chain ` +
        `records which schedule these documents were written under, and the local marker at ` +
        `${config.platformSchedulePath} can only speak for THIS gateway. If any other gateway shares ` +
        `contract ${config.platform.contractId}, you are responsible for it running schedule ` +
        `${SCHEDULE} as well, because a mismatch renumbers every epoch and season and nothing here ` +
        `can detect it.`,
    );
  } else if (config.store === "sqlite") {
    // ":memory:" is a SQLite database that dies with the process, so it is the ephemeral store wearing
    // the durable store's name. Without this it slipped past the opt-in above and even logged itself as
    // durable, which is worse than the plain memory store because the log said the opposite.
    if (config.nullifierStorePath === ":memory:" && !config.allowEphemeralNullifiers) {
      throw new Error(
        "MNO_NULLIFIER_PATH=:memory: keeps the spent-nullifier set in memory, so a restart mid-epoch " +
          "forgets every spend. Point it at a file, or set MNO_ALLOW_EPHEMERAL_NULLIFIERS=1 to accept " +
          "that for local use.",
      );
    }
    const { SqliteNullifierStore } = await import("./nullifier_sqlite.js");
    const { mkdirSync, chmodSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const ephemeralDb = config.nullifierStorePath === ":memory:";
    if (!ephemeralDb) {
      // The directory is the second half of the boundary, and mkdir's mode applies only when it
      // CREATES the directory. A data directory left over from an earlier run keeps whatever mode it
      // had, so set it explicitly every boot rather than assuming creation.
      const dir = dirname(config.nullifierStorePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch (e) {
        throw new Error(`refusing to start: cannot restrict ${dir} to mode 0700 (${e.message})`);
      }
    }
    nullifiers = new SqliteNullifierStore(config.nullifierStorePath, SCHEDULE);
    // The open database handle, registered here rather than in close(), so a refusal further down
    // the boot (the two-tier guards, a missing verification key, a malformed register context) does
    // not strand it with no handle to close it through.
    release.push(() => nullifiers.close());
    console.log(
      ephemeralDb
        ? "[gateway] EPHEMERAL in-memory SQLite nullifier state: a restart forgets every spend this epoch"
        : `[gateway] durable nullifier state at ${config.nullifierStorePath}`,
    );
  } else {
    nullifiers = new NullifierStore();
    console.warn("[gateway] EPHEMERAL nullifier state: a restart forgets every spend this epoch");
  }

  // The window's ordering key, DERIVED from the validated version rather than read from the snapshot.
  //
  // Taking it from the snapshot is what removed the window's bound: the key space became "any string a
  // source cares to send", so one height could hold unlimited records. Deriving it means the key space
  // is exactly as large as the set of versions this build understands, which is two, so at most two
  // records can share a height and the bound is a property of the enumeration rather than a counter
  // somebody has to remember to check.
  function windowOrderKey(version, order) {
    return version === 3 ? String(order) : null; // v1 and v2 are the legacy ordering
  }

  // The DML root window, fed by the oracle. One window holds both roots per snapshot (RootWindows), so
  // the Poseidon view (dmlRoots.isRecent, for single-tier verify and two-tier registration) and the
  // SHA-256 view (dmlRoots.shaView(), for the zkVM registration statement) are structurally in lockstep
  // and cannot drift. The zkVM registration verify (deferred with the live receipt verifier) uses
  // dmlRoots.shaView() as its rootStore.
  // The node caller, built once, only in node mode. Shared with the oracle CLI so the timeout and
  // buffer limits that exist because of specific failures are not re-derived here.
  const nodeCall = config.dmlSource === "node"
    ? makeNodeCall({
        rpcUrl: config.nodeRpcUrl,
        rpcUser: config.nodeRpcUser,
        rpcPass: config.nodeRpcPass,
        rpcHeader: config.nodeRpcHeader,
        timeoutMs: config.nodeCallTimeoutMs,
      })
    : null;
  if (config.dmlSource === "node") {
    console.warn(
      `[gateway] DIRECT NODE MODE: the DML is read from ${config.nodeRpcUrl ?? "the local dash-cli"} ` +
        `and gated on ChainLock, so no oracle signing key is trusted. This is a TRUSTED-NODE read: one ` +
        `server answers the ChainLock query, the block hash, and the list, so it can return matching ` +
        `hashes over an arbitrary set. It becomes chain-authenticated only when the merkleRootMNList ` +
        `commitment check exists.`,
    );
  }

  const dmlRoots = new RootWindows(config.rootWindow, {
    maxLeaves: config.rootWindowMaxLeaves,
    // The leaf bound must not evict a root a live challenge was minted against, which would refuse a
    // proof that was correct when the member asked for it (review finding F4).
    pinnedRoots: () => challenges.pinnedRoots(),
  });
  // The last verified oracle snapshot, so provers can fetch leaves and build paths. DERIVED from the
  // window rather than tracked beside it: the snapshot rides in the same record as its roots, so
  // aging, eviction, and adoption move all of them together.
  //
  // WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. At any single instant the served snapshot and the
  // served root are the same record, which is what was broken: as two variables aged by separate
  // rules they could split, and a record whose timestamp was older than a retained one cleared the
  // served snapshot while leaving its root current, so /v1/challenge advertised a root /v1/dml had no
  // leaves for. It does NOT make a challenge and a later /v1/dml agree, because they are separate
  // requests and a refresh can land between them. A prover that fetches leaves after a changeover can
  // still receive a different snapshot than its challenge named, and must re-challenge. Closing that
  // needs lookup by root, which is recorded in TODO.md rather than claimed here.
  const latestSnapshot = () => dmlRoots.current()?.snapshot ?? null;
  const dmlRootFromLeaves = await makeDmlRootHasher(config.treeDepth);

  // Reject a malformed or implausibly-timestamped snapshot before it can reach the verify path
  // (review finding M3). Shape, depth, and leaf field-elements are checked here, plus a bound on the
  // oracle's self-reported timestamp: too old to adopt, or too far in the future (which would
  // otherwise let a clock-skewed or replayed future-dated snapshot pose as fresh). The root recompute
  // in refreshRoots is the separate check that the leaves actually produce the claimed root.
  // Snapshot versions whose schema carries a SHA-256 root. A version absent from this set is refused on
  // a zkVM deployment even if it happens to include a shaRoot field, so adding a version is a decision
  // rather than something that happens by default.
  const DUAL_ROOT_VERSIONS = new Set([2, 3]);

  function validateSnapshot(o, requiresSha) {
    if (!o || typeof o !== "object") throw new Error("snapshot is not an object");
    if (!Number.isInteger(o.height) || o.height < 0) throw new Error("snapshot height invalid");
    const depth = o.depth ?? config.treeDepth;
    if (depth !== config.treeDepth) throw new Error(`snapshot depth ${depth} != expected ${config.treeDepth}`);
    if (o.root == null || !isCanonicalField(o.root)) throw new Error("snapshot root is not a canonical field element");
    if (!Array.isArray(o.leaves)) throw new Error("snapshot leaves missing");
    if (o.leaves.length > 2 ** config.treeDepth) throw new Error("snapshot leaves exceed tree capacity");
    for (const l of o.leaves) if (!isCanonicalField(l)) throw new Error("snapshot leaf is not a canonical field element");
    // Strict version, failing closed: absent/1 is v1, 2 is v2, anything else is rejected, so an
    // unknown-version snapshot cannot be adopted under the legacy v1 message with future fields
    // unauthenticated. One dispatch point shared with the signer (common/oracle_sig.js).
    const version = snapshotVersion(o);
    // Version schema, enforced independent of deployment mode so a malformed snapshot is never adopted
    // anywhere: v2 always carries a well-formed SHA-256 root, v1 never carries one. This closes a v2
    // snapshot with no shaRoot being accepted on a non-zkVM or unsigned deployment, and a v1 snapshot
    // smuggling a shaRoot. A shaRoot, when present, is a 64-lowercase-hex STRING (not a coercible array
    // or number), so a malformed value cannot pass the recompute and signature paths via String().
    if (o.shaRoot != null && (typeof o.shaRoot !== "string" || !/^[0-9a-f]{64}$/.test(o.shaRoot))) {
      throw new Error("snapshot shaRoot is not a 64 lowercase hex string");
    }
    // ONE BLOCK-HASH SCHEMA FOR EVERY VERSION THAT CARRIES THE FIELD, checked here rather than in the
    // signature path, so unsigned deployments get it too. Two problems came from having two rules.
    // The signature path tested String(o.blockHash) against a case-INSENSITIVE pattern, so a singleton
    // array holding a valid hash coerced through and an uppercase hash was accepted, while v3 demanded
    // a lowercase string. mayCoexist then compares stored hashes exactly, so an uppercase v2 record and
    // the lowercase v3 record for the SAME block read as different blocks and the changeover was
    // refused for a freshness period. Canonical lowercase everywhere removes the representational
    // difference rather than teaching each comparison to normalize.
    //
    // BREAKING for any deployment publishing uppercase block hashes: those snapshots are now refused,
    // and the fix is to publish the lowercase form Core emits and re-sign.
    if (o.blockHash != null && (typeof o.blockHash !== "string" || !/^[0-9a-f]{64}$/.test(o.blockHash))) {
      throw new Error("snapshot blockHash is not a 64 lowercase hex string");
    }
    if (version === 2 && o.shaRoot == null) throw new Error("v2 snapshot is missing its shaRoot");
    if (version === 1 && o.shaRoot != null) throw new Error("v1 snapshot must not carry a shaRoot");
    // v3 carries everything v2 does PLUS the leaf ORDER, and the schema has to demand both or the
    // signed-message form cannot be relied on. Adding a version and leaving its schema unstated is how
    // a new version becomes the weakest one: v3 had no rule here at all, so a v3 snapshot with no
    // shaRoot and no order passed validation that v2 would have failed.
    // v1 and v2 signatures do not cover `order` or `chainlocked`, so accepting those fields on those
    // versions is accepting unauthenticated input. A compromised host could append a unique order
    // string on every refresh while keeping a valid signature, and because the window keyed on that
    // string it grew without bound at one height. Refuse them outright rather than ignoring them, so a
    // snapshot claiming something its signature does not cover is a hard error rather than a silent
    // discard.
    if (version !== 3) {
      if (o.order != null) throw new Error(`a v${version} snapshot must not carry a leaf order`);
      if (o.chainlocked != null) throw new Error(`a v${version} snapshot must not carry a chainlock claim`);
    }
    if (version === 3) {
      if (o.shaRoot == null) throw new Error("v3 snapshot is missing its shaRoot");
      if (typeof o.order !== "string" || o.order.length === 0) {
        throw new Error("v3 snapshot is missing its leaf order");
      }
      // The ordering rules this build knows how to reason about. An unrecognised one is refused rather
      // than filed under a label nothing understands, because the window keys on it to hold two orders
      // apart and a label it cannot interpret makes that separation meaningless.
      if (o.order !== "proRegTxHash") throw new Error(`v3 snapshot has an unknown leaf order: ${o.order}`);
      // The ChainLock claim is what a v3 snapshot exists to carry, and it is in the signed bytes, so a
      // v3 snapshot without it is either torn or built by something that did not read a ChainLock.
      // The signature covering the claim is not enough on its own: with it false, missing, or
      // mistyped, the signed message still formed (encoding "0") and this function accepted the
      // snapshot, so a v3 could be adopted without making the claim v3 exists to make.
      if (o.chainlocked !== true) {
        throw new Error("v3 snapshot does not claim a ChainLocked block (chainlocked must be boolean true)");
      }
      // A v3 snapshot is a BLOCK-BOUND read, so the block it names must be well formed regardless of
      // deployment mode. Before this check, only signed deployments validated the hash (in
      // oracleSignaturesOk), so unsigned mode could adopt a v3 snapshot anchored to nothing.
      // Lowercase-hex strict, the same canonical-form rule shaRoot follows, and what Core emits.
      if (typeof o.blockHash !== "string" || !/^[0-9a-f]{64}$/.test(o.blockHash)) {
        throw new Error("v3 snapshot blockHash is not a 64 lowercase hex string");
      }
    }
    // Deployment-scoped dual-root requirement (docs/ZKVM_INTEGRATION.md). A zkVM deployment refuses a
    // v1 snapshot outright, since it lacks the SHA-256 root the zkVM statement is checked against, so a
    // downgrade cannot slip a rootless snapshot in. `requiresSha` is judged by configured intent AND a
    // durable current-season zkVM declaration (computed in refreshRoots), so a gateway reopened with
    // existing zkVM registrations keeps requiring v2 even if the config flag was unset (the rollback
    // rule the review flagged).
    // The versions whose SCHEMA carries a SHA-256 root, enumerated rather than inferred. This read
    // `version !== 2`, which guaranteed three things: no snapshot without a shaRoot, no v1, and, as a
    // side effect of testing equality with ONE version, no other version either. That third guarantee
    // was accidental and is worth keeping, because it fails closed on a future version that might not
    // carry a root. It also rejected every v3 snapshot, which made the block-bound read unusable on any
    // zkVM deployment. Listing the versions keeps the fail-closed property and admits v3.
    if (requiresSha && (!DUAL_ROOT_VERSIONS.has(version) || o.shaRoot == null)) {
      throw new Error(
        `zkVM deployment requires a snapshot carrying a shaRoot (v${[...DUAL_ROOT_VERSIONS].join(" or v")}), ` +
          `got v${version} (downgrade refused)`,
      );
    }
    if (config.oracleMaxAgeSeconds > 0) {
      const ts = Number(o.ts);
      if (!Number.isFinite(ts)) throw new Error("snapshot timestamp invalid");
      if (nowSec() - ts > config.oracleMaxAgeSeconds) throw new Error("snapshot is too old");
      if (ts - nowSec() > config.oracleFutureSkewSeconds) throw new Error("snapshot timestamp too far in the future");
    }
  }

  // Authenticate the leaf set, not just its internal consistency. With trusted oracle keys configured,
  // count how many distinct keys signed this snapshot's canonical message and require the quorum. A
  // signature covers the root, which commits to the leaves, so a met quorum means trusted oracle keys
  // vouched for this membership set, and a host that merely serves the JSON cannot forge one. With no
  // keys configured (allowUnsignedOracle let the gateway boot), signing is not enforced.
  function oracleSignaturesOk(o) {
    if (config.oraclePubkeys.length === 0) return true;
    // A signed snapshot must anchor a real block, since the signature covers the block hash and the
    // chain-anchor argument rests on it. Reject a missing or malformed one rather than count signatures
    // over an empty anchor. The shape is the same canonical rule validateSnapshot applies to every
    // version, typed rather than coerced, so a singleton array cannot pass here by stringifying.
    if (typeof o.blockHash !== "string" || !/^[0-9a-f]{64}$/.test(o.blockHash)) {
      console.error(`[gateway] signed oracle snapshot has no valid block hash, rejected`);
      return false;
    }
    // THE WORK HERE IS BOUNDED BY THE CONFIGURED KEYS, NOT BY THE RESPONSE. `sigs` had no length
    // bound and the entries' own key labels were ignored, so the gateway scanned and verified the
    // whole array once per trusted key. A host that cannot forge a quorum could therefore still buy
    // synchronous Ed25519 work with a large array (a reviewer measured 10,000 invalid checks at about
    // 1.28 s, multiplied by the number of pinned keys), blocking the event loop at boot and on every
    // refresh. That partly reverses the point of checking signatures before the tree rebuild.
    //
    // Each entry names the key it was made with, so the array is indexed by that label and at most
    // ONE signature is checked per trusted key. A duplicate label is refused outright rather than
    // resolved, because two entries claiming one key is not something an honest signer produces and
    // picking a winner would be inventing a rule. The cost is now O(configured keys) verifications
    // whatever the source sends.
    const sigs = Array.isArray(o.sigs) ? o.sigs : [];
    if (sigs.length > MAX_SNAPSHOT_SIGS) {
      console.error(`[gateway] oracle snapshot carries ${sigs.length} signatures, over the ${MAX_SNAPSHOT_SIGS} cap, rejected`);
      return false;
    }
    const byKey = new Map();
    for (const entry of sigs) {
      if (!entry || typeof entry.key !== "string" || typeof entry.sig !== "string") continue;
      // CANONICALIZE THE LABEL before matching. The same 32-byte key has several base64 spellings
      // (padding, base64url), and the previous code was immune to that because it ignored labels and
      // tried every signature against every key. Indexing by a raw label would have made a valid
      // signature invisible purely because its spelling differed, which is a fail-closed bug rather
      // than a security one but a real outage. Decoding is cheap and bounded by the cap above; it is
      // signature VERIFICATION that this whole change exists to bound.
      let id;
      try {
        id = rawPublicB64(publicKeyFromRaw(entry.key));
      } catch {
        continue; // an unparseable label cannot match any trusted key
      }
      if (byKey.has(id)) {
        console.error(`[gateway] oracle snapshot carries two signatures for one key, rejected`);
        return false;
      }
      byKey.set(id, entry.sig);
    }
    const msg = snapshotMessage(o);
    let met = 0;
    for (const trusted of config.oraclePubkeys) {
      const candidate = byKey.get(trusted.b64);
      if (candidate != null && verifySnapshotSig(msg, candidate, trusted.key)) met += 1;
    }
    return met >= config.oracleQuorum;
  }

  // Enforce the freshness bound on EVERY root the window will still accept, not only the newest. Each
  // root carries its own oracle timestamp (bounded at adoption to no more than oracleFutureSkewSeconds
  // in the future), so dropping those older than the bound stops a removed node from proving against
  // an aged-out root that newer snapshots happened to keep in the window. Called on the refresh tick
  // and at request time, so a refresh interval longer than the bound cannot leave a stale root
  // servable between ticks. The served snapshot needs no separate sweep: it rides in the record, so
  // dropping the record drops its leaves at the same instant, which is what stops the two splitting.
  function enforceDmlFreshness() {
    if (config.oracleMaxAgeSeconds <= 0) return;
    const cutoff = nowSec() - config.oracleMaxAgeSeconds;
    const before = dmlRoots.current()?.root ?? null;
    dmlRoots.dropOlderThan(cutoff); // one window ages both roots and the snapshot of each record
    const after = dmlRoots.current()?.root ?? null;
    if (before !== null && after === null) {
      console.error(`[gateway] oracle snapshot stale, dropping root until a fresh one arrives`);
    }
  }

  // Refreshes are SERIALIZED. setInterval does not await, so two fetches could overlap and finish out
  // of publication order, letting a slow older response be adopted after a newer one and become the
  // served snapshot. A refresh already in flight makes the tick a no-op rather than queuing, because
  // the next tick is only seconds away and a queue of stale fetches has no value.
  //
  // THE IN-FLIGHT REFRESH IS HELD AS A PROMISE, not merely as a flag, because close() has to be able
  // to WAIT for it. Clearing an interval does not cancel a callback already running: a refresh whose
  // fetch is outstanding keeps its own request and abort timer alive and would go on to mutate the
  // root window after close() had returned, which is exactly the "gave everything back" claim being
  // false. A refresh that starts after close() does not run at all.
  let refreshInFlight = null;
  let closed = false;
  // The one teardown every close() caller shares. Built on the first call; see close() below.
  let closePromise = null;
  // The most recent listen attempt, settled either way, so teardown can wait for a bind in progress.
  let lastListen = Promise.resolve();

  async function refreshRoots() {
    if (refreshInFlight) {
      // Not an error. A source slower than the refresh interval is an operational fact, and skipping
      // is what keeps completion order equal to publication order.
      return;
    }
    if (closed) return;
    let settle;
    refreshInFlight = new Promise((resolve) => {
      settle = resolve;
    });
    try {
      // THE READ, from whichever source this deployment trusts. In node mode the gateway builds the
      // snapshot itself from its own node, so nothing is fetched, nothing is signed, and there is no
      // publisher between the chain and here. Everything downstream is identical: the same
      // validateSnapshot, the same root recompute, the same window. Only the origin differs.
      const o = config.dmlSource === "node"
        ? await buildDiffSnapshot({ call: nodeCall, log: (m) => console.error(m) })
        : await loadOracle(config.oracleSource, { allowHttp: config.oracleAllowHttp });
      // Require v2 if configured OR if a durable zkVM registration exists in the current season, so a
      // deployment that has served zkVM registrations cannot be downgraded to v1 by clearing the flag.
      let requiresSha = config.requireShaRoot;
      if (!requiresSha && twoTier && registrationStore) {
        requiresSha = await registrationStore.seasonHasEngine(timeGuard.season(), "zkvm");
      }
      // EVERY await above this line is a window for close() to have run, so the check sits after the
      // LAST of them, immediately before the work whose effects outlive this call. A first version
      // checked after the read only, and the two-tier engine lookup right behind it reopened the
      // exact race the check was added for: a refresh could adopt a root into a window whose owner
      // had already handed everything back.
      if (closed) return;
      validateSnapshot(o, requiresSha);
      // THE SIGNATURE QUORUM IS CHECKED BEFORE THE TREE REBUILDS, because the rebuilds are the
      // expensive part and an unauthenticated source must not be able to buy them. A host with no
      // trusted key can serve a schema-valid snapshot carrying a full tree of leaves, and rebuilding
      // both roots before rejecting it blocks the event loop for seconds per refresh, which is a
      // denial of service against every endpoint. Ed25519 verification is cheap and decides the same
      // question. On an unsigned deployment this is a no-op, so the order costs nothing there.
      // A locally built snapshot has no signatures and needs none: it never left this process, so
      // there is no transport to authenticate. oracleSignaturesOk would refuse it for having no
      // block-hash-bearing sigs array, which would be checking the wrong property entirely.
      const signaturesOk = config.dmlSource === "node" ? true : oracleSignaturesOk(o);
      // Always recompute the root from the published leaves and trust only a self-consistent snapshot,
      // whether the root is new or a republish of the current one. The fast hasher is O(real leaves),
      // so this runs every refresh cheaply, and a snapshot whose leaves do not hash to its root is
      // rejected and does not renew freshness, so a corrupted or inconsistent source cannot keep a
      // stale root alive. The recompute only proves internal consistency. oracleSignaturesOk is the
      // separate check that a trusted oracle key vouched for this leaf set, so a source that forges a
      // self-consistent pair over an attacker-chosen set is rejected unless it also holds a trusted key.
      const recomputed = signaturesOk ? dmlRootFromLeaves(o.leaves) : null;
      // Recompute the SHA-256 root from the SAME leaves too, so a v2 snapshot whose shaRoot does not
      // hash from its leaves is rejected exactly like a mismatched Poseidon root. Both roots are
      // recomputed for every snapshot that is adopted, so a source cannot pair a good Poseidon root
      // with a forged shaRoot, and the two provably describe one leaf set.
      const shaRecomputed = signaturesOk && o.shaRoot != null ? shaRootFromLeaves(o.leaves, config.treeDepth) : null;
      if (!signaturesOk) {
        console.error(`[gateway] oracle snapshot signature quorum not met (need ${config.oracleQuorum} trusted signer(s)), rejected`);
      } else if (recomputed !== String(o.root)) {
        // Reject the inconsistent snapshot, but do not early-return: the staleness check below must
        // still run, or an aged-out accepted root would keep being served while the source is bad.
        console.error(`[gateway] oracle root mismatch, snapshot rejected: claimed ${o.root}, recomputed ${recomputed}`);
      } else if (shaRecomputed !== null && shaRecomputed !== String(o.shaRoot)) {
        console.error(`[gateway] oracle shaRoot mismatch, snapshot rejected: claimed ${o.shaRoot}, recomputed ${shaRecomputed}`);
      } else if (dmlRoots.maxHeight() !== null && Number(o.height) < dmlRoots.maxHeight()) {
        // Height regressed below the accepted root. A masternode list height is the block count and
        // only moves forward, so a lower height is a replayed old snapshot or a reorg, and the two are
        // indistinguishable without the block hash (tracked with the leaf-authentication follow-up).
        // The safe default for a security gate is to reject: adopting it would strand provers and
        // re-window a stale root a node may have been evicted from. If the lower height is a genuine
        // sustained reorg, the old root ages out within oracleMaxAgeSeconds, the window empties, and
        // the next lower-height snapshot is then accepted, so the gateway self-heals onto the
        // canonical branch within the bound.
        console.error(`[gateway] oracle height regressed (${o.height} < ${dmlRoots.maxHeight()}), snapshot rejected`);
      } else if (
        // Asked of the WINDOW, unconditionally, for every candidate. The guard used to be reached only
        // when a separate last-adopted pointer existed and disagreed, so an expired pointer beside a
        // surviving record at the same height skipped the check entirely and let an inconsistent set
        // in beside a consistent one. An exact republish still passes, because a record describing the
        // same block and the same leaf multiset is what the check admits.
        !dmlRoots.mayCoexist({
          height: o.height,
          blockHash: o.blockHash ?? null,
          setCommitment: leafSetCommitment(o.leaves),
        })
      ) {
        // Same height, different root, and NOT a legitimate ordering pair. The list at a fixed height is
        // deterministic, so this is inconsistent. Reject rather than flap the served root.
        //
        // The exception is narrow and checked, not assumed. A v2 and a v3 snapshot of the same
        // masternodes differ in build order and so in root, and both are meant to be provable against
        // during a changeover. mayCoexist admits that pair ONLY when the two describe the same block AND
        // commit to the same leaf multiset, so a member present only in a stale, orphaned, or
        // inconsistent set cannot keep proving after the canonical root arrives. Without that check the
        // coexistence would have been the hole rather than the feature.
        console.error(`[gateway] oracle root changed at height ${o.height}, snapshot rejected`);
      } else {
        // Height is at or above every retained record, so this snapshot becomes (or stays) current.
        // Only a self-consistent snapshot reaches here, so the ts that drives expiry is
        // verified-fresh, and the snapshot itself is stored in the record so the served leaves and
        // the served root can never name different snapshots.
        // One paired record holds both roots, so the two views stay in lockstep by construction. A v1
        // snapshot has shaRoot null and never matches the SHA-256 view.
        // `order` carries the snapshot's leaf ordering, so a v2 and a v3 root at one height coexist in
        // the window instead of the newer replacing the older. That is what lets an oracle switch to the
        // block-bound read without locking out every prover still holding a tree in the old order. A
        // snapshot that does not state its order is legacy ordering, which is what v1 and v2 are.
        dmlRoots.adopt({
          height: o.height,
          root: o.root,
          shaRoot: o.shaRoot ?? null,
          ts: o.ts ?? nowSec(),
          order: windowOrderKey(snapshotVersion(o), o.order),
          blockHash: o.blockHash ?? null,
          // Derived here from the leaves this gateway just recomputed both roots from, so it is never a
          // value the source chose. It is what a later snapshot at this height is checked against.
          setCommitment: leafSetCommitment(o.leaves),
          // A NORMALIZED snapshot, never the parsed object as it arrived. Retaining `o` retained
          // whatever else the source had put in it: snapshot validation does not reject unknown
          // properties and the signed message ignores them, so a host holding no signing key could
          // append a large padding field to a legitimately signed snapshot and have the gateway keep
          // it at every height in the window. A reviewer measured 157 MB of resident growth from
          // eight padded records. Copying only the fields /v1/dml serves bounds what a record can
          // cost to the leaves it is actually for, and drops the signatures too, which have no
          // consumer after adoption.
          snapshot: normalizeSnapshot(o, config.treeDepth),
        });
      }
    } catch (err) {
      console.error("[gateway] root refresh failed:", err.message);
    } finally {
      try {
        // Prune aged-out roots from the window. validateSnapshot only blocks adopting a stale
        // snapshot; this stops serving ones already accepted, so a stalled, replayed, or inconsistent
        // source cannot keep admitting members against a frozen root. Runs every tick, even when the
        // fetch failed or the snapshot was rejected above, and again at request time (see the server
        // handler). Skipped after close(), which has already given the window up.
        if (!closed) enforceDmlFreshness();
      } finally {
        // Always, whatever happened above, because close() waits on this promise and a refresh that
        // never settles would hang the teardown rather than delay it.
        refreshInFlight = null;
        settle();
      }
    }
  }

  // Two-tier state. SeasonMembers owns the season-scoped members tree (a cache rebuilt from the
  // durable registration records, so a restart never loses a registration and a season boundary
  // starts a fresh empty tree) and serializes rollovers and member commits on one queue, which is
  // what closes the season-rollover race. See core/season.js.
  let vkey, regVkey, membersVkey, registrationStore, seasonMembers;

  // The zkVM registration engine needs the live receipt verifier (a pinned r0vm subprocess or a WASM
  // build), which is deferred and artifact-gated. Refuse to boot in that mode rather than run a
  // registration path whose crypto check is unconfigured (verifyZkvmRegistration would fail closed on
  // every request anyway). The PLONK engine is the shipping default. See docs/ZKVM_INTEGRATION.md.
  if (twoTier && config.registrationEngine === "zkvm") {
    throw new Error(
      "MNO_REGISTRATION_ENGINE=zkvm needs the RISC Zero receipt verifier, which is not wired yet. " +
        "Use the default plonk engine; the zkVM registration path is the tracked follow-up in " +
        "docs/ZKVM_INTEGRATION.md (step 5, the live STARK verifier).",
    );
  }

  if (twoTier) {
    // The two-tier + Platform-store combination is rejected up front (see the guard near the top).
    regVkey = await loadVerificationKey(config.registrationVkeyPath);
    membersVkey = await loadVerificationKey(config.membersVkeyPath);
    const { RegistrationStore, FileBackend } = await import("./registration_store.js");
    registrationStore = new RegistrationStore(new FileBackend(config.registrationStorePath, SCHEDULE, config.assumeSchedule));
    await registrationStore.ready();
    console.log(`[gateway] durable registration records at ${config.registrationStorePath}`);
    // The empty members root, computed once via the fast hasher (instant), so an empty context never
    // forces a 2**16 tree build (see SeasonMembers).
    const emptyMembersRoot = dmlRootFromLeaves([]);
    seasonMembers = new SeasonMembers({
      store: registrationStore,
      rootWindow: config.rootWindow,
      nowSec,
      emptyRoot: emptyMembersRoot,
      // The gateway's seasons come from the guarded clock, so a backward roll here would mean the
      // guard was bypassed. Refuse rather than rebuild a season that has already ended.
      monotonic: true,
      // The authoritative season, re-read inside the serialized commit so a registration cannot
      // append a record for a season wall time has already left.
      // OBSERVES BOTH PERIODS, not just the one it returns. `regressed` only moves for the observation
      // actually made, so a callback that sampled the season alone left a backward step that crossed an
      // EPOCH boundary but not a season boundary invisible to the registration commit, while the
      // membership path checked both. Same defect shape as the verify path and the members read, which
      // is now the fourth place it has appeared: the rule is to observe everything the decision rests
      // on, and the decision here rests on the clock being trustworthy at all.
      seasonNow: () => {
        timeGuard.epoch();
        return timeGuard.season();
      },
      // Checked inside the serialized commit, immediately before the durable append, so a clock that
      // went backward during the heavy proof cannot write a registration under a numbering the gateway
      // no longer trusts.
      clockRegressed: () => timeGuard.regressed,
    });
    await seasonMembers.ensure(timeGuard.season());
    if (config.registerRootMaxAgeSeconds <= 0) {
      console.warn(
        `[gateway] MNO_REGISTER_ROOT_MAX_AGE is 0, so the registration anchor rule is DISABLED and a ` +
          `registration may use any root the membership window still holds. Roots are pruned once ` +
          `older than MNO_ORACLE_MAX_AGE (${config.oracleMaxAgeSeconds}s), on each refresh and on each ` +
          `request, so that is the effective grace. A node that left the masternode list within it can ` +
          `still register and keep membership for the remainder of the season.`,
      );
    } else {
      console.log(
        `[gateway] registration anchor: a root may be at most ${config.registerRootMaxAgeSeconds}s old, ` +
          `against a membership window of ${config.oracleMaxAgeSeconds}s. A node that left the ` +
          `masternode list within that grace can still register for the remainder of the season.`,
      );
    }
    // FAIL CLOSED ON AN UNSET ALLOWLIST, in the same style as the unauthenticated-gateway and
    // unsigned-oracle opt-ins. A warning was not enough: an existing deployment upgrading to this
    // version would keep the unbounded path simply by not knowing about a new setting, which leaves
    // the very defect the allowlist exists to close, and the cost is not theoretical because each
    // fresh context forces a full members-tree build.
    if (config.registerContexts.length === 0 && !config.allowAnyRegisterContext) {
      throw new Error(
        "refusing to start two-tier mode with no MNO_REGISTER_CONTEXTS: registration is " +
          "proof-authenticated but the caller chooses the context, so with no allowlist one valid " +
          "masternode holder can allocate unlimited context trees, each costing a durable record and a " +
          "full members-tree build. Set MNO_REGISTER_CONTEXTS to the context hashes this deployment " +
          "serves, or MNO_ALLOW_ANY_REGISTER_CONTEXTS=1 to run open on purpose (local dev, demos).",
      );
    }
    if (config.registerContexts.length === 0) {
      console.warn(
        "[gateway] MNO_ALLOW_ANY_REGISTER_CONTEXTS=1: ANY context hash may be registered, so one valid " +
          "masternode holder can allocate unlimited context trees. Local dev and demos only.",
      );
    }
    for (const c of config.registerContexts) {
      if (!isCanonicalField(c)) {
        throw new Error(
          `MNO_REGISTER_CONTEXTS entry ${JSON.stringify(c)} is not a canonical field element. A context ` +
            `hash that no proof can ever carry would silently admit nobody, which reads as a working ` +
            `allowlist that refuses everyone.`,
        );
      }
    }
  } else {
    vkey = await loadVerificationKey(config.verificationKeyPath);
  }

  await refreshRoots();
  every(config.oracleRefreshSeconds * 1000, refreshRoots);
  every(60_000, () => challenges.sweep());
  // EVERY limiter, from the derived list, so adding a limiter cannot silently omit it from the
  // sweep. Three limiters added in an earlier fold were missed exactly that way (two reviewers found
  // it independently): they grew until the hard maxKeys ceiling forced a synchronous sweep, which
  // both costs more memory in the meantime and reaches the shed-load path under milder pressure than
  // the swept ones. The list is Object.values of the limiter map, so a limiter that exists is swept.
  every(60_000, sweepLimiters);
  // Roll the members tree over at a season boundary even when no request arrives to trigger it.
  if (twoTier) every(60_000, () => seasonMembers.ensure(timeGuard.season()).catch(() => {}));

  // Drop spent nullifiers from epochs that can no longer be verified against, so a long-lived gateway
  // does not grow without bound. Only a durable store implements prune; the in-memory one dies with
  // the process and the Platform one is not ours to sweep. The window is a correctness boundary, so it
  // keeps the current epoch and at least one past epoch (see config.nullifierRetainEpochs): pruning
  // the current epoch would forget live spends and reopen the double-claim hole this store closes.
  if (typeof nullifiers.prune === "function") {
    const pruneClaims = () => {
      try {
        const cutoff = timeGuard.epoch() - config.nullifierRetainEpochs;
        const { removed } = nullifiers.prune(cutoff);
        if (removed) console.log(`[gateway] pruned ${removed} spent nullifiers older than epoch ${cutoff}`);
      } catch (e) {
        console.warn(`[gateway] nullifier prune failed: ${e.message}`);
      }
    };
    pruneClaims();
    every(3600_000, pruneClaims);
  }

  function send(res, code, body) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  // Read and JSON-parse the request body under a hard byte cap. The cap counts RECEIVED BYTES (each
  // chunk is a Buffer), not string units, so a multibyte payload is measured correctly, and once the
  // cap is crossed it stops retaining chunks AND destroys the request, so an unauthenticated caller
  // cannot keep sending to exhaust memory (a single request would otherwise suffice, so the rate limit
  // does not help). Resolves or rejects exactly once.
  function readBody(req, maxBytes = config.maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const settle = (fn, arg) => {
        if (done) return;
        done = true;
        fn(arg);
      };
      req.on("data", (c) => {
        if (done) return;
        total += c.length; // c is a Buffer, so .length is bytes
        if (total > maxBytes) {
          chunks.length = 0; // drop what we have, keep no more
          req.destroy(); // stop receiving so the caller cannot keep growing the body
          settle(reject, new Error("body too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          settle(resolve, raw ? JSON.parse(raw) : {});
        } catch {
          settle(reject, new Error("invalid json"));
        }
      });
      req.on("error", (e) => settle(reject, e));
    });
  }

  // IN-FLIGHT REQUEST HANDLERS, counted, because closing the server is not the same as waiting for
  // them. `server.close()` waits for CONNECTIONS to end, and a client that disconnects mid-request
  // ends its connection while the handler keeps running: the proof verify, the nullifier read, the
  // durable registration append all continue. Teardown would then release the stores underneath a
  // handler that is still using them, which surfaces as "statement has been finalized" on the read
  // path and, on the two-tier path, as a registration append racing whatever opens that file next.
  let inFlightRequests = 0;
  let notifyDrained = null;
  const drainRequests = () =>
    inFlightRequests === 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          notifyDrained = resolve;
        });

  const server = createServer(async (req, res) => {
    inFlightRequests += 1;
    try {
      // Enforce DML freshness on every request, so a refresh interval longer than the freshness bound
      // cannot serve a root that aged out since the last tick.
      enforceDmlFreshness();
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      // Refuse the state-bearing endpoints if the clock has stepped backwards. Observing both periods
      // here is what detects it, so this runs before any handler reads an epoch or a season. The read
      // endpoints (dml, members, health) stay up on purpose, so an operator can still see what the
      // gateway thinks the time is while diagnosing.
      if (path === "/v1/challenge" || path === "/v1/verify" || path === "/v1/register") {
        timeGuard.epoch();
        timeGuard.season();
        if (timeGuard.regressed) {
          const { kind, observed, mark } = timeGuard.regression;
          console.error(`[gateway] refusing ${path}: ${kind} went backwards (saw ${observed}, high-water ${mark})`);
          return send(res, 503, { error: "clock-regression", period: kind });
        }
      }

      if (req.method === "POST" && path === "/v1/challenge") {
        // Auth before the rate limiter, so an unauthorized caller cannot burn the bucket for a client
        // key and block the real adapter.
        if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
        // The ingress shield, before anything is read from the socket. The shared bucket is charged
        // BELOW, only once the per-account limit accepts. Charging
        // it here meant a request the account limit was about to reject still consumed the shared
        // bucket, so one account could spend its own small allowance and then keep draining the
        // community's large one with requests that were never served. The per-account limit then
        // subdivided nothing, which is the opposite of what it was added for.
        if (!ingressLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
        const { platform, communityId, roleId, account: rawAccount } = await readBody(req);
        if (!platform || !communityId || !roleId || !rawAccount) return send(res, 400, { error: "missing fields" });
        // Normalize the account to a string here, the one place it enters, so the signal hash and the
        // stored claim use the same form a numeric or other non-string account would otherwise mint a
        // challenge that the string-typed verify (verifyMembership) could never satisfy.
        const account = String(rawAccount);
        // A BOUND ON THE IDENTIFIER, not just on the body. The account outlives its request: it keys a
        // rate-limit bucket, it is stored in the pending challenge, and it is written into the durable
        // claim record. So a single oversized string is retained long after the capped body that
        // carried it is gone. Measured in BYTES, because a length in characters is not a bound on
        // memory once anything outside the basic multilingual plane is involved.
        if (Buffer.byteLength(account, "utf8") > config.maxAccountBytes) {
          return send(res, 400, { error: `account exceeds ${config.maxAccountBytes} bytes` });
        }
        const ctx = contextHash({ platform, communityId, roleId }).toString();
        // The per-account limit, applied now that the account is actually known. With an authenticated
        // adapter this stops one user behind that adapter from spending the whole community's window;
        // without one it is best-effort, since the caller chooses the string (see the note above).
        // BOTH BUCKETS TOGETHER, or neither. Charging them in sequence made a request refused by the
        // second still cost the first, so a caller the shared bucket turned away lost its own personal
        // allowance too. Reordering just moved which one leaked, and both orderings shipped.
        if (!allowAll([
          [accountChallengeLimiter, rateKey(clientKey(req), account, ctx)],
          [challengeLimiter, clientKey(req)],
        ])) {
          return send(res, 429, { error: "rate limited" });
        }
        // Two-tier challenges run against this context's own members tree (review finding B2), so a
        // member registered for another community cannot prove here.
        let cur;
        let challengeSeason;
        if (twoTier) {
          challengeSeason = timeGuard.season();
          await seasonMembers.ensureContext(challengeSeason, ctx);
          cur = seasonMembers.rootCurrent(ctx);
        } else {
          cur = dmlRoots.current();
        }
        if (!cur) return send(res, 503, { error: "no root available yet" });

        const nonce = randomUUID();
        const epoch = timeGuard.epoch();
        const sig = signalHash(nonce, account).toString();
        // The season is recorded with the challenge so the verify path can tell whether the season it
        // was minted in is still current. Without it a two-tier verify could only compare root store
        // identity, which a rollover-then-rematerialize could make equal again.
        // The root is stored so the window can PIN it, keeping the leaf bound from evicting the ground
      // this member is about to prove against.
      if (!challenges.put(nonce, { account, signalHash: sig, epoch, contextHash: ctx, season: challengeSeason, root: cur.root }))
          return send(res, 429, { error: "too many pending challenges" });
        return send(res, 200, {
          nonce,
          signalHash: sig,
          epoch,
          root: cur.root,
          contextHash: ctx,
          epochSeconds: config.epochSeconds,
          mode: config.mode,
          // The encoding version, so a rolling upgrade that mixes v1 and v2 gateways is visible rather
          // than silently minting two membership domains for one community.
          hashVersion: CONTEXT_VERSION,
          // Two-tier provers select their member secret by context AND season. Without this the prover
          // received null and fell back to whichever accepted secret readdir happened to return first,
          // which after a rollover can be last season's, absent from the current tree.
          ...(twoTier ? { season: challengeSeason } : {}),
        });
      }

      if (req.method === "POST" && path === "/v1/verify") {
        if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
        // Charged below, after the per-account limit accepts. See the challenge handler for why. The
        // ingress shield runs first, before the body is read.
        if (!ingressLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
        const { nonce, proof, publicSignals, account } = await readBody(req);
        if (!nonce || !proof || !publicSignals || !account) return send(res, 400, { error: "missing fields" });
        // Same bound here, before the account reaches a rate-limit key. The challenge path cannot be
        // the only place it is enforced: /v1/verify keys a limiter on this string too.
        if (Buffer.byteLength(String(account), "utf8") > config.maxAccountBytes) {
          return send(res, 400, { error: `account exceeds ${config.maxAccountBytes} bytes` });
        }
        // Per-account, for the same reason as the challenge path. Checked before the challenge is
        // TAKEN, so a rate-limited caller does not consume the one-time nonce it was holding. The
        // Keyed by ACCOUNT ALONE, deliberately, and not by context. A reviewer suggested adding the
        // context so a user in two communities does not share one bucket. Rejected: the context is
        // only knowable by TAKING the challenge, which is the thing that must not happen before the
        // limit is checked, and keying on the nonce instead would be worse than useless because a
        // caller mints a fresh nonce per attempt and would get a fresh bucket with it. Sharing across
        // a user's communities is also the conservative direction: the alternative lets someone
        // multiply their allowance by joining more communities, and the cost being limited here is
        // proof verification, which is per-user work whatever community it is for.
        // Both buckets together, and both BEFORE challenges.take(), so neither a refusal nor a partial
        // charge consumes the one-time nonce.
        if (!allowAll([
          [accountVerifyLimiter, rateKey(clientKey(req), String(account))],
          [verifyLimiter, clientKey(req)],
        ])) {
          return send(res, 429, { error: "rate limited" });
        }
        const pending = challenges.take(nonce);
        if (!pending) return send(res, 410, { ok: false, reason: "unknown-or-expired-challenge" });

        // HOLD THE ROOT FOR THE WHOLE VERIFY. Taking the challenge removed it from the pending map,
        // and the pin the leaf bound consults came from that map, so the root became evictable at the
        // exact moment the expensive work began. The proof check yields the event loop for its whole
        // duration, which is the longest window a refresh has to evict the ground from under it, and
        // the member would then be refused stale-or-unknown-root with the nonce already spent. That
        // left review finding F4 half closed while reading as closed, and a reviewer reproduced it.
        const releaseRoot = challenges.hold(pending.root);
        try {

        // The submitted account must equal the account the challenge was minted for, checked here
        // before the proof verify and the nullifier spend, so a relayed proof cannot grant the relayer
        // or burn the real owner's epoch (review finding B1). With MNO_ADAPTER_SECRET set, the account
        // is supplied only by an authenticated adapter (see authorized() above), so this binding is
        // authoritative rather than just an adapter-relay guard.
        if (String(account) !== String(pending.account)) return send(res, 200, { ok: false, reason: "account-mismatch" });

        // The challenge was minted for pending.epoch. If that epoch has since rolled over, reject here,
        // before the proof verify and the nullifier spend, so a stale-epoch proof does not burn the
        // member's epoch claim for a grant that would already be expired. The gateway owns epoch timing,
        // so an adapter can trust an ok response rather than re-checking expiry against its own clock. The
        // member re-verifies for the current epoch.
        if (nowSec() >= (pending.epoch + 1) * config.epochSeconds) return send(res, 200, { ok: false, reason: "epoch-rolled-over" });

        // The proof is checked against the root window of the same context the challenge was minted
        // for, in the current season. A season rollover since the challenge resets that window, so a
        // proof against the stale root is rejected as stale-or-unknown-root.
        let rootStore = dmlRoots;
        if (twoTier) {
          await seasonMembers.ensureContext(timeGuard.season(), pending.contextHash);
          rootStore = seasonMembers.rootStore(pending.contextHash);
        }
        let result;
        try {
          result = await verifyMembership({
            vkey: twoTier ? membersVkey : vkey,
            proof,
            publicSignals,
            nullifiers,
            gate: (fn) => verifySem.run(fn),
            expected: {
              rootStore,
              epoch: pending.epoch,
              contextHash: pending.contextHash,
              signalHash: pending.signalHash,
              // Re-asked immediately before the nullifier spend, after the proof verify has yielded
              // the event loop for however long it took. Everything here was already checked before
              // the proof; the point is that it is checked AGAIN at the moment the irreversible write
              // happens. Returns null while the period still holds, or the refusal reason.
              stillCurrent: async () => {
                // OBSERVE THE CLOCK, then read the flag. `regressed` is a getter over a mark that only
                // moves inside TimeGuard's own observation, which happens when epoch() or season() is
                // CALLED. Reading the flag alone therefore reported whatever the last observation
                // concluded, which for a single-tier verify was before the proof started, so a clock
                // that stepped backward DURING the proof was invisible to the very check added to
                // catch it. The two-tier branch below happened to observe via season(); single-tier
                // observed nothing. Confirmed directly: step the clock back without re-observing and
                // the flag stays false.
                // BOTH PERIODS, unconditionally. The flag is only updated by the observation that is
                // actually made, so sampling one period cannot see a step backward that moves the
                // other. Season length is not an integer multiple of epoch length (90 days over 7 is
                // not whole), so a step back can change the season while leaving the epoch number
                // alone, and the reverse. Two reviewers reached this from opposite directions, one
                // naming the season-only case and one the epoch-only case, which is the giveaway that
                // the rule is "observe everything the decision depends on" rather than "add the one
                // that was missing".
                timeGuard.epoch();
                timeGuard.season();
                if (timeGuard.regressed) return "clock-regressed";
                if (nowSec() >= (pending.epoch + 1) * config.epochSeconds) return "epoch-rolled-over";
                if (twoTier) {
                  // A season rollover clears the context trees, and this verify has been holding a
                  // root store object that the rollover may already have detached.
                  if (Number(timeGuard.season()) !== Number(pending.season)) return "season-rolled-over";
                  const live = seasonMembers.rootStore(pending.contextHash);
                  if (live !== rootStore) return "season-rolled-over";
                }
                // The root must still be one the window accepts. It can age out or be evicted while a
                // proof runs, and a grant against a root the gateway would no longer accept is the
                // same defect as accepting it in the first place.
                const s = readSignals(publicSignals);
                if (!rootStore.isRecent(s.root)) return "stale-or-unknown-root";
                return null;
              },
              account: pending.account,
            },
          });
        } catch (err) {
          // The verify concurrency gate shed this request. The challenge was taken but NOT processed
          // (the crypto verify never ran), so restore it (original expiry) rather than burn the
          // member's one-time nonce for a transient overload, then shed with 503. restore fails only if
          // the challenge expired meanwhile or the store is genuinely full, in which case the nonce
          // could not be preserved and the member must request a new challenge (say so, rather than tell
          // them to retry a dead nonce).
          if (err && err.overloaded) {
            const restored = challenges.restore(nonce, pending);
            return restored
              ? send(res, 503, { error: "overloaded, retry later" })
              : send(res, 503, { error: "overloaded, the challenge could not be preserved, request a new challenge" });
          }
          throw err;
        }
        if (!result.ok) return send(res, 200, result);
        const expiresAt = (pending.epoch + 1) * config.epochSeconds;
        // regranted is true when this was an idempotent re-verify of an already-spent tag by the same
        // account (its adapter recovering from a failed first grant), so an adapter can log the recovery.
        return send(res, 200, { ok: true, account: pending.account, epoch: result.epoch, expiresAt, regranted: result.regranted === true });
        } finally {
          // Released on every path out, including the shed-load return and any throw, because a hold
          // that leaks would pin a root for the life of the process and turn the leaf bound into one
          // an ordinary request can defeat.
          releaseRoot();
        }
      }

      if (twoTier && req.method === "POST" && path === "/v1/register") {
        // No adapter token here: registration is member-driven (the member's own prover posts it) and
        // proof-authenticated, and it carries no account to vouch for. Its guards are the registration
        // PLONK proof, the one-per-(season, context) registration nullifier, and the rate limit.
        if (!registerLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
        // Registration carries the (potentially multi-megabyte) proof, so it uses the larger register
        // body cap, while challenge and verify keep the small general cap.
        const { platform, communityId, roleId, proof, publicSignals } = await readBody(req, config.maxRegisterBodyBytes);
        if (!platform || !communityId || !roleId || !proof || !publicSignals) return send(res, 400, { error: "missing fields" });

        const ctx = contextHash({ platform, communityId, roleId }).toString();
        // THE CONTEXT MUST BE ONE THIS GATEWAY SERVES, checked BEFORE the expensive proof verify and
        // before any state is allocated for it. Registration is deliberately unauthenticated, because
        // the proof is the credential, and the caller chooses the platform, community, and role that
        // form the context. So the registration nullifier being once-per-context bounds nothing: a
        // valid masternode holder picks a fresh context each time and gets another durable record and
        // another cached tree, without limit. Two reviewers reached this independently and one called
        // it a blocker.
        //
        // An allowlist rather than a cap, decided 2026-08-03. A cap lets an attacker fill it first and
        // lock out the real communities, which converts a resource problem into a denial-of-service
        // one. An operator already knows which communities they gate, so naming them costs nothing
        // they do not already know. An EMPTY list means unconfigured, which stays open and warns at
        // boot rather than refusing every registration on a dev or demo deployment.
        if (config.registerContexts.length > 0 && !config.registerContexts.includes(ctx)) {
          return send(res, 403, { ok: false, reason: "context-not-served" });
        }
        const season = timeGuard.season();
        await seasonMembers.ensure(season);
        const result = await verifyRegistration({
          vkey: regVkey,
          proof,
          publicSignals,
          gate: (fn) => verifySem.run(fn),
          // The gateway's configured registration engine and statement (plonk/derive by default; a zkvm
          // gateway is refused at boot until the receipt verifier lands). They bind this (season,
          // context)'s durable declaration, so a registration under a different engine or statement for
          // the same bucket is rejected with statement-mismatch, keeping the nullifiers comparable. The
          // Poseidon root store here is the PLONK view; the zkVM path (deferred) would use
          // dmlRoots.shaView() via verifyZkvmRegistration.
          expected: {
            rootStore: dmlRoots,
            season,
            contextHash: ctx,
            engine: config.registrationEngine,
            statement: config.registrationStatement,
            // The registration anchor rule: accepted by the window AND, when the operator has set a
            // tighter bound, no older than that. Checked before the proof and again immediately
            // before the durable commit, so a root that ages out or is evicted during a verify that
            // takes real time cannot still buy a season of membership.
            rootEligible: (root) => dmlRoots.isEligibleWithin(root, config.registerRootMaxAgeSeconds, nowSec()),
          },
          registrationStore,
          // The durable record and the members-tree mirror happen together inside the season
          // serialization, re-checking the season so a rollover during the proof verify above cannot
          // publish a stale-season root (the M2 race). The commit targets this context's tree.
          commit: ({ season: s, commitment, contextHash: c, regNullifier: n, engine, statement, root }) =>
            seasonMembers.commit(s, c, commitment, () => {
              // THE ANCHOR IS ASKED ONE LAST TIME HERE, inside the season queue and immediately before
              // the durable append. The verifier's recheck runs after the proof but the commit is then
              // QUEUED behind any in-flight rollover or other commit, and the root can age out or be
              // evicted while it waits. Same lesson as the season check: the guard belongs against the
              // irreversible write, not merely after the slow step.
              if (!dmlRoots.isEligibleWithin(root, config.registerRootMaxAgeSeconds, nowSec())) {
                return { staleRoot: true };
              }
              // WHERE THIS CHECK STOPS, stated because the boundary is real and moving it does not
              // remove it. `append()` still awaits opening the file, writing, and fsync, and the
              // anchor could age out or the season roll during those awaits. Checking again after the
              // write would not help either: the record is durable by then, so a late refusal would
              // have to be a compensating delete, and a delete that can itself be interrupted is a
              // worse failure than a slightly stale admission.
              //
              // So the rule is DECIDED AT WRITE INITIATION, not at durable completion, and the
              // residual is bounded by how long one append takes rather than by how long a proof
              // takes, which is the difference this whole item was about (minutes down to a file
              // write). Closing it properly needs a reversible or tombstoned admission record, which
              // is a format change and is recorded in TODO.md rather than smuggled in here.
              return registrationStore.append({ season: s, contextHash: c, regNullifier: n, commitment, engine, statement });
            }),
        });
        if (!result.ok) return send(res, 200, result);
        return send(res, 200, { ok: true, index: result.index, membersRoot: result.membersRoot, size: result.size });
      }

      if (twoTier && req.method === "GET" && path === "/v1/members") {
        // Per-context members tree, so a prover fetches the leaves and root for its own community. The
        // context comes straight from the client here, so it is rate-limited and validated as a
        // canonical field element, and an empty context serves the shared empty root without building
        // a tree (so varying the context cannot force expensive tree builds).
        if (!membersLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
        const ctx = url.searchParams.get("context");
        if (!ctx || !isCanonicalField(ctx)) return send(res, 400, { error: "context must be a canonical field element" });
        // A CLOCK REGRESSION IS REPORTED, NOT THROWN THROUGH. This is a read, and the comments around
        // the state-bearing endpoints say the reads stay up during a regression so an operator can see
        // what the gateway holds. They did not: ensureContext passes the regressed season to the
        // members cache, whose monotonic guard throws "refusing to roll the members tree back", which
        // surfaced as a generic 400 about a malformed context. So the endpoint blamed the caller for
        // the host's clock, and the diagnostic path was the one that broke.
        // SAMPLE, THEN READ THE FLAG. This is the third time this exact shape has appeared: `regressed`
        // is a getter over a mark that only moves when epoch() or season() is CALLED, so reading it
        // alone reports whatever the last observation concluded. The version written moments ago in
        // this same session read the flag first, which caught a regression already known at boot and
        // missed a LIVE one, where the very next line's season() would be the thing that noticed and
        // the throw would beat the guard. A reviewer found it. The lesson is the twin-hunt one: fixing
        // a shape in one place is the moment to grep for it everywhere.
        timeGuard.epoch();
        timeGuard.season();
        if (timeGuard.regressed) {
          return send(res, 503, {
            error: "clock regression",
            reason: "clock-regressed",
            regression: timeGuard.regression,
          });
        }
        // Belt and braces, and testable in a way the ordering above is not. If a rollback is somehow
        // seen only inside the members cache's own monotonic guard, that is still a clock problem and
        // not a malformed request, so it must not surface as a 400 blaming the caller.
        try {
          await seasonMembers.ensureContext(timeGuard.season(), ctx);
        } catch (err) {
          if (/refusing to roll the members tree back/.test(String(err?.message))) {
            return send(res, 503, { error: "clock regression", reason: "clock-regressed" });
          }
          throw err;
        }
        return send(res, 200, { membersRoot: seasonMembers.root(ctx), size: seasonMembers.size(ctx), commitments: seasonMembers.commitments(ctx) });
      }

      if (req.method === "GET" && path === "/v1/dml") {
        // The largest response this gateway serves, public and unauthenticated. It was the only read
        // endpoint with no limit while its sibling /v1/members had one.
        if (!dmlLimiter.allow(clientKey(req))) return send(res, 429, { error: "rate limited" });
        // public DML snapshot so a prover can find its leaf and build a Merkle path. shaRoot is the
        // SHA-256 tree root for the zkVM registration statement, null on a v1 snapshot, so a zkVM
        // prover can build its SHA-256 path from the same leaves.
        // Derived from the window's current record, so this response's root and leaves always belong
        // to one snapshot. It is the CURRENT record at the moment of this request, which a refresh
        // between a challenge and this call can have moved on from, so a prover comparing the two
        // must re-challenge rather than assume they match.
        const served = latestSnapshot();
        return send(res, 200, {
          root: served?.root ?? null,
          shaRoot: served?.shaRoot ?? null,
          height: served?.height ?? null,
          depth: served?.depth ?? config.treeDepth,
          leaves: served?.leaves ?? [],
        });
      }

      if (req.method === "GET" && path === "/v1/health") {
        // Two-tier has no single members root (one per context), so health reports the count of
        // active context trees instead, alongside the shared DML root.
        const dmlRoot = dmlRoots.current()?.root ?? null;
        // ok reports readiness, not liveness: a clock regression leaves the process healthy but
        // unwilling to issue or verify, and an operator needs to see that here rather than infer it
        // from 503s on the other endpoints.
        // Observe BOTH periods: a rollback across an epoch but not a season would otherwise report
        // healthy until some state-bearing request happened to notice it.
        timeGuard.epoch();
        const season = timeGuard.season();
        // READINESS IS CAPABILITY-SPECIFIC, not merely "the clock is sane". `ok` reported true in
        // single-tier mode with no DML root at all, while every challenge returned 503, so a readiness
        // probe kept routing users to an instance that could not serve them and an oracle outage read
        // as healthy. The booleans are separate because the modes genuinely differ: a two-tier gateway
        // can still verify existing members while registration is unavailable.
        const clockOk = !timeGuard.regressed;
        const canChallenge = clockOk && (twoTier ? true : dmlRoot != null);
        const canVerify = canChallenge;
        const canRegister = clockOk && twoTier && dmlRoot != null;
        return send(res, 200, {
          ok: clockOk && canChallenge,
          canChallenge,
          canVerify,
          canRegister,
          mode: config.mode,
          // WHICH TRUST MODEL THIS GATEWAY IS RUNNING, because the two differ and nothing else here
          // says. `snapshot` trusts whoever holds the oracle signing keys; `node` trusts the operator's
          // own Dash Core node and no signing key at all. An operator reading health should not have to
          // infer that from a startup log they may not have kept. Surfaced after a rule 6 shape search
          // over the change that added the second source found every branch handled except this one.
          dmlSource: config.dmlSource,
          root: twoTier ? null : dmlRoot,
          dmlRoot,
          season,
          ...(timeGuard.regressed ? { clockRegression: timeGuard.regression } : {}),
          ...(twoTier ? { contexts: seasonMembers.contextCount() } : {}),
        });
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      // The verify concurrency gate sheds load with an "overloaded" error when its wait queue is full;
      // report that as 503 (try again) rather than 400 (bad request), since the request was well-formed.
      if (err && err.overloaded) return send(res, 503, { error: "overloaded, retry later" });
      return send(res, 400, { error: err.message });
    } finally {
      // Whatever the outcome, including a throw the catch above re-raises, so a handler that fails
      // cannot leave the count permanently above zero and hang every future teardown.
      inFlightRequests -= 1;
      if (inFlightRequests === 0 && notifyDrained) {
        const resolve = notifyDrained;
        notifyDrained = null;
        resolve();
      }
    }
  });

  if (!config.adapterSecret)
    console.warn("[gateway] WARNING: running UNAUTHENTICATED (MNO_ALLOW_UNAUTH_GATEWAY=1). /v1/challenge, /v1/verify, and /v1/register accept any caller and the submitted account is not vouched for. Do not use in production; set MNO_ADAPTER_SECRET instead (review finding B1/M5).");

  // Give back everything this boot created. The server is built but NOT listening, because binding a
  // port is the caller's decision: the entry point below wants a real socket, and a test wants the
  // handler without one.
  return {
    config,
    server,
    // REJECTS ON A FAILED BIND. A port already taken or a privileged port is the common way this
    // fails, and observing only the success callback left the caller awaiting a promise that would
    // never settle while the error went out as an uncaught 'error' event. The handlers are removed on
    // whichever outcome arrives first, so a later socket error does not resolve or reject a second
    // time and is left to the server's own error handling.
    listen(port = config.port) {
      // A CLOSED GATEWAY DOES NOT LISTEN AGAIN. Node's HTTP server can be re-listened after close(),
      // so without this a listen after (or racing) a teardown binds a socket onto a gateway whose
      // stores are released and whose timers are stopped: every request would then reach a closed
      // database, and a later close() would return the settled teardown promise and leave the new
      // socket open. The teardown is one-shot, so refusing is the honest answer; build another
      // gateway instead.
      if (closed) return Promise.reject(new Error("gateway is closed: build a new one with createGateway()"));
      const attempt = new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          console.log(`[gateway] dash-mno-verify (${config.mode}) listening on :${server.address().port}`);
          resolve(server.address().port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port);
      });
      // A BIND IN PROGRESS IS SOMETHING TEARDOWN MUST WAIT FOR. Binding is asynchronous even locally
      // (`server.listening` is still false on the line after `server.listen()`), so a close racing a
      // listen would find nothing listening, release everything, and let the socket come up
      // afterwards, on a gateway with stopped timers and released stores, with the one-shot teardown
      // already settled and unable to close it. Recorded as a promise that never rejects, since
      // teardown cares only that the attempt has finished.
      lastListen = attempt.then(
        () => {},
        () => {},
      );
      return attempt;
    },
    // Give back everything the boot took: the timers, the socket, and the stores. The release list is
    // the same one a failed boot walks, so an acquisition registered at its creation point is
    // released by both paths and neither can forget one.
    //
    // Ordered so nothing runs against something already released: refuse further work, wait for a
    // refresh already in flight (clearing an interval does not cancel a callback that is running, and
    // that callback would otherwise mutate the root window after this returns), close the socket, then
    // walk the release list in reverse.
    //
    // ONE TEARDOWN, SHARED BY EVERY CALLER. Guarding each step individually is not enough: the first
    // caller starts draining the socket, `server.listening` goes false, and a second caller sailing
    // past that guard would close the stores while the first is still waiting on in-flight requests
    // that use them. So the first call builds the promise and every call returns it, which is also
    // what makes repeat calls (a finally block plus a teardown hook) safe by construction.
    //
    // Every release is ATTEMPTED even if one throws. Stopping at the first failure would leave the
    // later acquisitions held forever, with the list already emptied so no retry could reach them.
    // The first failure is rethrown at the end, after everything releasable is released.
    close() {
      closePromise ??= (async () => {
        closed = true;
        await refreshInFlight;
        await lastListen; // a bind in progress finishes first, or its socket would outlive this
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        // AND THEN THE HANDLERS. Closing the server stops new connections and waits for open ones,
        // which is not the same as waiting for the work in flight: a disconnected client's handler
        // runs on with no connection to wait for.
        await drainRequests();
        let firstFailure = null;
        for (const fn of release.splice(0, release.length).reverse()) {
          try {
            await fn();
          } catch (err) {
            firstFailure ??= err;
          }
        }
        if (firstFailure) throw firstFailure;
      })();
      return closePromise;
    },
    // The internals a test needs to observe, named rather than reached through the module. Exposing
    // them is what replaces reading this file's source text to prove a call happens.
    state: {
      get dmlRoots() {
        return dmlRoots;
      },
      get challenges() {
        return challenges;
      },
      get nullifiers() {
        return nullifiers;
      },
      get seasonMembers() {
        return seasonMembers;
      },
      get registrationStore() {
        return registrationStore;
      },
      get timeGuard() {
        return timeGuard;
      },
      limiters: LIMITERS,
      allLimiters: ALL_LIMITERS,
      sweepLimiters,
      // The live timer list, so a caller can check that close() stopped them. process's own active
      // resource list cannot answer this: these are unref'd, so they are not among the resources
      // keeping the event loop alive and never appear there whether they are running or not.
      timers,
      refreshRoots,
      latestSnapshot,
      schedule: SCHEDULE,
    },
  };
}

// THE ENTRY POINT, and the only thing in this file that runs on its own. `node core/gateway.js`
// boots against the process environment and listens; importing the module does neither. The check is
// on the resolved path of the script node was asked to run, so a symlinked or relative invocation
// still matches, and importing this from a test never does.
//
// BOTH SPELLINGS OF THE PATH ARE COMPARED, because node does not always canonicalize the entry.
// import.meta.url is normally the real path, so resolving argv[1] is what makes a symlinked checkout
// match. Under --preserve-symlinks-main node deliberately keeps the symlink in import.meta.url
// instead, and then it is the UNRESOLVED argv[1] that matches. Comparing only the resolved form made
// that invocation exit silently without booting, which is the worst shape of failure here: a
// deployment that starts, reports nothing, and serves nothing.
//
// Resolving can also fail outright (node was given -e, or a runner put something in argv[1] that is
// not a file), and the answer is then simply no. Throwing would make an ordinary import fail for a
// reason that has nothing to do with the importer.
function invokedAsEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const candidates = [entry];
  try {
    candidates.push(realpathSync(entry));
  } catch {
    // Not a path on disk, so the unresolved comparison below is the only one available.
  }
  return candidates.some((p) => {
    try {
      return pathToFileURL(p).href === import.meta.url;
    } catch {
      return false;
    }
  });
}

if (invokedAsEntryPoint()) {
  const gateway = await createGateway();
  await gateway.listen();
}
