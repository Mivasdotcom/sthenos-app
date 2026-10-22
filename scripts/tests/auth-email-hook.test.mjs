/**
 * Supabase Send Email Hook: signature verification and payload mapping.
 *
 * Signs payloads the way Supabase does (Standard Webhooks) and checks that the
 * hook accepts valid ones, maps them to the right template inputs, and rejects
 * bad signatures, stale timestamps, missing headers and unknown action types.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { HookError, verifyAndParseHook } from "../../src/lib/auth-email-hook.ts";

const RAW_KEY = "test-secret-bytes-32-long-xxxxxx";
const SECRET = `v1,whsec_${Buffer.from(RAW_KEY).toString("base64")}`;
const SUPABASE_URL = "https://example.supabase.co";
const NOW = 1_800_000_000;
const WEBHOOK_ID = "msg_abc123";

function sign(body, { id = WEBHOOK_ID, timestamp = NOW, key = RAW_KEY } = {}) {
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

function signedHeaders(body, opts = {}) {
  const timestamp = opts.timestamp ?? NOW;
  return new Headers({
    "webhook-id": opts.id ?? WEBHOOK_ID,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sign(body, { id: opts.id ?? WEBHOOK_ID, timestamp, key: opts.key }),
  });
}

function payload(overrides = {}) {
  return {
    user: { id: "user-1", email: "member@example.com", ...overrides.user },
    email_data: {
      token: "123456",
      token_hash: "hash-current",
      redirect_to: "https://app.example.com/reset?x=1",
      email_action_type: "recovery",
      site_url: "https://sthenos.live",
      token_new: "",
      token_hash_new: "",
      ...overrides.email_data,
    },
  };
}

function verify(body, headers, secret = SECRET) {
  return verifyAndParseHook(body, headers, secret, SUPABASE_URL, NOW);
}

test("a correctly signed recovery payload is accepted and mapped", () => {
  const body = JSON.stringify(payload());

  const result = verify(body, signedHeaders(body));

  assert.equal(result.webhookId, WEBHOOK_ID);
  assert.equal(result.emailType, "recovery");
  assert.equal(result.recipient, "member@example.com");
  assert.equal(
    result.templateProps.confirmationUrl,
    `${SUPABASE_URL}/auth/v1/verify?token=hash-current&type=recovery&redirect_to=${encodeURIComponent(
      "https://app.example.com/reset?x=1",
    )}`,
  );
  assert.equal(
    result.templateProps.confirmationUrl,
    "https://example.supabase.co/auth/v1/verify?token=hash-current&type=recovery&redirect_to=https%3A%2F%2Fapp.example.com%2Freset%3Fx%3D1",
  );
  assert.equal(result.templateProps.token, "123456");
  assert.equal(result.templateProps.email, "member@example.com");
});

test("a tampered body is rejected with 401", () => {
  const body = JSON.stringify(payload());
  const headers = signedHeaders(body);
  const tampered = JSON.stringify(payload({ user: { email: "attacker@example.com" } }));

  assert.throws(
    () => verify(tampered, headers),
    (err) => err instanceof HookError && err.status === 401,
  );
});

test("a wrong secret is rejected with 401", () => {
  const body = JSON.stringify(payload());
  const headers = signedHeaders(body, { key: "some-other-key-entirely-different" });

  assert.throws(
    () => verify(body, headers),
    (err) => err instanceof HookError && err.status === 401,
  );
});

test("a timestamp 301 seconds old is rejected with 401", () => {
  const body = JSON.stringify(payload());
  const headers = signedHeaders(body, { timestamp: NOW - 301 });

  assert.throws(
    () => verify(body, headers),
    (err) => err instanceof HookError && err.status === 401,
  );
});

test("an unknown email_action_type is rejected with 400", () => {
  const body = JSON.stringify(payload({ email_data: { email_action_type: "foo" } }));

  assert.throws(
    () => verify(body, signedHeaders(body)),
    (err) => err instanceof HookError && err.status === 400,
  );
});

test("a missing webhook-id header is rejected with 400", () => {
  const body = JSON.stringify(payload());
  const headers = signedHeaders(body);
  headers.delete("webhook-id");

  assert.throws(
    () => verify(body, headers),
    (err) => err instanceof HookError && err.status === 400,
  );
});

test("email_change sends one email to new_email using the _new hashes", () => {
  const body = JSON.stringify(
    payload({
      user: { email: "old@example.com", new_email: "new@example.com" },
      email_data: {
        email_action_type: "email_change",
        token: "111111",
        token_hash: "hash-old",
        token_new: "222222",
        token_hash_new: "hash-new",
      },
    }),
  );

  const result = verify(body, signedHeaders(body));

  assert.equal(result.emailType, "email_change");
  assert.equal(result.recipient, "new@example.com");
  assert.equal(result.templateProps.newEmail, "new@example.com");
  assert.equal(result.templateProps.oldEmail, "old@example.com");
  assert.equal(result.templateProps.token, "222222");
  assert.equal(
    result.templateProps.confirmationUrl,
    `${SUPABASE_URL}/auth/v1/verify?token=hash-new&type=email_change&redirect_to=${encodeURIComponent(
      "https://app.example.com/reset?x=1",
    )}`,
  );
});

test("when several signatures are sent, a valid second entry is accepted", () => {
  const body = JSON.stringify(payload());
  const bogus = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const headers = signedHeaders(body);
  headers.set("webhook-signature", `${bogus} ${sign(body)}`);

  const result = verify(body, headers);

  assert.equal(result.emailType, "recovery");
});

test("a secret given without the v1,whsec_ prefix still verifies", () => {
  const body = JSON.stringify(payload());
  const bareSecret = Buffer.from(RAW_KEY).toString("base64");

  const result = verify(body, signedHeaders(body), bareSecret);

  assert.equal(result.emailType, "recovery");
});
