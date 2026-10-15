-- ============================================================
-- MIGRATION 021: endurecer los permisos del rol anónimo (hallazgo de la revisión del 15-oct-2026)
-- La anon key es pública (viaja en el bundle de la web). Supabase da por defecto a `anon` TODOS los privilegios sobre cada tabla
-- nueva de `public`; en las tablas con RLS eso no abre filas, pero:
--   1. `currencies` NO tenía RLS: con la anon key cualquiera podía insertar, actualizar, borrar o vaciar los códigos de moneda de
--      los que cuelgan cuentas, movimientos y metas.
--   2. TRUNCATE, REFERENCES y TRIGGER no pasan por RLS en ninguna tabla. PostgREST no expone TRUNCATE, pero un privilegio que nadie
--      usa es superficie de ataque gratis.
-- Esta migración: (a) pone RLS en `currencies` con lectura para todos y escritura para nadie (solo el rol de servicio/propietario,
-- que ignora RLS), (b) quita a `anon` toda escritura y esos tres privilegios en todas las tablas de `public`, (c) quita a
-- `authenticated` TRUNCATE/REFERENCES/TRIGGER (sus INSERT/UPDATE/DELETE siguen: RLS decide fila por fila), y (d) hace que las tablas
-- FUTURAS no nazcan con privilegios para `anon`. `anon` conserva SELECT (inofensivo con RLS: las políticas son TO authenticated).
-- Idempotente: se puede aplicar dos veces. Para revertir (d): ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon.
-- ============================================================

ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS currencies_select ON currencies;
CREATE POLICY currencies_select ON currencies
    FOR SELECT TO anon, authenticated
    USING (true);

-- Los códigos de moneda no se editan desde la app ni desde las funciones (solo existen en 001_initial_schema.sql).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON currencies FROM anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Las tablas que cree esta cuenta en adelante no heredan privilegios para anon (cada migración da lo que necesite, como 018 y 020).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
