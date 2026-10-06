-- ============================================================
-- MIGRATION 015: memoria de Wabid (catálogo de fichas + búsqueda por palabras que completa con OR)
-- Idempotente: solo CREATE OR REPLACE y GRANT/REVOKE. No toca tablas ni datos.
--
--   vault_catalogo()  una fila por ficha con su "Qué es" (primeros 400 caracteres). Es lo que el agente pone en su
--                     contexto para que la IA ELIJA qué ficha leer. Corre como el usuario que llama (RLS).
--   vault_search()    mismo contrato que en 005. Cambia el relajamiento: antes la búsqueda pasaba a "cualquiera de las
--                     palabras" solo si la estricta (todas) no encontraba NADA; ahora lo hace cuando encuentra MENOS DE 3,
--                     y los resultados que cumplen todas las palabras van primero.
-- Orden de despliegue: indistinto. El agente usa vault_catalogo si existe y, si no, arma el catálogo sin frases.
-- ============================================================

CREATE OR REPLACE FUNCTION vault_catalogo()
RETURNS TABLE (path TEXT, title TEXT, cliente TEXT, proyecto TEXT, que_es TEXT)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    -- Texto bajo "## Qué es" hasta el siguiente "##". (Sin cuantificador no codicioso: en una ARE de Postgres el primer
    -- cuantificador fija la codicia de toda la expresión, y "[ \t]+" lo hace codicioso.)
    SELECT d.path, d.title, d.cliente, d.proyecto,
           left(btrim(regexp_replace(
               regexp_replace(
                   COALESCE(substring(d.content FROM '(?i)(?:^|\n)##[ \t]+qu[eé][ \t]+es[^\n]*\n(.*)'), ''),
                   '\n##.*$', ''),
               '\s+', ' ', 'g')), 400)
    FROM vault_docs d
    WHERE d.user_id = auth.uid() AND d.kind = 'ficha'
    ORDER BY d.path
$$;

CREATE OR REPLACE FUNCTION vault_search(
    p_query   TEXT,
    p_cliente TEXT    DEFAULT NULL,
    p_kinds   TEXT[]  DEFAULT NULL,
    p_limit   INTEGER DEFAULT 8,
    p_context BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
    path TEXT, kind TEXT, title TEXT, cliente TEXT, proyecto TEXT, padre TEXT, tags TEXT[], links TEXT[],
    score REAL, snippet TEXT, context TEXT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_strict tsquery;   -- todas las palabras
    v_q      tsquery;   -- la que filtra: la estricta o, si hay pocos resultados, "cualquiera de las palabras"
    v_alt    tsquery;
    v_n      INTEGER;
    v_kinds  TEXT[] := COALESCE(p_kinds, ARRAY['ficha', 'nota']);
    v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 20);
BEGIN
    v_strict := websearch_to_tsquery('public.vault_es', COALESCE(p_query, '')) || websearch_to_tsquery('pg_catalog.spanish', COALESCE(p_query, ''));
    IF numnode(v_strict) = 0 THEN
        RETURN;    -- vacía o solo palabras vacías ("de la")
    END IF;
    v_q := v_strict;

    -- Sin comillas ni exclusiones (-palabra): ahí el usuario pidió algo exacto y no se relaja.
    IF p_query !~ '(^|\s)-|"' THEN
        SELECT COUNT(*) INTO v_n FROM (
            SELECT 1 FROM vault_docs d
            WHERE d.user_id = auth.uid() AND d.kind = ANY (v_kinds) AND d.search @@ v_strict
              AND (p_cliente IS NULL OR lower(d.cliente) = lower(p_cliente))
            LIMIT 3
        ) c;
        IF v_n < 3 THEN
            v_alt := websearch_to_tsquery('public.vault_es', regexp_replace(btrim(p_query), '\s+', ' or ', 'g'))
                  || websearch_to_tsquery('pg_catalog.spanish', regexp_replace(btrim(p_query), '\s+', ' or ', 'g'));
            IF numnode(v_alt) > 0 THEN
                v_q := v_alt;   -- OR incluye todo lo de la estricta; esos van primero (columna `estricto`)
            END IF;
        END IF;
    END IF;

    RETURN QUERY
    WITH scored AS (   -- el ranking se calcula una sola vez por documento
        SELECT d.path, d.kind, d.title, d.cliente, d.proyecto, d.padre, d.tags, d.links, d.content,
               (d.search @@ v_strict) AS estricto,
               (ts_rank_cd(d.search, v_q, 33) * CASE WHEN d.kind = 'ficha' THEN 1.25 ELSE 1.0 END)::REAL AS rk
        FROM vault_docs d
        WHERE d.user_id = auth.uid() AND d.kind = ANY (v_kinds) AND d.search @@ v_q
          AND (p_cliente IS NULL OR lower(d.cliente) = lower(p_cliente))
    ),
    hits AS (
        SELECT s.*, row_number() OVER (ORDER BY s.estricto DESC, s.rk DESC, s.title) AS rn
        FROM scored s
        ORDER BY s.estricto DESC, s.rk DESC, s.title
        LIMIT v_limit
    )
    SELECT h.path, h.kind, h.title, h.cliente, h.proyecto, h.padre, h.tags, h.links, h.rk,
           ts_headline('public.vault_es', left(h.content, 60000), v_q,
                       'StartSel=⟦, StopSel=⟧, MaxFragments=1, MaxWords=32, MinWords=14'),
           CASE WHEN p_context AND h.rn <= 4 THEN   -- el modelo solo recibe las 4 mejores
               ts_headline('public.vault_es', left(h.content, 60000), v_q,
                           'StartSel=⟦, StopSel=⟧, MaxFragments=3, MaxWords=60, MinWords=25, FragmentDelimiter=" … "')
           END
    FROM hits h
    ORDER BY h.estricto DESC, h.rk DESC, h.title;
END $$;

-- Mismos permisos que el resto del índice: solo usuarios autenticados y el cliente de servicio.
REVOKE EXECUTE ON FUNCTION vault_search(TEXT, TEXT, TEXT[], INTEGER, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION vault_catalogo() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vault_search(TEXT, TEXT, TEXT[], INTEGER, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vault_catalogo() TO authenticated, service_role;
