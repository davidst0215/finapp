// Prueba la migración 021 contra un Postgres real (PGlite, WASM): la aplica tres veces (idempotencia) y comprueba que
// (a) `currencies` queda con RLS: todos leen, nadie escribe (ni anon ni authenticated),
// (b) anon pierde toda escritura y TRUNCATE/REFERENCES/TRIGGER en las demás tablas pero conserva SELECT,
// (c) authenticated conserva INSERT/UPDATE/DELETE sobre sus tablas (RLS manda) y pierde TRUNCATE,
// (d) las tablas futuras no nacen con privilegios para anon.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-021.mjs
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

// Supabase da a anon, authenticated y service_role todos los privilegios sobre cada tabla nueva de public: se reproduce eso (también
// como privilegios por defecto) para que los REVOKE de la migración se comprueben de verdad.
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE currencies (currency_code VARCHAR(3) PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO currencies VALUES ('PEN', 'Sol'), ('USD', 'Dólar');
  CREATE TABLE cuentas (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, code VARCHAR(3) REFERENCES currencies(currency_code));
  ALTER TABLE cuentas ENABLE ROW LEVEL SECURITY;
  CREATE POLICY cuentas_own ON cuentas FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
`);
const run = () => db.exec(readFileSync(path.join(dir, "021_endurecer_anon.sql"), "utf8"));
await run();
await run(); // idempotente
await run();

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const como = async (rol, user, sql, params = []) => {
  await db.exec(`SET ROLE ${rol}; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
const falla = (rol, user, sql, re) => assert.rejects(como(rol, user, sql), re);

// --- (a) currencies: leer sí, escribir no ---
assert.equal((await como("anon", null, `SELECT * FROM currencies`)).length, 2, "anon lee las monedas");
assert.equal((await como("authenticated", U, `SELECT * FROM currencies`)).length, 2, "authenticated lee las monedas");
for (const rol of ["anon", "authenticated"]) {
  await falla(rol, U, `INSERT INTO currencies VALUES ('XXX', 'Falsa')`, /permission denied/);
  await falla(rol, U, `UPDATE currencies SET name = 'Hackeada'`, /permission denied/);
  await falla(rol, U, `DELETE FROM currencies`, /permission denied/);
  await falla(rol, U, `TRUNCATE currencies`, /permission denied/);
}
assert.equal((await db.query(`SELECT name FROM currencies WHERE currency_code = 'PEN'`)).rows[0].name, "Sol", "nada cambió");
assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'currencies'`)).rows[0].relrowsecurity, true);

// --- (b) anon: solo SELECT en el resto ---
await falla("anon", null, `INSERT INTO cuentas (user_id) VALUES ('${U}')`, /permission denied/);
await falla("anon", null, `UPDATE cuentas SET code = 'USD'`, /permission denied/);
await falla("anon", null, `DELETE FROM cuentas`, /permission denied/);
await falla("anon", null, `TRUNCATE cuentas`, /permission denied/);
assert.equal((await como("anon", null, `SELECT * FROM cuentas`)).length, 0, "anon puede consultar pero RLS no le da filas");

// --- (c) authenticated: sigue escribiendo lo suyo; TRUNCATE ya no ---
await como("authenticated", U, `INSERT INTO cuentas (user_id, code) VALUES ('${U}', 'PEN')`);
await como("authenticated", U, `UPDATE cuentas SET code = 'USD' WHERE user_id = '${U}'`);
assert.equal((await como("authenticated", U, `SELECT code FROM cuentas`))[0].code, "USD");
await falla("authenticated", U, `TRUNCATE cuentas`, /permission denied/);
await como("authenticated", U, `DELETE FROM cuentas WHERE user_id = '${U}'`);

// --- (d) una tabla futura no nace con privilegios para anon (sí para authenticated) ---
await db.exec(`CREATE TABLE futura (id INT)`);
await falla("anon", null, `SELECT * FROM futura`, /permission denied/);
assert.equal((await como("authenticated", U, `SELECT * FROM futura`)).length, 0);

console.log("check-021: OK");
