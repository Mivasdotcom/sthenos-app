/**
 * The public cron/worker hooks accept ONLY `Authorization: Bearer <CRON_SECRET>`.
 * The Supabase publishable/anon key ships to every browser and the service-role
 * key must never be a cron credential, so both are rejected.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { authorizeCron } from "../../src/lib/cron-auth.server.ts";

const CRON_SECRET = "cron-secret-123456";
const ENV = {
  CRON_SECRET,
  SUPABASE_PUBLISHABLE_KEY: "pk_public",
  VITE_SUPABASE_PUBLISHABLE_KEY: "pk_public",
  SUPABASE_ANON_KEY: "anon_public",
  SUPABASE_SERVICE_ROLE_KEY: "service_role_secret",
};

function req(headers = {}) {
  return new Request("https://example.test/api/public/hooks/retention-nightly", {
    method: "POST",
    headers,
  });
}

test("accepts the correct dedicated CRON_SECRET as a Bearer token", () => {
  assert.equal(authorizeCron(req({ Authorization: `Bearer ${CRON_SECRET}` }), ENV), true);
});

test("rejects the publishable key sent as a Bearer token", () => {
  assert.equal(authorizeCron(req({ Authorization: "Bearer pk_public" }), ENV), false);
});

test("rejects the publishable key sent in the apikey header", () => {
  assert.equal(authorizeCron(req({ apikey: "pk_public" }), ENV), false);
});

test("rejects the anon key sent as a Bearer token", () => {
  assert.equal(authorizeCron(req({ Authorization: "Bearer anon_public" }), ENV), false);
});

test("rejects the service-role key sent as a Bearer token", () => {
  assert.equal(authorizeCron(req({ Authorization: "Bearer service_role_secret" }), ENV), false);
});

test("rejects a request with no credentials", () => {
  assert.equal(authorizeCron(req(), ENV), false);
});

test("rejects an empty Bearer token", () => {
  assert.equal(authorizeCron(req({ Authorization: "Bearer " }), ENV), false);
});

test("rejects everything when CRON_SECRET is missing, even an empty Bearer", () => {
  const env = { ...ENV, CRON_SECRET: undefined };
  assert.equal(authorizeCron(req({ Authorization: "Bearer " }), env), false);
});

test("rejects the string 'undefined' when CRON_SECRET is missing", () => {
  const env = { ...ENV, CRON_SECRET: undefined };
  assert.equal(authorizeCron(req({ Authorization: "Bearer undefined" }), env), false);
});

test("rejects the real secret when CRON_SECRET is missing from env", () => {
  const env = { ...ENV, CRON_SECRET: undefined };
  assert.equal(authorizeCron(req({ Authorization: `Bearer ${CRON_SECRET}` }), env), false);
});

test("rejects a token of a different length without throwing", () => {
  assert.doesNotThrow(() => authorizeCron(req({ Authorization: "Bearer x" }), ENV));
  assert.equal(authorizeCron(req({ Authorization: "Bearer x" }), ENV), false);
  assert.equal(authorizeCron(req({ Authorization: `Bearer ${CRON_SECRET}extra` }), ENV), false);
});

test("fails closed when CRON_SECRET is shorter than 16 chars", () => {
  const env = { ...ENV, CRON_SECRET: "short-secret" };
  assert.equal(authorizeCron(req({ Authorization: "Bearer short-secret" }), env), false);
});
