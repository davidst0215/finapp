-- ============================================================
-- MIGRATION 022: la configuración de proyectos de Norte vive en el vault (una sola fuente)
-- Wabid clasificaba las carpetas en Trabajo/Personal con una COPIA de projects.config.json de Norte guardada a mano como secreto
-- (VAULT_PROJECTS_JSON): al cambiar la config en Norte, Wabid quedaba desactualizado en silencio. Ahora la tarea programada del
-- portátil copia ese archivo al vault (90-meta/norte.config.json), viaja por GitHub como todo lo demás y la sincronización de
-- Wabid lo guarda aquí. Si el vault no trae el archivo, sigue mandando el secreto (VAULT_PROJECTS_JSON).
-- Aditiva e idempotente: dos columnas nuevas en la fila de estado que ya existe por usuario (RLS ya vigente en vault_sync).
-- ============================================================

ALTER TABLE vault_sync ADD COLUMN IF NOT EXISTS config_sha  TEXT;  -- sha del blob de 90-meta/norte.config.json ya guardado
ALTER TABLE vault_sync ADD COLUMN IF NOT EXISTS config_json TEXT;  -- su contenido validado (se parsea al usarlo)
