DO $$ BEGIN IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated'; END IF; END $$;
REVOKE EXECUTE ON FUNCTION public.loopline_set_updated_at() FROM PUBLIC, anon, authenticated;

CREATE SCHEMA IF NOT EXISTS extensions;
DROP EXTENSION pg_net;
CREATE EXTENSION pg_net WITH SCHEMA extensions;