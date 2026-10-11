-- ============================================================
-- MIGRATION 016: saldos que se mueven solos + multimoneda (PEN y USD)
--
-- PROBLEMA 1. accounts.current_balance no cambiaba con los movimientos: ni la web ni el agente lo actualizaban, así que una cuenta
-- seguía diciendo lo mismo después de registrar gastos, ingresos o transferencias.
-- PROBLEMA 2. Los totales (resumen del mes, presupuestos, gastos por categoría) sumaban `amount` sin mirar la moneda: US$ 10 valían S/ 10.
--
-- QUÉ HACE
--   A. Trigger AFTER INSERT/UPDATE/DELETE en transactions que aplica el DELTA a la(s) cuenta(s). Cubre alta, edición de monto, de
--      tipo y de cuenta (origen o destino), borrado, transferencias y tarjeta de crédito.
--   B. Trigger BEFORE en transactions que RECHAZA un movimiento cuya moneda no es la de su cuenta (y, en una transferencia, la de la
--      cuenta destino), y que la cuenta sea de otro dueño. accounts no deja cambiar de moneda ni de "tarjeta / no tarjeta" si ya
--      tiene movimientos (el saldo y sus signos quedarían mal).
--   C. fx_rates: caché del tipo de cambio (fecha, par, valor, fuente), con fx_tasa()/fn_a_soles() para convertir a soles.
--   D. fn_get_monthly_summary, fn_get_budget_status y fn_get_spending_by_category pasan a sumar EN SOLES (USD × tipo de cambio).
--
-- SIGNO DEL SALDO (decisión documentada)
--   La web muestra las tarjetas de crédito como DEUDA: Dashboard.tsx y Accounts.tsx hacen `patrimonio -= saldo` si
--   account_type = 'credit_card', AccountCard pinta el saldo en rojo, y el agente dice «debes» (cuentas.ts). Por eso en una tarjeta
--   current_balance es la deuda, en positivo, y todo se invierte:
--                         cuenta normal        tarjeta de crédito (saldo = deuda)
--     income              saldo + monto        deuda − monto   (reembolso, abono)
--     expense             saldo − monto        deuda + monto   (compra con la tarjeta)
--     transfer, origen    saldo − monto        deuda + monto   (adelanto de efectivo)
--     transfer, destino   saldo + monto        deuda − monto   (pago de la tarjeta)
--   Otros tipos (savings, cash, investment, loan, other) se mueven como una cuenta normal, igual que hoy los suma la web.
--   ('loan' queda como activo, tal como lo suma hoy el patrimonio; si David quiere verlo como deuda es otra decisión.)
--
-- POR QUÉ NO HAY BACKFILL
--   Los saldos actuales son los que David dejó y quedan INTACTOS: esta migración no toca ninguna fila de accounts ni de transactions.
--   Recalcular "saldo inicial + movimientos" inventaría saldos iniciales que nunca existieron y pisaría los que él puso a mano.
--   El modelo que queda es: saldo_hoy = saldo_al_aplicar_016 + Σ efecto(movimientos nuevos o editados). Un movimiento anterior a 016
--   que se edite o borre sí mueve el saldo por la diferencia: el invariante es «saldo − Σ efecto(movimientos) es constante», es decir,
--   el saldo inicial implícito de cada cuenta es `saldo_hoy − Σ efecto(movimientos existentes)` y no cambia nunca.
--
-- IDEMPOTENTE: CREATE ... IF NOT EXISTS / OR REPLACE, DROP ... IF EXISTS antes de cada trigger y política. Correrla dos veces no
-- aplica nada dos veces (no toca datos).
--
-- TIPO DE CAMBIO: lo llena la edge function `fx` (BCRP, serie SBS venta; respaldo open.er-api.com). Ver functions/fx/index.ts.
-- Sin ninguna tasa en fx_rates, un movimiento en USD queda FUERA de las sumas en soles (no se cuenta como si fueran soles).
-- ============================================================

