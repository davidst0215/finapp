-- ============================================================
-- MIGRATION 014: retomar una sesión quieta o cerrada con el runner de la laptop
-- Un mensaje del celular que sigue 'en_cola' (el hook Stop no llegó porque la sesión está quieta o cerrada) se convierte
-- en una tarea del runner: "retomar la sesión X con este mensaje" (claude -p --resume <id> --fork-session).
--   1. claude_messages: estados nuevos 'retomando' (lo tomó el runner) y 'no_retomado' (no se pudo), con la tarea que lo lleva
--      y el motivo del fallo. Un mensaje sale de 'en_cola' UNA vez (UPDATE condicional): o lo entrega el hook Stop o el runner.
--   2. claude_tasks: tipo 'resume' (sesión a retomar y carpeta de esa sesión; el runner valida la carpeta contra su allowlist).
--   3. claude_sessions: continued_from = sesión original de la que se bifurcó (el chat muestra "continuación de ...").
-- Requiere 008, 012 y 013. Aplicar ANTES de desplegar la nueva versión de claude-events. Idempotente.
-- ============================================================

-- 2. Tareas
ALTER TABLE claude_tasks
    ADD COLUMN IF NOT EXISTS kind              VARCHAR(8) NOT NULL DEFAULT 'new',
    ADD COLUMN IF NOT EXISTS resume_session_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS resume_cwd        VARCHAR(300);

ALTER TABLE claude_tasks DROP CONSTRAINT IF EXISTS claude_tasks_kind_check;
ALTER TABLE claude_tasks ADD CONSTRAINT claude_tasks_kind_check CHECK (kind IN ('new', 'resume'));
ALTER TABLE claude_tasks DROP CONSTRAINT IF EXISTS claude_tasks_resume_check;
ALTER TABLE claude_tasks ADD CONSTRAINT claude_tasks_resume_check CHECK ((kind = 'resume') = (resume_session_id IS NOT NULL));

-- 1. Mensajes
ALTER TABLE claude_messages
    ADD COLUMN IF NOT EXISTS resume_task_id    UUID,         -- sin llave foránea a propósito: se reclama el mensaje ANTES de insertar la tarea (el reclamo es lo atómico)
    ADD COLUMN IF NOT EXISTS resume_claimed_at TIMESTAMPTZ,  -- cuándo lo reclamó el runner; un 'retomando' sin tarea tras el plazo vuelve a la cola
    ADD COLUMN IF NOT EXISTS error             VARCHAR(300);

-- 'no_retomado' tiene 11 caracteres y 012 declaró status VARCHAR(10): se ensancha (los valores de claude_tasks.status
-- caben en 10 y kind en 8, no se tocan).
ALTER TABLE claude_messages ALTER COLUMN status TYPE VARCHAR(12);

ALTER TABLE claude_messages DROP CONSTRAINT IF EXISTS claude_messages_status_check;  -- el CHECK en línea de 012 (nombre por defecto)
ALTER TABLE claude_messages
    ADD CONSTRAINT claude_messages_status_check CHECK (status IN ('en_cola', 'entregando', 'entregado', 'vencido', 'retomando', 'no_retomado'));

-- Los CHECK de tabla de 012 no tienen nombre. Se retiran por su definición y se recrean CON nombre (idempotente):
--   body:      texto obligatorio mientras espera (en_cola/entregando); 'retomando' lo CONSERVA (si la tarea no se crea, el mensaje
--              vuelve a en_cola con su texto) y se borra solo al vencer.
--   claimed:   claimed_at solo en 'entregando' (el reclamo del hook Stop). El del runner usa resume_claimed_at.
--   delivered: delivered_at solo en 'entregado' (retomando -> entregado lo fija).
DO $$
DECLARE c record;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'claude_messages'::regclass AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%body IS NOT NULL%'
            OR pg_get_constraintdef(oid) LIKE '%claimed_at IS NOT NULL%'
            OR pg_get_constraintdef(oid) LIKE '%delivered_at IS NOT NULL%')
    LOOP
        EXECUTE format('ALTER TABLE claude_messages DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;
ALTER TABLE claude_messages
    ADD CONSTRAINT claude_messages_body_queued_check CHECK (status NOT IN ('en_cola', 'entregando') OR body IS NOT NULL),
    ADD CONSTRAINT claude_messages_claimed_check CHECK ((status = 'entregando') = (claimed_at IS NOT NULL)),
    ADD CONSTRAINT claude_messages_delivered_check CHECK ((status = 'entregado') = (delivered_at IS NOT NULL));

-- Candidatos a retomar: en cola, por dispositivo, los más viejos primero.
CREATE INDEX IF NOT EXISTS idx_claude_messages_device_queue
    ON claude_messages(device_id, created_at) WHERE status = 'en_cola';

-- 3. Sesiones
ALTER TABLE claude_sessions
    ADD COLUMN IF NOT EXISTS continued_from VARCHAR(100),
    ADD COLUMN IF NOT EXISTS start_cwd      VARCHAR(300);   -- carpeta donde NACIÓ la sesión: `claude --resume` busca la conversación ahí (cwd cambia con cada cd)

-- Sesiones anteriores a 014: el cwd guardado es la mejor pista disponible (mejor que el del primer evento tras desplegar).
UPDATE claude_sessions SET start_cwd = cwd WHERE start_cwd IS NULL AND cwd IS NOT NULL;

COMMENT ON COLUMN claude_messages.resume_task_id IS 'Tarea del runner que retoma la sesión con este mensaje (status retomando/entregado/no_retomado).';
COMMENT ON COLUMN claude_sessions.continued_from IS 'Sesión original de la que se bifurcó esta (retomar con --fork-session).';
