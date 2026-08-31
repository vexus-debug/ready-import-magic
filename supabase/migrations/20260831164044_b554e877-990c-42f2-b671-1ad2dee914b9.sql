-- lovable-cron-fallback-reviewed: 720 runs/day; required two-minute freshness for the live market scanner while no browser is open
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'loopline-background-scan-every-2-minutes';
EXCEPTION
  WHEN undefined_table THEN NULL;
END $$;

CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION IF EXISTS pg_net;
CREATE EXTENSION pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'loopline-background-scan-every-2-minutes',
  '*/2 * * * *',
  $$SELECT extensions.http_get(url := 'https://project--07527b3e-e3d5-498c-8142-c052c4bd0007.lovable.app/api/public/scan?token=' || (SELECT token FROM public.loopline_scanner_cron_secret WHERE id = 1));$$
);