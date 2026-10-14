-- ============================================================
-- MIGRATION 020: agent_trazas (qué dijo David, qué entendió el agente y qué pasó)
-- Para saber DÓNDE se rompe un pedido: el texto dictado, la herramienta que eligió el modelo, los argumentos que armó, la
-- respuesta y los tiempos. Los logs de la función no sirven para eso: no llevan contenido (a propósito) y se pierden en un día.
-- Datos personales de David: RLS por usuario, nada para el rol anónimo y retención de 30 días (limpieza diaria con pg_cron).
-- La función `agent` escribe con el JWT de David, así que las políticas de aquí son la única barrera. Los teléfonos NO se guardan:
-- la función enmascara todo tramo de 6 o más dígitos y no guarda el argumento `telefono` (_shared/traza.ts).
-- Idempotente (IF NOT EXISTS / DROP POLICY IF EXISTS): se puede aplicar dos veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_trazas (
    traza_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Como en 011/018: el default completa el dueño con el JWT y la política RLS lo valida.
    user_id    UUID NOT NULL DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    texto      TEXT NOT NULL,           -- lo que dijo o escribió David (el dictado ya transcrito), números enmascarados
    fn         TEXT,                    -- herramienta que eligió el modelo ("(inservible)" si no hubo una usable)
    args       JSONB,                   -- argumentos que armó el modelo, sin teléfonos
    resultado  TEXT,                    -- ToolResult.action: create_transaction, clarify, error…
    mensaje    TEXT,                    -- lo que se le respondió en pantalla
    error      TEXT,                    -- modelo_502, inservible, tool_desconocida:x, excepcion:…; NULL si salió bien
    prov       TEXT,                    -- proveedor del modelo que respondió
    respaldo   BOOLEAN NOT NULL DEFAULT FALSE,
    voz        BOOLEAN NOT NULL DEFAULT FALSE,
    voz_chars  INTEGER,                 -- lo que se mandó (y cobró) a ElevenLabs
    medidas    JSONB                    -- ms por fase (auth, ctx, llm, tool, total) y tokens (tok_in, tok_cache, tok_out)
);

CREATE INDEX IF NOT EXISTS idx_agent_trazas_user_fecha ON agent_trazas(user_id, created_at DESC);

ALTER TABLE agent_trazas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_trazas_all_own ON agent_trazas;
CREATE POLICY agent_trazas_all_own ON agent_trazas
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Sin sesión no hay acceso, ni siquiera a la estructura.
REVOKE ALL ON agent_trazas FROM anon;

-- Retención: 30 días. Solo si pg_cron está instalado (en producción lo está; en una base de pruebas puede no estarlo).
-- cron.schedule con el mismo nombre actualiza el trabajo, así que volver a aplicar esta migración no lo duplica.
DO $$
BEGIN
    IF to_regnamespace('cron') IS NOT NULL THEN
        PERFORM cron.schedule(
            'wabid-trazas-limpiar',
            '17 6 * * *',
            $cmd$DELETE FROM public.agent_trazas WHERE created_at < NOW() - INTERVAL '30 days'$cmd$
        );
    END IF;
END
$$;
