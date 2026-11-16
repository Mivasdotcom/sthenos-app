/**
 * Password-reset links may only be built against origins derived from the
 * configured PUBLIC_SITE_URL (plus localhost for development). Any other
 * caller-supplied origin falls back to PUBLIC_SITE_URL.
 *
 * Node's own test runner, no dependencies. Types are stripped at load.
 */
import test from "node:test";
import assert from "node:assert/strict";

const SITE = "https://app.example.com";

// site.ts reads VITE_PUBLIC_SITE_URL at module load, so set it before importing.
process.env.VITE_PUBLIC_SITE_URL = SITE;
const { safeOrigin } = await import("../../src/lib/password-reset.server.ts");

test("accepts the configured site origin", () => {
  assert.equal(safeOrigin(SITE), SITE);
});

test("accepts the www. variant of the configured host", () => {
  assert.equal(safeOrigin("https://www.app.example.com"), "https://www.app.example.com");
});

test("rejects a lovable.app preview origin and falls back", () => {
  assert.equal(safeOrigin("https://x.lovable.app"), SITE);
});

test("accepts localhost for development", () => {
  assert.equal(safeOrigin("http://localhost:3000"), "http://localhost:3000");
});

test("rejects an unrelated origin and falls back", () => {
  assert.equal(safeOrigin("https://evil.com"), SITE);
});

test("falls back when no origin is supplied", () => {
  assert.equal(safeOrigin(null), SITE);
  assert.equal(safeOrigin(undefined), SITE);
});

test("strips a trailing slash before matching", () => {
  assert.equal(safeOrigin(`${SITE}/`), SITE);
});
