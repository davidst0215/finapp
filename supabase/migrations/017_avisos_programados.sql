-- ============================================================
-- MIGRATION 017: avisos programados (recordatorios, vencimientos y presupuestos)
-- Requiere 001 (cuentas, movimientos, recurrentes, presupuestos), 002, 004 (notifications) y 006 (push_subscriptions). Idempotente.
--
-- Qué hace
--   * avisos_programados: cola de avisos con hora. Un cron cada minuto llama a la función `avisos`, que RECLAMA los vencidos
--     con un UPDATE atómico (avisos_reclamar) y los envía por el mismo camino que todo aviso de Wabid (notify: bandeja + push).
--   * Recordatorios de David ("recuérdame llamar a Marco a las 5"): los inserta el agente con su JWT (RLS). Pueden apuntar a
--     una tarea de Norte (tarea_path / tarea_line).
--   * Vencimientos: pagos recurrentes y tarjetas avisan 1 día antes, a las 9:00 de Lima (avisos_encolar_vencimientos, cada hora).
--   * Presupuestos: un trigger en `transactions` encola el aviso al pasar el umbral (80 % por defecto) y el 100 % del presupuesto
--     mensual de la categoría, UNA vez por umbral y mes (dedupe_key única).
--   * avisos_preferencias: interruptores de "avisos de vencimientos" y "avisos de presupuesto". Se miran al ENVIAR, no al encolar:
--     apagarlo no destruye nada y encenderlo de nuevo recupera lo que aún no caducó.
--
-- Por qué el presupuesto va en un TRIGGER y no en el cron
--   Los gastos entran por varios caminos (la web, el agente, la voz, el pago de un recurrente, importaciones) y todos terminan en
--   un INSERT a `transactions`. El trigger los cubre a todos sin que cada uno tenga que acordarse, corre dentro de la misma
--   transacción (no se pierde ni se duplica: la llave única lo impide) y evalúa SOLO la categoría tocada. Un cron tendría que
--   recalcular todos los presupuestos cada minuto y avisaría con hasta un minuto de retraso. El riesgo de un trigger es romper el
--   registro de un gasto: por eso el cuerpo atrapa cualquier error y lo reduce a un WARNING. Registrar un gasto nunca falla por un aviso.
--
-- ANTES DE APLICAR (lo hace el hilo principal; nada de esto va en el repo):
--   1. Elegir un valor aleatorio largo (>= 32 caracteres) y guardarlo en DOS sitios con el MISMO valor:
--        a) Supabase Vault:         select vault.create_secret('<valor>', 'avisos_cron_secret');
--        b) Secreto de la función:  npx supabase secrets set AVISOS_CRON_SECRET=<valor> --project-ref rrhyyclltgaecfyertqh
--   2. Desplegar la función con verify_jwt=false (la llama pg_cron, que no tiene JWT de usuario):
--        npx supabase functions deploy avisos --no-verify-jwt --project-ref rrhyyclltgaecfyertqh
--   3. Aplicar esta migración. Si el secreto de Vault falta, el job igual corre pero la función responde 401 y no pasa nada más.
-- Después de aplicar: desplegar `agent` (tools nuevas) y la web.
-- ============================================================

