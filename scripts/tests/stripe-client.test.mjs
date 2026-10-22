/**
 * The platform's Stripe client must talk to api.stripe.com directly with the
 * platform's own secret key. No connector gateway, no Lovable headers.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createStripeClient } from "../../src/lib/stripe.server.ts";

const DUMMY_KEY = "sk_test_dummy123";

function stubFetch(calls) {
  return async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({ object: "list", data: [], has_more: false, url: "/v1/customers" }),
      {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      },
    );
  };
}

test("sandbox client calls api.stripe.com directly with the platform key", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.STRIPE_SANDBOX_API_KEY;
  const calls = [];
  process.env.STRIPE_SANDBOX_API_KEY = DUMMY_KEY;
  globalThis.fetch = stubFetch(calls);
  try {
    await createStripeClient("sandbox").customers.list({ limit: 1 });

    assert.equal(calls.length, 1, "expected exactly one outbound request");
    const { input, init } = calls[0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.host, "api.stripe.com");

    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${DUMMY_KEY}`);
    assert.equal(headers.has("lovable-api-key"), false, "must not send Lovable-API-Key");
    assert.equal(headers.has("x-connection-api-key"), false, "must not send X-Connection-Api-Key");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.STRIPE_SANDBOX_API_KEY;
    else process.env.STRIPE_SANDBOX_API_KEY = originalKey;
  }
});

test("sandbox client throws when STRIPE_SANDBOX_API_KEY is missing", () => {
  const originalKey = process.env.STRIPE_SANDBOX_API_KEY;
  delete process.env.STRIPE_SANDBOX_API_KEY;
  try {
    assert.throws(
      () => createStripeClient("sandbox"),
      (err) => {
        assert.match(err.message, /STRIPE_SANDBOX_API_KEY/);
        assert.equal(err.message.includes(DUMMY_KEY), false, "error must not echo a key value");
        return true;
      },
    );
  } finally {
    if (originalKey !== undefined) process.env.STRIPE_SANDBOX_API_KEY = originalKey;
  }
});
