-- ============================================================
-- MIGRATION 023: cerebro de caja (SPEC-cerebro.md)
-- «¿Cuánto puedo gastar hasta el domingo?», «¿qué me toca pagar?», «¿cómo cierro el año?»: el agente lo calcula con
-- _shared/caja.ts a partir de estas tablas. La base guarda los datos; el cálculo vive en el código (con sus tests).
--
--   A. recurring_transactions.frequency acepta 'once': un pago o cobro de una sola vez (deuda con Hugo, bono, CTS,
--      gratificación). Al pagarse queda is_active = false (agent/tools/finanzas.ts, pay_recurring).
--   B. bolsas: topes semanales de gasto variable (comida, compras, gasolina). `categorias` son nombres de categoría;
--      NULL = «todo gasto variable que no cae en otra bolsa» (a lo más una por usuario). `arrastre`: lo no gastado de una
--      semana pasa a la siguiente (gasolina: no se carga todas las semanas).
--   C. plan_caja: una fila por usuario con el inicio del plan, la meta de caja a una fecha y el colchón que no se toca.
--   D. Categoría del sistema «Deudas» (los pagos a Hugo, Yape, Interbank…).
--
-- Idempotente: CREATE ... IF NOT EXISTS, CHECK y políticas recreados, INSERT con NOT EXISTS. No toca filas existentes:
-- el CHECK nuevo es más amplio que el viejo (todas las frecuencias de hoy siguen valiendo).
-- Orden de despliegue: primero esta migración, después el agente (que lee bolsas y plan_caja; sin ellas sigue funcionando,
-- sin plan).
-- ============================================================

-- ------------------------------------------------------------
-- A. Frecuencia 'once'
-- ------------------------------------------------------------
-- El CHECK original de 001 no tiene nombre propio: se busca por su definición (como en 013).
CREATE OR REPLACE FUNCTION pg_temp.drop_checks(tbl regclass, needle text) RETURNS void AS $$
DECLARE c record;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = tbl AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%' || needle || '%'
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, c.conname);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT pg_temp.drop_checks('recurring_transactions', 'biweekly');
ALTER TABLE recurring_transactions DROP CONSTRAINT IF EXISTS recurring_transactions_frequency_check;
ALTER TABLE recurring_transactions
    ADD CONSTRAINT recurring_transactions_frequency_check CHECK (frequency IN (
        'once', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'
    ));

-- ------------------------------------------------------------
-- B. Bolsas de gasto variable
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bolsas (
    bolsa_id     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID          NOT NULL DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    nombre       VARCHAR(40)   NOT NULL CHECK (btrim(nombre) <> ''),
    tope_semanal NUMERIC(18,2) NOT NULL CHECK (tope_semanal > 0),
    categorias   TEXT[]        CHECK (categorias IS NULL OR cardinality(categorias) > 0),
    arrastre     BOOLEAN       NOT NULL DEFAULT FALSE,
    orden        SMALLINT      NOT NULL DEFAULT 0,
    -- Un cambio de tope ya decidido («compras baja a 70 desde el 16-nov»): rige para las semanas que empiezan desde esa fecha.
    tope_nuevo       NUMERIC(18,2) CHECK (tope_nuevo IS NULL OR tope_nuevo > 0),
    tope_nuevo_desde DATE,
    creado       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    actualizado  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT bolsas_cambio_completo CHECK ((tope_nuevo IS NULL) = (tope_nuevo_desde IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bolsas_nombre_uq ON bolsas (user_id, lower(nombre));
-- Una sola bolsa «resto» por usuario: si hubiera dos, un gasto sin bolsa propia no sabría a cuál descontar.
CREATE UNIQUE INDEX IF NOT EXISTS bolsas_resto_uq ON bolsas (user_id) WHERE categorias IS NULL;

ALTER TABLE bolsas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bolsas_all_own ON bolsas;
CREATE POLICY bolsas_all_own ON bolsas FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE ALL ON bolsas FROM PUBLIC, anon, authenticated;   -- parte de cero: los privilegios por defecto de Supabase incluyen TRUNCATE
GRANT SELECT, INSERT, UPDATE, DELETE ON bolsas TO authenticated;
GRANT ALL ON bolsas TO service_role;
COMMENT ON TABLE bolsas IS 'Topes semanales de gasto variable de David (comida, compras, gasolina). categorias NULL = el resto.';

-- ------------------------------------------------------------
-- C. Plan de caja
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_caja (
    user_id     UUID          PRIMARY KEY DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    inicio      DATE          NOT NULL,
    meta_monto  NUMERIC(18,2) CHECK (meta_monto IS NULL OR meta_monto >= 0),
    meta_fecha  DATE,
    colchon     NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (colchon >= 0),
    actualizado TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- Una meta sin fecha (o una fecha sin monto) no se puede comprobar: van las dos o ninguna.
    CONSTRAINT plan_caja_meta_completa CHECK ((meta_monto IS NULL) = (meta_fecha IS NULL))
);

ALTER TABLE plan_caja ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_caja_all_own ON plan_caja;
CREATE POLICY plan_caja_all_own ON plan_caja FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
REVOKE ALL ON plan_caja FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_caja TO authenticated;
GRANT ALL ON plan_caja TO service_role;
COMMENT ON TABLE plan_caja IS 'Plan de caja de David: desde cuándo corre, la meta de caja a una fecha y el colchón que no se toca.';

-- ------------------------------------------------------------
-- D. Categoría «Deudas»
-- ------------------------------------------------------------
INSERT INTO categories (user_id, category_name, category_type, icon, color, is_system)
SELECT NULL, 'Deudas', 'expense', '💳', '#94a3b8', TRUE
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND category_name = 'Deudas' AND category_type = 'expense');
