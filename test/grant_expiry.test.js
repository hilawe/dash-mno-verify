import { test } from "node:test";
import assert from "node:assert/strict";
import { grantExpiresAt, epochNow, seasonNow } from "../common/index.js";

// Review finding F1 (2026-09-27). The gateway ended every grant at its epoch end, so a two-tier grant
// minted just before a season boundary outlived that season, whose members tree had already been
// cleared. The numbers are the review's reproduction under the default schedule.
const EPOCH = 7 * 24 * 3600;
const SEASON = 90 * 24 * 3600;

test("a two-tier grant minted 120 s before a season boundary ends AT the boundary, not six days later", () => {
  const seasonEnd = 1788480000; // the end of season 229 under the default 90-day season
  const now = seasonEnd - 120;
  const epoch = epochNow(EPOCH, now);
  const season = seasonNow(SEASON, now);
  assert.equal(season, 229);
  assert.equal((epoch + 1) * EPOCH, 1788998400, "the uncapped epoch end the gateway used to return");
  assert.equal(grantExpiresAt({ epoch, epochSeconds: EPOCH, season, seasonSeconds: SEASON }), seasonEnd);
});

test("contrary: a two-tier grant in mid-season still ends with its epoch", () => {
  const now = 229 * SEASON + 10 * 24 * 3600; // ten days into season 229
  const epoch = epochNow(EPOCH, now);
  const epochEnd = (epoch + 1) * EPOCH;
  assert.ok(epochEnd < 230 * SEASON, "the epoch ends well before the season does");
  assert.equal(grantExpiresAt({ epoch, epochSeconds: EPOCH, season: 229, seasonSeconds: SEASON }), epochEnd);
});

test("contrary: single-tier expiry is unchanged, the epoch end even across a season boundary", () => {
  const now = 1788480000 - 120;
  const epoch = epochNow(EPOCH, now);
  assert.equal(grantExpiresAt({ epoch, epochSeconds: EPOCH }), (epoch + 1) * EPOCH);
});

test("an epoch that ends exactly on the season boundary gives that boundary either way", () => {
  // 7 days and 91 days share boundaries every 91 days, so an aligned case exists to check.
  const season = 13 * EPOCH;
  const epoch = 12; // the last epoch of season 0
  assert.equal(grantExpiresAt({ epoch, epochSeconds: EPOCH, season: 0, seasonSeconds: season }), season);
});

test("a season without a positive seasonSeconds is refused rather than silently ignored", () => {
  assert.throws(() => grantExpiresAt({ epoch: 1, epochSeconds: EPOCH, season: 0 }), /positive seasonSeconds/);
  assert.throws(() => grantExpiresAt({ epoch: 1, epochSeconds: EPOCH, season: 0, seasonSeconds: 0 }), /positive seasonSeconds/);
});
