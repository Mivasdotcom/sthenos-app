/**
 * Coverage for the pure and env-reading parts of src/lib/stripe.server.ts:
 * environment selection, key lookup, error message shaping, the hand-rolled
 * webhook signature check and the billing-anchor date.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  firstOfNextMonthUnix,
  getConnectionApiKey,
  getStripeEnv,
  getStripeErrorMessage,
  verifyStripeWebhook,
} from "../../src/lib/stripe.server.ts";

const ENV_KEYS = [
  "NODE_ENV",
  "STRIPE_LIVE_API_KEY",
  "STRIPE_SANDBOX_API_KEY",
  "PAYMENTS_SANDBOX_WEBHOOK_SECRET",
  "PAYMENTS_LIVE_WEBHOOK_SECRET",
];

const WEBHOOK_SECRET = "whsec_sandbox_test_secret";
const BODY = JSON.stringify({
  id: "evt_1",
  type: "invoice.paid",
  data: { object: { id: "in_1" } },
});

let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("getStripeEnv", () => {
  it("returns live when STRIPE_LIVE_API_KEY is set and NODE_ENV is production", () => {
    process.env.STRIPE_LIVE_API_KEY = "sk_live_x";
    process.env.NODE_ENV = "production";

    assert.equal(getStripeEnv(), "live");
  });

  it("returns sandbox when NODE_ENV is not production, even with a live key present", () => {
    process.env.STRIPE_LIVE_API_KEY = "sk_live_x";
    process.env.NODE_ENV = "development";

    assert.equal(getStripeEnv(), "sandbox");
  });

  it("returns sandbox when NODE_ENV is unset (empty), even with a live key present", () => {
    process.env.STRIPE_LIVE_API_KEY = "sk_live_x";

    assert.equal(getStripeEnv(), "sandbox");
  });

  it("returns sandbox in production when no live key is configured", () => {
    process.env.NODE_ENV = "production";

    assert.equal(getStripeEnv(), "sandbox");
  });
});

describe("getConnectionApiKey", () => {
  it("returns the sandbox key for the sandbox environment", () => {
    process.env.STRIPE_SANDBOX_API_KEY = "sk_test_sandbox";
    process.env.STRIPE_LIVE_API_KEY = "sk_live_live";

    assert.equal(getConnectionApiKey("sandbox"), "sk_test_sandbox");
  });

  it("returns the live key for the live environment", () => {
    process.env.STRIPE_SANDBOX_API_KEY = "sk_test_sandbox";
    process.env.STRIPE_LIVE_API_KEY = "sk_live_live";

    assert.equal(getConnectionApiKey("live"), "sk_live_live");
  });

  it("throws naming the variable when the sandbox key is missing", () => {
    process.env.STRIPE_LIVE_API_KEY = "sk_live_live";

    assert.throws(() => getConnectionApiKey("sandbox"), {
      message: "STRIPE_SANDBOX_API_KEY is not configured",
    });
  });

  it("throws naming the variable when the live key is missing", () => {
    process.env.STRIPE_SANDBOX_API_KEY = "sk_test_sandbox";

    assert.throws(() => getConnectionApiKey("live"), {
      message: "STRIPE_LIVE_API_KEY is not configured",
    });
  });

  it("treats an empty-string key as missing", () => {
    process.env.STRIPE_SANDBOX_API_KEY = "";

    assert.throws(() => getConnectionApiKey("sandbox"), {
      message: "STRIPE_SANDBOX_API_KEY is not configured",
    });
  });
});

describe("getStripeErrorMessage", () => {
  it("builds 'message (type, code, decline_code, param)' from a Stripe error shape", () => {
    const stripeError = {
      message: "top-level message is ignored when raw is present",
      type: "top_type",
      raw: {
        message: "Your card was declined.",
        type: "card_error",
        code: "card_declined",
        decline_code: "insufficient_funds",
        param: "number",
      },
    };

    assert.equal(
      getStripeErrorMessage(stripeError),
      "Your card was declined. (card_error, card_declined, insufficient_funds, number)",
    );
  });

  it("uses top-level fields when there is no raw object", () => {
    const stripeError = {
      message: "No such customer",
      type: "invalid_request_error",
      code: "resource_missing",
      param: "customer",
    };

    assert.equal(
      getStripeErrorMessage(stripeError),
      "No such customer (invalid_request_error, resource_missing, customer)",
    );
  });

  it("returns a plain Error's message with no details appended", () => {
    assert.equal(getStripeErrorMessage(new Error("socket reset")), "socket reset");
  });

  it("falls back to the generic text for a non-error string", () => {
    assert.equal(getStripeErrorMessage("boom"), "Stripe request failed");
  });

  it("falls back to the generic text for null and undefined", () => {
    assert.equal(getStripeErrorMessage(null), "Stripe request failed");
    assert.equal(getStripeErrorMessage(undefined), "Stripe request failed");
  });

  it("falls back to the generic text for an object with an empty message", () => {
    assert.equal(
      getStripeErrorMessage({ message: "", type: "card_error" }),
      "Stripe request failed",
    );
  });
});

describe("verifyStripeWebhook", () => {
  beforeEach(() => {
    process.env.PAYMENTS_SANDBOX_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  /** Stripe's scheme: t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<body>") in hex. */
  function signatureFor(body, { timestamp = nowSeconds(), secret = WEBHOOK_SECRET } = {}) {
    const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return { timestamp, header: `t=${timestamp},v1=${digest}` };
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function webhookRequest(body, signatureHeader) {
    const headers = new Headers();
    if (signatureHeader !== undefined) headers.set("stripe-signature", signatureHeader);
    return new Request("https://sthenos.live/api/public/hooks/stripe", {
      method: "POST",
      headers,
      body,
    });
  }

  it("accepts a correctly signed body and returns the parsed event (positive control)", async () => {
    const { header } = signatureFor(BODY);

    const event = await verifyStripeWebhook(webhookRequest(BODY, header), "sandbox");

    assert.equal(event.id, "evt_1");
    assert.equal(event.type, "invoice.paid");
    assert.equal(event.data.object.id, "in_1");
  });

  it("accepts a valid v1 entry when a second, wrong v1 entry is also present", async () => {
    const { timestamp, header } = signatureFor(BODY);
    const combined = `t=${timestamp},v1=${"0".repeat(64)},${header.split(",")[1]}`;

    const event = await verifyStripeWebhook(webhookRequest(BODY, combined), "sandbox");

    assert.equal(event.id, "evt_1");
  });

  it("rejects a signature made with a different secret", async () => {
    const { header } = signatureFor(BODY, { secret: "whsec_someone_else" });

    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, header), "sandbox"), {
      message: "Invalid webhook signature",
    });
  });

  it("rejects a valid signature over a different body (tampered payload)", async () => {
    const { header } = signatureFor(BODY);
    const tampered = BODY.replace("in_1", "in_2");

    await assert.rejects(verifyStripeWebhook(webhookRequest(tampered, header), "sandbox"), {
      message: "Invalid webhook signature",
    });
  });

  it("rejects a timestamp 301 seconds old as too old", async () => {
    const { header } = signatureFor(BODY, { timestamp: nowSeconds() - 301 });

    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, header), "sandbox"), {
      message: "Webhook timestamp too old",
    });
  });

  it("rejects a timestamp 301 seconds in the future as too old (symmetric tolerance)", async () => {
    const { header } = signatureFor(BODY, { timestamp: nowSeconds() + 301 });

    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, header), "sandbox"), {
      message: "Webhook timestamp too old",
    });
  });

  it("accepts a timestamp 299 seconds old (positive control for the tolerance)", async () => {
    const { header } = signatureFor(BODY, { timestamp: nowSeconds() - 299 });

    const event = await verifyStripeWebhook(webhookRequest(BODY, header), "sandbox");

    assert.equal(event.id, "evt_1");
  });

  it("rejects a request with no Stripe-Signature header", async () => {
    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY), "sandbox"), {
      message: "Missing signature or body",
    });
  });

  it("rejects a request with an empty body", async () => {
    const { header } = signatureFor("");

    await assert.rejects(verifyStripeWebhook(webhookRequest("", header), "sandbox"), {
      message: "Missing signature or body",
    });
  });

  it("rejects a malformed header with no t= entry", async () => {
    const digest = createHmac("sha256", WEBHOOK_SECRET).digest("hex");

    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, `v1=${digest}`), "sandbox"), {
      message: "Invalid signature format",
    });
  });

  it("rejects a malformed header with a t= entry but no v1= entry", async () => {
    await assert.rejects(
      verifyStripeWebhook(webhookRequest(BODY, `t=${nowSeconds()}`), "sandbox"),
      { message: "Invalid signature format" },
    );
  });

  it("rejects a garbage header", async () => {
    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, "garbage"), "sandbox"), {
      message: "Invalid signature format",
    });
  });

  it("throws naming the variable when the sandbox webhook secret is not configured", async () => {
    delete process.env.PAYMENTS_SANDBOX_WEBHOOK_SECRET;
    const { header } = signatureFor(BODY);

    await assert.rejects(verifyStripeWebhook(webhookRequest(BODY, header), "sandbox"), {
      message: "PAYMENTS_SANDBOX_WEBHOOK_SECRET is not configured",
    });
  });
});

