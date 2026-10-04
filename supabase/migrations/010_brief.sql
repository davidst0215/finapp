-- ============================================================
-- MIGRATION 010: brief de las 7:00
-- Un brief por día (fecha de Lima) para el dueño. Lo escribe la edge function `brief` con el rol de servicio;
-- la app solo lo lee. Un job de pg_cron lo dispara cada día a las 12:00 UTC (7:00 Lima, sin horario de verano).
--
-- ANTES DE APLICAR (lo hace el hilo principal, nada de esto va en el repo):
--   1. Elegir un valor aleatorio largo (>= 32 caracteres) y guardarlo en DOS sitios con el MISMO valor:
--        a) Supabase Vault:   select vault.create_secret('<valor>', 'brief_cron_secret');
--        b) Secreto de la función:  npx supabase secrets set BRIEF_CRON_SECRET=<valor> --project-ref rrhyyclltgaecfyertqh
--   2. Secreto de la función WABID_OWNER_ID = UUID de David en Supabase Auth.
--   3. Desplegar la función con verify_jwt=false (la llama pg_cron, que no tiene JWT de usuario):
--        npx supabase functions deploy brief --no-verify-jwt --project-ref rrhyyclltgaecfyertqh
-- Si el secreto de Vault falta, el job igual corre pero la función responde 401 y no pasa nada más.
-- ============================================================

CREATE TABLE IF NOT EXISTS briefs (
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    fecha      DATE NOT NULL,                              -- día en America/Lima
    texto      TEXT NOT NULL,                              -- lo que Wabid dice en voz alta
    secciones  JSONB NOT NULL,                             -- agenda, tareas, dinero, esperas (datos exactos)
    origen     VARCHAR(10) NOT NULL DEFAULT 'cron' CHECK (origen IN ('cron', 'manual')),
    creado     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notificado BOOLEAN NOT NULL DEFAULT FALSE,             -- el push de las 7:00 ya salió (el cron reintenta si es false)
    PRIMARY KEY (user_id, fecha)                           -- idempotencia: un brief por usuario y día
);

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS briefs_select_own ON briefs;
CREATE POLICY briefs_select_own ON briefs FOR SELECT USING (user_id = auth.uid());
-- Sin políticas de escritura: solo el rol de servicio (edge function) inserta. Además se quitan los permisos.
REVOKE INSERT, UPDATE, DELETE ON briefs FROM anon, authenticated;

-- ------------------------------------------------------------
-- Cron diario
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Idempotente: si el job ya existe se reemplaza.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wabid-brief') THEN
        PERFORM cron.unschedule('wabid-brief');
    END IF;

    PERFORM cron.schedule(
        'wabid-brief',
        '0 12 * * *',
        $job$
        SELECT net.http_post(
            url := 'https://rrhyyclltgaecfyertqh.supabase.co/functions/v1/brief?forceFunctionRegion=us-west-2',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-brief-secret', COALESCE(
                    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'brief_cron_secret'), '')
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 60000
        );
        $job$
    );
END $$;
