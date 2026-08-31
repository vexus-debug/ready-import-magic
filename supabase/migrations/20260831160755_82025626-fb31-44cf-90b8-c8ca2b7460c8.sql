CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE public.loopline_scanner_state (id smallint PRIMARY KEY DEFAULT 1, status text NOT NULL DEFAULT 'idle', last_started_at timestamptz, last_completed_at timestamptz, market_fetched_at timestamptz, instruments jsonb NOT NULL DEFAULT '[]'::jsonb, tickers jsonb NOT NULL DEFAULT '[]'::jsonb, opportunities jsonb NOT NULL DEFAULT '[]'::jsonb, settings jsonb NOT NULL DEFAULT '{}'::jsonb, error_message text, failure_count integer NOT NULL DEFAULT 0, paused boolean NOT NULL DEFAULT false, pause_reason text, lease_id text, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.loopline_scanner_state TO anon, authenticated;
GRANT ALL ON public.loopline_scanner_state TO service_role;
ALTER TABLE public.loopline_scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read the latest scanner state" ON public.loopline_scanner_state FOR SELECT TO anon, authenticated USING (id = 1);
CREATE POLICY "Service role manages scanner state" ON public.loopline_scanner_state FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.loopline_scanner_cron_secret (id smallint PRIMARY KEY DEFAULT 1, token text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'), created_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.loopline_scanner_cron_secret TO service_role;
ALTER TABLE public.loopline_scanner_cron_secret ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages scanner scheduler secret" ON public.loopline_scanner_cron_secret FOR ALL TO service_role USING (true) WITH CHECK (true);
INSERT INTO public.loopline_scanner_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.loopline_scanner_cron_secret (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.loopline_set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER loopline_scanner_state_updated_at BEFORE UPDATE ON public.loopline_scanner_state FOR EACH ROW EXECUTE FUNCTION public.loopline_set_updated_at();

SELECT cron.schedule('loopline-background-scan-every-2-minutes', '*/2 * * * *', $$SELECT net.http_get(url := 'https://project--1268040a-0195-485a-ac6e-b2edb968fb72.lovable.app/api/public/scan?token=' || (SELECT token FROM public.loopline_scanner_cron_secret WHERE id = 1));$$);