-- ------------------------------------------------------------
-- A. Delta del saldo
-- ------------------------------------------------------------
-- Efecto de UN movimiento sobre UNA cuenta. p_es_destino = true para la cuenta que recibe una transferencia.
CREATE OR REPLACE FUNCTION fn_saldo_delta(p_tipo_cuenta TEXT, p_es_destino BOOLEAN, p_tipo_mov TEXT, p_monto NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT (CASE WHEN p_tipo_cuenta = 'credit_card' THEN -1 ELSE 1 END)
         * (CASE
                WHEN p_es_destino     AND p_tipo_mov = 'transfer' THEN  p_monto
                WHEN NOT p_es_destino AND p_tipo_mov = 'income'   THEN  p_monto
                WHEN NOT p_es_destino AND p_tipo_mov = 'expense'  THEN -p_monto
                WHEN NOT p_es_destino AND p_tipo_mov = 'transfer' THEN -p_monto
                ELSE 0
            END)
$$;

-- Aplica a accounts.current_balance la diferencia entre lo que el movimiento hacía antes (OLD, se revierte) y lo que hace ahora
-- (NEW). Una sola sentencia agrupa por cuenta: editar el monto de una transferencia toca cada cuenta una vez.
CREATE OR REPLACE FUNCTION fn_tx_aplicar_saldo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    o_cuenta UUID; o_destino UUID; o_tipo TEXT; o_monto NUMERIC;
    n_cuenta UUID; n_destino UUID; n_tipo TEXT; n_monto NUMERIC;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        o_cuenta := OLD.account_id; o_tipo := OLD.transaction_type; o_monto := OLD.amount;
        IF OLD.transaction_type = 'transfer' THEN o_destino := OLD.transfer_to_account_id; END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        n_cuenta := NEW.account_id; n_tipo := NEW.transaction_type; n_monto := NEW.amount;
        IF NEW.transaction_type = 'transfer' THEN n_destino := NEW.transfer_to_account_id; END IF;
    END IF;

    -- Descripción, fecha, categoría, notas...: el saldo no cambia.
    IF TG_OP = 'UPDATE'
       AND o_cuenta = n_cuenta AND o_destino IS NOT DISTINCT FROM n_destino AND o_tipo = n_tipo AND o_monto = n_monto THEN
        RETURN NULL;
    END IF;

    WITH mov(cuenta, es_destino, tipo, monto, signo) AS (
        SELECT o_cuenta,  FALSE, o_tipo, o_monto, -1 WHERE o_cuenta  IS NOT NULL
        UNION ALL
        SELECT o_destino, TRUE,  o_tipo, o_monto, -1 WHERE o_destino IS NOT NULL
        UNION ALL
        SELECT n_cuenta,  FALSE, n_tipo, n_monto,  1 WHERE n_cuenta  IS NOT NULL
        UNION ALL
        SELECT n_destino, TRUE,  n_tipo, n_monto,  1 WHERE n_destino IS NOT NULL
    ),
    neto AS (
        SELECT m.cuenta, SUM(m.signo * fn_saldo_delta(a.account_type, m.es_destino, m.tipo, m.monto)) AS delta
        FROM mov m
        JOIN accounts a ON a.account_id = m.cuenta
        GROUP BY m.cuenta
    )
    UPDATE accounts a
    SET current_balance = a.current_balance + n.delta,
        updated_at = NOW()
    FROM neto n
    WHERE a.account_id = n.cuenta AND n.delta <> 0;

    RETURN NULL;  -- AFTER: el valor de retorno se ignora
END;
$$;

DROP TRIGGER IF EXISTS trg_tx_aplicar_saldo ON transactions;
CREATE TRIGGER trg_tx_aplicar_saldo
    AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION fn_tx_aplicar_saldo();

-- ------------------------------------------------------------
-- B. Moneda y dueño: rechazar lo que dejaría un saldo sin sentido
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_tx_validar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cuenta accounts%ROWTYPE;
    v_destino accounts%ROWTYPE;
BEGIN
    -- Editar descripción, fecha o monto de un movimiento viejo no se valida otra vez: solo cuando cambia lo que decide el saldo.
    IF TG_OP = 'UPDATE'
       AND OLD.account_id = NEW.account_id
       AND OLD.transfer_to_account_id IS NOT DISTINCT FROM NEW.transfer_to_account_id
       AND OLD.currency_code = NEW.currency_code
       AND OLD.transaction_type = NEW.transaction_type
       AND OLD.user_id = NEW.user_id THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_cuenta FROM accounts WHERE account_id = NEW.account_id;
    IF NOT FOUND OR v_cuenta.user_id <> NEW.user_id THEN
        RAISE EXCEPTION 'La cuenta del movimiento no existe o no es tuya.' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_cuenta.currency_code <> NEW.currency_code THEN
        RAISE EXCEPTION 'El movimiento es en % y la cuenta «%» es en %. Usa una cuenta de la misma moneda.',
            NEW.currency_code, v_cuenta.account_name, v_cuenta.currency_code
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.transaction_type = 'transfer' THEN
        IF NEW.transfer_to_account_id IS NULL THEN
            RAISE EXCEPTION 'Una transferencia necesita cuenta de destino.' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.transfer_to_account_id = NEW.account_id THEN
            RAISE EXCEPTION 'La transferencia necesita dos cuentas distintas.' USING ERRCODE = 'check_violation';
        END IF;
        SELECT * INTO v_destino FROM accounts WHERE account_id = NEW.transfer_to_account_id;
        IF NOT FOUND OR v_destino.user_id <> NEW.user_id THEN
            RAISE EXCEPTION 'La cuenta de destino no existe o no es tuya.' USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF v_destino.currency_code <> NEW.currency_code THEN
            RAISE EXCEPTION 'No se transfiere entre monedas distintas: «%» es en % y «%» en %.',
                v_cuenta.account_name, v_cuenta.currency_code, v_destino.account_name, v_destino.currency_code
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tx_validar ON transactions;
CREATE TRIGGER trg_tx_validar
    BEFORE INSERT OR UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION fn_tx_validar();

-- Una cuenta con movimientos no cambia de moneda (los movimientos quedarían en otra) ni pasa a/desde tarjeta (los signos se invertirían).
CREATE OR REPLACE FUNCTION fn_cuenta_validar_cambio()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (NEW.currency_code <> OLD.currency_code OR (NEW.account_type = 'credit_card') <> (OLD.account_type = 'credit_card'))
       AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = OLD.account_id OR t.transfer_to_account_id = OLD.account_id) THEN
        RAISE EXCEPTION 'La cuenta «%» ya tiene movimientos: no se le puede cambiar la moneda ni pasarla a/desde tarjeta de crédito. Crea otra cuenta.', OLD.account_name
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cuenta_validar_cambio ON accounts;
CREATE TRIGGER trg_cuenta_validar_cambio
    BEFORE UPDATE OF currency_code, account_type ON accounts
    FOR EACH ROW EXECUTE FUNCTION fn_cuenta_validar_cambio();