describe("firstOfNextMonthUnix", () => {
  function isoOf(unix) {
    return new Date(unix * 1000).toISOString();
  }

  it("mid-month returns 00:00 UTC on the 1st of the following month", () => {
    const now = new Date("2026-11-13T10:00:00.000Z");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2026-12-01T00:00:00.000Z");
  });

  it("rolls over from December to January of the next year", () => {
    const now = new Date("2026-12-15T12:00:00.000Z");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2027-01-01T00:00:00.000Z");
  });

  it("on the last day of a month returns the 1st of the next month (not the same month)", () => {
    const now = new Date("2026-10-31T23:59:59.999Z");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2026-11-01T00:00:00.000Z");
  });

  it("on the last day of February in a leap year returns 1 March", () => {
    const now = new Date("2028-02-29T23:59:59.000Z");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2028-03-01T00:00:00.000Z");
  });

  it("on the 1st at 00:00:00 UTC returns the following month, not now (strictly after)", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2026-12-01T00:00:00.000Z");
  });

  it("uses UTC, not the local date: 23:30 on 31 Oct at UTC-5 is already 1 Nov UTC", () => {
    const now = new Date("2026-10-31T23:30:00-05:00");

    assert.equal(isoOf(firstOfNextMonthUnix(now)), "2026-12-01T00:00:00.000Z");
  });
});
