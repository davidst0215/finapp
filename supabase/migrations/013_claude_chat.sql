-- ============================================================
-- MIGRATION 013: claude-code como chat
-- La pestaña Claude Code pasa a ser una lista de conversaciones; cada sesión es un chat. Para pintar la conversación:
--   1. los eventos aceptan el tipo 'user_prompt' (lo que David escribe en la laptop, hook UserPromptSubmit);
--   2. el texto del evento sube de 300 a 2000 caracteres (la respuesta completa de Claude al fin de cada turno);
--   3. la sesión recuerda quién habló último (vista previa de la lista);
--   4. el texto de un mensaje enviado desde el celular YA NO se borra al entregarlo (solo al vencer sin entregar):
--      sin él, el chat mostraría "mensaje enviado" en vez de lo que David escribió.
-- Requiere 008 y 012. Aplicar ANTES de desplegar la nueva versión de claude-events (los eventos viejos siguen valiendo).
-- Retención: la poda existente (eventos 14 días, mensajes ahora también 14 días; ver LIMITS.retention en handlers.ts).
-- ============================================================

-- Quita los CHECK de una tabla cuya definición contiene `needle` (los CHECK en línea de 008/012 no tienen nombre fijo).
CREATE OR REPLACE FUNCTION pg_temp.drop_checks(tbl regclass, needle text) RETURNS void AS $$
DECLARE c record;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = tbl AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%' || needle || '%'
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, c.conname);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 1 y 2. Eventos: tipo nuevo y texto largo
-- ------------------------------------------------------------
SELECT pg_temp.drop_checks('claude_events', 'permission_request');
ALTER TABLE claude_events DROP CONSTRAINT IF EXISTS claude_events_kind_check;  -- idempotente: si ya corrió, el de arriba también la quitó
ALTER TABLE claude_events
    ADD CONSTRAINT claude_events_kind_check CHECK (kind IN (
        'session_start', 'session_end', 'stop', 'stop_failure', 'notification', 'permission_request', 'user_prompt'
    ));

ALTER TABLE claude_events ALTER COLUMN summary TYPE VARCHAR(2000);

-- ------------------------------------------------------------
-- 3. Quién habló último en la sesión (vista previa de la lista de conversaciones)
-- ------------------------------------------------------------
ALTER TABLE claude_sessions
    ADD COLUMN IF NOT EXISTS last_role VARCHAR(8) CHECK (last_role IN ('usuario', 'claude'));

-- ------------------------------------------------------------
-- 4. Mensajes del celular: el texto se conserva tras la entrega
--    Antes: texto presente SOLO en cola/entregando. Ahora: obligatorio mientras está en cola/entregando y
--    ausente solo si venció sin entregarse (los ya entregados antes de esta migración quedan sin texto).
-- ------------------------------------------------------------
SELECT pg_temp.drop_checks('claude_messages', 'body IS NOT NULL');
ALTER TABLE claude_messages
    DROP CONSTRAINT IF EXISTS claude_messages_body_queued_check,
    DROP CONSTRAINT IF EXISTS claude_messages_body_expired_check;  -- idempotente: se pueden volver a correr los ADD de abajo
ALTER TABLE claude_messages
    ADD CONSTRAINT claude_messages_body_queued_check CHECK (status NOT IN ('en_cola', 'entregando') OR body IS NOT NULL),
    ADD CONSTRAINT claude_messages_body_expired_check CHECK (status <> 'vencido' OR body IS NULL);

COMMENT ON COLUMN claude_messages.body IS 'Texto de David. Se conserva tras la entrega (lo muestra el chat) hasta la poda; se borra al vencer sin entregar. Sin permiso de lectura para authenticated: lo sirve la función.';
