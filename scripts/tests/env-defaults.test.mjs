/**
 * Empty environment values (Docker `ARG X` + `ENV X=$X`, compose `${X:-}`,
 * `.env.example` `KEY=""`) must behave exactly like unset ones. `??` does not
 * catch "", so every default goes through envOr / envOptional.
 *
 * Node's own test runner, no dependencies. Relative imports only: this file
 * must never load anything through the `@/` alias.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { envOr, envOptional } from "../../src/lib/env.ts";
import { normaliseDomain, resolveFromLocalPart } from "../../src/lib/email-sender-identity.ts";

const SITE = "https://app.example.test";

test("envOr returns the fallback for undefined, null, empty and whitespace-only values", () => {
  assert.equal(envOr(undefined, "fb"), "fb");
  assert.equal(envOr(null, "fb"), "fb");
  assert.equal(envOr("", "fb"), "fb");
  assert.equal(envOr("   ", "fb"), "fb");
});

test("envOr trims a set value and returns it", () => {
  assert.equal(envOr(" x ", "fb"), "x");
});

test("envOr keeps a set value over the fallback (positive control)", () => {
  assert.equal(envOr("claude-custom", "claude-opus-5-5"), "claude-custom");
});

test("envOptional applies the same emptiness rule and returns undefined", () => {
  assert.equal(envOptional(""), undefined);
  assert.equal(envOptional("  \t "), undefined);
  assert.equal(envOptional(undefined), undefined);
  assert.equal(envOptional(" https://x.test/ "), "https://x.test/");
});

test("sending domain is derived from the site URL when EMAIL_SENDING_DOMAIN is empty", () => {
  assert.equal(normaliseDomain("", SITE), "notify.app.example.test");
  assert.equal(normaliseDomain("   ", SITE), "notify.app.example.test");
  assert.equal(normaliseDomain(undefined, SITE), "notify.app.example.test");
});

test("an explicit sending domain wins over the site-derived default", () => {
  assert.equal(normaliseDomain("Mail.Example.COM", SITE), "mail.example.com");
});

test("sending domain tolerates a full address or URL configured by mistake", () => {
  assert.equal(normaliseDomain("ops@mail.example.com", SITE), "mail.example.com");
  assert.equal(normaliseDomain("https://mail.example.com/", SITE), "mail.example.com");
});

test("local part is noreply when EMAIL_SENDING_LOCAL_PART is empty", () => {
  assert.equal(resolveFromLocalPart(""), "noreply");
  assert.equal(resolveFromLocalPart("  "), "noreply");
  assert.equal(resolveFromLocalPart(undefined), "noreply");
});

test("an explicit local part wins and is lower-cased", () => {
  assert.equal(resolveFromLocalPart(" Hello "), "hello");
});

/**
 * Import the real modules in a fresh Node process with only the env we pass,
 * so module-load-time evaluation (the crash path) is exercised, not a cached
 * import from the test runner.
 */
function importInChild(viteSiteUrl) {
  const siteHref = pathToFileURL(new URL("../../src/lib/site.ts", import.meta.url).pathname).href;
  const resetHref = pathToFileURL(
    new URL("../../src/lib/password-reset.server.ts", import.meta.url).pathname,
  ).href;
  const script = [
    `const site = await import(${JSON.stringify(siteHref)});`,
    `await import(${JSON.stringify(resetHref)});`,
    "console.log(site.PUBLIC_SITE_URL);",
  ].join("\n");
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: { ...process.env, VITE_PUBLIC_SITE_URL: viteSiteUrl },
    },
  );
}

test("password-reset and site load with VITE_PUBLIC_SITE_URL empty and fall back to the canonical origin", () => {
  const run = importInChild("");
  assert.equal(run.status, 0, `child exited ${run.status}: ${run.stderr}`);
  assert.equal(run.stdout.trim(), "https://sthenos.live");
});

test("a set VITE_PUBLIC_SITE_URL wins in the same child import (positive control)", () => {
  const run = importInChild("https://example.test");
  assert.equal(run.status, 0, `child exited ${run.status}: ${run.stderr}`);
  assert.equal(run.stdout.trim(), "https://example.test");
});
