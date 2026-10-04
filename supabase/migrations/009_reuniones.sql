-- ============================================================
-- MIGRATION 009: caché de reuniones de Fathom
-- Fathom es la fuente de verdad; aquí queda una copia de lectura (resumen, action items, invitados)
-- para que la app y el agente respondan sin llamar a Fathom en cada pregunta. NO se guarda la
-- transcripción. Wabid no convierte action items en tareas: eso lo hace el pipeline nocturno de Norte.
--
-- Escritura: solo la edge function `fathom` con el rol de servicio, después de comprobar que quien llama
-- es el dueño (WABID_OWNER_ID). Por eso no hay políticas de INSERT/UPDATE/DELETE: con RLS activa y sin
-- política, el cliente (anon key + JWT) no puede insertar ni falsificar reuniones. El rol de servicio
-- salta RLS. Lectura: cada usuario ve solo lo suyo.
-- ============================================================

CREATE TABLE IF NOT EXISTS fathom_meetings (
    user_id       UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    recording_id  BIGINT      NOT NULL,                 -- id de la grabación en Fathom
    titulo        TEXT        NOT NULL DEFAULT '',
    inicio        TIMESTAMPTZ NOT NULL,                 -- inicio de la grabación (o el agendado, o created_at)
    duracion_min  INTEGER,                              -- minutos; NULL si Fathom no dio inicio y fin
    invitados     JSONB       NOT NULL DEFAULT '[]',    -- [{ "name", "email", "externo" }]
    resumen       TEXT        NOT NULL DEFAULT '',      -- markdown de Fathom
    action_items  JSONB       NOT NULL DEFAULT '[]',    -- [{ "texto", "dueno", "hecho", "url" }]
    share_url     TEXT,
    creada_en     TIMESTAMPTZ NOT NULL,                 -- created_at de Fathom: es el cursor de la sincronización
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, recording_id)
);

CREATE INDEX IF NOT EXISTS idx_fathom_meetings_inicio ON fathom_meetings (user_id, inicio DESC);
CREATE INDEX IF NOT EXISTS idx_fathom_meetings_creada ON fathom_meetings (user_id, creada_en DESC);

ALTER TABLE fathom_meetings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fathom_meetings_select_own ON fathom_meetings;
CREATE POLICY fathom_meetings_select_own ON fathom_meetings FOR SELECT USING (user_id = auth.uid());

-- Esperas que ya se avisaron (una sola vez por espera). `clave` = quién + texto normalizado de la tarea:
-- no se usa path/línea porque cambian cuando se edita el vault.
CREATE TABLE IF NOT EXISTS fathom_avisos (
    user_id    UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    clave      TEXT        NOT NULL,
    avisado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, clave)
);

ALTER TABLE fathom_avisos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fathom_avisos_select_own ON fathom_avisos;
CREATE POLICY fathom_avisos_select_own ON fathom_avisos FOR SELECT USING (user_id = auth.uid());
-- Solo escribe la función `fathom` (rol de servicio) en estas tablas.

-- Estado de la sincronización. `complete_until` solo avanza cuando una corrida TERMINA: hasta ahí no
-- falta ninguna reunión. Mientras una corrida está cortada (tope de páginas o de tiempo, error, pestaña
-- cerrada) quedan guardados `en_curso_desde`/`en_curso_antes`/`objetivo` y la siguiente continúa desde ahí.
CREATE TABLE IF NOT EXISTS fathom_sync_estado (
    user_id         UUID        PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    complete_until  TIMESTAMPTZ,
    en_curso_desde  TIMESTAMPTZ,
    en_curso_antes  TIMESTAMPTZ,
    objetivo        TIMESTAMPTZ,                       -- inicio de la corrida en curso: será el nuevo complete_until
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE fathom_sync_estado ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fathom_sync_estado_select_own ON fathom_sync_estado;
CREATE POLICY fathom_sync_estado_select_own ON fathom_sync_estado FOR SELECT USING (user_id = auth.uid());
