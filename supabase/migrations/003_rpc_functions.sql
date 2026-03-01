-- ============================================================
-- MIGRATION 003: Funciones RPC
-- Propósito: Stored procedures llamables desde el frontend
-- ============================================================

-- fn_get_monthly_summary: Resumen financiero del mes
CREATE OR REPLACE FUNCTION fn_get_monthly_summary(
    p_year INTEGER,
    p_month INTEGER
)
RETURNS TABLE (
    total_income NUMERIC,
    total_expenses NUMERIC,
    net_balance NUMERIC,
    transaction_count BIGINT,
    top_category_name VARCHAR,
    top_category_amount NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH monthly_data AS (
        SELECT
            t.transaction_type,
            t.amount,
            t.category_id
        FROM transactions t
        WHERE t.user_id = auth.uid()
            AND EXTRACT(YEAR FROM t.transaction_date) = p_year
            AND EXTRACT(MONTH FROM t.transaction_date) = p_month
    ),
    totals AS (
        SELECT
            COALESCE(SUM(md.amount) FILTER (WHERE md.transaction_type = 'income'), 0) AS ti,
            COALESCE(SUM(md.amount) FILTER (WHERE md.transaction_type = 'expense'), 0) AS te,
            COUNT(*) AS tc
        FROM monthly_data md
    ),
    top_cat AS (
        SELECT
            c.category_name,
            SUM(md.amount) AS cat_amount
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
        COALESCE(tc.cat_amount, 0::NUMERIC)
    FROM totals tt
    LEFT JOIN top_cat tc ON TRUE;
END;
$$;

-- fn_get_budget_status: Estado actual de presupuestos mensuales
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
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.budget_id,
        c.category_name,
        c.icon,
        c.color,
        b.amount_limit,
        COALESCE(SUM(t.amount), 0) AS amount_spent,
        ROUND(COALESCE(SUM(t.amount), 0) / b.amount_limit * 100, 1) AS percentage_used,
        b.amount_limit - COALESCE(SUM(t.amount), 0) AS remaining
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

-- fn_get_spending_by_category: Gastos agrupados por categoría
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
AS $$
BEGIN
    RETURN QUERY
    WITH cat_totals AS (
        SELECT
            c.category_id,
            c.category_name,
            c.icon,
            c.color,
            SUM(t.amount) AS total_amount,
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
        ct.total_amount,
        ct.transaction_count,
        ROUND(ct.total_amount / NULLIF(gt.grand_sum, 0) * 100, 1)
    FROM cat_totals ct
    CROSS JOIN grand_total gt
    ORDER BY ct.total_amount DESC;
END;
$$;
