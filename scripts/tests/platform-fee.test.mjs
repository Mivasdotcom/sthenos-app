/**
 * Platform fee maths.
 *
 * Every euro that moves through Sthenos passes through these five functions,
 * and a mistake in any of them is silent: the charge still succeeds, the gym
 * still gets paid, and the platform is quietly short on every transaction.
 * That already happened once, which is why STRIPE_FEE_PERCENT exists.
 *
 * Node's own test runner, no dependencies, so this runs in CI with nothing
 * installed. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PLATFORM_FEE_PERCENT,
  STRIPE_FEE_PERCENT,
  STRIPE_FEE_FIXED_CENTS,
  stripeFeeCents,
  platformFeeCents,
  totalAppFeeCents,
  grossChargeCents,
  subscriptionAppFeePercent,
} from "../../src/lib/platform-fee.ts";

test("the rates are what the gyms were told they are", () => {
  assert.equal(PLATFORM_FEE_PERCENT, 1);
  assert.equal(STRIPE_FEE_PERCENT, 1.5);
  assert.equal(STRIPE_FEE_FIXED_CENTS, 25);
});

test("stripeFeeCents: percentage plus the fixed cost", () => {
  assert.equal(stripeFeeCents(0), 0, "no charge, no fee");
  assert.equal(stripeFeeCents(4545), 93, "1.5% of 45.45 is 68c, plus 25c fixed");
  assert.equal(stripeFeeCents(6565), 123, "the charge from the comment in the source");
  assert.equal(stripeFeeCents(100), 27, "1.5% of a euro rounds to 2c, plus 25c");
});

test("stripeFeeCents: the fixed 25c applies to every non-zero charge", () => {
  for (const cents of [1, 50, 100, 999, 5000, 100000]) {
    assert.ok(
      stripeFeeCents(cents) >= STRIPE_FEE_FIXED_CENTS,
      `${cents}c should carry at least the fixed fee`,
    );
  }
});

test("platformFeeCents: one percent, rounded to the cent", () => {
  assert.equal(platformFeeCents(0), 0);
  assert.equal(platformFeeCents(4500), 45, "45.00 -> 45c");
  assert.equal(platformFeeCents(6565), 66, "65.65 -> 65.65c, rounds to 66c");
  assert.equal(platformFeeCents(1250), 13, "12.50 -> 12.5c, rounds up");
  assert.equal(platformFeeCents(49), 0, "under 50c of base earns nothing");
});

test("grossChargeCents: pass-through decides what the member sees", () => {
  assert.equal(grossChargeCents(4500, false), 4500, "gym absorbs the 1%");
  assert.equal(grossChargeCents(4500, true), 4545, "member covers the 1%");
  assert.equal(grossChargeCents(0, true), 0, "nothing to charge");
  assert.equal(grossChargeCents(0, false), 0);
});

test("totalAppFeeCents: the platform's margin plus Stripe's cost", () => {
  assert.equal(
    totalAppFeeCents(4500, 4545),
    138,
    "45c margin on the base, 93c Stripe on the gross",
  );
  assert.equal(totalAppFeeCents(4500, 4500), 138, "same when the gym absorbs it");
});

test("totalAppFeeCents: never claims more than the charge itself", () => {
  // On charges smaller than Stripe's fixed 25c the platform eats the shortfall
  // rather than handing the gym a negative payout.
  assert.equal(totalAppFeeCents(20, 20), 20, "clamped to the whole charge");
  assert.equal(totalAppFeeCents(30, 30), 25, "25c fee, gym keeps 5c");

  for (const cents of [1, 10, 20, 24, 25, 26, 100, 4500]) {
    assert.ok(
      totalAppFeeCents(cents, cents) <= cents,
      `${cents}c: fee must never exceed the charge`,
    );
  }
});

test("the gym bears Stripe's cost, the platform keeps its margin", () => {
  // A destination charge: Stripe debits the platform and transfers the rest to
  // the gym. The platform only truly nets (application fee - Stripe's cost).
  for (const base of [1000, 2500, 4500, 6565, 12000, 50000]) {
    for (const passFee of [true, false]) {
      const gross = grossChargeCents(base, passFee);
      const appFee = totalAppFeeCents(base, gross);
      const stripeCost = stripeFeeCents(gross);
      const platformNets = appFee - stripeCost;

      assert.equal(
        platformNets,
        platformFeeCents(base),
        `base ${base}, passFee ${passFee}: platform should net exactly its 1%`,
      );
      assert.ok(gross - appFee >= 0, "the gym's payout must not go negative");
    }
  }
});

test("regression: the real payment of 20 September", () => {
  // Lucas Sofocleous, FTBJJ Limassol. Base 45.00 with pass-through on.
  // Confirmed against Stripe: member paid 45.45, application fee 1.38,
  // Stripe took 0.93, the gym received 44.07, the platform netted 0.45.
  const base = 4500;
  const gross = grossChargeCents(base, true);
  const appFee = totalAppFeeCents(base, gross);
  const stripeCost = stripeFeeCents(gross);

  assert.equal(gross, 4545, "member is charged 45.45");
  assert.equal(appFee, 138, "application fee is 1.38");
  assert.equal(stripeCost, 93, "Stripe takes 0.93");
  assert.equal(gross - appFee, 4407, "gym receives 44.07");
  assert.equal(appFee - stripeCost, 45, "platform nets 0.45");
});

test("subscriptionAppFeePercent: never more than two decimal places", () => {
  // Stripe rejects three or more: "Invalid decimal: 0.9901". That rejection
  // made every pass-through signup checkout fail outright, so this is the
  // property that actually matters, not any single value.
  for (let base = 100; base <= 30000; base += 25) {
    for (const passFee of [true, false]) {
      const gross = grossChargeCents(base, passFee);
      const percent = subscriptionAppFeePercent(base, gross, passFee);
      const scaled = percent * 100;

      assert.ok(
        Math.abs(scaled - Math.round(scaled)) < 1e-9,
        `base ${base}, passFee ${passFee}: ${percent} has more than 2dp`,
      );
      assert.ok(percent > 0 && percent <= 100, `base ${base}: ${percent} out of range`);
    }
  }
});

test("subscriptionAppFeePercent: known values", () => {
  assert.equal(subscriptionAppFeePercent(4500, 4545, true), 3.04, "138 of 4545");
  assert.equal(
    subscriptionAppFeePercent(4500, 0, true),
    PLATFORM_FEE_PERCENT,
    "no gross yet, fall back to the bare margin",
  );
});

test("subscriptionAppFeePercent: pass-through does not change what is claimed", () => {
  // The flag is deliberately ignored -- the gym pays Stripe either way, and
  // pass-through only decides who covers the platform's 1%. If someone makes
  // this depend on passFee again, this fails.
  for (const base of [1000, 4500, 9900]) {
    const gross = grossChargeCents(base, true);
    assert.equal(
      subscriptionAppFeePercent(base, gross, true),
      subscriptionAppFeePercent(base, gross, false),
      `base ${base}: the same gross must yield the same percent`,
    );
  }
});
