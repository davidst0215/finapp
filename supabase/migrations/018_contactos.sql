-- ============================================================
-- MIGRATION 018: contactos (la agenda propia de Wabid)
-- "Guarda a Marco con el 999 888 777", "escríbele a Marco que llego tarde", "llama a Marco". Es una agenda aparte de Google:
-- Google está conectado a la cuenta de trabajo y los contactos personales de David viven en otra.
-- Wabid NO envía mensajes ni llama: arma un enlace (api.whatsapp.com/send o tel:) y David lo toca.
-- Los teléfonos son datos personales de terceros: RLS por usuario y nada para el rol anónimo. El agente (edge function `agent`)
-- lee y escribe con el JWT de David, así que las políticas de aquí son la única barrera; el modelo nunca ve la tabla.
-- Idempotente (IF NOT EXISTS / DROP POLICY IF EXISTS): se puede aplicar dos veces. Numerada 018: 016 (saldos), 017 (avisos)
-- y 019 (memoria) están reservadas a las ramas que corren en paralelo.
-- ============================================================

CREATE TABLE IF NOT EXISTS contactos (
    contacto_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Como en 011: el default completa el dueño con el JWT y la política RLS lo valida; el rol de servicio manda user_id explícito.
    user_id     UUID NOT NULL DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    nombre      VARCHAR(100) NOT NULL CHECK (btrim(nombre) <> ''),
    -- Apodos con que David nombra a la persona ("mamá", "el dentista"). Hasta 10; la app los recorta a 60 letras cada uno.
    alias       TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(alias) <= 10 AND char_length(array_to_string(alias, '|')) <= 600),
    -- E.164 estricto: "+" y 8 a 15 dígitos sin cero inicial. Lo normaliza la app (Perú por defecto) antes de guardar.
    telefono    VARCHAR(16) NOT NULL CHECK (telefono ~ '^\+[1-9][0-9]{7,14}$'),
    -- Quién es, en pocas palabras ("de Saya", "mi primo"): distingue a dos Marco cuando Wabid pregunta cuál.
    relacion    VARCHAR(100) CHECK (relacion IS NULL OR btrim(relacion) <> ''),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un mismo número no se guarda dos veces por usuario: importar dos veces desde el celular no duplica.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactos_user_telefono ON contactos(user_id, telefono);
CREATE INDEX IF NOT EXISTS idx_contactos_user_nombre ON contactos(user_id, lower(nombre));

ALTER TABLE contactos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contactos_all_own ON contactos;
CREATE POLICY contactos_all_own ON contactos
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Sin sesión no hay acceso, ni siquiera a la estructura.
REVOKE ALL ON contactos FROM anon;
