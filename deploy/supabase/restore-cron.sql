-- Undo repoint-cron.sql: put back the cron jobs that repoint-cron.sql removed.
--
-- Run by the person who owns the Supabase project. See deploy/README.md, section 6,
-- "Undo".
--
-- Usage:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f deploy/supabase/restore-cron.sql
--
-- No variables. The script contains no secrets.
--
-- What it does:
--   1. Removes the four jobs that repoint-cron.sql scheduled, by name. A name that
--      is not present is skipped.
--   2. Schedules every job in ops.cron_job_backup again, with its original name,
--      schedule and command. A job that was inactive when backed up is paused again.
--
-- Pure-SQL jobs such as enforce-overdue-grace were never removed, so they are not
-- touched. The Vault secret app_cron_secret is not removed either: the restored
-- commands do not use it.
--
-- Running it twice gives the same result.

BEGIN;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN ('process-email-queue', 'membership-nightly', 'retention-nightly', 'scheduled-workflows');

DO $$
DECLARE
  backup_row record;
  new_job_id bigint;
BEGIN
  FOR backup_row IN
    SELECT jobname, schedule, command, active
    FROM ops.cron_job_backup
    ORDER BY jobname
  LOOP
    new_job_id := cron.schedule(backup_row.jobname, backup_row.schedule, backup_row.command);
    IF NOT backup_row.active THEN
      PERFORM cron.alter_job(new_job_id, active := false);
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- Show the result.
SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobid;
