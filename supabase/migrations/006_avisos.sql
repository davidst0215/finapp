-- ============================================================
-- MIGRATION 006: avisos (suscripciones Web Push)
-- Un dispositivo o navegador = una fila. La función `push` las crea y borra
-- (cliente de servicio, tras validar el endpoint) y _shared/notify.ts las lee
-- para enviar cada aviso. Requiere la migración 004 (notifications).
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    endpoint        TEXT NOT NULL,                       -- URL del push service: identifica al dispositivo
    p256dh          TEXT NOT NULL,                       -- clave pública del navegador (base64url, 65 bytes)
    auth            TEXT NOT NULL,                       -- secreto de autenticación (base64url, 16 bytes)
    user_agent      VARCHAR(300),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- alta
    last_ok_at      TIMESTAMPTZ,                         -- último envío aceptado por el push service
    failures        INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0), -- fallos seguidos desde el último envío bueno
    CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- El usuario solo ve las suyas. No hay políticas de INSERT/UPDATE/DELETE a propósito: el servidor hace POST
-- al endpoint al enviar, así que solo la función `push` (que valida que sea un push service conocido) escribe aquí.
-- Si un cliente pudiera insertar filas directamente, podría apuntar el envío a una dirección interna (SSRF).
DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON push_subscriptions
    FOR SELECT USING (user_id = auth.uid());
