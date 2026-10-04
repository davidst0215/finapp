-- ============================================================
-- MIGRATION 011: user_id por defecto = usuario de la sesión
-- La web inserta cuentas, movimientos, presupuestos, metas, recurrentes y alertas sin
-- mandar user_id, y la columna es NOT NULL: todo alta desde la UI fallaba. Con el default,
-- PostgREST completa el dueño con el JWT y la política RLS (user_id = auth.uid()) lo valida.
-- Los inserts con el rol de servicio siguen mandando user_id explícito (auth.uid() es NULL ahí).
-- Numerada 011 para no chocar con 005–010, reservadas a los módulos en construcción.
-- ============================================================

ALTER TABLE accounts               ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE transactions           ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE recurring_transactions ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE budgets                ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE savings_goals          ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE alerts                 ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE ai_chat_history        ALTER COLUMN user_id SET DEFAULT auth.uid();
ALTER TABLE trading_portfolio      ALTER COLUMN user_id SET DEFAULT auth.uid();
-- Categorías propias: las del sistema se siembran con user_id NULL (sin sesión, auth.uid() es NULL).
ALTER TABLE categories             ALTER COLUMN user_id SET DEFAULT auth.uid();
