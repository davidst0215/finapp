-- ============================================================
-- MIGRATION 007: módulo google (agenda con Calendar, correo con Gmail)
-- Cuentas de Google conectadas por OAuth y sus tokens.
--
-- Quién lee qué:
--   * google_accounts: correo, permisos concedidos y estado de la conexión. David las lee (RLS);
--     solo las edge functions (cliente de servicio) escriben.
--   * google_tokens: apunta a un secreto de Supabase Vault. Sin políticas RLS y sin privilegios para
--     anon/authenticated: el cliente jamás lo ve. El token vive cifrado en vault.secrets.
--   * Los tokens se leen y escriben solo con google_token_get / google_token_put
--     (SECURITY DEFINER, EXECUTE únicamente para service_role).
--
-- ¿Por qué Vault y no pgcrypto?
--   pgcrypto cifra bien, pero necesita una llave simétrica en algún lugar. Guardada en la base sería
--   decorativa (quien lee la tabla lee la llave). Pasada en cada consulta queda expuesta en logs de
--   errores y a quien tenga acceso SQL. Vault usa cifrado autenticado (libsodium) con una llave que
--   Supabase guarda fuera de la base: ni un volcado, ni un backup, ni un `select *` de estas tablas
--   muestran un token. Y no hay una variable de entorno más que cuidar.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

-- Falla temprano y claro si Vault no está disponible (en vez de fallar al primer login de Google).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'vault' AND p.proname = 'create_secret'
    ) THEN
        RAISE EXCEPTION 'Falta Supabase Vault: habilita la extensión supabase_vault (Database > Extensions) y repite la migración.';
    END IF;
END
$$;

-- ============================================================
-- TABLA: google_accounts
-- Una fila por cuenta de Google conectada. Hoy se usa una (david@sayainvestments.co),
-- pero el esquema admite más sin migrar.
-- ============================================================
CREATE TABLE IF NOT EXISTS google_accounts (
    account_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    google_sub        VARCHAR(64) NOT NULL,            -- id estable de la cuenta en Google (claim "sub")
    email             VARCHAR(320) NOT NULL,
    scopes            TEXT[] NOT NULL DEFAULT '{}',    -- permisos realmente concedidos (Google deja desmarcar alguno)
    status            VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    access_expires_at TIMESTAMPTZ,                     -- vencimiento del access token vigente (informativo)
    last_error        VARCHAR(200),                    -- por qué dejó de funcionar (p. ej. invalid_grant)
    connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, google_sub)
);

CREATE INDEX IF NOT EXISTS idx_google_accounts_user_active
    ON google_accounts(user_id, connected_at DESC) WHERE status = 'active';

ALTER TABLE google_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS google_accounts_select_own ON google_accounts;
CREATE POLICY google_accounts_select_own ON google_accounts
    FOR SELECT USING (user_id = auth.uid());
-- Sin políticas de escritura: solo las edge functions (service_role) crean o cambian filas.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON google_accounts FROM anon, authenticated;

-- ============================================================
-- TABLA: google_tokens
-- Puntero al secreto cifrado en Vault. El secreto es un JSON con el refresh_token y, mientras
-- sea válido, el access_token y su vencimiento. NUNCA se expone al cliente.
-- ============================================================
CREATE TABLE IF NOT EXISTS google_tokens (
    account_id UUID PRIMARY KEY REFERENCES google_accounts(account_id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    secret_id  UUID NOT NULL,                          -- id del secreto en vault.secrets
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS activo y ninguna política = ningún rol de cliente lee ni escribe. El REVOKE lo refuerza.
ALTER TABLE google_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON google_tokens FROM anon, authenticated;

-- ============================================================
-- Acceso a los tokens (solo service_role)
-- ============================================================

-- Guarda o reemplaza los tokens de una cuenta. p_payload es el JSON en texto.
CREATE OR REPLACE FUNCTION google_token_put(p_account_id UUID, p_user_id UUID, p_payload TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_secret_id UUID;
BEGIN
    -- Bloquea la cuenta: dos escrituras simultáneas (renovación + reconexión) no crean dos secretos.
    PERFORM 1 FROM public.google_accounts a
    WHERE a.account_id = p_account_id AND a.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cuenta de Google no encontrada';
    END IF;

    SELECT t.secret_id INTO v_secret_id
    FROM public.google_tokens t
    WHERE t.account_id = p_account_id;

    IF v_secret_id IS NULL THEN
        v_secret_id := vault.create_secret(
            p_payload,
            'google_tokens:' || p_account_id::TEXT,
            'Tokens OAuth de Google (Wabid)'
        );
        INSERT INTO public.google_tokens (account_id, user_id, secret_id)
        VALUES (p_account_id, p_user_id, v_secret_id);
    ELSE
        PERFORM vault.update_secret(v_secret_id, p_payload);
        UPDATE public.google_tokens SET updated_at = NOW() WHERE account_id = p_account_id;
    END IF;
END;
$$;

-- Devuelve el JSON descifrado de los tokens de una cuenta (NULL si no existe).
CREATE OR REPLACE FUNCTION google_token_get(p_account_id UUID, p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload TEXT;
BEGIN
    SELECT s.decrypted_secret INTO v_payload
    FROM public.google_tokens t
    JOIN vault.decrypted_secrets s ON s.id = t.secret_id
    WHERE t.account_id = p_account_id AND t.user_id = p_user_id;

    RETURN v_payload;
END;
$$;

-- Al borrar una cuenta (o sus tokens) se borra también el secreto: no quedan huérfanos en Vault.
CREATE OR REPLACE FUNCTION google_token_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM vault.secrets WHERE id = OLD.secret_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_google_tokens_cleanup ON google_tokens;
CREATE TRIGGER trg_google_tokens_cleanup
    AFTER DELETE ON google_tokens
    FOR EACH ROW EXECUTE FUNCTION google_token_cleanup();

-- Por defecto las funciones de public son llamables por anon y authenticated (vía /rest/v1/rpc).
-- Estas NO: quien las llame lee tokens. Solo el cliente de servicio.
REVOKE ALL ON FUNCTION google_token_put(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION google_token_get(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION google_token_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION google_token_put(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION google_token_get(UUID, UUID) TO service_role;
