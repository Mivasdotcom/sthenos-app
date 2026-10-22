/**
 * www.<CANONICAL_HOST> redirects to <CANONICAL_HOST> with a 301. Disabled when
 * CANONICAL_HOST is unset, and /api/public/hooks/* is never redirected.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalHostRedirect } from "../../src/lib/canonical-host.ts";

function req(url) {
  return new Request(url);
}

test("redirects www to the canonical host with a 301, keeping path and query", () => {
  const res = canonicalHostRedirect(req("https://www.example.com/members?x=1"), "example.com");
  assert.ok(res, "expected a redirect response");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://example.com/members?x=1");
});

test("returns null for a request already on the canonical host", () => {
  assert.equal(canonicalHostRedirect(req("https://example.com/members"), "example.com"), null);
});

test("returns null when CANONICAL_HOST is unset, so a www request is not redirected", () => {
  assert.equal(canonicalHostRedirect(req("https://www.example.com/members"), undefined), null);
});

test("returns null when CANONICAL_HOST is empty", () => {
  assert.equal(canonicalHostRedirect(req("https://www.example.com/members"), ""), null);
});

test("never redirects /api/public/hooks/* endpoints", () => {
  const res = canonicalHostRedirect(
    req("https://www.example.com/api/public/hooks/email-queue"),
    "example.com",
  );
  assert.equal(res, null);
});

test("returns null for an unrelated www host", () => {
  assert.equal(canonicalHostRedirect(req("https://www.other.com/members"), "example.com"), null);
});
