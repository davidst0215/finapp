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
    ADD COLUMN IF NOT EXISTS resume_task_id UUID,   -- sin llave foránea a propósito: se reclama el mensaje ANTES de insertar la tarea (el reclamo es lo atómico)
    ADD COLUMN IF NOT EXISTS error          VARCHAR(300);

ALTER TABLE claude_messages DROP CONSTRAINT IF EXISTS claude_messages_status_check;  -- el CHECK en línea de 012 (nombre por defecto)
ALTER TABLE claude_messages
    ADD CONSTRAINT claude_messages_status_check CHECK (status IN ('en_cola', 'entregando', 'entregado', 'vencido', 'retomando', 'no_retomado'));

-- Candidatos a retomar: en cola, por dispositivo, los más viejos primero.
CREATE INDEX IF NOT EXISTS idx_claude_messages_device_queue
    ON claude_messages(device_id, created_at) WHERE status = 'en_cola';

-- 3. Sesiones
ALTER TABLE claude_sessions ADD COLUMN IF NOT EXISTS continued_from VARCHAR(100);

COMMENT ON COLUMN claude_messages.resume_task_id IS 'Tarea del runner que retoma la sesión con este mensaje (status retomando/entregado/no_retomado).';
COMMENT ON COLUMN claude_sessions.continued_from IS 'Sesión original de la que se bifurcó esta (retomar con --fork-session).';
