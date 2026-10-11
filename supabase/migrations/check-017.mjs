// Prueba la migración 017 contra un Postgres real (PGlite, WASM): aplica 001 → 016 y luego 017 (017 tres veces: idempotencia; 017 depende de 016) y comprueba
//   (a) la cola: reclamo atómico (dos "crons" a la vez, y con una lectura vieja), reintentos acotados, caducidad, reclamos huérfanos y preferencias;
//   (b) los vencimientos de recurrentes y tarjetas (1 día antes, 9:00 Lima, medianoche, fin de mes, meses cortos, sin duplicar tras cancelar);
//   (c) el trigger de presupuestos (80 % y 100 % una sola vez por mes de Lima, un gasto que cruza los dos, que registrar un gasto nunca falle);
//   (d) la RLS y los permisos de columnas y funciones, con roles de Supabase y sus privilegios por defecto;
//   (e) el job de pg_cron. PGlite NO trae pg_cron, pg_net ni Vault: la sección CRON de la migración (después de la marca "==== CRON") se corre
//       contra dobles de esos tres (tabla cron.job, net.http_post que apunta la llamada, vault.decrypted_secrets) y se EJECUTA el comando guardado
//       de cada job. Lo que NO se prueba aquí es el planificador real de pg_cron ni la entrega de pg_net: eso solo se ve en Supabase.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-017.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PGLITE_DIR) {
  console.log("PGLITE_DIR no está definido: se omite (instala @electric-sql/pglite en una carpeta temporal y apúntalo ahí).");
  process.exit(0);
}
const url = (...p) => pathToFileURL(path.join(process.env.PGLITE_DIR, ...p)).href;
const { PGlite } = await import(url("dist", "index.js"));
const { unaccent } = await import(url("dist", "contrib", "unaccent.js"));
const dir = import.meta.dirname;
const db = new PGlite({ extensions: { unaccent } });