REVOKE ALL ON FUNCTION fn_tx_aplicar_saldo() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_tx_validar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_cuenta_validar_cambio() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- C. Tipo de cambio
-- ------------------------------------------------------------
-- par 'USD/PEN' = soles por 1 dólar. Una fila por día publicado (la fuente no publica fines de semana ni feriados): para una fecha
-- vale la última fila con fecha <= esa fecha. `fuente` dice de dónde salió cada valor.
CREATE TABLE IF NOT EXISTS fx_rates (
    par         VARCHAR(7)   NOT NULL CHECK (par ~ '^[A-Z]{3}/PEN$'),
    fecha       DATE         NOT NULL,
    valor       NUMERIC(12,6) NOT NULL CHECK (valor > 0),
    fuente      VARCHAR(80)  NOT NULL,
    obtenido_en TIMESTAMPTZ  NOT NULL DEFAULT NOW(),   -- cuándo lo trajo la edge function (decide si hay que refrescar)
    PRIMARY KEY (par, fecha)
);

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;

-- Dato público, no de un usuario: cualquier sesión lo lee. Solo la edge function (rol de servicio) escribe.
DROP POLICY IF EXISTS fx_rates_select ON fx_rates;
CREATE POLICY fx_rates_select ON fx_rates FOR SELECT TO authenticated USING (TRUE);
REVOKE ALL ON fx_rates FROM anon;
REVOKE INSERT, UPDATE, DELETE ON fx_rates FROM authenticated;

