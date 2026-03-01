-- ============================================================
-- MIGRATION 001: Schema inicial FinApp
-- Propósito: Crear todas las tablas core de la app de finanzas
-- Autor: FinApp
-- Fecha: 2026-03-01
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLA: users (extiende auth.users de Supabase)
-- ============================================================
CREATE TABLE users (
    user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name    VARCHAR(100) NOT NULL,
    default_currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
    timezone        VARCHAR(50) NOT NULL DEFAULT 'America/Lima',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLA: currencies
-- ============================================================
CREATE TABLE currencies (
    currency_code   VARCHAR(3) PRIMARY KEY,
    currency_name   VARCHAR(50) NOT NULL,
    symbol          VARCHAR(5) NOT NULL,
    decimal_places  SMALLINT NOT NULL DEFAULT 2,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================
-- TABLA: accounts
-- ============================================================
CREATE TABLE accounts (
    account_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    account_name    VARCHAR(100) NOT NULL,
    account_type    VARCHAR(20) NOT NULL CHECK (account_type IN (
                        'checking', 'savings', 'credit_card', 'cash',
                        'investment', 'loan', 'other'
                    )),
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'PEN' REFERENCES currencies(currency_code),
    current_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
    credit_limit    NUMERIC(18,2),
    billing_day     SMALLINT CHECK (billing_day BETWEEN 1 AND 31),
    payment_due_day SMALLINT CHECK (payment_due_day BETWEEN 1 AND 31),
    color           VARCHAR(7),
    icon            VARCHAR(50),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_user_id ON accounts(user_id);

-- ============================================================
-- TABLA: categories
-- ============================================================
CREATE TABLE categories (
    category_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(user_id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES categories(category_id),
    category_name   VARCHAR(100) NOT NULL,
    category_type   VARCHAR(10) NOT NULL CHECK (category_type IN ('income', 'expense')),
    icon            VARCHAR(50),
    color           VARCHAR(7),
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_user_id ON categories(user_id);
CREATE INDEX idx_categories_type ON categories(category_type);

-- ============================================================
-- TABLA: transactions
-- ============================================================
CREATE TABLE transactions (
    transaction_id  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES accounts(account_id),
    category_id     UUID REFERENCES categories(category_id),
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN (
                        'income', 'expense', 'transfer'
                    )),
    amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'PEN' REFERENCES currencies(currency_code),
    description     VARCHAR(500),
    notes           TEXT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    transfer_to_account_id UUID REFERENCES accounts(account_id),
    input_method    VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (input_method IN (
                        'manual', 'voice', 'recurring', 'import'
                    )),
    raw_voice_text  VARCHAR(500),
    is_recurring    BOOLEAN NOT NULL DEFAULT FALSE,
    recurring_id    UUID,
    tags            TEXT[],
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX idx_transactions_user_category ON transactions(user_id, category_id);
CREATE INDEX idx_transactions_user_account ON transactions(user_id, account_id);
CREATE INDEX idx_transactions_user_type_date ON transactions(user_id, transaction_type, transaction_date DESC);
CREATE INDEX idx_transactions_tags ON transactions USING GIN(tags);

-- ============================================================
-- TABLA: recurring_transactions
-- ============================================================
CREATE TABLE recurring_transactions (
    recurring_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES accounts(account_id),
    category_id     UUID REFERENCES categories(category_id),
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('income', 'expense')),
    amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'PEN' REFERENCES currencies(currency_code),
    description     VARCHAR(500) NOT NULL,
    frequency       VARCHAR(20) NOT NULL CHECK (frequency IN (
                        'daily', 'weekly', 'biweekly', 'monthly', 'quarterly',
                        'semiannual', 'annual'
                    )),
    day_of_month    SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
    start_date      DATE NOT NULL,
    end_date        DATE,
    next_due_date   DATE NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    auto_register   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_user_next ON recurring_transactions(user_id, next_due_date);
CREATE INDEX idx_recurring_active ON recurring_transactions(is_active) WHERE is_active = TRUE;

-- ============================================================
-- TABLA: budgets
-- ============================================================
CREATE TABLE budgets (
    budget_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    category_id     UUID NOT NULL REFERENCES categories(category_id),
    amount_limit    NUMERIC(18,2) NOT NULL CHECK (amount_limit > 0),
    period_type     VARCHAR(10) NOT NULL CHECK (period_type IN ('weekly', 'monthly', 'annual')),
    alert_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.80,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_budgets_user_category_period UNIQUE (user_id, category_id, period_type)
);

-- ============================================================
-- TABLA: savings_goals
-- ============================================================
CREATE TABLE savings_goals (
    goal_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    goal_name       VARCHAR(200) NOT NULL,
    target_amount   NUMERIC(18,2) NOT NULL CHECK (target_amount > 0),
    current_amount  NUMERIC(18,2) NOT NULL DEFAULT 0,
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'PEN' REFERENCES currencies(currency_code),
    target_date     DATE,
    icon            VARCHAR(50),
    color           VARCHAR(7),
    is_completed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_savings_goals_user ON savings_goals(user_id);

-- ============================================================
-- TABLA: savings_contributions
-- ============================================================
CREATE TABLE savings_contributions (
    contribution_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    goal_id         UUID NOT NULL REFERENCES savings_goals(goal_id) ON DELETE CASCADE,
    transaction_id  UUID REFERENCES transactions(transaction_id),
    amount          NUMERIC(18,2) NOT NULL,
    contribution_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLA: alerts
-- ============================================================
CREATE TABLE alerts (
    alert_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    alert_type      VARCHAR(30) NOT NULL CHECK (alert_type IN (
                        'budget_threshold', 'budget_exceeded',
                        'recurring_due', 'goal_milestone',
                        'unusual_spending', 'credit_card_due',
                        'low_balance'
                    )),
    reference_id    UUID,
    title           VARCHAR(200) NOT NULL,
    message         TEXT,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_dismissed    BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_user_unread ON alerts(user_id, triggered_at DESC) WHERE is_read = FALSE;

-- ============================================================
-- TABLA: ai_chat_history
-- ============================================================
CREATE TABLE ai_chat_history (
    chat_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role            VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    tokens_used     INTEGER,
    model_used      VARCHAR(50),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_chat_user_date ON ai_chat_history(user_id, created_at DESC);

-- ============================================================
-- TABLA: trading_portfolio (fase futura)
-- ============================================================
CREATE TABLE trading_portfolio (
    position_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    symbol          VARCHAR(20) NOT NULL,
    asset_type      VARCHAR(20) NOT NULL CHECK (asset_type IN (
                        'stock', 'etf', 'crypto', 'bond', 'other'
                    )),
    quantity        NUMERIC(18,8) NOT NULL,
    avg_buy_price   NUMERIC(18,8) NOT NULL,
    currency_code   VARCHAR(3) NOT NULL DEFAULT 'USD' REFERENCES currencies(currency_code),
    account_id      UUID REFERENCES accounts(account_id),
    is_open         BOOLEAN NOT NULL DEFAULT TRUE,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_portfolio_user ON trading_portfolio(user_id) WHERE is_open = TRUE;
