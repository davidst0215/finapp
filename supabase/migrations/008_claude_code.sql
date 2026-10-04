-- ============================================================
-- MIGRATION 008: módulo claude-code de Wabid
-- Supervisión privada de las sesiones de Claude Code de David desde el celular.
-- Flujo: hooks locales en la laptop -> edge function claude-events -> celular.
-- Nada pasa por claude.ai ni por Remote Control: la cuenta de Claude Code se comparte con otra persona.
--
-- Todas las escrituras las hace la edge function con la llave de servicio. Los clientes (anon/authenticated)
-- solo pueden LEER sus propias filas y nunca ven el hash del token de dispositivo.
-- Los comandos y resúmenes llegan ya recortados y con secretos redactados (la función lo vuelve a hacer
-- antes de guardar); aquí solo se fijan los largos máximos.
-- ============================================================

-- ------------------------------------------------------------
-- Dispositivos emparejados (cada laptop que manda eventos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_devices (
    device_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name               VARCHAR(60) NOT NULL,
    token_hash         CHAR(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- SHA-256 del secreto del token; el token nunca se guarda
    approvals_enabled  BOOLEAN NOT NULL DEFAULT FALSE,                            -- modo ausente: aprobar permisos desde el celular
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_claude_devices_user
    ON claude_devices(user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------
-- Sesiones de Claude Code (una por session_id que entrega el hook)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_sessions (
    user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id     VARCHAR(100) NOT NULL,
    device_id      UUID NOT NULL REFERENCES claude_devices(device_id) ON DELETE CASCADE,
    project        VARCHAR(100) NOT NULL DEFAULT '',        -- carpeta de trabajo (o repo + worktree)
    cwd            VARCHAR(300),                            -- con el home colapsado a ~
    status         VARCHAR(12) NOT NULL DEFAULT 'trabajando'
                       CHECK (status IN ('trabajando', 'esperando', 'terminada', 'error')),
    last_summary   VARCHAR(300),                            -- último mensaje de Claude / error, ya redactado
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_event_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at       TIMESTAMPTZ,
    PRIMARY KEY (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_claude_sessions_recent
    ON claude_sessions(user_id, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_claude_sessions_device
    ON claude_sessions(device_id, started_at DESC);        -- tope de sesiones nuevas por hora y borrado en cascada

-- ------------------------------------------------------------
-- Eventos (línea de tiempo de cada sesión)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_events (
    event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    session_id  VARCHAR(100) NOT NULL,
    device_id   UUID NOT NULL REFERENCES claude_devices(device_id) ON DELETE CASCADE,
    kind        VARCHAR(20) NOT NULL CHECK (kind IN (
                    'session_start', 'session_end', 'stop', 'stop_failure', 'notification', 'permission_request'
                )),
    detail      VARCHAR(60),                                -- fuente, motivo, tipo de aviso o de error
    summary     VARCHAR(300) NOT NULL DEFAULT '',           -- resumen corto en español
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id, session_id) REFERENCES claude_sessions(user_id, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_claude_events_session
    ON claude_events(user_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_events_device_recent
    ON claude_events(device_id, created_at DESC);          -- tope de eventos por minuto

-- ------------------------------------------------------------
-- Aprobaciones de permiso (Claude pide permiso -> David aprueba o rechaza desde el celular)
-- Vencen solas (la función fija expires_at a ~2 min) para no dejar colgado a Claude Code.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_approvals (
    approval_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id          UUID NOT NULL REFERENCES claude_devices(device_id) ON DELETE CASCADE,
    session_id         VARCHAR(100) NOT NULL,
    project            VARCHAR(100) NOT NULL DEFAULT '',
    tool_name          VARCHAR(100) NOT NULL,
    description        VARCHAR(200),                        -- lo que Claude dice que hace; es solo una pista, no una garantía
    preview            VARCHAR(3000) NOT NULL,              -- comando o vista previa, recortado y con secretos redactados
    preview_truncated  BOOLEAN NOT NULL DEFAULT FALSE,
    status             VARCHAR(10) NOT NULL DEFAULT 'pendiente'
                           CHECK (status IN ('pendiente', 'aprobada', 'denegada', 'vencida')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ NOT NULL,
    decided_at         TIMESTAMPTZ,                         -- cuándo se aprobó, rechazó o venció
    decided_by         UUID REFERENCES users(user_id) ON DELETE SET NULL,  -- quién; NULL si venció sola
    FOREIGN KEY (user_id, session_id) REFERENCES claude_sessions(user_id, session_id) ON DELETE CASCADE,
    CHECK ((status = 'pendiente') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_claude_approvals_user_status
    ON claude_approvals(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claude_approvals_device
    ON claude_approvals(device_id, status);                 -- tope de pendientes por dispositivo y borrado en cascada

-- ------------------------------------------------------------
-- RLS: cada usuario solo lee lo suyo. Sin políticas de escritura: escribe la edge function (llave de servicio).
-- ------------------------------------------------------------
ALTER TABLE claude_devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE claude_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE claude_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE claude_approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claude_devices_select_own ON claude_devices;
CREATE POLICY claude_devices_select_own ON claude_devices
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS claude_sessions_select_own ON claude_sessions;
CREATE POLICY claude_sessions_select_own ON claude_sessions
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS claude_events_select_own ON claude_events;
CREATE POLICY claude_events_select_own ON claude_events
    FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS claude_approvals_select_own ON claude_approvals;
CREATE POLICY claude_approvals_select_own ON claude_approvals
    FOR SELECT USING (user_id = auth.uid());

-- ------------------------------------------------------------
-- Privilegios: defensa en profundidad sobre RLS.
-- - anon no toca nada; authenticated solo lee.
-- - claude_devices se lee por columnas: token_hash no sale por la API de datos aunque falle una política.
--   (Con privilegios por columna, un `select *` desde el navegador falla: hay que pedir las columnas.)
-- ------------------------------------------------------------
REVOKE ALL ON claude_devices, claude_sessions, claude_events, claude_approvals FROM anon, authenticated;

GRANT SELECT (device_id, user_id, name, approvals_enabled, created_at, last_seen_at, revoked_at)
    ON claude_devices TO authenticated;
GRANT SELECT ON claude_sessions, claude_events, claude_approvals TO authenticated;

COMMENT ON TABLE claude_devices   IS 'Laptops emparejadas con Wabid. Solo se guarda el SHA-256 del secreto del token.';
COMMENT ON TABLE claude_sessions  IS 'Sesiones de Claude Code vistas por los hooks locales.';
COMMENT ON TABLE claude_events    IS 'Línea de tiempo por sesión (resúmenes cortos, sin contenido sensible).';
COMMENT ON TABLE claude_approvals IS 'Permisos que Claude Code pidió y David aprueba o rechaza desde el celular. Vencen solos.';
