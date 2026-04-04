-- ============================================================
-- MIGRATION 002: Row Level Security Policies
-- Propósito: Asegurar que cada usuario solo acceda a sus datos
-- ============================================================

-- Habilitar RLS en todas las tablas
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_portfolio ENABLE ROW LEVEL SECURITY;

-- Users: solo ver/editar su propio perfil
CREATE POLICY "users_select_own" ON users FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "users_insert_own" ON users FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "users_update_own" ON users FOR UPDATE USING (user_id = auth.uid());

-- Accounts
CREATE POLICY "accounts_all_own" ON accounts FOR ALL USING (user_id = auth.uid());

-- Categories: ver sistema (sin dueño) + propias, modificar solo propias
CREATE POLICY "categories_select" ON categories FOR SELECT
    USING (user_id = auth.uid() OR (is_system = TRUE AND user_id IS NULL));
CREATE POLICY "categories_insert" ON categories FOR INSERT
    WITH CHECK (user_id = auth.uid());
CREATE POLICY "categories_update" ON categories FOR UPDATE
    USING (user_id = auth.uid() AND is_system = FALSE);
CREATE POLICY "categories_delete" ON categories FOR DELETE
    USING (user_id = auth.uid() AND is_system = FALSE);

-- Transactions
CREATE POLICY "transactions_all_own" ON transactions FOR ALL USING (user_id = auth.uid());

-- Recurring transactions
CREATE POLICY "recurring_all_own" ON recurring_transactions FOR ALL USING (user_id = auth.uid());

-- Budgets
CREATE POLICY "budgets_all_own" ON budgets FOR ALL USING (user_id = auth.uid());

-- Savings goals
CREATE POLICY "savings_goals_all_own" ON savings_goals FOR ALL USING (user_id = auth.uid());

-- Savings contributions (via goal ownership)
CREATE POLICY "contributions_select" ON savings_contributions FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM savings_goals sg
        WHERE sg.goal_id = savings_contributions.goal_id
        AND sg.user_id = auth.uid()
    ));
CREATE POLICY "contributions_insert" ON savings_contributions FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM savings_goals sg
        WHERE sg.goal_id = savings_contributions.goal_id
        AND sg.user_id = auth.uid()
    ));

-- Alerts
CREATE POLICY "alerts_all_own" ON alerts FOR ALL USING (user_id = auth.uid());

-- AI Chat
CREATE POLICY "ai_chat_all_own" ON ai_chat_history FOR ALL USING (user_id = auth.uid());

-- Trading portfolio
CREATE POLICY "portfolio_all_own" ON trading_portfolio FOR ALL USING (user_id = auth.uid());
