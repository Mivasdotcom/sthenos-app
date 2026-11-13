/**
 * The Dockerfile build stage must refuse to run `npm run build` when any of the
 * four VITE_* build args is empty or missing. Vite inlines them into the browser
 * bundle, so a silent empty value ships a broken image.
 *
 * The check step is extracted from the Dockerfile and executed with /bin/sh, the
 * same shell Docker uses for shell-form RUN. Node's own test runner, no dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCKERFILE = resolve(ROOT, "Dockerfile");

const VITE_ARGS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PROJECT_ID",
  "VITE_PUBLIC_SITE_URL",
];

const BUILD_LINE = "RUN npm run build";

/**
 * Returns the shell text of the instruction directly above `RUN npm run build`,
 * which must itself be a RUN. Only that one instruction is taken, so the helper
 * never executes an earlier step such as `RUN npm ci`. Docker runs shell-form RUN
 * as `/bin/sh -c <text>`; sh understands the backslash-newline continuations.
 */
function checkStepScript() {
  const lines = readFileSync(DOCKERFILE, "utf8").split("\n");
  const buildIdx = lines.findIndex((line) => line === BUILD_LINE);
  assert.ok(buildIdx > 0, `Dockerfile has no "${BUILD_LINE}" line`);

  // An instruction starts at column 0 with a keyword; continuation lines are indented or follow a backslash.
  let start = buildIdx - 1;
  while (start > 0 && !/^[A-Z]+ /.test(lines[start])) start--;
  assert.ok(
    lines[start].startsWith("RUN "),
    `the instruction directly before "${BUILD_LINE}" is not a RUN step: ${lines[start]}`,
  );

  const block = lines.slice(start, buildIdx);
  while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
  block[0] = block[0].slice("RUN ".length);
  return block.join("\n");
}

/** Runs the check step under /bin/sh with exactly the given VITE_* values. */
function runCheck(viteEnv) {
  const env = { PATH: process.env.PATH };
  for (const [name, value] of Object.entries(viteEnv)) {
    if (value !== undefined) env[name] = value;
  }
  return spawnSync("/bin/sh", ["-c", checkStepScript()], { env, encoding: "utf8" });
}

function allSet() {
  return {
    VITE_SUPABASE_URL: "https://x.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "dummy",
    VITE_SUPABASE_PROJECT_ID: "x",
    VITE_PUBLIC_SITE_URL: "https://localhost",
  };
}

test("the Dockerfile has a check step directly before npm run build", () => {
  const script = checkStepScript();
  for (const name of VITE_ARGS) {
    assert.ok(script.includes(name), `check step does not mention ${name}`);
  }
});

test("all four VITE_* args set: the check passes (positive control)", () => {
  const result = runCheck(allSet());
  assert.equal(result.status, 0, `check failed: ${result.stderr}`);
});

test("all four VITE_* args missing: the check fails and names all four", () => {
  const result = runCheck({});
  assert.notEqual(result.status, 0, "check passed with no VITE_* args");
  for (const name of VITE_ARGS) {
    assert.ok(result.stderr.includes(name), `stderr does not name ${name}: ${result.stderr}`);
  }
});

for (const name of VITE_ARGS) {
  test(`${name} empty (others set): the check fails and names only ${name}`, () => {
    const result = runCheck({ ...allSet(), [name]: "" });
    assert.notEqual(result.status, 0, `check passed with empty ${name}`);
    assert.ok(result.stderr.includes(name), `stderr does not name ${name}: ${result.stderr}`);
    for (const other of VITE_ARGS.filter((n) => n !== name)) {
      assert.ok(!result.stderr.includes(other), `stderr wrongly names ${other}: ${result.stderr}`);
    }
  });

  test(`${name} unset (others set): the check fails and names ${name}`, () => {
    const env = allSet();
    delete env[name];
    const result = runCheck(env);
    assert.notEqual(result.status, 0, `check passed with ${name} unset`);
    assert.ok(result.stderr.includes(name), `stderr does not name ${name}: ${result.stderr}`);
  });
}
