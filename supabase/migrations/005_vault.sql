-- ============================================================
-- MIGRATION 005: índice del vault de Obsidian (tareas + memoria)
-- El vault vive en GitHub (repo privado) y es la fuente de verdad. Aquí solo hay un ÍNDICE derivado para
-- que la app no lea GitHub en cada apertura y para buscar en español, rápido y barato:
--   vault_sync   estado de la última sincronización por usuario
--   vault_docs   fichas, notas y pendientes (con tsvector en español sin acentos)
--   vault_tasks  tareas ya parseadas (sintaxis Obsidian Tasks, mismo formato que Norte)
-- Todo lo escribe la edge function `vault`; todo es por usuario (RLS).
-- ============================================================

-- unaccent: "informacion" encuentra "información". En Supabase las extensiones viven en el esquema `extensions`.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- Configuración de búsqueda 'vault_es': primero quita acentos y luego aplica el stemmer en español, así
-- "informacion" encuentra "información". Ojo: el stemmer de Snowball necesita el acento para reconocer
-- "-ción" (singular), por eso el índice y las consultas combinan vault_es con el 'spanish' estándar
-- (que sí lo ve): "facturación" también encuentra "facturaciones" y "facturar".
DO $$
DECLARE
    unaccent_schema TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
        WHERE c.cfgname = 'vault_es' AND n.nspname = 'public'
    ) THEN
        CREATE TEXT SEARCH CONFIGURATION public.vault_es (COPY = pg_catalog.spanish);
        SELECT n.nspname INTO unaccent_schema
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'unaccent';
        EXECUTE format(
            'ALTER TEXT SEARCH CONFIGURATION public.vault_es ALTER MAPPING FOR hword, hword_part, word WITH %I.unaccent, pg_catalog.spanish_stem',
            unaccent_schema
        );
    END IF;
END $$;