// ---------------------------------------------------------------------------------------------------------------------------------
// Un "Supabase" mínimo: roles, auth.uid(), los privilegios por defecto (Supabase da ALL a anon/authenticated/service_role sobre lo que
// se crea en public; por eso la migración debe REVOCAR lo que no corresponde) y dobles de Vault, pg_cron y pg_net (PGlite no los trae).
// ---------------------------------------------------------------------------------------------------------------------------------
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA extensions;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, extensions, public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

  CREATE SCHEMA vault;
  CREATE TABLE vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
  CREATE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
  CREATE FUNCTION vault.create_secret(s text, n text DEFAULT NULL, d text DEFAULT NULL) RETURNS uuid LANGUAGE sql AS
    $$ INSERT INTO vault.secrets (name, secret) VALUES (n, s) RETURNING id $$;
  CREATE FUNCTION vault.update_secret(i uuid, s text) RETURNS void LANGUAGE sql AS $$ UPDATE vault.secrets SET secret = s WHERE id = i $$;

  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text, schedule text, command text);
  CREATE TABLE cron.job_run_details (runid serial PRIMARY KEY, jobid int, status text, end_time timestamptz);
  CREATE FUNCTION cron.schedule(n text, s text, c text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (n, s, c) RETURNING jobid::bigint $$;
  CREATE FUNCTION cron.unschedule(n text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = n; SELECT true $$;

  CREATE SCHEMA net;
  CREATE TABLE net.llamadas (url text, headers jsonb, body jsonb, timeout_ms int);
  CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{"Content-Type": "application/json"}', timeout_milliseconds int DEFAULT 5000)
    RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.llamadas VALUES (url, headers, body, timeout_milliseconds) RETURNING 1::bigint $$;
`);
const leer = (f) => readFileSync(path.resolve(dir, f), "utf8");
const archivo = (prefijo) => readdirSync(dir).find((f) => f.startsWith(`${prefijo}_`) && f.endsWith(".sql"));
// Las extensiones que PGlite no trae se quitan del texto; sus esquemas ya están simulados arriba.
const sinExtensiones = (sql) => sql.replace(/^CREATE EXTENSION IF NOT EXISTS\s+("uuid-ossp"|supabase_vault|pg_cron|pg_net).*$/gim, "");
const run = (f) => db.exec(sinExtensiones(leer(f)));
// 017 DEPENDE DE 016 (suma los gastos en soles con fn_a_soles): se aplica todo 001 → 016 antes.
for (let n = 1; n <= 16; n++) await run(archivo(String(n).padStart(3, "0")));
await db.exec(`
  INSERT INTO currencies (currency_code, currency_name, symbol) VALUES ('PEN', 'Sol', 'S/'), ('USD', 'Dólar', '$') ON CONFLICT DO NOTHING;
`);

// 017 sin la sección CRON (pg_cron no existe aquí). Tres veces: idempotencia.
// CHECK_017_ARCHIVO permite correr el check contra una copia mutada de la migración (y comprobar que falla).
const completa = leer(process.env.CHECK_017_ARCHIVO ?? "017_avisos_programados.sql");
const MARCA = "-- ==== CRON";
assert.ok(completa.includes(MARCA), "la migración trae la marca de la sección CRON");
const [sinCron, cron] = [completa.slice(0, completa.indexOf(MARCA)), completa.slice(completa.indexOf(MARCA))];
const inventario = async () => {
  const q = async (sql) => (await db.query(sql)).rows[0].n;
  return {
    funciones: await q(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname LIKE 'avisos\\_%' OR p.proname = 'trg_transactions_avisos_presupuesto'`),
    politicas: await q(`SELECT count(*)::int n FROM pg_policies WHERE tablename IN ('avisos_programados', 'avisos_preferencias')`),
    triggers: await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('trg_avisos_ventanas', 'trg_transactions_avisos_presupuesto')`),
    indices: await q(`SELECT count(*)::int n FROM pg_indexes WHERE tablename = 'avisos_programados'`),
    checks: await q(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'avisos_programados'::regclass AND contype = 'c'`),
  };
};
await db.exec(sinCron);
const inv1 = await inventario();
await db.exec(sinCron);
await db.exec(sinCron);
assert.deepEqual(await inventario(), inv1, "aplicar 017 otra vez no duplica funciones, políticas, triggers, índices ni checks");
assert.ok(inv1.funciones >= 14 && inv1.politicas === 4 && inv1.triggers === 2, `inventario inesperado: ${JSON.stringify(inv1)}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------------------------------------------
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const uno = async (sql, params = []) => (await q(sql, params))[0];
const como = async (rol, user, sql, params = []) => {
  await db.exec(`SET ROLE ${rol}; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
const falla = (rol, user, sql, params, re) => assert.rejects(() => como(rol, user, sql, params), re);
const RLS = /row-level security|violates row-level/i;
const PERMISO = /permission denied/i;

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
await db.exec(`INSERT INTO auth.users VALUES ('${A}'), ('${B}'); INSERT INTO users (user_id, display_name) VALUES ('${A}', 'David'), ('${B}', 'Otro');`);

let semilla = 0;
// Inserta un aviso directamente (como el rol de servicio); devuelve su id.
const aviso = async (o = {}) => {
  const f = {
    user: A, origen: "recordatorio", titulo: `Aviso ${++semilla}`, cuando: "now() - interval '1 minute'", estado: "pendiente", intentos: 0,
    entidad: null, fechaRef: null, clave: null, reclamado: null, ...o,
  };
  return (await uno(
    `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, estado, intentos, entidad_id, fecha_ref, dedupe_key, reclamado_at, enviado_at)
     VALUES ($1, $2, $3, ${f.cuando}, $4, $5, $6, $7, $8, ${f.reclamado ?? "NULL"}, CASE WHEN $9::text = 'enviado' THEN now() END) RETURNING aviso_id`,
    [f.user, f.origen, f.titulo, f.estado, f.intentos, f.entidad, f.fechaRef, f.clave, f.estado],
  )).aviso_id;
};
const estado = async (id) => (await uno(`SELECT estado, intentos, detalle FROM avisos_programados WHERE aviso_id = $1`, [id]));
const limpiarCola = () => db.exec(`DELETE FROM avisos_programados`);

// PGlite trae la base de zonas horarias? Todo lo de Lima depende de eso.
assert.equal((await uno(`SELECT to_char('2026-10-12T03:30:00Z'::timestamptz AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS t`)).t, "2026-10-11 22:30", "America/Lima existe y es UTC-5");

// ---------------------------------------------------------------------------------------------------------------------------------
// Ventanas (trigger BEFORE INSERT)
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const dias = async (origen) => {
    const id = await aviso({ origen, cuando: "'2026-10-12T22:00:00Z'::timestamptz", titulo: `ventana ${origen}`, entidad: origen === "recordatorio" ? null : A });
    const r = await uno(`SELECT EXTRACT(epoch FROM caduca_at - cuando) / 3600 AS h, disponible_desde = cuando AS igual FROM avisos_programados WHERE aviso_id = $1`, [id]);
    return { h: Number(r.h), igual: r.igual };
  };
  assert.deepEqual(await dias("recordatorio"), { h: 2, igual: true }, "un recordatorio vale 2 h después de su hora");
  assert.deepEqual(await dias("vencimiento"), { h: 12, igual: true });
  assert.deepEqual(await dias("presupuesto"), { h: 6, igual: true });
  await limpiarCola();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// (a) Cola: reclamo, reintentos, caducidad, huérfanos, preferencias
// ---------------------------------------------------------------------------------------------------------------------------------
{
  // La atomicidad depende de piezas concretas del texto de la función. PGlite tiene UNA conexión y no puede probar la carrera, así que
  // se fijan aquí: quitar FOR UPDATE SKIP LOCKED, el CTE MATERIALIZED o la guarda `estado = 'pendiente'` del UPDATE hace fallar este check.
  // (La carrera real se probó con sesiones simultáneas de Postgres 16: ver la sección de pruebas del commit.)
  // pg_get_functiondef trae el cuerpo CON sus comentarios (el de este CTE nombra SKIP LOCKED y MATERIALIZED): se quitan, para que solo
  // cuente SQL ejecutable y una mutación no quede tapada por su propio comentario.
  const def = (await uno(`SELECT pg_get_functiondef('avisos_reclamar(integer, timestamptz)'::regprocedure) AS d`)).d.replace(/--[^\n]*/g, "");
  assert.match(def, /FOR UPDATE SKIP LOCKED/, "el reclamo debe saltar lo bloqueado por otra sesión");
  assert.match(def, /AS MATERIALIZED/, "el CTE materializado evita reevaluar la subconsulta con LIMIT + SKIP LOCKED");
  assert.match(def, /AND a\.estado = 'pendiente'/, "el UPDATE debe exigir estado = 'pendiente' (guarda contra una lectura vieja)");
  assert.match(def, /intentos = a\.intentos \+ 1/);
  const ahora = "2026-10-12T15:00:00Z";
  const ts = (min) => `'${ahora}'::timestamptz + interval '${min} minutes'`;
  const vencido1 = await aviso({ cuando: ts(-3), titulo: "vencido 1" });
  const vencido2 = await aviso({ cuando: ts(-2), titulo: "vencido 2" });
  const vencido3 = await aviso({ cuando: ts(-1), titulo: "vencido 3" });
  const futuro = await aviso({ cuando: ts(10), titulo: "futuro" });
  const caducado = await aviso({ cuando: ts(-180), titulo: "caducado (hace 3 h, vale 2 h)" });

  assert.equal((await uno(`SELECT avisos_hay_trabajo($1) AS t`, [ahora])).t, true, "hay trabajo");

  // Dos "crons" a la vez: ninguno recibe el aviso del otro y entre los dos salen todos, una sola vez.
  const [r1, r2] = await Promise.all([q(`SELECT aviso_id FROM avisos_reclamar(2, $1)`, [ahora]), q(`SELECT aviso_id FROM avisos_reclamar(2, $1)`, [ahora])]);
  const ids1 = r1.map((r) => r.aviso_id), ids2 = r2.map((r) => r.aviso_id);
  assert.equal(ids1.filter((i) => ids2.includes(i)).length, 0, "ningún aviso se reclama dos veces");
  assert.deepEqual([...ids1, ...ids2].sort(), [vencido1, vencido2, vencido3].sort(), "entre los dos salen los 3 vencidos, ni uno más");
  assert.deepEqual(await estado(futuro), { estado: "pendiente", intentos: 0, detalle: null }, "el futuro no se toca");
  assert.equal((await estado(caducado)).estado, "caducado", "lo que ya no sirve se caduca sin enviarse");
  const rec = await uno(`SELECT estado, intentos, reclamado_at FROM avisos_programados WHERE aviso_id = $1`, [vencido1]);
  assert.equal(rec.estado, "enviando");
  assert.equal(rec.intentos, 1);

  // Lectura vieja: el cron A vio los pendientes ANTES de que B los reclamara; su UPDATE (con la guarda estado = 'pendiente') no pisa nada.
  await limpiarCola();
  const x = await aviso({ cuando: ts(-1) });
  const vistoPorA = (await q(`SELECT aviso_id FROM avisos_programados WHERE estado = 'pendiente'`)).map((r) => r.aviso_id);
  assert.deepEqual(vistoPorA, [x]);
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1)`, [ahora])).length, 1, "B lo reclama");
  const pisado = await q(`UPDATE avisos_programados SET estado = 'enviando', intentos = intentos + 1 WHERE aviso_id = ANY($1::uuid[]) AND estado = 'pendiente' RETURNING aviso_id`, [vistoPorA]);
  assert.equal(pisado.length, 0, "A no reclama lo que B ya reclamó");
  assert.equal((await estado(x)).intentos, 1, "intentos sumado una sola vez");
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1)`, [ahora])).length, 0, "un segundo reclamo no devuelve nada");

  // Cierre: ok.
  assert.equal((await uno(`SELECT avisos_cerrar($1, true, 'push') AS e`, [x])).e, "enviado");
  assert.equal((await uno(`SELECT avisos_cerrar($1, true, 'push') AS e`, [x])).e, null, "un cierre repetido no hace nada");
  assert.equal((await estado(x)).estado, "enviado");

  // Reintentos acotados: espera 1, 3 y 9 min; al 4.º intento fallido, 'fallido'. No se reclama antes de tiempo.
  await limpiarCola();
  const r = await aviso({ cuando: ts(-1) });
  const esperas = [];
  let reloj = ahora;
  for (let intento = 1; intento <= 4; intento++) {
    const salio = await q(`SELECT intentos FROM avisos_reclamar(5, $1)`, [reloj]);
    assert.equal(salio.length, 1, `intento ${intento}: se reclama`);
    assert.equal(salio[0].intentos, intento);
    const fin = (await uno(`SELECT avisos_cerrar($1, false, 'push 503', NULL, $2) AS e`, [r, reloj])).e;
    if (intento < 4) {
      assert.equal(fin, "pendiente");
      const prox = await uno(`SELECT EXTRACT(epoch FROM disponible_desde - $2::timestamptz) / 60 AS m FROM avisos_programados WHERE aviso_id = $1`, [r, reloj]);
      esperas.push(Number(prox.m));
      assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1::timestamptz + interval '30 seconds')`, [reloj])).length, 0, "durante la espera no se reclama");
      reloj = (await uno(`SELECT ($1::timestamptz + make_interval(mins => $2)) AS t`, [reloj, esperas.at(-1)])).t.toISOString();
    } else {
      assert.equal(fin, "fallido", "agotados los intentos: fallido");
    }
  }
  assert.deepEqual(esperas, [1, 3, 9], "espera creciente entre intentos");
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1::timestamptz + interval '2 hours')`, [reloj])).length, 0, "un fallido no vuelve");

  // Reintento que pasa la caducidad: se caduca en vez de enviarse tarde.
  await limpiarCola();
  const t = await aviso({ cuando: ts(-100) }); // vale 2 h: caduca a los +20 min de `ahora`
  await q(`SELECT 1 FROM avisos_reclamar(5, $1)`, [ahora]);
  await q(`SELECT avisos_cerrar($1, false, 'push 503', NULL, $2)`, [t, ahora]); // reintenta en 1 min
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1::timestamptz + interval '10 minutes')`, [ahora])).length, 1, "dentro de la ventana sigue valiendo");
  await q(`SELECT avisos_cerrar($1, false, 'push 503', NULL, $2::timestamptz + interval '10 minutes')`, [t, ahora]); // reintenta en 3 min (+13)
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, $1::timestamptz + interval '30 minutes')`, [ahora])).length, 0, "pasada la ventana ya no se envía");
  assert.equal((await estado(t)).estado, "caducado");

  // Reclamo huérfano: el envío murió a medias → vuelve a la cola pasados 5 min.
  await limpiarCola();
  const h = await aviso({ cuando: ts(-1) });
  await q(`SELECT 1 FROM avisos_reclamar(5, $1)`, [ahora]);
  assert.equal((await uno(`SELECT avisos_hay_trabajo($1::timestamptz + interval '1 minute') AS t`, [ahora])).t, false, "recién reclamado: nada que hacer");
  assert.equal((await uno(`SELECT avisos_hay_trabajo($1::timestamptz + interval '6 minutes') AS t`, [ahora])).t, true, "reclamo viejo: hay que rescatarlo");
  const otra = await q(`SELECT aviso_id, intentos FROM avisos_reclamar(5, $1::timestamptz + interval '6 minutes')`, [ahora]);
  assert.deepEqual(otra.map((x) => [x.aviso_id, x.intentos]), [[h, 2]], "se vuelve a reclamar (2.º intento)");

  // Orden y límite: salen primero los más antiguos; el límite se respeta.
  await limpiarCola();
  const o = [await aviso({ cuando: ts(-1) }), await aviso({ cuando: ts(-5) }), await aviso({ cuando: ts(-3) })];
  assert.deepEqual((await q(`SELECT aviso_id FROM avisos_reclamar(2, $1)`, [ahora])).map((x) => x.aviso_id).sort(), [o[1], o[2]].sort());

  // Preferencias: apagadas, el vencimiento se queda 'pendiente' (no se envía ni se pierde); encendidas, sale.
  await limpiarCola();
  const p = await aviso({ origen: "presupuesto", cuando: ts(-1), titulo: "presupuesto" });
  const v = await aviso({ origen: "recordatorio", cuando: ts(-1), titulo: "recordatorio" });
  await db.exec(`INSERT INTO avisos_preferencias (user_id, presupuestos) VALUES ('${A}', false)`);
  assert.deepEqual((await q(`SELECT aviso_id FROM avisos_reclamar(5, $1)`, [ahora])).map((x) => x.aviso_id), [v], "con presupuestos apagado solo sale el recordatorio");
  assert.equal((await estado(p)).estado, "pendiente");
  assert.equal((await uno(`SELECT avisos_hay_trabajo($1) AS t`, [ahora])).t, false, "apagado: el cron no despierta la función");
  await db.exec(`UPDATE avisos_preferencias SET presupuestos = true WHERE user_id = '${A}'`);
  assert.deepEqual((await q(`SELECT aviso_id FROM avisos_reclamar(5, $1)`, [ahora])).map((x) => x.aviso_id), [p], "encendido otra vez: sale");
  await db.exec(`DELETE FROM avisos_preferencias`);
  await limpiarCola();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// (b) Vencimientos