-- ------------------------------------------------------------
-- Preferencias (una fila por usuario; sin fila = todo encendido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avisos_preferencias (
    user_id       UUID PRIMARY KEY DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    vencimientos  BOOLEAN NOT NULL DEFAULT TRUE,     -- pagos recurrentes y tarjetas, 1 día antes
    presupuestos  BOOLEAN NOT NULL DEFAULT TRUE,     -- al pasar el umbral y el 100 % del mes
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Cola de avisos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avisos_programados (
    aviso_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL DEFAULT auth.uid() REFERENCES users(user_id) ON DELETE CASCADE,
    origen           VARCHAR(15) NOT NULL CHECK (origen IN ('recordatorio', 'tarea', 'vencimiento', 'tarjeta', 'presupuesto')),
    titulo           VARCHAR(120) NOT NULL CHECK (char_length(btrim(titulo)) >= 1),
    cuerpo           VARCHAR(400) NOT NULL DEFAULT '',
    -- Ruta INTERNA de la app a abrir al tocar el aviso ("/tareas"); nunca "//host", "\host" ni una URL. Misma regla que isSafeAppPath.
    url              VARCHAR(300) CHECK (url IS NULL OR url ~ '^/([^/\\[:space:][:cntrl:]][^\\[:space:][:cntrl:]]*)?$'),
    cuando           TIMESTAMPTZ NOT NULL,                        -- instante en que debe salir
    disponible_desde TIMESTAMPTZ NOT NULL,                        -- = cuando; un reintento lo adelanta (espera entre intentos)
    caduca_at        TIMESTAMPTZ NOT NULL,                        -- pasada esta hora ya no sirve: se marca 'caducado' sin enviar
    estado           VARCHAR(10) NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'cancelado', 'omitido', 'caducado', 'fallido')),
    intentos         SMALLINT NOT NULL DEFAULT 0 CHECK (intentos >= 0),
    reclamado_at     TIMESTAMPTZ,                                 -- cuándo lo reclamó el último envío (para rescatar un reclamo huérfano)
    enviado_at       TIMESTAMPTZ,
    detalle          VARCHAR(200),                                -- por qué se omitió/falló, o por dónde salió ('push', 'bandeja')
    notification_id  UUID REFERENCES notifications(notification_id) ON DELETE SET NULL,   -- la fila de la bandeja (un reintento no la duplica)
    tarea_path       TEXT,                                        -- recordatorio ligado a una tarea de Norte
    tarea_line       INTEGER,
    tarea_texto      VARCHAR(200),
    entidad_id       UUID,                                        -- recurring_id / account_id / budget_id (avisos del sistema)
    fecha_ref        DATE,                                        -- vencimiento: la fecha de pago (Lima) que se avisa
    dedupe_key       TEXT,                                        -- tipo:entidad:periodo — una sola vez, aunque corra dos veces
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (tarea_line IS NULL OR tarea_path IS NOT NULL),
    CHECK (origen <> 'tarea' OR tarea_path IS NOT NULL),
    CHECK (estado <> 'enviado' OR enviado_at IS NOT NULL)
);

