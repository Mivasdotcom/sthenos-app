-- Repoint the Supabase pg_cron jobs from the old Lovable host to the self-hosted app.
--
-- Run by the person who owns the Supabase project, once, after the new app is
-- deployed and answering /api/public/health. See deploy/README.md, section
-- "Supabase owner checklist", step (e). To undo, run restore-cron.sql.
--
-- Usage:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 \
--     -v app_url=https://example.com \
--     -v cron_secret="$CRON_SECRET" \
--     -v sched_email_queue='5 seconds' \
--     -v sched_membership='<copied from cron.job>' \
--     -v sched_retention='<copied from cron.job>' \
--     -v sched_workflows='<copied from cron.job>' \
--     -f deploy/supabase/repoint-cron.sql
--
-- Variables (all required, there are NO defaults):
--   app_url        Public origin of the app, https, no trailing slash.
--   cron_secret    Must equal CRON_SECRET in the app's server .env. Stored in Vault
--                  as app_cron_secret. Never written to cron.job.command.
--   sched_*        Cron schedules. Copy the existing schedule of each job from the
--                  output of `select jobid, jobname, schedule, command from cron.job`.
--                  The '5 seconds' syntax needs pg_cron >= 1.5.
--
-- The script contains no secrets. The Bearer token is read from Vault when each job
-- runs, so cron.job.command only holds the URL and a Vault lookup.
--
-- Backup: every job this script removes is copied to ops.cron_job_backup first.
-- Rows are inserted only when no row exists for that jobname, so a re-run never
-- overwrites the original command. The backup can contain the old Lovable commands
-- verbatim, including any service-role key they carried. ops is not exposed to the
-- API roles.
--
-- Idempotent: re-running updates the Vault secret and replaces the four jobs.

BEGIN;

-- 1. Vault secret. psql variables are not interpolated inside dollar-quoted strings,
--    so the two statements below are plain SQL. Only one of them does anything.
SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'app_cron_secret'),
  :'cron_secret',
  'app_cron_secret',
  'Bearer token for the app /api/public/hooks/* cron endpoints'
)
FROM vault.secrets
WHERE name = 'app_cron_secret';

SELECT vault.create_secret(
  :'cron_secret',
  'app_cron_secret',
  'Bearer token for the app /api/public/hooks/* cron endpoints'
)
WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'app_cron_secret');

-- 2. Back up the jobs this script is about to remove, then remove them.
--    The WHERE clause is the same for the backup and the unschedule, so the backup
--    covers exactly the jobs that are removed. Pure-SQL jobs such as
--    enforce-overdue-grace do not match and are left alone.
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.cron_job_backup (
  jobname text PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  database text NOT NULL,
  username text NOT NULL,
  active boolean NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

-- Only the owner reads the backup. The API roles exist on Supabase only, so each
-- REVOKE is guarded: REVOKE from a missing role is an error.
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
REVOKE ALL ON TABLE ops.cron_job_backup FROM PUBLIC;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA ops FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON TABLE ops.cron_job_backup FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- A job whose command reads app_cron_secret was written by this script on an earlier
-- run. It is not an original, so it is never backed up. Without this filter a re-run
-- would back up the repointed jobs too.
INSERT INTO ops.cron_job_backup (jobname, schedule, command, database, username, active)
SELECT jobname, schedule, command, database, username, active
FROM cron.job
WHERE (command ILIKE '%/lovable/%'
    OR command ILIKE '%/api/public/hooks/%'
    OR jobname IN ('process-email-queue', 'membership-nightly', 'retention-nightly', 'scheduled-workflows'))
  AND command NOT LIKE '%app_cron_secret%'
ON CONFLICT (jobname) DO NOTHING;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE command ILIKE '%/lovable/%'
   OR command ILIKE '%/api/public/hooks/%'
   OR jobname IN ('process-email-queue', 'membership-nightly', 'retention-nightly', 'scheduled-workflows');

-- 3. Schedule the four hooks. The command reads the token from Vault at run time.

-- process-email-queue runs every few seconds. It calls the worker only when there is
-- work to do, as the original Lovable job did:
--   a) the rate-limit cooldown is not active. email_send_state is a singleton row
--      (CHECK id = 1). A missing row means no cooldown;
--   b) the auth_emails or transactional_emails queue has messages. A queue table
--      that does not exist counts as empty.
SELECT cron.schedule(
  'process-email-queue',
  :'sched_email_queue',
  format($cmd$DO $job$
DECLARE
  has_work boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.email_send_state WHERE id = 1 AND retry_after_until > now()
  ) THEN
    IF to_regclass('pgmq.q_auth_emails') IS NOT NULL THEN
      has_work := EXISTS (SELECT 1 FROM pgmq.q_auth_emails);
    END IF;
    IF NOT has_work AND to_regclass('pgmq.q_transactional_emails') IS NOT NULL THEN
      has_work := EXISTS (SELECT 1 FROM pgmq.q_transactional_emails);
    END IF;
    IF has_work THEN
      PERFORM net.http_post(url := %L, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret')), timeout_milliseconds := 10000);
    END IF;
  END IF;
END
$job$;$cmd$, :'app_url' || '/api/public/hooks/email-queue')
);

SELECT cron.schedule(
  'membership-nightly',
  :'sched_membership',
  format($cmd$SELECT net.http_post(url := %L, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret')), timeout_milliseconds := 10000);$cmd$, :'app_url' || '/api/public/hooks/membership-nightly')
);

SELECT cron.schedule(
  'retention-nightly',
  :'sched_retention',
  format($cmd$SELECT net.http_post(url := %L, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret')), timeout_milliseconds := 10000);$cmd$, :'app_url' || '/api/public/hooks/retention-nightly')
);

SELECT cron.schedule(
  'scheduled-workflows',
  :'sched_workflows',
  format($cmd$SELECT net.http_post(url := %L, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret')), timeout_milliseconds := 10000);$cmd$, :'app_url' || '/api/public/hooks/scheduled-workflows')
);

COMMIT;

-- Show the result for the app owner.
SELECT jobname, schedule, command FROM cron.job ORDER BY jobid;
