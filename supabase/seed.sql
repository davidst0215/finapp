-- ============================================================
-- SEED DATA: Monedas y categorías por defecto
-- ============================================================

-- Monedas principales
INSERT INTO currencies (currency_code, currency_name, symbol, decimal_places) VALUES
    ('PEN', 'Sol Peruano', 'S/', 2),
    ('USD', 'Dólar Americano', '$', 2),
    ('EUR', 'Euro', '€', 2)
ON CONFLICT (currency_code) DO NOTHING;

-- Categorías de GASTO (sistema)
INSERT INTO categories (user_id, category_name, category_type, icon, color, is_system) VALUES
    (NULL, 'Alimentación', 'expense', '🍽️', '#ef4444', TRUE),
    (NULL, 'Transporte', 'expense', '🚗', '#f97316', TRUE),
    (NULL, 'Entretenimiento', 'expense', '🎬', '#8b5cf6', TRUE),
    (NULL, 'Compras', 'expense', '🛒', '#ec4899', TRUE),
    (NULL, 'Salud', 'expense', '💊', '#10b981', TRUE),
    (NULL, 'Educación', 'expense', '📚', '#3b82f6', TRUE),
    (NULL, 'Servicios', 'expense', '💡', '#f59e0b', TRUE),
    (NULL, 'Vivienda', 'expense', '🏠', '#6366f1', TRUE),
    (NULL, 'Ropa', 'expense', '👕', '#14b8a6', TRUE),
    (NULL, 'Tecnología', 'expense', '📱', '#64748b', TRUE),
    (NULL, 'Suscripciones', 'expense', '📺', '#a855f7', TRUE),
    (NULL, 'Mascotas', 'expense', '🐾', '#d97706', TRUE),
    (NULL, 'Regalos', 'expense', '🎁', '#e11d48', TRUE),
    (NULL, 'Otros gastos', 'expense', '📋', '#94a3b8', TRUE);

-- Categorías de INGRESO (sistema)
INSERT INTO categories (user_id, category_name, category_type, icon, color, is_system) VALUES
    (NULL, 'Sueldo', 'income', '💰', '#10b981', TRUE),
    (NULL, 'Freelance', 'income', '💻', '#3b82f6', TRUE),
    (NULL, 'Negocio', 'income', '🏢', '#8b5cf6', TRUE),
    (NULL, 'Inversiones', 'income', '📈', '#f59e0b', TRUE),
    (NULL, 'Devolución préstamo', 'income', '🔄', '#06b6d4', TRUE),
    (NULL, 'Trading', 'income', '📊', '#22c55e', TRUE),
    (NULL, 'Otros ingresos', 'income', '✨', '#94a3b8', TRUE);
