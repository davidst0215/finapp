-- ============================================================
-- MIGRATION 019: memoria personal de Wabid (lo que David pidió recordar)
-- «Recuerda que mi tarjeta principal es la BBVA», «Marco es de Saya», «olvida lo de la tarjeta».
-- Idempotente: CREATE ... IF NOT EXISTS, políticas recreadas y GRANT/REVOKE. No toca datos de otras tablas.
--
--   wabid_hechos   una fila por recuerdo: una frase de hasta 200 caracteres y, si David la dio, una categoría.
--                  El agente (edge function `agent`, con el JWT de David) lee, inserta, actualiza y borra sus filas:
--                  RLS deja a cada usuario SOLO las suyas, y `anon` no ve nada.
--
-- Qué NO hace (a propósito): no impide que dos recuerdos se contradigan. Decidir si un dato nuevo reemplaza a uno viejo lo hace el
-- agente (con los recuerdos a la vista). La base solo evita el duplicado literal: la misma frase, sin importar mayúsculas.
-- Orden de despliegue: indistinto. Sin esta tabla el agente funciona igual, sin recuerdos (registra el error y sigue).
-- ============================================================

CREATE TABLE IF NOT EXISTS wabid_hechos (
    hecho_id    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID         NOT NULL DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    texto       VARCHAR(200) NOT NULL CHECK (btrim(texto) <> ''),
    categoria   VARCHAR(40),
    creado      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actualizado TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- El mismo texto dos veces (dos pedidos casi a la vez) no entra: el segundo recibe 23505 y el agente lo toma como «ya lo sabía».
CREATE UNIQUE INDEX IF NOT EXISTS wabid_hechos_texto_uq ON wabid_hechos (user_id, lower(texto));
-- «Los más recientes primero», que es como los lee el contexto del agente.
CREATE INDEX IF NOT EXISTS wabid_hechos_recientes_idx ON wabid_hechos (user_id, actualizado DESC, creado DESC);

ALTER TABLE wabid_hechos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wabid_hechos_all_own ON wabid_hechos;
CREATE POLICY wabid_hechos_all_own ON wabid_hechos FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON wabid_hechos FROM PUBLIC, anon, authenticated;   -- parte de cero: los privilegios por defecto de Supabase incluyen TRUNCATE
GRANT SELECT, INSERT, UPDATE, DELETE ON wabid_hechos TO authenticated;
GRANT ALL ON wabid_hechos TO service_role;

COMMENT ON TABLE wabid_hechos IS 'Recuerdos que David pidió a Wabid. Datos del usuario: el agente los pone en el contexto como datos, nunca como instrucciones.';