// ---------------------------------------------------------------------------------------------------------------------------------
const cuenta = async (user, nombre, tipo, extra = {}) =>
  (await uno(
    `INSERT INTO accounts (user_id, account_name, account_type, currency_code, current_balance, payment_due_day, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING account_id`,
    [user, nombre, tipo, extra.moneda ?? "PEN", extra.saldo ?? 0, extra.dia ?? null, extra.activa ?? true],
  )).account_id;
const recurrente = async (user, cuentaId, desc, monto, siguiente, extra = {}) =>
  (await uno(
    `INSERT INTO recurring_transactions (user_id, account_id, transaction_type, amount, currency_code, description, frequency, start_date, next_due_date, is_active, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01', $8, $9, $10) RETURNING recurring_id`,
    [user, cuentaId, extra.tipo ?? "expense", monto, extra.moneda ?? "PEN", desc, extra.frecuencia ?? "monthly", siguiente, extra.activo ?? true, extra.fin ?? null],
  )).recurring_id;
const avisosDe = async (origen) => q(`SELECT titulo, cuerpo, url, to_char(cuando AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS lima, fecha_ref::text AS fecha_ref, estado FROM avisos_programados WHERE origen = $1 ORDER BY cuando, titulo`, [origen]);
{
  const banco = await cuenta(A, "BCP", "checking");
  const netflix = await recurrente(A, banco, "Netflix", 52, "2026-10-12");
  await recurrente(A, banco, "Gimnasio", 120, "2026-10-13", { moneda: "USD" });
  await recurrente(A, banco, "Seguro (lejos)", 80, "2026-10-14");
  await recurrente(A, banco, "Sueldo", 3000, "2026-10-12", { tipo: "income" });
  await recurrente(A, banco, "Pausado", 10, "2026-10-12", { activo: false });
  await recurrente(A, banco, "Terminó ayer", 10, "2026-10-12", { fin: "2026-10-11" });
  await recurrente(A, banco, "Diario", 5, "2026-10-12", { frecuencia: "daily" }); // «mañana vence» de algo diario o semanal es ruido
  await recurrente(A, banco, "Semanal", 15, "2026-10-12", { frecuencia: "weekly" });
  await recurrente(B, await cuenta(B, "Caja B", "cash"), "Luz de B", 90, "2026-10-12");

  // 06:00 Lima del domingo 11 (11:00 UTC): los de mañana (12) salen hoy a las 9:00; los de pasado mañana (13), mañana a las 9:00.
  const n1 = (await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T11:00:00Z') AS n`)).n;
  const venc = await avisosDe("vencimiento");
  assert.equal(n1, 3, JSON.stringify(venc));
  assert.deepEqual(venc.map((x) => [x.titulo, x.lima]), [
    ["Mañana vence Luz de B", "2026-10-11 09:00"],
    ["Mañana vence Netflix", "2026-10-11 09:00"],
    ["Mañana vence Gimnasio", "2026-10-12 09:00"],
  ], "1 día antes a las 9:00 de Lima; ni ingresos, ni pausados, ni terminados, ni los de 3 días");
  assert.equal(venc.find((x) => x.titulo.includes("Netflix")).cuerpo, "S/ 52.00 · 12 de octubre");
  assert.equal(venc.find((x) => x.titulo.includes("Gimnasio")).cuerpo, "US$ 120.00 · 13 de octubre");
  assert.ok(venc.every((x) => x.url === "/recurring" && x.estado === "pendiente"));

  // Idempotente, también tras cancelar (cancelar no "libera" la llave).
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T11:00:00Z') AS n`)).n, 0, "correr dos veces no duplica");
  await db.exec(`UPDATE avisos_programados SET estado = 'cancelado' WHERE titulo = 'Mañana vence Netflix'`);
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T11:00:00Z') AS n`)).n, 0, "cancelado no vuelve a encolarse");
  // Una hora después sigue sin repetirse.
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T12:00:00Z') AS n`)).n, 0);

  // Si la hora de las 9:00 ya pasó (10:00 Lima), el de mañana no se encola.
  await limpiarCola();
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T15:00:00Z') AS n`)).n, 1, "solo Gimnasio (13): su aviso es mañana 9:00");
  await limpiarCola();

  // Medianoche: 22:30 de Lima del 11 ya es 12 en UTC. Para Lima "hoy" es el 11: el de 14 queda fuera.
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-10-13' WHERE description = 'Seguro (lejos)'`);
  const n2 = (await uno(`SELECT avisos_encolar_vencimientos('2026-10-12T03:30:00Z') AS n`)).n;
  const noche = (await avisosDe("vencimiento")).map((x) => x.titulo);
  assert.equal(n2, 2, `a las 22:30 de Lima el día es el 11: los del 13 entran (su 9:00 es mañana); los del 12 no (su 9:00 ya pasó). ${noche}`);
  assert.deepEqual(noche.sort(), ["Mañana vence Gimnasio", "Mañana vence Seguro (lejos)"]);
  await limpiarCola();
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-10-14' WHERE description = 'Seguro (lejos)'`);
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-12T03:30:00Z') AS n`)).n, 1, "a las 22:30 de Lima el 14 sigue lejos: solo Gimnasio (con la fecha UTC, 12, entraría el 14 también)");
  await limpiarCola();

  // Cambio de mes: el 30 de octubre, un pago del 1 de noviembre avisa el 31 a las 9:00.
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-11-01' WHERE description = 'Netflix'`);
  await db.exec(`DELETE FROM recurring_transactions WHERE description NOT IN ('Netflix')`);
  const n3 = (await uno(`SELECT avisos_encolar_vencimientos('2026-10-30T14:00:00Z') AS n`)).n;
  assert.equal(n3, 1);
  assert.deepEqual((await avisosDe("vencimiento")).map((x) => [x.lima, x.fecha_ref, x.cuerpo]), [["2026-10-31 09:00", "2026-11-01", "S/ 52.00 · 1 de noviembre"]]);
  await limpiarCola();

  // Ya pagado: la web avanza la fecha al registrar el pago → el aviso encolado se omite al limpiar; el agente registra el pago sin avanzar → también.
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-10-12'`);
  await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T11:00:00Z') AS n`);
  assert.equal((await q(`SELECT 1 FROM avisos_programados WHERE estado = 'pendiente'`)).length, 1);
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-11-12'`); // la web lo avanzó tras pagar
  await uno(`SELECT avisos_limpiar('2026-10-11T12:00:00Z')`);
  assert.deepEqual(await q(`SELECT estado FROM avisos_programados`), [{ estado: "omitido" }]);
  await limpiarCola();
  await db.exec(`UPDATE recurring_transactions SET next_due_date = '2026-10-12'`);
  await db.query(`INSERT INTO transactions (user_id, account_id, transaction_type, amount, transaction_date, is_recurring, recurring_id) VALUES ($1, $2, 'expense', 52, '2026-10-05T17:00:00Z', true, $3)`, [A, banco, netflix]);
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-11T11:00:00Z') AS n`)).n, 0, "pagado este mes (registrado por el agente): no se encola");
  await db.exec(`DELETE FROM transactions; DELETE FROM recurring_transactions`);
  await limpiarCola();

  // Tarjetas: día de pago, recortado en meses cortos; cruza de mes; solo activas con día de pago.
  const visa = await cuenta(A, "Visa", "credit_card", { dia: 15, saldo: 850.5 });
  await cuenta(A, "Amex sin saldo", "credit_card", { dia: 15 });
  await cuenta(A, "Vieja", "credit_card", { dia: 15, activa: false });
  await cuenta(A, "Sin día", "credit_card");
  await cuenta(A, "Ahorros", "savings", { dia: 15 });
  const n4 = (await uno(`SELECT avisos_encolar_vencimientos('2026-10-14T11:00:00Z') AS n`)).n;
  const tj = await avisosDe("tarjeta");
  assert.equal(n4, 2, JSON.stringify(tj));
  assert.deepEqual(tj.map((x) => [x.titulo, x.lima, x.fecha_ref]), [
    ["Mañana vence el pago de Amex sin saldo", "2026-10-14 09:00", "2026-10-15"],
    ["Mañana vence el pago de Visa", "2026-10-14 09:00", "2026-10-15"],
  ]);
  assert.ok(tj.every((x) => x.cuerpo === "Vence el 15 de octubre"), "al encolar el cuerpo no lleva la deuda: se arma al reclamar");
  // Entre el encolado y el envío la deuda cambió (016 mueve el saldo con cada compra y pago): al reclamar se dice la de ESTE momento.
  await db.exec(`UPDATE accounts SET current_balance = 1200 WHERE account_name = 'Visa'`);
  const reclamadas = await q(`SELECT titulo, cuerpo FROM avisos_reclamar(5, '2026-10-14T14:00:00Z') ORDER BY titulo`);
  assert.deepEqual(reclamadas.map((x) => [x.titulo, x.cuerpo]), [
    ["Mañana vence el pago de Amex sin saldo", "Vence el 15 de octubre"],
    ["Mañana vence el pago de Visa", "Debes S/ 1200.00 · 15 de octubre"],
  ]);
  assert.deepEqual((await q(`SELECT cuerpo FROM avisos_programados WHERE titulo LIKE '%Visa'`)).map((x) => x.cuerpo), ["Debes S/ 1200.00 · 15 de octubre"], "y el cuerpo armado queda guardado");
  assert.equal((await uno(`SELECT avisos_encolar_vencimientos('2026-10-14T11:00:00Z') AS n`)).n, 0, "idempotente");
  await limpiarCola();
  await db.exec(`UPDATE accounts SET payment_due_day = 31 WHERE payment_due_day IS NOT NULL AND account_type = 'credit_card'`);
  // Noviembre tiene 30 días: el 31 se recorta al 30 → aviso el 29 a las 9:00.
  assert.deepEqual((await (async () => { await q(`SELECT avisos_encolar_vencimientos('2026-11-28T11:00:00Z')`); return avisosDe("tarjeta"); })()).map((x) => [x.lima, x.fecha_ref]), [["2026-11-29 09:00", "2026-11-30"], ["2026-11-29 09:00", "2026-11-30"]], "31 en un mes de 30 días");
  await limpiarCola();
  // Febrero de un año no bisiesto: 28.
  await q(`SELECT avisos_encolar_vencimientos('2027-02-26T11:00:00Z')`);
  assert.deepEqual([...new Set((await avisosDe("tarjeta")).map((x) => x.fecha_ref))], ["2027-02-28"], "31 en febrero → 28");
  await limpiarCola();
  // Cruce de mes: día de pago 1, hoy 30 de octubre → 1 de noviembre (próximo mes).
  await db.exec(`UPDATE accounts SET payment_due_day = 1 WHERE payment_due_day IS NOT NULL AND account_type = 'credit_card'`);
  await q(`SELECT avisos_encolar_vencimientos('2026-10-30T11:00:00Z')`);
  assert.deepEqual([...new Set((await avisosDe("tarjeta")).map((x) => `${x.lima} ${x.fecha_ref}`))], ["2026-10-31 09:00 2026-11-01"], "pago el 1 de noviembre, aviso el 31 de octubre");
  await limpiarCola();
  // Tarjeta desactivada después del encolado: se omite al limpiar.
  await db.exec(`UPDATE accounts SET payment_due_day = 15 WHERE payment_due_day IS NOT NULL AND account_type = 'credit_card'`);
  await q(`SELECT avisos_encolar_vencimientos('2026-10-14T11:00:00Z')`);
  await db.exec(`UPDATE accounts SET is_active = false WHERE account_id = '${visa}'`);
  await q(`SELECT avisos_limpiar('2026-10-14T12:00:00Z')`);
  assert.deepEqual((await q(`SELECT titulo, estado FROM avisos_programados ORDER BY titulo`)).map((x) => `${x.titulo}=${x.estado}`), [
    "Mañana vence el pago de Amex sin saldo=pendiente",
    "Mañana vence el pago de Visa=omitido",
  ]);
  await limpiarCola();
  await db.exec(`DELETE FROM accounts; DELETE FROM recurring_transactions`);

  // Mantenimiento: purga lo terminado hace más de 90 días y devuelve el resumen.
  await aviso({ cuando: "now() - interval '100 days'", estado: "enviado", titulo: "viejo enviado" });
  await aviso({ cuando: "now() - interval '100 days'", estado: "pendiente", titulo: "viejo pendiente" });
  await aviso({ cuando: "now() - interval '10 days'", estado: "cancelado", titulo: "reciente cancelado" });
  await db.exec(`INSERT INTO cron.job_run_details (jobid, status, end_time) VALUES (1, 'succeeded', now() - interval '30 days'), (1, 'succeeded', now() - interval '8 days'), (1, 'succeeded', now() - interval '1 day')`);
  const m = (await uno(`SELECT avisos_mantener() AS r`)).r;
  assert.equal((await uno(`SELECT count(*)::int AS n FROM cron.job_run_details`)).n, 1, "el historial de pg_cron de más de 7 días se purga y el reciente se queda");
  assert.deepEqual(m, { limpiados: 1, encolados: 0, purgados: 2, historial_cron: 2 }, "el pendiente de hace 100 días se caduca y, ya caducado, se purga junto con el enviado viejo");
  assert.deepEqual((await q(`SELECT titulo FROM avisos_programados ORDER BY titulo`)).map((x) => x.titulo), ["reciente cancelado"]);
  await limpiarCola();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// (c) Presupuestos (trigger en transactions)
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const cat = async (nombre, user = A) => (await uno(`INSERT INTO categories (user_id, category_name, category_type) VALUES ($1, $2, 'expense') RETURNING category_id`, [user, nombre])).category_id;
  const presupuesto = async (user, categoria, limite, umbral = 0.8, extra = {}) =>
    (await uno(`INSERT INTO budgets (user_id, category_id, amount_limit, period_type, alert_threshold, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING budget_id`,
      [user, categoria, limite, extra.periodo ?? "monthly", umbral, extra.activo ?? true])).budget_id;
  const gasto = (user, cuentaId, categoria, monto, fecha = "now()", tipo = "expense") =>
    db.query(`INSERT INTO transactions (user_id, account_id, category_id, transaction_type, amount, transaction_date) VALUES ($1, $2, $3, $4, $5, ${fecha})`, [user, cuentaId, categoria, tipo, monto]);
  const pres = () => q(`SELECT titulo, cuerpo, url, estado, split_part(dedupe_key, ':', 4) AS umbral FROM avisos_programados WHERE origen = 'presupuesto' ORDER BY created_at, dedupe_key`);

  const banco = await cuenta(A, "BCP", "checking");
  const comida = await cat("Comida");
  const taxi = await cat("Taxi");
  const ocio = await cat("Ocio");
  await presupuesto(A, comida, 500);
  await presupuesto(A, taxi, 500);
  await presupuesto(A, ocio, 500, 0.5);

  await gasto(A, banco, comida, 300);
  assert.deepEqual(await pres(), [], "60 %: nada");
  await gasto(A, banco, comida, 110);
  let p = await pres();
  assert.deepEqual(p.map((x) => [x.umbral, x.estado]), [["80", "pendiente"]], "82 %: aviso del 80");
  assert.equal(p[0].titulo, "Presupuesto de Comida al 82 %");
  assert.equal(p[0].cuerpo, "Llevas S/ 410.00 de S/ 500.00 este mes.");
  assert.equal(p[0].url, "/budgets");
  await gasto(A, banco, comida, 20);
  assert.equal((await pres()).length, 1, "más gasto en la zona del 80 no repite el aviso");
  // El cron ya envió el del 80 (pasó más de un minuto): al llegar al 100 % sale el segundo y el primero queda como estaba.
  await db.exec(`UPDATE avisos_programados SET estado = 'enviado', enviado_at = now() WHERE origen = 'presupuesto'`);
  await gasto(A, banco, comida, 100);
  p = await pres();
  assert.deepEqual(p.map((x) => [x.umbral, x.estado]), [["80", "enviado"], ["100", "pendiente"]], "al 100 % sale el segundo");
  assert.equal(p[1].titulo, "Pasaste tu presupuesto de Comida");
  assert.equal(p[1].cuerpo, "S/ 530.00 de S/ 500.00 este mes (106 %).");
  await gasto(A, banco, comida, 50);
  assert.equal((await pres()).length, 2, "pasado el 100 % tampoco repite");

  // Un solo gasto cruza los dos umbrales: sale el del 100 %; el del 80 queda omitido (no son dos avisos seguidos).
  await limpiarCola();
  await gasto(A, banco, taxi, 600);
  p = await pres();
  assert.deepEqual(p.map((x) => [x.umbral, x.estado]).sort(), [["100", "pendiente"], ["80", "omitido"]].sort());
  await gasto(A, banco, taxi, 10);
  assert.equal((await pres()).length, 2, "el 80 omitido tampoco sale después");

  // El 80 todavía pendiente (el cron no pasó) y llega el 100: el 80 se omite, no salen dos avisos seguidos.
  await limpiarCola();
  const pend = await cat("Pend");
  await presupuesto(A, pend, 500);
  await gasto(A, banco, pend, 410);
  assert.deepEqual((await pres()).map((x) => [x.umbral, x.estado]), [["80", "pendiente"]]);
  await gasto(A, banco, pend, 100);
  assert.deepEqual((await pres()).map((x) => [x.umbral, x.estado]).sort(), [["100", "pendiente"], ["80", "omitido"]].sort(), "el 80 sin enviar se omite al llegar el 100");
  await limpiarCola();

  // Umbral propio (0.5) → llave :50; umbral fuera de rango (>= 1) → 80.
  await gasto(A, banco, ocio, 260);
  assert.deepEqual((await pres()).map((x) => [x.umbral, x.titulo]), [["50", "Presupuesto de Ocio al 52 %"]]);
  await limpiarCola();
  await db.exec(`UPDATE budgets SET alert_threshold = 1.5 WHERE category_id = '${ocio}'`);
  await gasto(A, banco, ocio, 150); // 410 / 500 = 82 %
  assert.deepEqual((await pres()).map((x) => x.umbral), ["80"]);
  await limpiarCola();

  // Lo que NO avisa: ingreso, traspaso, sin categoría, otra categoría sin presupuesto, presupuesto inactivo o no mensual, gasto de un mes pasado.
  const sinPres = await cat("Sin presupuesto");
  await gasto(A, banco, sinPres, 9999);
  await gasto(A, banco, comida, 9999, "now()", "income");
  const ahorros = await cuenta(A, "Ahorros", "savings"); // 016 exige cuenta destino en un traspaso
  await db.query(`INSERT INTO transactions (user_id, account_id, category_id, transaction_type, amount, transfer_to_account_id) VALUES ($1, $2, $3, 'transfer', 9999, $4)`, [A, banco, comida, ahorros]);
  await db.query(`INSERT INTO transactions (user_id, account_id, transaction_type, amount) VALUES ($1, $2, 'expense', 9999)`, [A, banco]);
  assert.deepEqual(await pres(), [], "ingreso, traspaso, sin categoría o sin presupuesto: nada");
  const quieta = await cat("Quieta");
  await presupuesto(A, quieta, 100, 0.8, { activo: false });
  const semanal = await cat("Semanal");
  await presupuesto(A, semanal, 100, 0.8, { periodo: "weekly" });
  await gasto(A, banco, quieta, 500);
  await gasto(A, banco, semanal, 500);
  assert.deepEqual(await pres(), [], "presupuesto inactivo o no mensual: nada");
  const viejaCat = await cat("Vieja");
  await presupuesto(A, viejaCat, 100);
  await gasto(A, banco, viejaCat, 500, "now() - interval '40 days'");
  assert.deepEqual(await pres(), [], "un gasto de un mes cerrado no avisa");

  // Cada usuario ve lo suyo: B tiene su propio presupuesto sobre su categoría; el gasto de A no lo toca.
  const bCuenta = await cuenta(B, "Caja B", "cash");
  const bCat = await cat("Comida B", B);
  await presupuesto(B, bCat, 100);
  await gasto(A, banco, comida, 5);
  assert.equal((await uno(`SELECT count(*)::int AS n FROM avisos_programados WHERE user_id = $1`, [B])).n, 0, "el gasto de A no genera avisos para B");
  await gasto(B, bCuenta, bCat, 95);
  assert.deepEqual((await q(`SELECT user_id FROM avisos_programados WHERE origen = 'presupuesto' AND titulo LIKE '%Comida B%'`)).map((x) => x.user_id), [B]);
  await limpiarCola();

  // 016: el presupuesto se mide EN SOLES. Un gasto en dólares cuenta convertido con el tipo de cambio de su día; sin tipo de cambio queda
  // fuera de la suma (como en fn_get_budget_status), nunca como si los dólares fueran soles.
  const usd = await cuenta(A, "Dólares", "checking", { moneda: "USD" });
  const viaje = await cat("Viaje");
  await presupuesto(A, viaje, 1000);
  await db.exec(`INSERT INTO fx_rates (par, fecha, valor, fuente) VALUES ('USD/PEN', '2020-01-01', 3.8, 'prueba')`);
  const gastoUsd = (monto) => db.query(`INSERT INTO transactions (user_id, account_id, category_id, transaction_type, amount, currency_code) VALUES ($1, $2, $3, 'expense', $4, 'USD')`, [A, usd, viaje, monto]);
  await gastoUsd(200); // US$ 200 × 3.80 = S/ 760: 76 %, nada (sumado como soles serían 200: 20 %)
  assert.deepEqual(await pres(), []);
  await gasto(A, banco, viaje, 50); // + S/ 50 = S/ 810: 81 %
  assert.deepEqual((await pres()).map((x) => [x.umbral, x.titulo, x.cuerpo]), [["80", "Presupuesto de Viaje al 81 %", "Llevas S/ 810.00 de S/ 1000.00 este mes."]], "los dólares suman convertidos");
  await limpiarCola();
  await db.exec(`DELETE FROM fx_rates`);
  await gastoUsd(5000); // sin tipo de cambio: fuera de la suma (y los 200 de antes también: ya no se saben convertir)
  assert.deepEqual(await pres(), [], "un gasto en dólares sin tipo de cambio no dispara nada");
  await gasto(A, banco, viaje, 800); // solo cuentan los soles: 50 + 800 = 850
  assert.deepEqual((await pres()).map((x) => [x.umbral, x.cuerpo]), [["80", "Llevas S/ 850.00 de S/ 1000.00 este mes."]]);
  await limpiarCola();
  await db.exec(`DELETE FROM transactions WHERE category_id = '${viaje}'`);

  // Mes de Lima: el 31 de octubre a las 22:00 de Lima ya es 1 de noviembre en UTC. Se siembra sin el trigger y se evalúa a mano.
  await db.exec(`ALTER TABLE transactions DISABLE TRIGGER trg_transactions_avisos_presupuesto; DELETE FROM transactions`);
  const mes = await cat("Mes de Lima");
  const bm = await presupuesto(A, mes, 500);
  await gasto(A, banco, mes, 450, "'2026-11-01T03:00:00Z'"); // 31-oct 22:00 Lima
  await gasto(A, banco, mes, 420, "'2026-11-01T06:00:00Z'"); // 01-nov 01:00 Lima
  const evaluar = async (fechaGasto, ahora) => (await uno(`SELECT avisos_evaluar_presupuestos($1, $2, $3, $4) AS n`, [A, mes, fechaGasto, ahora])).n;
  assert.equal(await evaluar("2026-11-01T03:00:00Z", "2026-11-01T04:00:00Z"), 1, "31-oct 23:00 Lima: octubre suma 450 (90 %)");
  assert.equal(await evaluar("2026-11-01T06:00:00Z", "2026-11-01T06:30:00Z"), 1, "01-nov 01:30 Lima: noviembre suma 420 (84 %), SIN los 450 de octubre");
  assert.equal(await evaluar("2026-11-01T03:00:00Z", "2026-11-01T06:30:00Z"), 0, "un gasto de octubre evaluado en noviembre no cuenta");
  const llaves = (await q(`SELECT dedupe_key, cuerpo FROM avisos_programados WHERE origen = 'presupuesto' ORDER BY dedupe_key`));
  assert.deepEqual(llaves.map((x) => x.dedupe_key.slice(-10)), ["2026-10:80", "2026-11:80"], "una llave por mes de Lima");
  assert.deepEqual(llaves.map((x) => x.cuerpo), ["Llevas S/ 450.00 de S/ 500.00 este mes.", "Llevas S/ 420.00 de S/ 500.00 este mes."]);
  assert.equal(await evaluar("2026-11-01T06:00:00Z", "2026-11-01T07:00:00Z"), 0, "misma llave: no se repite");
  await db.exec(`ALTER TABLE transactions ENABLE TRIGGER trg_transactions_avisos_presupuesto; DELETE FROM transactions`);
  await limpiarCola();

  // UPDATE de un gasto (cambia el monto) también evalúa.
  const g = await uno(`INSERT INTO transactions (user_id, account_id, category_id, transaction_type, amount) VALUES ($1, $2, $3, 'expense', 100) RETURNING transaction_id`, [A, banco, comida]);
  assert.deepEqual(await pres(), []);
  await db.query(`UPDATE transactions SET amount = 450 WHERE transaction_id = $1`, [g.transaction_id]);
  assert.deepEqual((await pres()).map((x) => x.umbral), ["80"], "editar el monto a 450 cruza el 80");
  await limpiarCola();

  // Registrar un gasto NUNCA falla por un aviso: se rompe la cola a propósito y el INSERT sigue funcionando.
  await db.exec(`ALTER TABLE avisos_programados RENAME TO avisos_rota`);
  await gasto(A, banco, taxi, 700);
  assert.equal((await uno(`SELECT count(*)::int AS n FROM transactions WHERE category_id = '${taxi}'`)).n, 1, "el gasto se registró aunque el aviso falló");
  await db.exec(`ALTER TABLE avisos_rota RENAME TO avisos_programados`);
  await db.exec(`DELETE FROM transactions`);
  await limpiarCola();
  void bm;

  // Preferencias de presupuesto apagadas: se encola igual, pero no se envía.
  await db.exec(`INSERT INTO avisos_preferencias (user_id, presupuestos) VALUES ('${A}', false)`);
  await gasto(A, banco, comida, 450);
  assert.equal((await pres()).length, 1);
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, now() + interval '1 minute')`)).length, 0, "apagado: no se reclama");
  await db.exec(`DELETE FROM avisos_preferencias`);
  assert.equal((await q(`SELECT 1 FROM avisos_reclamar(5, now() + interval '1 minute')`)).length, 1, "encendido: sale");
  await db.exec(`DELETE FROM transactions; DELETE FROM budgets; DELETE FROM categories; DELETE FROM accounts`);
  await limpiarCola();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// (d) RLS y permisos
// ---------------------------------------------------------------------------------------------------------------------------------
{
  const ins = (user, extra = "", vals = "") =>
    como("authenticated", user, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando${extra}) VALUES ($1, 'recordatorio', 'Llamar a Marco', now() + interval '1 hour'${vals}) RETURNING aviso_id`, [user]);
  const [mio] = await ins(A);
  const [ajeno] = await ins(B);
  assert.ok(mio.aviso_id && ajeno.aviso_id);

  assert.deepEqual((await como("authenticated", A, `SELECT aviso_id FROM avisos_programados`)).map((x) => x.aviso_id), [mio.aviso_id], "cada quien ve solo lo suyo");
  assert.deepEqual(await como("authenticated", "", `SELECT aviso_id FROM avisos_programados`), [], "sin sesión no ve nada");
  await falla("anon", "", `SELECT * FROM avisos_programados`, [], PERMISO);

  // Insertar: solo a su nombre y solo recordatorios/tareas.
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando) VALUES ($1, 'recordatorio', 'x', now())`, [B], RLS);
  for (const origen of ["vencimiento", "tarjeta", "presupuesto"]) {
    await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando) VALUES ($1, '${origen}', 'x', now())`, [A], RLS);
  }
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, estado) VALUES ($1, 'recordatorio', 'x', now(), 'enviado')`, [A], PERMISO);
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, dedupe_key) VALUES ($1, 'recordatorio', 'x', now(), 'k')`, [A], PERMISO);
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, caduca_at) VALUES ($1, 'recordatorio', 'x', now(), now() + interval '99 years')`, [A], PERMISO);
  // 'tarea' exige la referencia a la tarea; con ella entra.
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando) VALUES ($1, 'tarea', 'x', now())`, [A], /check constraint/i);
  assert.equal((await como("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, tarea_path, tarea_line, tarea_texto) VALUES ($1, 'tarea', 'Revisar el simulador', now() + interval '1 day', '20-projects/novafondos-app/pendientes.md', 4, 'Revisar el simulador') RETURNING aviso_id`, [A])).length, 1);
  // user_id por defecto = sesión (como el resto de tablas, migración 011).
  assert.equal((await como("authenticated", A, `INSERT INTO avisos_programados (origen, titulo, cuando) VALUES ('recordatorio', 'sin user_id', now() + interval '1 day') RETURNING user_id`)).at(0).user_id, A);

  // Rutas: solo internas.
  for (const mala of ["//evil.com", "https://evil.com", "/\\evil", "/a b", "javascript:alert(1)", "evil", "/x\ny"]) {
    await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, url) VALUES ($1, 'recordatorio', 'x', now() + interval '1 day', $2)`, [A, mala], /check constraint/i);
  }
  for (const buena of ["/", "/tareas", "/tareas?id=1", "/avisos#x"]) {
    assert.equal((await como("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, url) VALUES ($1, 'recordatorio', 'x', now() + interval '1 day', $2) RETURNING 1`, [A, buena])).length, 1, buena);
  }
  await falla("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando) VALUES ($1, 'recordatorio', '   ', now())`, [A], /check constraint/i);

  // Cancelar: lo propio y pendiente. Nada más.
  await falla("authenticated", A, `UPDATE avisos_programados SET titulo = 'otro' WHERE aviso_id = $1`, [mio.aviso_id], PERMISO);
  await falla("authenticated", A, `UPDATE avisos_programados SET cuando = now() WHERE aviso_id = $1`, [mio.aviso_id], PERMISO);
  await falla("authenticated", A, `UPDATE avisos_programados SET estado = 'enviado' WHERE aviso_id = $1`, [mio.aviso_id], RLS);
  await falla("authenticated", A, `UPDATE avisos_programados SET estado = 'pendiente' WHERE aviso_id = $1`, [mio.aviso_id], RLS);
  assert.deepEqual(await como("authenticated", A, `UPDATE avisos_programados SET estado = 'cancelado' WHERE aviso_id = $1 RETURNING aviso_id`, [ajeno.aviso_id]), [], "no cancela lo de otro");
  assert.equal((await estado(ajeno.aviso_id)).estado, "pendiente");
  assert.equal((await como("authenticated", A, `UPDATE avisos_programados SET estado = 'cancelado' WHERE aviso_id = $1 RETURNING aviso_id`, [mio.aviso_id])).length, 1);
  assert.deepEqual(await como("authenticated", A, `UPDATE avisos_programados SET estado = 'cancelado' WHERE aviso_id = $1 RETURNING aviso_id`, [mio.aviso_id]), [], "ya cancelado: nada que cancelar");
  await falla("authenticated", A, `DELETE FROM avisos_programados WHERE aviso_id = $1`, [mio.aviso_id], PERMISO);
  await db.query(`UPDATE avisos_programados SET estado = 'enviando' WHERE aviso_id = $1`, [ajeno.aviso_id]);
  assert.deepEqual(await como("authenticated", B, `UPDATE avisos_programados SET estado = 'cancelado' WHERE aviso_id = $1 RETURNING aviso_id`, [ajeno.aviso_id]), [], "uno que ya se está enviando no se cancela");

  // Funciones internas: ni la app ni anon las ejecutan; el rol de servicio sí.
  for (const fn of [
    "avisos_reclamar(integer, timestamptz)", "avisos_cerrar(uuid, boolean, text, uuid, timestamptz)", "avisos_limpiar(timestamptz)",
    "avisos_hay_trabajo(timestamptz)", "avisos_encolar_vencimientos(timestamptz)", "avisos_purgar(timestamptz)", "avisos_mantener(timestamptz)",
    "avisos_origen_activo(uuid, text)", "avisos_vencimiento_vigente(uuid, date)", "avisos_asentar_notificacion(uuid, uuid)",
  ]) {
    const priv = async (rol) => (await uno(`SELECT has_function_privilege('${rol}', '${fn}', 'EXECUTE') AS ok`)).ok;
    assert.equal(await priv("anon"), false, `${fn}: anon no`);
    assert.equal(await priv("authenticated"), false, `${fn}: authenticated no`);
    assert.equal(await priv("service_role"), true, `${fn}: service_role sí`);
  }
  for (const fn of ["avisos_evaluar_presupuestos(uuid, uuid, timestamptz, timestamptz)", "trg_transactions_avisos_presupuesto()", "avisos_fijar_ventanas()", "avisos_cuerpo_tarjeta(uuid, date, text)"]) {
    assert.equal((await uno(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS ok`)).ok, false, `${fn}: authenticated no`);
  }
  await falla("authenticated", A, `SELECT * FROM avisos_reclamar(5)`, [], PERMISO);
  await falla("authenticated", A, `SELECT avisos_evaluar_presupuestos($1, $1, now())`, [B], PERMISO);
  // Todas las funciones con privilegios de dueño fijan su search_path.
  const sinPath = await q(`SELECT proname FROM pg_proc WHERE prosecdef AND (proname LIKE 'avisos\\_%' OR proname LIKE 'trg\\_transactions\\_avisos%') AND (proconfig IS NULL OR NOT proconfig::text LIKE '%search_path%')`);
  assert.deepEqual(sinPath, [], "toda SECURITY DEFINER fija search_path");

  // La web mueve una tarea de proyecto (task.move): sus recordatorios la siguen con avisos_mover_tarea, que solo toca lo de quien llama.
  const REF = { path: "20-projects/cajon-desastre/pendientes.md", line: 4, texto: "Llamar a Ana" };
  await como("authenticated", A, `INSERT INTO avisos_programados (user_id, origen, titulo, cuando, tarea_path, tarea_line, tarea_texto) VALUES ($1, 'tarea', 'Llamar a Ana', now() + interval '1 day', $2, $3, $4)`, [A, REF.path, REF.line, REF.texto]);
  const mover = async (user, ...args) => (await como("authenticated", user, `SELECT avisos_mover_tarea($1, $2, $3, $4, $5) AS n`, args))[0].n;
  assert.equal(await mover(B, REF.path, REF.line, REF.texto, "20-projects/lota/pendientes.md", 9), 0, "otro usuario no mueve lo de David");
  assert.equal(await mover(A, REF.path, 5, REF.texto, "x.md", 1), 0, "otra línea: no es esa tarea");
  assert.equal(await mover(A, REF.path, REF.line, "Otro texto", "x.md", 1), 0, "otro texto: no es esa tarea");
  assert.equal(await mover(A, REF.path, REF.line, REF.texto, null, null), 0, "sin destino no hace nada");
  assert.equal(await mover(A, REF.path, REF.line, REF.texto, "20-projects/lota/pendientes.md", 9), 1);
  assert.deepEqual(await q(`SELECT tarea_path, tarea_line FROM avisos_programados WHERE tarea_texto = 'Llamar a Ana'`), [{ tarea_path: "20-projects/lota/pendientes.md", tarea_line: 9 }]);
  assert.equal(await mover(A, REF.path, REF.line, REF.texto, "z.md", 1), 0, "ya no está en la ruta vieja");
  await falla("anon", "", `SELECT avisos_mover_tarea('a', 1, 'b', 'c', 2)`, [], PERMISO);
  await db.exec(`UPDATE avisos_programados SET estado = 'enviado', enviado_at = now() WHERE tarea_texto = 'Llamar a Ana'`);
  assert.equal(await mover(A, "20-projects/lota/pendientes.md", 9, REF.texto, "y.md", 2), 0, "uno ya enviado no se mueve");

  // La fila de la bandeja se guarda JUSTO al crearla: solo sobre un reclamo vigente y una sola vez.
  await limpiarCola();
  const aId = await aviso({ cuando: "now() - interval '1 minute'", titulo: "para asentar" });
  const nId = (await uno(`INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'agenda', 'x') RETURNING notification_id`, [A])).notification_id;
  const asentar = async () => (await uno(`SELECT avisos_asentar_notificacion($1, $2) AS ok`, [aId, nId])).ok;
  assert.equal(await asentar(), false, "sin reclamo (pendiente) no hay dónde asentarla");
  await q(`SELECT 1 FROM avisos_reclamar(50)`);
  assert.equal(await asentar(), true);
  assert.equal(await asentar(), false, "ya tiene una: no se pisa");
  assert.equal((await uno(`SELECT notification_id FROM avisos_programados WHERE aviso_id = $1`, [aId])).notification_id, nId);
  // Un reintento (rescate) vuelve a reclamarla CON esa fila: el envío no crea otra.
  await q(`SELECT avisos_cerrar($1, false, 'push 503')`, [aId]);
  assert.equal((await uno(`SELECT notification_id FROM avisos_programados WHERE aviso_id = $1`, [aId])).notification_id, nId, "un cierre fallido conserva la fila de la bandeja");
  await limpiarCola();

  // Preferencias.
  assert.equal((await como("authenticated", A, `INSERT INTO avisos_preferencias (user_id, vencimientos) VALUES ($1, false) RETURNING user_id`, [A])).length, 1);
  await falla("authenticated", A, `INSERT INTO avisos_preferencias (user_id) VALUES ($1)`, [B], RLS);
  assert.deepEqual(await como("authenticated", B, `SELECT * FROM avisos_preferencias`), [], "B no ve las de A");
  assert.deepEqual(await como("authenticated", B, `UPDATE avisos_preferencias SET vencimientos = true WHERE user_id = $1 RETURNING 1`, [A]), []);
  assert.equal((await como("authenticated", A, `UPDATE avisos_preferencias SET presupuestos = false, updated_at = now() WHERE user_id = $1 RETURNING 1`, [A])).length, 1);
  await falla("anon", "", `SELECT * FROM avisos_preferencias`, [], PERMISO);
  await db.exec(`DELETE FROM avisos_preferencias`);
  await limpiarCola();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// (e) Sección CRON contra dobles de pg_cron, pg_net y Vault
// ---------------------------------------------------------------------------------------------------------------------------------
{
  // (los dobles de cron, net y vault ya se crearon al arrancar, para poder aplicar 001 → 016)
  // Sin CREATE EXTENSION: pg_cron/pg_net no existen en PGlite (y el resto de la sección es la migración tal cual).
  const cronSinExt = cron.split("\n").filter((l) => !/^CREATE EXTENSION/i.test(l)).join("\n");
  assert.equal(cron.split("\n").filter((l) => /^CREATE EXTENSION/i.test(l)).length, 2, "la sección declara pg_cron y pg_net");
  await db.exec(cronSinExt);
  await db.exec(cronSinExt); // idempotente: reemplaza, no duplica
  const jobs = await q(`SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'wabid-avisos%' ORDER BY jobname`);
  assert.deepEqual(jobs.map((j) => [j.jobname, j.schedule]), [["wabid-avisos", "* * * * *"], ["wabid-avisos-mantener", "5 * * * *"]], "dos jobs, sin duplicar");
  const cmd = Object.fromEntries(jobs.map((j) => [j.jobname, j.command]));

  // El secreto sale del Vault y no está en el SQL.
  assert.match(cmd["wabid-avisos"], /vault\.decrypted_secrets WHERE name = 'avisos_cron_secret'/);
  assert.match(cmd["wabid-avisos"], /functions\/v1\/avisos\?forceFunctionRegion=us-west-2/);
  assert.ok(!/[A-Za-z0-9_\-]{32,}/.test(cmd["wabid-avisos"].replace(/https:\/\/[^\s']+/g, "")), "ningún valor largo parecido a un secreto en el comando");
  assert.ok(!/eyJ[A-Za-z0-9_\-]{10,}|Bearer\s+\S{20,}/.test(completa), "ni JWT ni Bearer en la migración");

  // Se ejecuta el comando guardado. Sin trabajo: no hay llamada HTTP.
  await db.exec(`SELECT vault.create_secret('secreto-de-prueba', 'avisos_cron_secret')`);
  await db.exec(cmd["wabid-avisos"]);
  assert.equal((await q(`SELECT * FROM net.llamadas`)).length, 0, "sin avisos por enviar, el cron no llama a la función");
  // Con un aviso vencido: una llamada con el secreto del Vault en el header.
  await aviso({ cuando: "now() - interval '1 minute'", titulo: "para el cron" });
  await db.exec(cmd["wabid-avisos"]);
  const llamadas = await q(`SELECT url, headers, timeout_ms FROM net.llamadas`);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].headers["x-avisos-secret"], "secreto-de-prueba");
  assert.match(llamadas[0].url, /^https:\/\/rrhyyclltgaecfyertqh\.supabase\.co\/functions\/v1\/avisos/);
  // Secreto ausente en el Vault: el header va vacío (la función responderá 401), no falla el job.
  await db.exec(`DELETE FROM vault.secrets; DELETE FROM net.llamadas`);
  await db.exec(cmd["wabid-avisos"]);
  assert.equal((await q(`SELECT headers FROM net.llamadas`))[0].headers["x-avisos-secret"], "");
  // Con el aviso ya reclamado, el cron vuelve a callar.
  await q(`SELECT 1 FROM avisos_reclamar(5)`);
  await db.exec(`DELETE FROM net.llamadas`);
  await db.exec(cmd["wabid-avisos"]);
  assert.equal((await q(`SELECT * FROM net.llamadas`)).length, 0);
  // El job horario corre sin errores.
  await db.exec(cmd["wabid-avisos-mantener"]);
  await limpiarCola();

  // Si purgar el historial de pg_cron fallara (p. ej. un rol sin permiso), el mantenimiento sigue y solo deja un WARNING.
  // Se simula con una vista no actualizable en lugar de la tabla: el DELETE falla igual que fallaría sin privilegios.
  await db.exec(`DROP TABLE cron.job_run_details; CREATE VIEW cron.job_run_details AS SELECT DISTINCT 1::int AS runid, now() AS end_time`);
  const sinPermiso = (await uno(`SELECT avisos_mantener() AS r`)).r;
  assert.deepEqual(sinPermiso, { limpiados: 0, encolados: 0, purgados: 0, historial_cron: 0 }, "el resto del mantenimiento corrió aunque la purga del historial falló");
  await db.exec(`DROP VIEW cron.job_run_details`);
  assert.equal((await uno(`SELECT avisos_mantener() AS r`)).r.historial_cron, 0, "sin la tabla (otro entorno) tampoco falla");
}

console.log("check-017: OK");
