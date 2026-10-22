-- Repoint the Supabase pg_cron jobs from the old Lovable host to the self-hosted app.
--
-- Run by the person who owns the Supabase project, once, after the new app is
-- deployed and answering /api/public/health. See deploy/README.md, section
-- "Supabase owner checklist", step (e).
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

-- 2. Remove the old HTTP jobs: anything pointing at the Lovable host, anything
--    pointing at the app hooks, and the four known job names. Pure-SQL jobs such
--    as enforce-overdue-grace do not match and are left alone.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE command ILIKE '%/lovable/%'
   OR command ILIKE '%/api/public/hooks/%'
   OR jobname IN ('process-email-queue', 'membership-nightly', 'retention-nightly', 'scheduled-workflows');

-- 3. Schedule the four hooks. The command reads the token from Vault at run time.
SELECT cron.schedule(
  'process-email-queue',
  :'sched_email_queue',
  format($cmd$SELECT net.http_post(url := %L, body := '{}'::jsonb, headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_cron_secret')), timeout_milliseconds := 10000);$cmd$, :'app_url' || '/api/public/hooks/email-queue')
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
