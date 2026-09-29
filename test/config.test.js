import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../core/config.js";

// buildConfig is a pure factory over an environment, so these drive it directly with a synthetic env,
// with no gateway boot and no socket. A base env that passes every other validation, so each case
// isolates the one setting under test.
const BASE = {
  MNO_MODE: "single",
  MNO_STORE: "memory",
  MNO_ALLOW_EPHEMERAL_NULLIFIERS: "1",
  MNO_ALLOW_UNAUTH_GATEWAY: "1",
  MNO_ALLOW_UNSIGNED_ORACLE: "1",
  MNO_ORACLE_SOURCE: "/tmp/does-not-need-to-exist.json",
};

// Run fn with console.warn captured, returning the warnings it emitted.
function withWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("A9: an oracle refresh interval that would overflow the 32-bit timer is refused at boot", () => {
  // MNO_ORACLE_REFRESH is multiplied by 1000 for setInterval, and a value whose product exceeds the
  // signed 32-bit range makes Node clamp the interval to 1 ms, hammering the source. The cap is the
  // largest value whose product still fits.
  assert.throws(
    () => buildConfig({ ...BASE, MNO_ORACLE_REFRESH: "3000000" }),
    /MNO_ORACLE_REFRESH must be an integer in \[1, 2147483\]/,
    "a refresh interval past the cap is refused",
  );
  // The exact boundary is accepted (2,147,483 * 1000 fits a signed 32-bit int), so the cap does not
  // refuse a value that is actually safe.
  assert.equal(buildConfig({ ...BASE, MNO_ORACLE_REFRESH: "2147483" }).oracleRefreshSeconds, 2147483);
  // And an ordinary value is unaffected.
  assert.equal(buildConfig({ ...BASE, MNO_ORACLE_REFRESH: "60" }).oracleRefreshSeconds, 60);
});

test("A10: a positive max-age at or below the refresh interval warns but does not refuse", () => {
  // The combination guarantees a periodic 503 (a refreshed root ages out before the next refresh), but
  // it is a legitimate prefer-refuse-stale-over-serve-stale choice, so it warns rather than refusing.
  const warnings = withWarnings(() => {
    const c = buildConfig({ ...BASE, MNO_ORACLE_REFRESH: "3600", MNO_ORACLE_MAX_AGE: "60" });
    assert.equal(c.oracleRefreshSeconds, 3600, "the config still builds");
    assert.equal(c.oracleMaxAgeSeconds, 60);
  });
  assert.equal(warnings.length, 1, "exactly one warning is emitted");
  assert.match(warnings[0], /MNO_ORACLE_MAX_AGE.*at or below.*MNO_ORACLE_REFRESH/);
  assert.match(warnings[0], /503 on a fixed period/);
});

test("A10: a max-age above the refresh interval, and a disabled max-age, do not warn", () => {
  // The healthy default (refresh 30, max-age 1800) is silent.
  assert.equal(withWarnings(() => buildConfig({ ...BASE })).length, 0, "the default does not warn");
  // max-age 0 disables the freshness check, so it is exempt even with a long refresh.
  assert.equal(
    withWarnings(() => buildConfig({ ...BASE, MNO_ORACLE_REFRESH: "3600", MNO_ORACLE_MAX_AGE: "0" })).length,
    0,
    "a disabled max-age does not warn",
  );
});

// Review finding F2. The challenge lifetime depends on the mode, because a two-tier member makes the
// cheap proof after registering, and a single-tier member makes the heavy proof against the challenge.
test("the default challenge lifetime is 10 minutes for two-tier and 30 for single-tier", () => {
  assert.equal(buildConfig({ MNO_MODE: "two-tier" }).challengeTtlSeconds, 600);
  assert.equal(buildConfig({ MNO_MODE: "single" }).challengeTtlSeconds, 1800);
  assert.equal(buildConfig({}).challengeTtlSeconds, 1800, "single-tier is the default mode");
});

test("an explicit MNO_CHALLENGE_TTL overrides the mode default in either mode", () => {
  assert.equal(buildConfig({ MNO_MODE: "two-tier", MNO_CHALLENGE_TTL: "1200" }).challengeTtlSeconds, 1200);
  assert.equal(buildConfig({ MNO_MODE: "single", MNO_CHALLENGE_TTL: "300" }).challengeTtlSeconds, 300);
});

// The Discord pilot (2026-09-29) found a manual proof every week too much to ask of members. In two-tier
// mode the per-epoch proof never reads the masternode list again, so the epoch defaults to the season and
// a member acts once a season. Single-tier keeps a week, because there each epoch's proof is the heavy one
// against the current list.
test("the epoch defaults to the season in two-tier mode and to one week in single-tier", () => {
  const two = buildConfig({ MNO_MODE: "two-tier" });
  assert.equal(two.seasonSeconds, 90 * 24 * 3600);
  assert.equal(two.epochSeconds, two.seasonSeconds);
  assert.equal(buildConfig({ MNO_MODE: "single" }).epochSeconds, 7 * 24 * 3600);
  assert.equal(buildConfig({}).epochSeconds, 7 * 24 * 3600, "single-tier is the default mode");
});

test("the two-tier epoch follows a changed season, and an explicit MNO_EPOCH_SECONDS wins in either mode", () => {
  assert.equal(buildConfig({ MNO_MODE: "two-tier", MNO_SEASON_SECONDS: "86400" }).epochSeconds, 86400);
  assert.equal(buildConfig({ MNO_MODE: "two-tier", MNO_SEASON_SECONDS: "86400", MNO_EPOCH_SECONDS: "1800" }).epochSeconds, 1800);
  assert.equal(buildConfig({ MNO_MODE: "single", MNO_EPOCH_SECONDS: "3600" }).epochSeconds, 3600);
  assert.equal(buildConfig({ MNO_MODE: "single", MNO_SEASON_SECONDS: "86400" }).epochSeconds, 7 * 24 * 3600, "single-tier does not follow the season");
  assert.throws(() => buildConfig({ MNO_MODE: "two-tier", MNO_SEASON_SECONDS: "0" }), /MNO_SEASON_SECONDS must be an integer/, "reading the season first keeps its validation");
});

// A review of the Groth16 candidate found that MNO_REGISTRATION_ENGINE=plonk booted against the committed
// PLONK registration key, which verifies the registration circuit from before the key-0 rejection and the
// purpose tag, and accepted a real pre-candidate registration proof. The engine is retired at config.
test("the retired PLONK registration engine is refused, and groth16 is the default", () => {
  assert.throws(() => buildConfig({ ...BASE, MNO_MODE: "two-tier", MNO_REGISTRATION_ENGINE: "plonk" }), /MNO_REGISTRATION_ENGINE=plonk is retired/);
  assert.equal(buildConfig({ ...BASE, MNO_MODE: "two-tier" }).registrationEngine, "groth16");
});