-- Sin llave dedupe (recordatorios) no hay restricción. Con llave: una sola fila por usuario y llave, también tras cancelarse
-- (cancelar o recibir un aviso no lo "libera" para que vuelva a salir).
CREATE UNIQUE INDEX IF NOT EXISTS uq_avisos_dedupe ON avisos_programados (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_avisos_cola ON avisos_programados (disponible_desde) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_avisos_reclamados ON avisos_programados (reclamado_at) WHERE estado = 'enviando';
CREATE INDEX IF NOT EXISTS idx_avisos_usuario ON avisos_programados (user_id, cuando) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_avisos_tarea ON avisos_programados (user_id, tarea_path, tarea_line) WHERE tarea_path IS NOT NULL AND estado = 'pendiente';

-- disponible_desde y caduca_at los pone la base: el cliente solo dice CUÁNDO. Un recordatorio vale 2 h después de su hora
-- (llegar a las 10 de la noche con "llamar a Marco a las 5" no sirve); un vencimiento, 12 h (sigue siendo antes del pago).
CREATE OR REPLACE FUNCTION avisos_fijar_ventanas() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.disponible_desde := COALESCE(NEW.disponible_desde, NEW.cuando);
    NEW.caduca_at := COALESCE(NEW.caduca_at, NEW.cuando + CASE NEW.origen
        WHEN 'recordatorio' THEN INTERVAL '2 hours'
        WHEN 'tarea'        THEN INTERVAL '2 hours'
        WHEN 'presupuesto'  THEN INTERVAL '6 hours'
        ELSE INTERVAL '12 hours'
    END);
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_avisos_ventanas ON avisos_programados;
CREATE TRIGGER trg_avisos_ventanas
    BEFORE INSERT ON avisos_programados
    FOR EACH ROW EXECUTE FUNCTION avisos_fijar_ventanas();

-- ------------------------------------------------------------
-- RLS y privilegios
--   La app y el agente (JWT del usuario) leen lo suyo, crean recordatorios y los CANCELAN. Nada más: no editan la hora ni el
--   estado de envío, no borran y no pueden crear avisos "del sistema" (vencimiento, tarjeta, presupuesto). Reprogramar = cancelar y crear.
--   Los avisos del sistema y el envío los hace el rol de servicio / funciones SECURITY DEFINER.
-- ------------------------------------------------------------
ALTER TABLE avisos_programados ENABLE ROW LEVEL SECURITY;
ALTER TABLE avisos_preferencias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS avisos_select_own ON avisos_programados;
CREATE POLICY avisos_select_own ON avisos_programados FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS avisos_insert_own ON avisos_programados;
CREATE POLICY avisos_insert_own ON avisos_programados FOR INSERT
    WITH CHECK (user_id = auth.uid() AND origen IN ('recordatorio', 'tarea'));

DROP POLICY IF EXISTS avisos_cancel_own ON avisos_programados;
CREATE POLICY avisos_cancel_own ON avisos_programados FOR UPDATE
    USING (user_id = auth.uid() AND estado = 'pendiente')
    WITH CHECK (user_id = auth.uid() AND estado = 'cancelado');

DROP POLICY IF EXISTS avisos_preferencias_own ON avisos_preferencias;
CREATE POLICY avisos_preferencias_own ON avisos_preferencias FOR ALL
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

REVOKE ALL ON avisos_programados, avisos_preferencias FROM anon, authenticated;
GRANT SELECT ON avisos_programados TO authenticated;
GRANT INSERT (user_id, origen, titulo, cuerpo, url, cuando, tarea_path, tarea_line, tarea_texto) ON avisos_programados TO authenticated;
GRANT UPDATE (estado) ON avisos_programados TO authenticated;
GRANT SELECT, INSERT, UPDATE ON avisos_preferencias TO authenticated;
GRANT ALL ON avisos_programados, avisos_preferencias TO service_role;

COMMENT ON TABLE avisos_programados IS 'Avisos con hora (recordatorios, vencimientos, presupuestos). Los envía la función `avisos` cada minuto; reclamo atómico en avisos_reclamar.';

-- ------------------------------------------------------------
-- Textos (las comparten el encolado de vencimientos y el trigger de presupuestos)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION avisos_monto(p_monto NUMERIC, p_moneda TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE p_moneda WHEN 'PEN' THEN 'S/' WHEN 'USD' THEN 'US$' ELSE COALESCE(p_moneda, 'S/') END
           || ' ' || to_char(p_monto, 'FM999999999990.00');
$$;

CREATE OR REPLACE FUNCTION avisos_fecha_texto(p_fecha DATE) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT EXTRACT(day FROM p_fecha)::INT || ' de '
           || (ARRAY['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'])[EXTRACT(month FROM p_fecha)::INT];
$$;

CREATE OR REPLACE FUNCTION avisos_max_intentos() RETURNS INTEGER
LANGUAGE sql IMMUTABLE
AS $$ SELECT 4 $$;

-- ¿Este tipo de aviso está encendido para el usuario? Sin fila de preferencias, sí.
CREATE OR REPLACE FUNCTION avisos_origen_activo(p_user UUID, p_origen TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_origen IN ('vencimiento', 'tarjeta') THEN COALESCE((SELECT p.vencimientos FROM avisos_preferencias p WHERE p.user_id = p_user), TRUE)
        WHEN p_origen = 'presupuesto'               THEN COALESCE((SELECT p.presupuestos FROM avisos_preferencias p WHERE p.user_id = p_user), TRUE)
        ELSE TRUE
    END;
$$;

-- ¿Sigue vigente el aviso "mañana vence X"? Deja de serlo si el recurrente se desactivó, ya avanzó de fecha (la web lo avanza al
-- registrar el pago) o ya tiene un pago registrado en su ciclo (el agente registra pagos sin avanzar la fecha). Misma regla de
-- "pagado este mes" que el brief; en frecuencias menores a un mes se mira solo la última semana.
CREATE OR REPLACE FUNCTION avisos_vencimiento_vigente(p_recurring UUID, p_fecha DATE) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM recurring_transactions r
         WHERE r.recurring_id = p_recurring AND r.is_active AND r.next_due_date = p_fecha
           AND (r.end_date IS NULL OR r.end_date >= r.next_due_date)
           AND NOT EXISTS (
               SELECT 1 FROM transactions t
                WHERE t.recurring_id = r.recurring_id AND t.is_recurring
                  AND CASE WHEN r.frequency IN ('daily', 'weekly', 'biweekly')
                           THEN (t.transaction_date AT TIME ZONE 'America/Lima')::DATE >= p_fecha - 3
                           ELSE date_trunc('month', t.transaction_date AT TIME ZONE 'America/Lima') = date_trunc('month', p_fecha::TIMESTAMP)
                      END
           )
    );
$$;

-- ------------------------------------------------------------
-- Mantenimiento de la cola: rescata reclamos huérfanos, caduca lo que ya no sirve y omite vencimientos ya pagados.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION avisos_limpiar(p_ahora TIMESTAMPTZ DEFAULT now()) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    n INTEGER := 0;
    k INTEGER;
BEGIN
    -- Un reclamo sin cierre tras 5 min: el envío murió a medias. Vuelve a la cola (ya gastó un intento).
    UPDATE avisos_programados SET estado = 'pendiente', disponible_desde = p_ahora, detalle = 'el envío no terminó'
     WHERE estado = 'enviando' AND reclamado_at < p_ahora - INTERVAL '5 minutes';
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

    UPDATE avisos_programados SET estado = 'fallido', detalle = COALESCE(detalle, 'se agotaron los intentos')
     WHERE estado = 'pendiente' AND intentos >= avisos_max_intentos();
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

    UPDATE avisos_programados SET estado = 'caducado'
     WHERE estado = 'pendiente' AND caduca_at <= p_ahora;
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

    UPDATE avisos_programados SET estado = 'omitido', detalle = 'ya pagado o desactivado'
     WHERE estado = 'pendiente' AND origen = 'vencimiento' AND NOT avisos_vencimiento_vigente(entidad_id, fecha_ref);
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

    UPDATE avisos_programados s SET estado = 'omitido', detalle = 'tarjeta desactivada'
     WHERE s.estado = 'pendiente' AND s.origen = 'tarjeta'
       AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = s.entidad_id AND a.is_active AND a.account_type = 'credit_card');
    GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

    RETURN n;
END $$;

-- ¿Hay algo que enviar ahora? El cron lo consulta cada minuto y solo llama a la función `avisos` si es true: sin trabajo no hay
-- invocación (1440 al día → las que de verdad hacen falta).
CREATE OR REPLACE FUNCTION avisos_hay_trabajo(p_ahora TIMESTAMPTZ DEFAULT now()) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM avisos_programados a
         WHERE a.estado = 'pendiente' AND a.disponible_desde <= p_ahora AND a.caduca_at > p_ahora
           AND avisos_origen_activo(a.user_id, a.origen)
    ) OR EXISTS (
        SELECT 1 FROM avisos_programados WHERE estado = 'enviando' AND reclamado_at < p_ahora - INTERVAL '5 minutes'
    );