-- ------------------------------------------------------------
-- vault_sync: una fila por usuario
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_sync (
    user_id     UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    tree_sha    TEXT,                                  -- sha del árbol de GitHub en la última sincronización completa
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    docs        INTEGER NOT NULL DEFAULT 0,
    tasks       INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- vault_docs: documentos del vault
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_docs (
    user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    path        TEXT NOT NULL,                         -- ruta dentro del repo: 60-wiki/proyectos/x.md
    kind        TEXT NOT NULL CHECK (kind IN ('ficha', 'pendientes', 'nota')),
    title       TEXT NOT NULL,
    cliente     TEXT,
    proyecto    TEXT,
    padre       TEXT,
    estado      TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    links       TEXT[] NOT NULL DEFAULT '{}',          -- destinos de los [[wikilinks]] (fichas relacionadas)
    content     TEXT NOT NULL DEFAULT '',              -- cuerpo sin frontmatter; vacío en pendientes
    sha         TEXT NOT NULL,                         -- sha del blob en GitHub: detecta cambios sin descargar
    actualizado DATE,                                  -- `actualizado` del frontmatter
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search      TSVECTOR,                              -- lo llena el trigger de abajo
    PRIMARY KEY (user_id, path)
);

CREATE INDEX IF NOT EXISTS vault_docs_search_idx ON vault_docs USING GIN (search);
CREATE INDEX IF NOT EXISTS vault_docs_kind_idx ON vault_docs (user_id, kind);
CREATE INDEX IF NOT EXISTS vault_docs_cliente_idx ON vault_docs (user_id, lower(cliente));

-- Título peso A, etiquetas/cliente/proyecto peso B, contenido peso C; cada parte con las dos configuraciones.
-- (Trigger y no columna generada: array_to_string no es IMMUTABLE y las columnas generadas lo exigen.)
CREATE OR REPLACE FUNCTION vault_docs_set_search() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    meta TEXT;
BEGIN
    meta := COALESCE(array_to_string(NEW.tags, ' '), '') || ' ' || COALESCE(NEW.cliente, '') || ' ' || COALESCE(NEW.proyecto, '');
    NEW.search :=
        setweight(to_tsvector('public.vault_es', COALESCE(NEW.title, '')) || to_tsvector('pg_catalog.spanish', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('public.vault_es', meta) || to_tsvector('pg_catalog.spanish', meta), 'B') ||
        setweight(to_tsvector('public.vault_es', COALESCE(NEW.content, '')) || to_tsvector('pg_catalog.spanish', COALESCE(NEW.content, '')), 'C');
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS vault_docs_search_trg ON vault_docs;
CREATE TRIGGER vault_docs_search_trg
    BEFORE INSERT OR UPDATE OF title, tags, cliente, proyecto, content ON vault_docs
    FOR EACH ROW EXECUTE FUNCTION vault_docs_set_search();

-- ------------------------------------------------------------
-- vault_tasks: tareas indexadas (la UI lee de aquí, no de GitHub)
-- `line` es el índice de línea (base 0) en el archivo; al escribir se verifica además `raw`.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_tasks (
    user_id     UUID NOT NULL,
    path        TEXT NOT NULL,
    line        INTEGER NOT NULL,
    folder      TEXT NOT NULL,                         -- carpeta dentro de 20-projects
    raw         TEXT NOT NULL,                         -- línea completa tal como está en el .md
    text        TEXT NOT NULL,                         -- título limpio (sin tags ni emojis de metadata)
    status      TEXT NOT NULL CHECK (status IN ('pending', 'in-progress', 'completed', 'need-help', 'failed')),
    priority    SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),   -- 0 ninguna · 1 bajo · 2 medio · 3 alto
    due         DATE,                                  -- 📅
    scheduled   DATE,                                  -- ⏳
    done_on     DATE,                                  -- ✅
    recurring   TEXT,                                  -- 🔁
    shared      BOOLEAN NOT NULL DEFAULT FALSE,        -- #conjunto
    shared_with TEXT,                                  -- #conjunto/<quien>
    suggest     TEXT,                                  -- #destino/<carpeta> (cajón)
    source      TEXT,                                  -- 'fathom'
    note        TEXT,                                  -- detalle: bullets indentados bajo la tarea
    indent      SMALLINT NOT NULL DEFAULT 0,
    parent_line INTEGER,                               -- subtarea: línea de su tarea de primer nivel
    PRIMARY KEY (user_id, path, line),
    FOREIGN KEY (user_id, path) REFERENCES vault_docs (user_id, path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS vault_tasks_open_idx ON vault_tasks (user_id, status, due);
CREATE INDEX IF NOT EXISTS vault_tasks_folder_idx ON vault_tasks (user_id, folder);

-- ------------------------------------------------------------
-- RLS: cada fila es del usuario que la indexó
-- ------------------------------------------------------------
ALTER TABLE vault_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_sync_all_own ON vault_sync;
DROP POLICY IF EXISTS vault_docs_all_own ON vault_docs;
DROP POLICY IF EXISTS vault_tasks_all_own ON vault_tasks;
CREATE POLICY vault_sync_all_own ON vault_sync FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY vault_docs_all_own ON vault_docs FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY vault_tasks_all_own ON vault_tasks FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ------------------------------------------------------------
-- Una fecha mal escrita en el vault no debe tumbar toda la sincronización.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vault_to_date(p TEXT) RETURNS DATE
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p IS NULL OR p = '' THEN RETURN NULL; END IF;
    RETURN p::date;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END $$;

-- ------------------------------------------------------------
-- vault_apply_sync: aplica un lote del índice de forma atómica.
--   p_docs    [{path, kind, title, cliente, proyecto, padre, estado, tags[], links[], content, sha, actualizado}]
--   p_files   [{path, tasks:[{line, folder, raw, text, status, priority, due, scheduled, done_on, recurring,
--                             shared, shared_with, suggest, source, note, indent, parent_line}]}]
--             reemplaza TODAS las tareas de cada archivo listado
--   p_remove  rutas que ya no existen en el vault (sus tareas caen en cascada)
--   p_tree_sha  si viene, marca la sincronización completa (guarda el sha del árbol y la hora)
-- Corre como el usuario que llama (RLS): `p_user` solo sirve si coincide con auth.uid(); el cliente de servicio
-- (cron de sincronización) lo usa para indexar a nombre del dueño.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION vault_apply_sync(
    p_user     UUID,
    p_docs     JSONB   DEFAULT '[]'::jsonb,
    p_files    JSONB   DEFAULT '[]'::jsonb,
    p_remove   TEXT[]  DEFAULT '{}',
    p_tree_sha TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    f         RECORD;
    n_docs    INTEGER := 0;
    n_tasks   INTEGER := 0;
    n_removed INTEGER := 0;
    n         INTEGER;
BEGIN
    IF COALESCE(array_length(p_remove, 1), 0) > 0 THEN
        DELETE FROM vault_docs WHERE user_id = p_user AND path = ANY (p_remove);
        GET DIAGNOSTICS n_removed = ROW_COUNT;
    END IF;

    INSERT INTO vault_docs (user_id, path, kind, title, cliente, proyecto, padre, estado, tags, links, content, sha, actualizado, indexed_at)
    SELECT p_user, d.path, d.kind, d.title, d.cliente, d.proyecto, d.padre, d.estado,
           COALESCE(d.tags, '{}'), COALESCE(d.links, '{}'), COALESCE(d.content, ''), d.sha, vault_to_date(d.actualizado), NOW()
    FROM jsonb_to_recordset(p_docs) AS d(
        path TEXT, kind TEXT, title TEXT, cliente TEXT, proyecto TEXT, padre TEXT, estado TEXT,
        tags TEXT[], links TEXT[], content TEXT, sha TEXT, actualizado TEXT
    )
    ON CONFLICT (user_id, path) DO UPDATE SET
        kind = EXCLUDED.kind, title = EXCLUDED.title, cliente = EXCLUDED.cliente, proyecto = EXCLUDED.proyecto,
        padre = EXCLUDED.padre, estado = EXCLUDED.estado, tags = EXCLUDED.tags, links = EXCLUDED.links,
        content = EXCLUDED.content, sha = EXCLUDED.sha, actualizado = EXCLUDED.actualizado, indexed_at = NOW();
    GET DIAGNOSTICS n_docs = ROW_COUNT;

    FOR f IN SELECT x.path, x.tasks FROM jsonb_to_recordset(p_files) AS x(path TEXT, tasks JSONB) LOOP
        DELETE FROM vault_tasks WHERE user_id = p_user AND path = f.path;
        INSERT INTO vault_tasks (user_id, path, line, folder, raw, text, status, priority, due, scheduled, done_on, recurring,
                                 shared, shared_with, suggest, source, note, indent, parent_line)
        SELECT p_user, f.path, t.line, t.folder, t.raw, t.text, t.status, COALESCE(t.priority, 0),
               vault_to_date(t.due), vault_to_date(t.scheduled), vault_to_date(t.done_on), t.recurring,
               COALESCE(t.shared, FALSE), t.shared_with, t.suggest, t.source, t.note, COALESCE(t.indent, 0), t.parent_line
        FROM jsonb_to_recordset(f.tasks) AS t(
            line INTEGER, folder TEXT, raw TEXT, text TEXT, status TEXT, priority INTEGER, due TEXT, scheduled TEXT,
            done_on TEXT, recurring TEXT, shared BOOLEAN, shared_with TEXT, suggest TEXT, source TEXT, note TEXT,
            indent INTEGER, parent_line INTEGER
        );
        GET DIAGNOSTICS n = ROW_COUNT;
        n_tasks := n_tasks + n;
    END LOOP;

    IF p_tree_sha IS NOT NULL THEN
        INSERT INTO vault_sync (user_id, tree_sha, synced_at, docs, tasks)
        VALUES (
            p_user, p_tree_sha, NOW(),
            (SELECT COUNT(*) FROM vault_docs WHERE user_id = p_user),
            (SELECT COUNT(*) FROM vault_tasks WHERE user_id = p_user)
        )
        ON CONFLICT (user_id) DO UPDATE SET
            tree_sha = EXCLUDED.tree_sha, synced_at = NOW(), docs = EXCLUDED.docs, tasks = EXCLUDED.tasks;
    END IF;

    RETURN jsonb_build_object('docs', n_docs, 'tasks', n_tasks, 'removed', n_removed);
END $$;

-- ------------------------------------------------------------
-- vault_search: búsqueda en español, sin acentos, con ranking y fragmento.
--   p_query    texto libre (sintaxis tipo buscador: "frase exacta", -excluir, a or b)
--   p_cliente  filtra por cliente (sin distinguir mayúsculas); NULL = todos
--   p_kinds    tipos a buscar; NULL = fichas y notas (los pendientes se consultan como tareas)
--   p_context  true = también devuelve fragmentos largos para que el modelo redacte la respuesta
-- Si la búsqueda estricta (todas las palabras) no encuentra nada, se relaja a "cualquiera de las palabras".
-- Las coincidencias del fragmento vienen entre ⟦ y ⟧.
-- ------------------------------------------------------------
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
    v_q     tsquery;
    v_alt   tsquery;
    v_kinds TEXT[] := COALESCE(p_kinds, ARRAY['ficha', 'nota']);
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 20);
BEGIN
    v_q := websearch_to_tsquery('public.vault_es', COALESCE(p_query, '')) || websearch_to_tsquery('pg_catalog.spanish', COALESCE(p_query, ''));
    IF numnode(v_q) = 0 THEN
        RETURN;    -- vacía o solo palabras vacías ("de la")
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM vault_docs d
        WHERE d.user_id = auth.uid() AND d.kind = ANY (v_kinds) AND d.search @@ v_q
          AND (p_cliente IS NULL OR lower(d.cliente) = lower(p_cliente))
    ) AND p_query !~ '(^|\s)-|"' THEN   -- sin comillas ni exclusiones (-palabra): ahí el usuario pidió algo exacto
        v_alt := websearch_to_tsquery('public.vault_es', regexp_replace(btrim(p_query), '\s+', ' or ', 'g'))
              || websearch_to_tsquery('pg_catalog.spanish', regexp_replace(btrim(p_query), '\s+', ' or ', 'g'));
        IF numnode(v_alt) > 0 THEN
            v_q := v_alt;
        END IF;
    END IF;

    RETURN QUERY
    WITH hits AS (
        SELECT d.path, d.kind, d.title, d.cliente, d.proyecto, d.padre, d.tags, d.links, d.content,
               (ts_rank_cd(d.search, v_q, 33) * CASE WHEN d.kind = 'ficha' THEN 1.25 ELSE 1.0 END)::REAL AS rk
        FROM vault_docs d
        WHERE d.user_id = auth.uid() AND d.kind = ANY (v_kinds) AND d.search @@ v_q
          AND (p_cliente IS NULL OR lower(d.cliente) = lower(p_cliente))
        ORDER BY rk DESC, d.title
        LIMIT v_limit
    )
    SELECT h.path, h.kind, h.title, h.cliente, h.proyecto, h.padre, h.tags, h.links, h.rk,
           ts_headline('public.vault_es', h.content, v_q,
                       'StartSel=⟦, StopSel=⟧, MaxFragments=1, MaxWords=32, MinWords=14'),
           CASE WHEN p_context THEN
               ts_headline('public.vault_es', h.content, v_q,
                           'StartSel=⟦, StopSel=⟧, MaxFragments=3, MaxWords=60, MinWords=25, FragmentDelimiter=" … "')
           END
    FROM hits h
    ORDER BY h.rk DESC, h.title;
END $$;

-- Solo usuarios autenticados (y el cliente de servicio) ejecutan las funciones del índice.
REVOKE EXECUTE ON FUNCTION vault_apply_sync(UUID, JSONB, JSONB, TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION vault_search(TEXT, TEXT, TEXT[], INTEGER, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vault_apply_sync(UUID, JSONB, JSONB, TEXT[], TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION vault_search(TEXT, TEXT, TEXT[], INTEGER, BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Sincronización automática (opcional, a mano — requiere pg_cron + pg_net y el secreto real).
-- La app ya sincroniza al abrir Tareas y cuando el agente no encuentra algo; el cron mantiene el índice fresco
-- para el brief de las 7:00 y para consultas por voz aunque la app esté cerrada. Cada 5 minutos:
--
--   select cron.schedule('vault-sync', '*/5 * * * *', $cmd$
--     select net.http_post(
--       url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/vault',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                                     'Authorization', 'Bearer <ANON_KEY>',      -- el gateway exige un JWT
--                                     'x-vault-secret', '<VAULT_SYNC_SECRET>'),  -- el secreto de la función
--       body    := '{"action":"sync"}'::jsonb);
--   $cmd$);
-- ------------------------------------------------------------
