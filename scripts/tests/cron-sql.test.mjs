/**
 * Static checks for the Supabase cron SQL in deploy/supabase/. No database.
 *
 * The scripts are run by the Supabase project owner with psql. These checks
 * guard the properties that a DB-less run can see: no psql variable defaults,
 * no secret-like literals, the email queue guard, the backup and the restore.
 *
 * Node's own test runner, no dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOINT = resolve(ROOT, "deploy", "supabase", "repoint-cron.sql");
const RESTORE = resolve(ROOT, "deploy", "supabase", "restore-cron.sql");

const PSQL_VARIABLES = [
  "app_url",
  "cron_secret",
  "sched_email_queue",
  "sched_membership",
  "sched_retention",
  "sched_workflows",
];

/** A 32+ character hex run is how a generated secret or token looks in a dump. */
const HEX_SECRET = /[0-9a-fA-F]{32,}/;
/** Supabase JWTs and Stripe, Resend and Svix style keys. */
const KEY_PREFIX = /\b(eyJ[A-Za-z0-9_-]{10,}|sk_(live|test)_|whsec_|re_[A-Za-z0-9]{8,})/;

function read(path) {
  return readFileSync(path, "utf8");
}

test("repoint-cron.sql exists", () => {
  assert.ok(existsSync(REPOINT), `${REPOINT} does not exist`);
});

test("repoint-cron.sql gives no default for any psql variable", () => {
  const sql = read(REPOINT);
  // psql defaults are set with \set; a :{?name} test is a default check in disguise.
  assert.doesNotMatch(
    sql,
    /^\s*\\set\b/m,
    "psql \\set found: variables must be supplied with -v, never defaulted",
  );
  assert.doesNotMatch(sql, /:\{\?/, "conditional psql variable test found");
  for (const name of PSQL_VARIABLES) {
    assert.doesNotMatch(sql, new RegExp(`\\\\(set|gset)\\s+${name}\\b`), `${name} has a default`);
  }
});

test("cron SQL files contain no secret-like literals", () => {
  for (const path of [REPOINT, RESTORE].filter(existsSync)) {
    const sql = read(path);
    assert.doesNotMatch(sql, HEX_SECRET, `${path} contains a hex run that looks like a secret`);
    assert.doesNotMatch(sql, KEY_PREFIX, `${path} contains a key-shaped literal`);
  }
});

test("the process-email-queue guard checks the cooldown and both queues", () => {
  const sql = read(REPOINT);
  assert.match(sql, /retry_after_until/, "guard does not check email_send_state.retry_after_until");
  assert.match(sql, /auth_emails/, "guard does not check the auth_emails queue");
  assert.match(sql, /transactional_emails/, "guard does not check the transactional_emails queue");
});

test("the backup inserts with ON CONFLICT DO NOTHING so a re-run never overwrites", () => {
  const sql = read(REPOINT);
  assert.match(sql, /ops\.cron_job_backup/, "repoint-cron.sql does not write ops.cron_job_backup");
  assert.match(
    sql,
    /ON CONFLICT \(jobname\) DO NOTHING/i,
    "backup insert is not ON CONFLICT (jobname) DO NOTHING",
  );
});

test("the backup is written before the jobs are unscheduled", () => {
  const sql = read(REPOINT);
  const backupAt = sql.search(/INSERT INTO ops\.cron_job_backup/i);
  const unscheduleAt = sql.search(/SELECT cron\.unschedule\(jobid\)/);
  assert.ok(backupAt >= 0, "no backup insert found");
  assert.ok(unscheduleAt >= 0, "no unschedule found");
  assert.ok(backupAt < unscheduleAt, "backup must run before cron.unschedule");
});

test("restore-cron.sql reads ops.cron_job_backup and restores the jobs", () => {
  assert.ok(existsSync(RESTORE), `${RESTORE} does not exist`);
  const sql = read(RESTORE);
  assert.match(sql, /ops\.cron_job_backup/, "restore does not read ops.cron_job_backup");
  assert.match(sql, /cron\.schedule\(/, "restore does not reschedule jobs");
  assert.match(sql, /cron\.unschedule\(/, "restore does not remove the four new jobs");
});

test("the backup never stores a command this script wrote on an earlier run", () => {
  // The four repointed jobs match the backup filter on a re-run. Their commands read
  // app_cron_secret from Vault, so the backup must exclude that marker. Otherwise a
  // restore would bring the new commands back as if they were the originals.
  const sql = read(REPOINT);
  const start = sql.search(/INSERT INTO ops\.cron_job_backup/i);
  assert.ok(start >= 0, "no backup insert found");
  const insert = sql.slice(start, sql.indexOf("ON CONFLICT", start));
  assert.match(
    insert,
    /NOT LIKE '%app_cron_secret%'/,
    "backup filter does not exclude repointed commands",
  );
});
