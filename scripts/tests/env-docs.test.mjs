/**
 * Every variable in .env.example must be documented in deploy/README.md, and
 * .env.example must never carry a real value (committed secrets guard).
 *
 * Node's own test runner, no dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_EXAMPLE = resolve(ROOT, ".env.example");
const README = resolve(ROOT, "deploy", "README.md");

const NAME_LINE = /^[A-Z][A-Z0-9_]*=/gm;

function envExampleNames() {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  return [...text.matchAll(NAME_LINE)].map((m) => m[0].slice(0, -1));
}

/** Matches the name as a whole token, so SITE_URL does not match VITE_PUBLIC_SITE_URL. */
function mentions(text, name) {
  return new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(text);
}

test(".env.example lists at least one variable", () => {
  assert.ok(envExampleNames().length > 0, "no NAME= lines found in .env.example");
});

test("deploy/README.md documents every variable in .env.example", () => {
  assert.ok(
    existsSync(README),
    "deploy/README.md does not exist; the runbook must document every .env.example variable",
  );
  const readme = readFileSync(README, "utf8");
  const missing = envExampleNames().filter((name) => !mentions(readme, name));
  assert.deepEqual(
    missing,
    [],
    `deploy/README.md is missing these .env.example variables: ${missing.join(", ")}`,
  );
});

test(".env.example has no non-empty values (no committed secrets)", () => {
  // Empty placeholders are written as KEY="" and are allowed; anything else is a value.
  const withValue = /^[A-Z0-9_]+=(?!""\s*$)\S/m;
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  const offending = text
    .split("\n")
    .filter((line) => withValue.test(line))
    .map((line) => line.split("=")[0]);
  assert.deepEqual(
    offending,
    [],
    `.env.example has non-empty values for: ${offending.join(", ")}. Leave values empty.`,
  );
});
