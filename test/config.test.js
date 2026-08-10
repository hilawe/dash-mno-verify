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
