-- ============================================================
-- MIGRATION 004: bandeja de notificaciones de Wabid
-- Cada módulo avisa insertando aquí (vía _shared/notify.ts).
-- El módulo `avisos` agrega el envío push sobre esta misma tabla.
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    kind            VARCHAR(30) NOT NULL CHECK (kind IN (
                        'brief', 'pago', 'tarea', 'espera', 'agenda', 'correo', 'claude', 'sistema'
                    )),
    title           VARCHAR(120) NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    url             VARCHAR(300),            -- ruta de la app a abrir al tocar el aviso
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at         TIMESTAMPTZ,
    pushed_at       TIMESTAMPTZ               -- lo llena el módulo avisos al enviar el push
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_select_own ON notifications
    FOR SELECT USING (user_id = auth.uid());
CREATE POLICY notifications_update_own ON notifications
    FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- Los inserts los hacen las edge functions con el cliente de servicio.
