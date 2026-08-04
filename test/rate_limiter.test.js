import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, allowAll } from "../core/stores.js";

// TWO BUCKETS ARE CHARGED TOGETHER OR NOT AT ALL.
//
// The gateway limits an account-bearing request twice: once per account, so one user cannot spend a
// whole community's window, and once per source, as the aggregate guard. Charging them in sequence
// means a request the SECOND bucket refuses has already cost the first, so a caller turned away by
// the shared limit also loses its own personal allowance for a request that was never served.
//
// Both orderings shipped before this. The source bucket was charged first, which let a user's own
// refusals drain the community's allowance; that was fixed by charging the account bucket first,
// which leaked the other way. The question is not which to charge first but whether to charge at
// all, and a reviewer said so plainly after watching the fix swap the direction of the same defect.
//
// These run at the unit level deliberately. The HTTP path cannot isolate the property: from outside,
// a refusal looks the same whichever bucket refused and whichever buckets were charged, so a test
// there would assert a 429 and prove nothing about what it cost.

test("a refusal by one bucket charges neither", () => {
  const account = new RateLimiter({ windowSeconds: 60, max: 5 });
  const shared = new RateLimiter({ windowSeconds: 60, max: 2 });

  let served = 0;
  for (let i = 0; i < 5; i += 1) {
    if (allowAll([[account, "acct"], [shared, "src"]])) served += 1;
  }

  assert.equal(served, 2, "the tighter bucket decides how many are served");
  assert.equal(
    account.hits.get("acct").count,
    2,
    "and the account was charged only for the two that were SERVED, not the five attempted",
  );
  assert.equal(shared.hits.get("src").count, 2);
});

test("the account keeps the allowance a shared refusal did not spend", () => {
  // The consequence that matters to a user. Alice is refused by the community bucket, and when that
  // window frees up her own allowance must still be there. Under sequential charging her five
  // attempts would have spent her personal allowance on requests nobody served.
  const account = new RateLimiter({ windowSeconds: 60, max: 5 });
  const shared = new RateLimiter({ windowSeconds: 60, max: 2 });
  for (let i = 0; i < 5; i += 1) allowAll([[account, "alice"], [shared, "src"]]);

  // The shared window frees (a fresh key stands in for a new window).
  const freshShared = new RateLimiter({ windowSeconds: 60, max: 2 });
  assert.equal(
    allowAll([[account, "alice"], [freshShared, "src"]]),
    true,
    "alice still has allowance, because her refusals cost her nothing",
  );
});

test("every bucket is charged when all of them accept", () => {
  // The other half, so "charge nothing on refusal" is not mistaken for "charge nothing".
  const a = new RateLimiter({ windowSeconds: 60, max: 3 });
  const b = new RateLimiter({ windowSeconds: 60, max: 3 });
  assert.equal(allowAll([[a, "k"], [b, "k"]]), true);
  assert.equal(a.hits.get("k").count, 1);
  assert.equal(b.hits.get("k").count, 1);
});

test("wouldAllow reports without charging, which is what makes the two-phase check possible", () => {
  const l = new RateLimiter({ windowSeconds: 60, max: 1 });
  assert.equal(l.wouldAllow("k"), true);
  assert.equal(l.wouldAllow("k"), true, "asking twice does not consume the allowance");
  assert.equal(l.allow("k"), true);
  assert.equal(l.wouldAllow("k"), false, "and once spent it says so");
});

test("an exhausted key is refused and stays refused, so the guard still bounds", () => {
  const a = new RateLimiter({ windowSeconds: 60, max: 1 });
  const b = new RateLimiter({ windowSeconds: 60, max: 99 });
  assert.equal(allowAll([[a, "k"], [b, "k"]]), true);
  assert.equal(allowAll([[a, "k"], [b, "k"]]), false, "the tight bucket is spent");
  assert.equal(b.hits.get("k").count, 1, "and the loose one was not charged for the refusal");
});
