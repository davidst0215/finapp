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

-- Un mismo número no se guarda dos veces por usuario: importar dos veces desde el celular no duplica. Es el único índice además de
-- la llave: la app lee todos los contactos del usuario (hasta 2000) y el nombre se compara en memoria, así que otro índice no se usaría.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contactos_user_telefono ON contactos(user_id, telefono);

ALTER TABLE contactos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contactos_all_own ON contactos;
CREATE POLICY contactos_all_own ON contactos
    FOR ALL TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Sin sesión no hay acceso, ni siquiera a la estructura.
REVOKE ALL ON contactos FROM anon;

-- Tope de 1000 contactos por usuario. Es el `max_rows` de PostgREST en producción: una lectura (la de la web y la de Wabid por
-- voz) trae la agenda completa; con más de 1000 filas el resultado se recortaría en silencio y Wabid "olvidaría" contactos.
-- El trigger corre como quien inserta (RLS: solo cuenta los suyos) y ve las filas que el mismo INSERT ya agregó, así que un lote
-- que se pasa falla completo. 23514 = check_violation: la app lo reconoce y avisa en vez de mostrar un error técnico.
CREATE OR REPLACE FUNCTION contactos_tope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT count(*) FROM contactos WHERE user_id = NEW.user_id) >= 1000 THEN
        RAISE EXCEPTION 'contactos: tope de 1000 por usuario' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contactos_tope ON contactos;
CREATE TRIGGER contactos_tope BEFORE INSERT ON contactos
    FOR EACH ROW EXECUTE FUNCTION contactos_tope();