$$;

-- ------------------------------------------------------------
-- Reclamo atómico. Dos crons a la vez nunca reciben el mismo aviso: el UPDATE exige estado = 'pendiente' (si otra sesión ya lo
-- reclamó, Postgres relee la fila tras el bloqueo y deja de cumplirse) y la subconsulta usa FOR UPDATE SKIP LOCKED (la otra sesión
-- no espera: toma otros). Devuelve las filas reclamadas, con intentos ya sumado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION avisos_reclamar(p_limite INTEGER DEFAULT 20, p_ahora TIMESTAMPTZ DEFAULT now())
RETURNS SETOF avisos_programados
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM avisos_limpiar(p_ahora);
    -- El CTE va MATERIALIZED a propósito: con `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` el planificador puede
    -- reevaluar la subconsulta y reclamar más de n filas. Materializado, se elige y bloquea UNA vez.
    RETURN QUERY
    WITH elegidos AS MATERIALIZED (
        SELECT s.aviso_id FROM avisos_programados s
         WHERE s.estado = 'pendiente' AND s.disponible_desde <= p_ahora AND s.caduca_at > p_ahora
           AND avisos_origen_activo(s.user_id, s.origen)
         ORDER BY s.disponible_desde, s.cuando
         LIMIT LEAST(GREATEST(COALESCE(p_limite, 20), 1), 50)
         FOR UPDATE SKIP LOCKED
    ), reclamados AS (
        UPDATE avisos_programados a
           SET estado = 'enviando', reclamado_at = p_ahora, intentos = a.intentos + 1
          FROM elegidos e
         WHERE a.aviso_id = e.aviso_id AND a.estado = 'pendiente'
        RETURNING a.*
    )
    SELECT * FROM reclamados;
