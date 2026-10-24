// Prueba la migración 023 contra un Postgres real (PGlite, WASM): la aplica tres veces (idempotencia) y comprueba (a) la frecuencia
// 'once' en recurring_transactions sin romper las de antes, (b) restricciones y RLS de bolsas, (c) restricciones y RLS de plan_caja,
// (d) la categoría Deudas (una sola vez) y (e) los permisos.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-023.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PGLITE_DIR) {
  console.log("PGLITE_DIR no está definido: se omite (instala @electric-sql/pglite en una carpeta temporal y apúntalo ahí).");
  process.exit(0);
}
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, "dist", "index.js")).href);
const dir = import.meta.dirname;
const db = new PGlite();

// Lo mínimo de 001 que toca 023: users, categories y recurring_transactions con su CHECK original (sin nombre propio).
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE users (user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE categories (
    category_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    category_name VARCHAR(100) NOT NULL, category_type VARCHAR(10) NOT NULL CHECK (category_type IN ('income', 'expense')),
    icon VARCHAR(50), color VARCHAR(7), is_system BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE);
  CREATE TABLE recurring_transactions (
    recurring_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('income', 'expense')),
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0), description VARCHAR(500) NOT NULL,
    frequency VARCHAR(20) NOT NULL CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual')),
    day_of_month SMALLINT CHECK (day_of_month BETWEEN 1 AND 31), start_date DATE NOT NULL, end_date DATE,
    next_due_date DATE NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
`);
const run = () => db.exec(readFileSync(path.join(dir, "023_cerebro_caja.sql"), "utf8"));
await run();
await run(); // idempotente
await run();

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
await db.exec(`INSERT INTO auth.users VALUES ('${U}'), ('${OTRO}'); INSERT INTO users VALUES ('${U}'), ('${OTRO}');`);

const como = async (rol, user, sql, params = []) => {
  await db.exec(`SET ROLE ${rol}; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
const falla = async (fn, codigo, msg) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.code, codigo, `${msg}: ${e.message}`);
    return true;
  }, msg);
};
const mios = (sql, params) => como("authenticated", U, sql, params);
const sistema = (sql, params) => como("service_role", null, sql, params);

// --- (a) frecuencia 'once' ---
const rec = (frecuencia) => sistema(
  `INSERT INTO recurring_transactions (user_id, transaction_type, amount, description, frequency, start_date, next_due_date)
   VALUES ('${U}', 'expense', 1000, 'Deuda Melissa', $1, '2026-11-01', '2026-11-01') RETURNING frequency`, [frecuencia]);