-- Soles por 1 unidad de p_moneda en p_fecha. PEN = 1. Antes de la primera fecha conocida vale la primera conocida (mejor que 1);
-- sin ninguna fila para esa moneda devuelve NULL: «no sé convertir», nunca «vale lo mismo».
CREATE OR REPLACE FUNCTION fx_tasa(p_moneda TEXT, p_fecha DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_moneda = 'PEN' THEN 1::NUMERIC
        ELSE COALESCE(
            (SELECT r.valor FROM fx_rates r WHERE r.par = p_moneda || '/PEN' AND r.fecha <= p_fecha ORDER BY r.fecha DESC LIMIT 1),
            (SELECT r.valor FROM fx_rates r WHERE r.par = p_moneda || '/PEN' ORDER BY r.fecha ASC LIMIT 1)
        )
    END
$$;

CREATE OR REPLACE FUNCTION fn_a_soles(p_monto NUMERIC, p_moneda TEXT, p_fecha DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT p_monto * fx_tasa(p_moneda, p_fecha)
$$;

-- ------------------------------------------------------------
-- D. Resúmenes en soles (cada movimiento con el tipo de cambio de SU día, en hora de Lima)
-- ------------------------------------------------------------
-- Cambia la forma de la tabla devuelta (dos columnas nuevas al final): hay que soltarla primero. Quien lee por nombre no nota nada.
DROP FUNCTION IF EXISTS fn_get_monthly_summary(INTEGER, INTEGER);
CREATE FUNCTION fn_get_monthly_summary(
    p_year INTEGER,
    p_month INTEGER
)
RETURNS TABLE (
    total_income NUMERIC,
    total_expenses NUMERIC,
    net_balance NUMERIC,
    transaction_count BIGINT,
    top_category_name VARCHAR,
    top_category_amount NUMERIC,
    income_usd NUMERIC,      -- cuánto del ingreso fue en dólares (ya incluido, convertido, en total_income)
    expenses_usd NUMERIC     -- ídem para gastos
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH monthly_data AS (
        SELECT
            t.transaction_type,
            t.currency_code,
            t.amount,
            fn_a_soles(t.amount, t.currency_code, (t.transaction_date AT TIME ZONE 'America/Lima')::DATE) AS amount_pen,
            t.category_id
        FROM transactions t
        WHERE t.user_id = auth.uid()
            AND EXTRACT(YEAR FROM t.transaction_date) = p_year
            AND EXTRACT(MONTH FROM t.transaction_date) = p_month
    ),
    totals AS (
        SELECT
            COALESCE(SUM(md.amount_pen) FILTER (WHERE md.transaction_type = 'income'), 0) AS ti,
            COALESCE(SUM(md.amount_pen) FILTER (WHERE md.transaction_type = 'expense'), 0) AS te,
            COUNT(*) AS tc,
            COALESCE(SUM(md.amount) FILTER (WHERE md.transaction_type = 'income' AND md.currency_code = 'USD'), 0) AS iu,
            COALESCE(SUM(md.amount) FILTER (WHERE md.transaction_type = 'expense' AND md.currency_code = 'USD'), 0) AS eu
        FROM monthly_data md
    ),
    top_cat AS (
        SELECT
            c.category_name,
            SUM(md.amount_pen) AS cat_amount
        FROM monthly_data md
        JOIN categories c ON c.category_id = md.category_id
        WHERE md.transaction_type = 'expense'
        GROUP BY c.category_name
        ORDER BY cat_amount DESC
        LIMIT 1
    )
    SELECT
        tt.ti,
        tt.te,
        tt.ti - tt.te,
        tt.tc,
        COALESCE(tc.category_name, 'N/A'::VARCHAR),
        COALESCE(tc.cat_amount, 0::NUMERIC),
        tt.iu,
        tt.eu
    FROM totals tt
    LEFT JOIN top_cat tc ON TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION fn_get_budget_status()
RETURNS TABLE (
    budget_id UUID,
    category_name VARCHAR,
    category_icon VARCHAR,
    category_color VARCHAR,
    amount_limit NUMERIC,
    amount_spent NUMERIC,
    percentage_used NUMERIC,
    remaining NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.budget_id,
        c.category_name,
        c.icon,
        c.color,
        b.amount_limit,
        COALESCE(SUM(fn_a_soles(t.amount, t.currency_code, (t.transaction_date AT TIME ZONE 'America/Lima')::DATE)), 0) AS amount_spent,
        ROUND(COALESCE(SUM(fn_a_soles(t.amount, t.currency_code, (t.transaction_date AT TIME ZONE 'America/Lima')::DATE)), 0) / b.amount_limit * 100, 1) AS percentage_used,
        b.amount_limit - COALESCE(SUM(fn_a_soles(t.amount, t.currency_code, (t.transaction_date AT TIME ZONE 'America/Lima')::DATE)), 0) AS remaining
    FROM budgets b
    JOIN categories c ON c.category_id = b.category_id
    LEFT JOIN transactions t ON t.category_id = b.category_id
        AND t.user_id = auth.uid()
        AND t.transaction_type = 'expense'
        AND t.transaction_date >= date_trunc('month', CURRENT_DATE)
        AND t.transaction_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
    WHERE b.user_id = auth.uid()
        AND b.is_active = TRUE
        AND b.period_type = 'monthly'
    GROUP BY b.budget_id, c.category_name, c.icon, c.color, b.amount_limit;
END;
$$;

CREATE OR REPLACE FUNCTION fn_get_spending_by_category(
    p_start_date DATE,
    p_end_date DATE
)
RETURNS TABLE (
    category_id UUID,
    category_name VARCHAR,
    icon VARCHAR,
    color VARCHAR,
    total_amount NUMERIC,
    transaction_count BIGINT,
    percentage NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH cat_totals AS (
        SELECT
            c.category_id,
            c.category_name,
            c.icon,
            c.color,
            SUM(fn_a_soles(t.amount, t.currency_code, (t.transaction_date AT TIME ZONE 'America/Lima')::DATE)) AS total_amount,
            COUNT(*) AS transaction_count
        FROM transactions t
        JOIN categories c ON c.category_id = t.category_id
        WHERE t.user_id = auth.uid()
            AND t.transaction_type = 'expense'
            AND t.transaction_date >= p_start_date
            AND t.transaction_date < p_end_date + INTERVAL '1 day'
        GROUP BY c.category_id, c.category_name, c.icon, c.color
    ),
    grand_total AS (
        SELECT COALESCE(SUM(ct.total_amount), 0) AS grand_sum FROM cat_totals ct
    )
    SELECT
        ct.category_id,
        ct.category_name,
        ct.icon,
        ct.color,
        COALESCE(ct.total_amount, 0),
        ct.transaction_count,
        ROUND(COALESCE(ct.total_amount, 0) / NULLIF(gt.grand_sum, 0) * 100, 1)
    FROM cat_totals ct
    CROSS JOIN grand_total gt
    ORDER BY COALESCE(ct.total_amount, 0) DESC;
END;
$$;