END $$;

-- Cierra un envío reclamado. ok → 'enviado'. Si no: espera 1, 3 y 9 min entre intentos y, agotados (avisos_max_intentos), 'fallido'.
-- Solo actúa sobre filas 'enviando': un cierre repetido o tardío no pisa nada. Devuelve el estado en que quedó (NULL si no actuó).
CREATE OR REPLACE FUNCTION avisos_cerrar(
    p_id UUID, p_ok BOOLEAN, p_detalle TEXT DEFAULT NULL, p_notification_id UUID DEFAULT NULL, p_ahora TIMESTAMPTZ DEFAULT now()
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    nuevo TEXT;
BEGIN
    UPDATE avisos_programados SET
        notification_id = COALESCE(p_notification_id, notification_id),
        detalle = left(p_detalle, 200),
        estado = CASE WHEN p_ok THEN 'enviado' WHEN intentos >= avisos_max_intentos() THEN 'fallido' ELSE 'pendiente' END,
        enviado_at = CASE WHEN p_ok THEN p_ahora ELSE enviado_at END,
        disponible_desde = CASE WHEN p_ok OR intentos >= avisos_max_intentos() THEN disponible_desde
                                ELSE p_ahora + (ARRAY[1, 3, 9])[LEAST(intentos, 3)] * INTERVAL '1 minute' END
     WHERE aviso_id = p_id AND estado = 'enviando'
    RETURNING estado INTO nuevo;
    RETURN nuevo;
END $$;

-- ------------------------------------------------------------
-- Vencimientos: pagos recurrentes de gasto y tarjetas de crédito, 1 día antes a las 9:00 de Lima.
-- Mira los vencimientos de pasado mañana y mañana (el aviso de uno sale a la hora 9:00 del día anterior). Si esa hora ya pasó
-- (el recurrente se creó hoy para mañana por la tarde), no se encola: no tiene sentido avisar de algo que David acaba de poner.
-- Idempotente: la llave (tipo:entidad:fecha) impide repetir el aviso del mismo vencimiento.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION avisos_encolar_vencimientos(p_ahora TIMESTAMPTZ DEFAULT now()) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hoy DATE := (p_ahora AT TIME ZONE 'America/Lima')::DATE;
    n INTEGER := 0;
    k INTEGER;
BEGIN
    WITH cand AS (
        SELECT r.user_id, r.recurring_id, r.description, r.amount, r.currency_code, r.next_due_date,
               ((r.next_due_date - 1)::TIMESTAMP + TIME '09:00') AT TIME ZONE 'America/Lima' AS cuando
          FROM recurring_transactions r
         WHERE r.is_active AND r.transaction_type = 'expense'
           AND r.next_due_date BETWEEN v_hoy + 1 AND v_hoy + 2
           AND (r.end_date IS NULL OR r.end_date >= r.next_due_date)
    ), ins AS (
        INSERT INTO avisos_programados (user_id, origen, titulo, cuerpo, url, cuando, entidad_id, fecha_ref, dedupe_key)
        SELECT c.user_id, 'vencimiento', left('Mañana vence ' || c.description, 120),
               avisos_monto(c.amount, c.currency_code) || ' · ' || avisos_fecha_texto(c.next_due_date),
               '/recurring', c.cuando, c.recurring_id, c.next_due_date,
               'vencimiento:' || c.recurring_id || ':' || c.next_due_date
          FROM cand c
         WHERE c.cuando >= p_ahora AND avisos_vencimiento_vigente(c.recurring_id, c.next_due_date)
        ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO k FROM ins;
    n := n + k;

    -- Tarjetas: el día de pago del mes (recortado al último día de meses cortos) de este mes y del siguiente.
    WITH meses AS (
        SELECT (date_trunc('month', v_hoy::TIMESTAMP) + (g || ' month')::INTERVAL)::DATE AS mes FROM generate_series(0, 1) g
    ), cand AS (
        SELECT a.user_id, a.account_id, a.account_name, a.current_balance, a.currency_code,
               m.mes + (LEAST(a.payment_due_day, EXTRACT(day FROM (m.mes + INTERVAL '1 month' - INTERVAL '1 day'))::INT) - 1) AS fecha_pago
          FROM accounts a CROSS JOIN meses m
         WHERE a.is_active AND a.account_type = 'credit_card' AND a.payment_due_day IS NOT NULL
    ), ins AS (
        INSERT INTO avisos_programados (user_id, origen, titulo, cuerpo, url, cuando, entidad_id, fecha_ref, dedupe_key)
        SELECT c.user_id, 'tarjeta', left('Mañana vence el pago de ' || c.account_name, 120),
               CASE WHEN c.current_balance > 0 THEN 'Debes ' || avisos_monto(c.current_balance, c.currency_code) || ' · ' || avisos_fecha_texto(c.fecha_pago)
                    ELSE 'Vence el ' || avisos_fecha_texto(c.fecha_pago) END,
               '/accounts', ((c.fecha_pago - 1)::TIMESTAMP + TIME '09:00') AT TIME ZONE 'America/Lima', c.account_id, c.fecha_pago,
               'tarjeta:' || c.account_id || ':' || c.fecha_pago
          FROM cand c
         WHERE c.fecha_pago BETWEEN v_hoy + 1 AND v_hoy + 2
           AND ((c.fecha_pago - 1)::TIMESTAMP + TIME '09:00') AT TIME ZONE 'America/Lima' >= p_ahora
        ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO k FROM ins;
    n := n + k;

    RETURN n;
END $$;

-- Lo terminado hace más de 90 días se borra (la llave de un aviso viejo ya no puede repetirse: lleva la fecha o el mes).
CREATE OR REPLACE FUNCTION avisos_purgar(p_ahora TIMESTAMPTZ DEFAULT now()) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    n INTEGER;
BEGIN
    DELETE FROM avisos_programados
     WHERE estado IN ('enviado', 'cancelado', 'omitido', 'caducado', 'fallido') AND cuando < p_ahora - INTERVAL '90 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Lo que corre cada hora (job wabid-avisos-mantener).
CREATE OR REPLACE FUNCTION avisos_mantener(p_ahora TIMESTAMPTZ DEFAULT now()) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    limpiados INTEGER := avisos_limpiar(p_ahora);
    encolados INTEGER := avisos_encolar_vencimientos(p_ahora);
    purgados  INTEGER := avisos_purgar(p_ahora);
BEGIN
    RETURN jsonb_build_object('limpiados', limpiados, 'encolados', encolados, 'purgados', purgados);
END $$;

-- ------------------------------------------------------------
-- Presupuestos: avisa al pasar el umbral del presupuesto mensual de la categoría (alert_threshold, 80 % por defecto) y el 100 %.
--   * Una sola vez por presupuesto, umbral y mes de Lima (llave presupuesto:<id>:<AAAA-MM>:<80|100>).
--   * Si un solo gasto cruza los dos umbrales a la vez, sale solo el del 100 % y el otro queda 'omitido' (no son dos avisos seguidos).
--   * Solo cuenta el mes en curso: un gasto atrasado de un mes cerrado no avisa.
--   * Suma igual que fn_get_budget_status (gastos de la categoría, sin subcategorías ni monedas), pero con el mes de Lima.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION avisos_evaluar_presupuestos(
    p_user UUID, p_categoria UUID, p_fecha_gasto TIMESTAMPTZ, p_ahora TIMESTAMPTZ DEFAULT now()
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    b RECORD;
    v_mes_gasto TIMESTAMP := date_trunc('month', p_fecha_gasto AT TIME ZONE 'America/Lima');
    v_mes TIMESTAMP := date_trunc('month', p_ahora AT TIME ZONE 'America/Lima');
    v_desde TIMESTAMPTZ := v_mes AT TIME ZONE 'America/Lima';
    v_hasta TIMESTAMPTZ := (v_mes + INTERVAL '1 month') AT TIME ZONE 'America/Lima';
    v_periodo TEXT := to_char(v_mes, 'YYYY-MM');
    v_gastado NUMERIC;
    v_umbral NUMERIC;
    v_pct INTEGER;
    v_clave TEXT;
    n INTEGER := 0;
    k INTEGER;
BEGIN
    IF v_mes_gasto <> v_mes THEN RETURN 0; END IF;

    FOR b IN
        SELECT bu.budget_id, bu.amount_limit, bu.alert_threshold, c.category_name, COALESCE(u.default_currency, 'PEN') AS moneda
          FROM budgets bu
          JOIN categories c ON c.category_id = bu.category_id
          LEFT JOIN users u ON u.user_id = bu.user_id
         WHERE bu.user_id = p_user AND bu.category_id = p_categoria AND bu.is_active AND bu.period_type = 'monthly'
    LOOP
        SELECT COALESCE(SUM(t.amount), 0) INTO v_gastado
          FROM transactions t
         WHERE t.user_id = p_user AND t.category_id = p_categoria AND t.transaction_type = 'expense'
           AND t.transaction_date >= v_desde AND t.transaction_date < v_hasta;
        v_umbral := CASE WHEN b.alert_threshold > 0 AND b.alert_threshold < 1 THEN b.alert_threshold ELSE 0.80 END;
        v_pct := round(v_gastado / b.amount_limit * 100)::INT;
        v_clave := 'presupuesto:' || b.budget_id || ':' || v_periodo || ':';

        IF v_gastado >= b.amount_limit THEN
            INSERT INTO avisos_programados (user_id, origen, titulo, cuerpo, url, cuando, entidad_id, fecha_ref, dedupe_key)
            VALUES (p_user, 'presupuesto', left('Pasaste tu presupuesto de ' || b.category_name, 120),
                    avisos_monto(v_gastado, b.moneda) || ' de ' || avisos_monto(b.amount_limit, b.moneda) || ' este mes (' || v_pct || ' %).',
                    '/budgets', p_ahora, b.budget_id, v_mes::DATE, v_clave || '100')
            ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
            GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
            IF k > 0 THEN
                -- El aviso del umbral previo, si aún no salió, sobra; y si nunca existió, se deja asentado para que no salga después.
                UPDATE avisos_programados SET estado = 'omitido', detalle = 'superado por el 100 %'
                 WHERE user_id = p_user AND dedupe_key = v_clave || round(v_umbral * 100)::INT AND estado = 'pendiente';
                INSERT INTO avisos_programados (user_id, origen, titulo, cuerpo, cuando, entidad_id, fecha_ref, dedupe_key, estado, detalle)
                VALUES (p_user, 'presupuesto', left('Presupuesto de ' || b.category_name, 120), '', p_ahora, b.budget_id, v_mes::DATE,
                        v_clave || round(v_umbral * 100)::INT, 'omitido', 'superado por el 100 %')
                ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
            END IF;
        ELSIF v_gastado >= b.amount_limit * v_umbral THEN
            INSERT INTO avisos_programados (user_id, origen, titulo, cuerpo, url, cuando, entidad_id, fecha_ref, dedupe_key)
            VALUES (p_user, 'presupuesto', left('Presupuesto de ' || b.category_name || ' al ' || v_pct || ' %', 120),
                    'Llevas ' || avisos_monto(v_gastado, b.moneda) || ' de ' || avisos_monto(b.amount_limit, b.moneda) || ' este mes.',
                    '/budgets', p_ahora, b.budget_id, v_mes::DATE, v_clave || round(v_umbral * 100)::INT)
            ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
            GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
        END IF;
    END LOOP;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION trg_transactions_avisos_presupuesto() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.transaction_type = 'expense' AND NEW.category_id IS NOT NULL THEN
        BEGIN
            PERFORM avisos_evaluar_presupuestos(NEW.user_id, NEW.category_id, NEW.transaction_date);
        EXCEPTION WHEN OTHERS THEN
            -- Registrar un gasto nunca falla por un aviso.
            RAISE WARNING 'avisos de presupuesto: % (%)', SQLERRM, SQLSTATE;
        END;
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_transactions_avisos_presupuesto ON transactions;
CREATE TRIGGER trg_transactions_avisos_presupuesto
    AFTER INSERT OR UPDATE OF amount, category_id, transaction_date, transaction_type ON transactions
    FOR EACH ROW EXECUTE FUNCTION trg_transactions_avisos_presupuesto();

-- ------------------------------------------------------------
-- Permisos de las funciones. Supabase concede EXECUTE a anon y authenticated por defecto: se quita. Estas funciones reciben un
-- user_id como parámetro y corren con los permisos del dueño; solo el rol de servicio (la función `avisos`) y pg_cron las llaman.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
    avisos_fijar_ventanas(), avisos_origen_activo(UUID, TEXT), avisos_vencimiento_vigente(UUID, DATE), avisos_limpiar(TIMESTAMPTZ),
    avisos_hay_trabajo(TIMESTAMPTZ), avisos_reclamar(INTEGER, TIMESTAMPTZ), avisos_cerrar(UUID, BOOLEAN, TEXT, UUID, TIMESTAMPTZ),
    avisos_encolar_vencimientos(TIMESTAMPTZ), avisos_purgar(TIMESTAMPTZ), avisos_mantener(TIMESTAMPTZ),
    avisos_evaluar_presupuestos(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ), trg_transactions_avisos_presupuesto()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    avisos_origen_activo(UUID, TEXT), avisos_vencimiento_vigente(UUID, DATE), avisos_limpiar(TIMESTAMPTZ),
    avisos_hay_trabajo(TIMESTAMPTZ), avisos_reclamar(INTEGER, TIMESTAMPTZ), avisos_cerrar(UUID, BOOLEAN, TEXT, UUID, TIMESTAMPTZ),
    avisos_encolar_vencimientos(TIMESTAMPTZ), avisos_purgar(TIMESTAMPTZ), avisos_mantener(TIMESTAMPTZ)
TO service_role;

-- ==== CRON (pg_cron y pg_net: no existen en PGlite; check-017.mjs corta aquí y prueba esta parte contra dobles) ====
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Idempotente: si los jobs ya existen se reemplazan.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wabid-avisos') THEN
        PERFORM cron.unschedule('wabid-avisos');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'wabid-avisos-mantener') THEN
        PERFORM cron.unschedule('wabid-avisos-mantener');
    END IF;

    -- Cada minuto: si hay avisos por enviar, llama a la función `avisos`. El secreto sale del Vault, no del SQL.
    PERFORM cron.schedule(
        'wabid-avisos',
        '* * * * *',
        $job$
        SELECT net.http_post(
            url := 'https://rrhyyclltgaecfyertqh.supabase.co/functions/v1/avisos?forceFunctionRegion=us-west-2',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'x-avisos-secret', COALESCE(
                    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'avisos_cron_secret'), '')
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 30000
        )
        WHERE public.avisos_hay_trabajo();
        $job$
    );

    -- Cada hora, al minuto 5: encola los vencimientos de mañana y pasado, limpia la cola y purga lo viejo. No usa HTTP ni secretos.
    PERFORM cron.schedule(
        'wabid-avisos-mantener',
        '5 * * * *',
        $job$ SELECT public.avisos_mantener(); $job$
    );
END $$;