assert.equal((await rec("once"))[0].frequency, "once", "acepta 'once'");
for (const f of ["daily", "weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"]) await rec(f); // las de antes siguen
await falla(() => rec("nunca"), "23514", "rechaza una frecuencia inventada");
const checks = (await db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'recurring_transactions'::regclass AND pg_get_constraintdef(oid) LIKE '%biweekly%'`)).rows[0].n;
assert.equal(checks, 1, "un solo CHECK de frecuencia tras tres corridas");

// --- (b) bolsas ---
const [comida] = await mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias, orden) VALUES ('Comida', 200, '{Alimentación}', 1) RETURNING *`);
assert.equal(comida.user_id, U, "user_id por defecto = auth.uid()");
assert.equal(comida.arrastre, false, "sin arrastre por defecto");
await mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias, arrastre, orden) VALUES ('Gasolina', 81, '{Transporte}', true, 3)`);
await mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias, orden) VALUES ('Compras y otros', 100, NULL, 2)`);
await falla(() => mios(`INSERT INTO bolsas (nombre, tope_semanal) VALUES ('Otra resto', 50)`), "23505", "solo una bolsa «resto»");
await falla(() => mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias) VALUES ('comida', 10, '{Ropa}')`), "23505", "nombre repetido sin importar mayúsculas");
await falla(() => mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias) VALUES ('Cero', 0, '{Ropa}')`), "23514", "tope 0");
await falla(() => mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias) VALUES ('Vacía', 10, '{}')`), "23514", "lista de categorías vacía");
await falla(() => mios(`INSERT INTO bolsas (nombre, tope_semanal, categorias) VALUES ('  ', 10, '{Ropa}')`), "23514", "nombre en blanco");
// otro usuario puede tener su propia bolsa resto y su propia «Comida»
await como("authenticated", OTRO, `INSERT INTO bolsas (nombre, tope_semanal) VALUES ('Comida', 50)`);
assert.equal((await mios(`SELECT count(*)::int AS n FROM bolsas`))[0].n, 3, "solo ve sus 3 bolsas");
await falla(() => mios(`INSERT INTO bolsas (user_id, nombre, tope_semanal, categorias) VALUES ('${OTRO}', 'Falsa', 10, '{Ropa}')`), "42501", "no crea a nombre de otro");
const ajena = (await sistema(`SELECT bolsa_id FROM bolsas WHERE user_id = '${OTRO}'`))[0].bolsa_id;
assert.equal((await mios(`UPDATE bolsas SET tope_semanal = 1 WHERE bolsa_id = $1 RETURNING 1`, [ajena])).length, 0, "no toca la bolsa ajena");
assert.equal((await mios(`UPDATE bolsas SET tope_semanal = 90 WHERE nombre = 'Compras y otros' RETURNING tope_semanal`))[0].tope_semanal, "90.00", "cambia su tope");
const [cambio] = await mios(`UPDATE bolsas SET tope_nuevo = 70, tope_nuevo_desde = '2026-11-16' WHERE nombre = 'Compras y otros' RETURNING tope_nuevo, tope_nuevo_desde`);
assert.equal(cambio.tope_nuevo, "70.00", "programa un tope nuevo");
await falla(() => mios(`UPDATE bolsas SET tope_nuevo = 50, tope_nuevo_desde = NULL WHERE nombre = 'Comida'`), "23514", "tope nuevo sin fecha");
await falla(() => mios(`UPDATE bolsas SET tope_nuevo = 0, tope_nuevo_desde = '2026-11-16' WHERE nombre = 'Comida'`), "23514", "tope nuevo en 0");

// --- (c) plan_caja ---
const [plan] = await mios(`INSERT INTO plan_caja (inicio, meta_monto, meta_fecha) VALUES ('2026-10-24', 10500, '2026-12-31') RETURNING *`);
assert.equal(plan.user_id, U);
assert.equal(plan.colchon, "0.00", "colchón 0 por defecto");
await falla(() => mios(`INSERT INTO plan_caja (inicio) VALUES ('2026-10-25')`), "23505", "un solo plan por usuario");
await falla(() => como("authenticated", OTRO, `INSERT INTO plan_caja (inicio, meta_monto) VALUES ('2026-10-24', 100)`), "23514", "meta sin fecha");
await falla(() => como("authenticated", OTRO, `INSERT INTO plan_caja (inicio, colchon) VALUES ('2026-10-24', -1)`), "23514", "colchón negativo");
await como("authenticated", OTRO, `INSERT INTO plan_caja (inicio) VALUES ('2026-10-24')`); // sin meta también vale
assert.equal((await mios(`SELECT count(*)::int AS n FROM plan_caja`))[0].n, 1, "solo ve su plan");
assert.equal((await mios(`UPDATE plan_caja SET colchon = 100 WHERE user_id = '${OTRO}' RETURNING 1`)).length, 0, "no toca el plan ajeno");

// --- (d) categoría Deudas ---
const deudas = (await db.query(`SELECT count(*)::int AS n FROM categories WHERE user_id IS NULL AND category_name = 'Deudas' AND category_type = 'expense' AND is_system`)).rows[0].n;
assert.equal(deudas, 1, "Deudas una sola vez tras tres corridas");

// --- (e) permisos, RLS y cascada ---
for (const tabla of ["bolsas", "plan_caja"]) {
  const priv = async (rol, p) => (await db.query(`SELECT has_table_privilege('${rol}', '${tabla}', '${p}') AS ok`)).rows[0].ok;
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.equal(await priv("anon", p), false, `${tabla}: anon no tiene ${p}`);
    assert.equal(await priv("authenticated", p), true, `${tabla}: authenticated tiene ${p}`);
  }
  assert.equal(await priv("authenticated", "TRUNCATE"), false, `${tabla}: authenticated no puede vaciarla`);
  assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = '${tabla}'`)).rows[0].relrowsecurity, true, `${tabla}: RLS activa`);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = '${tabla}'`)).rows[0].n, 1, `${tabla}: una sola política`);
}
await db.exec(`DELETE FROM users WHERE user_id = '${OTRO}'`); // como superusuario: en el arnés, users se creó antes de los privilegios por defecto
assert.equal((await sistema(`SELECT count(*)::int AS n FROM bolsas WHERE user_id = '${OTRO}'`))[0].n, 0, "bolsas: ON DELETE CASCADE");
assert.equal((await sistema(`SELECT count(*)::int AS n FROM plan_caja WHERE user_id = '${OTRO}'`))[0].n, 0, "plan_caja: ON DELETE CASCADE");

console.log("check-023: OK");
