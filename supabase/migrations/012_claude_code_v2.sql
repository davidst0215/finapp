-- ============================================================
-- MIGRATION 012: claude-code v2 (responder desde el celular + lanzar tareas)
-- Ver SPEC-claude-code-v2.md. Requiere 008. Aplicar ANTES de desplegar la nueva versión de claude-events.
--
-- Igual que 008: todas las escrituras las hace la edge function (llave de servicio) y solo después de
-- comprobar que el usuario del JWT es el dueño (WABID_OWNER_ID). Los clientes solo pueden LEER lo suyo.
-- ============================================================

-- ------------------------------------------------------------
-- Runner de tareas: nombres de proyecto que reporta la laptop (nunca rutas) y último contacto
-- ------------------------------------------------------------
ALTER TABLE claude_devices
    ADD COLUMN IF NOT EXISTS runner_projects JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS runner_seen_at  TIMESTAMPTZ;

GRANT SELECT (runner_projects, runner_seen_at) ON claude_devices TO authenticated;

-- ------------------------------------------------------------
-- Mensajes del celular a una sesión. El texto SOLO existe mientras el mensaje está en cola:
-- al entregarse o vencer se borra (el CHECK lo garantiza). Tras la entrega el texto ya vive en la
-- transcripción local de Claude Code; guardarlo en la nube no aporta nada.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_messages (
    message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id    VARCHAR(100) NOT NULL,
    device_id     UUID NOT NULL REFERENCES claude_devices(device_id) ON DELETE CASCADE,
    body          VARCHAR(2000),
    status        VARCHAR(10) NOT NULL DEFAULT 'en_cola'
                      CHECK (status IN ('en_cola', 'entregado', 'vencido')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    delivered_at  TIMESTAMPTZ,
    FOREIGN KEY (user_id, session_id) REFERENCES claude_sessions(user_id, session_id) ON DELETE CASCADE,
    CHECK ((status = 'en_cola') = (body IS NOT NULL)),               -- texto solo mientras está en cola
    CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000),
    CHECK ((status = 'entregado') = (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_claude_messages_queue
    ON claude_messages(user_id, session_id, created_at) WHERE status = 'en_cola';
CREATE INDEX IF NOT EXISTS idx_claude_messages_recent
    ON claude_messages(user_id, created_at DESC);

-- ------------------------------------------------------------
-- Tareas nuevas lanzadas desde el celular (las ejecuta wabid-runner.mjs en la laptop)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_tasks (
    task_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id         UUID NOT NULL REFERENCES claude_devices(device_id) ON DELETE CASCADE,
    project           VARCHAR(60) NOT NULL,                  -- nombre de la allowlist local, no una ruta
    prompt            VARCHAR(4000) NOT NULL CHECK (char_length(prompt) >= 1),
    status            VARCHAR(10) NOT NULL DEFAULT 'en_cola'
                          CHECK (status IN ('en_cola', 'ejecutando', 'terminada', 'fallida', 'cancelada', 'rechazada', 'vencida')),
    cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
    session_id        VARCHAR(100),                          -- sesión de Claude Code que abrió la tarea
    progress          VARCHAR(300),                          -- último avance, redactado
    result            VARCHAR(1500),                         -- último mensaje del asistente, redactado
    error             VARCHAR(300),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL,                  -- una tarea en cola que nadie reclamó vence (laptop apagada)
    started_at        TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- latido del runner
    finished_at       TIMESTAMPTZ,
    CHECK ((status IN ('terminada', 'fallida', 'cancelada', 'rechazada', 'vencida')) = (finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_claude_tasks_user_recent ON claude_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_tasks_device_status ON claude_tasks(device_id, status, created_at);

-- ------------------------------------------------------------
-- RLS y privilegios: solo lectura de lo propio. El texto de los mensajes no se lee ni por la API de datos.
-- ------------------------------------------------------------
ALTER TABLE claude_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE claude_tasks    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claude_messages_select_own ON claude_messages;
CREATE POLICY claude_messages_select_own ON claude_messages
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS claude_tasks_select_own ON claude_tasks;
CREATE POLICY claude_tasks_select_own ON claude_tasks
    FOR SELECT USING (user_id = auth.uid());

REVOKE ALL ON claude_messages, claude_tasks FROM anon, authenticated;

GRANT SELECT (message_id, user_id, session_id, device_id, status, created_at, expires_at, delivered_at)
    ON claude_messages TO authenticated;                    -- sin `body`
GRANT SELECT ON claude_tasks TO authenticated;

COMMENT ON TABLE claude_messages IS 'Mensajes de David a una sesión de Claude Code. body solo existe en cola; se borra al entregar o vencer.';
COMMENT ON TABLE claude_tasks    IS 'Tareas lanzadas desde el celular y ejecutadas por wabid-runner.mjs en la laptop (allowlist local).';
