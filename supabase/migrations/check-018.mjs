// Prueba la migración 018 contra un Postgres real (PGlite, WASM): la aplica tres veces (idempotencia) y comprueba
// (a) el esquema y sus CHECK (E.164 estricto, nombre, apodos), (b) la unicidad (usuario, teléfono), (c) RLS: cada usuario ve y toca
// solo lo suyo, no puede insertar a nombre de otro ni mover una fila a otro dueño, (d) permisos: el rol anónimo no ve ni la tabla,
// (e) el default de user_id con el JWT y el rol de servicio, (f) ON DELETE CASCADE.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-018.mjs
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

// Supabase da a anon, authenticated y service_role todos los privilegios sobre cada tabla nueva de public: se reproduce eso para
// que el REVOKE de la migración se compruebe de verdad.
await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  CREATE TABLE users (user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
`);
const run = () => db.exec(readFileSync(path.join(dir, "018_contactos.sql"), "utf8"));
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
const falla = (rol, user, sql, params, re) => assert.rejects(como(rol, user, sql, params), re);
const alta = (user, nombre, tel, rel = null, alias = "{}") =>
  como("authenticated", user, `INSERT INTO contactos (nombre, telefono, relacion, alias) VALUES ($1, $2, $3, $4) RETURNING contacto_id, user_id`, [nombre, tel, rel, alias]);

// --- (e) el default de user_id es el del JWT ---
const [marco] = await alta(U, "Marco", "+51999888777", "de Saya");
assert.equal(marco.user_id, U, "user_id sale del JWT, la app no lo manda");
const [ajeno] = await alta(OTRO, "Marco ajeno", "+51999888777");
assert.equal(ajeno.user_id, OTRO, "el mismo número en otro usuario es otra fila (la unicidad es por usuario)");
await alta(U, "Rosa", "+573001234567", null, "{Mamá,Mami}");

// --- (a) CHECK ---
const malos = [
  ["sin +", ["X", "51999888777"]], ["con espacios", ["X", "+51 999 888 777"]], ["cero inicial", ["X", "+051999888777"]],
  ["corto", ["X", "+5199988"]], ["largo", ["X", "+1234567890123456"]], ["con letras", ["X", "+51999abc777"]], ["inyección", ["X", "+51999888777'; DROP TABLE contactos;--"]],
  ["nombre vacío", ["   ", "+51999000111"]],
];
for (const [que, [nombre, tel]] of malos) {
  await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono) VALUES ($1, $2)`, [nombre, tel], /violates check constraint|value too long/, que);
}
await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono, relacion) VALUES ('X', '+51999000111', '  ')`, [], /check constraint/);
await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono) VALUES ($1, '+51999000111')`, ["n".repeat(101)], /too long/);
await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono, alias) VALUES ('X', '+51999000111', $1)`, ["{a,b,c,d,e,f,g,h,i,j,k}"], /check constraint/);
await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono, alias) VALUES ('X', '+51999000111', $1)`, [`{${"x".repeat(601)}}`], /check constraint/);
await falla("authenticated", U, `INSERT INTO contactos (nombre) VALUES ('Sin número')`, [], /null value/);

// --- (b) unicidad (usuario, teléfono) ---
await falla("authenticated", U, `INSERT INTO contactos (nombre, telefono) VALUES ('Repetido', '+51999888777')`, [], /duplicate key|unique/);

// --- (c) RLS ---
assert.deepEqual((await como("authenticated", U, `SELECT nombre FROM contactos ORDER BY nombre`)).map((r) => r.nombre), ["Marco", "Rosa"], "solo los suyos");
assert.deepEqual((await como("authenticated", OTRO, `SELECT nombre FROM contactos`)).map((r) => r.nombre), ["Marco ajeno"]);
assert.deepEqual(await como("authenticated", "cccccccc-0000-4000-8000-000000000003", `SELECT 1 FROM contactos`), [], "un usuario sin filas no ve las de otros");
assert.deepEqual(await como("authenticated", null, `SELECT 1 FROM contactos`), [], "sin sub en el JWT no hay filas");

// no puede insertar a nombre de otro
await falla("authenticated", U, `INSERT INTO contactos (user_id, nombre, telefono) VALUES ($1, 'Intruso', '+51999000222')`, [OTRO], /row-level security/);
// ni mover su fila a otro dueño
await falla("authenticated", U, `UPDATE contactos SET user_id = $1 WHERE contacto_id = $2`, [OTRO, marco.contacto_id], /row-level security/);
// ni tocar la ajena: UPDATE y DELETE no afectan ninguna fila
assert.deepEqual(await como("authenticated", U, `UPDATE contactos SET nombre = 'Hackeado' WHERE contacto_id = $1 RETURNING 1`, [ajeno.contacto_id]), []);
assert.deepEqual(await como("authenticated", U, `DELETE FROM contactos WHERE contacto_id = $1 RETURNING 1`, [ajeno.contacto_id]), []);
assert.equal((await como("service_role", null, `SELECT nombre FROM contactos WHERE contacto_id = $1`, [ajeno.contacto_id]))[0].nombre, "Marco ajeno", "la ajena sigue intacta");
// lo suyo sí se edita y se borra
assert.equal((await como("authenticated", U, `UPDATE contactos SET relacion = 'de Saya (trabajo)' WHERE contacto_id = $1 RETURNING relacion`, [marco.contacto_id]))[0].relacion, "de Saya (trabajo)");
assert.equal((await como("authenticated", U, `DELETE FROM contactos WHERE nombre = 'Rosa' RETURNING 1`)).length, 1);

// --- (d) permisos: el rol anónimo no puede ni leer ---
await falla("anon", null, `SELECT * FROM contactos`, [], /permission denied/);
await falla("anon", null, `INSERT INTO contactos (user_id, nombre, telefono) VALUES ($1, 'Anon', '+51999000333')`, [U], /permission denied/);
const priv = async (rol) => (await db.query(`SELECT has_table_privilege('${rol}', 'contactos', 'SELECT') AS ok`)).rows[0].ok;
assert.equal(await priv("anon"), false);
assert.equal(await priv("authenticated"), true);
assert.equal(await priv("service_role"), true);
assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'contactos'`)).rows[0].relrowsecurity, true, "RLS encendida");

// --- (e) el rol de servicio manda user_id explícito ---
await como("service_role", null, `INSERT INTO contactos (user_id, nombre, telefono) VALUES ($1, 'Desde servicio', '+51999000444')`, [U]);
assert.equal((await como("authenticated", U, `SELECT count(*)::int AS n FROM contactos`))[0].n, 2);

// --- (f) al borrar al usuario se van sus contactos ---
await db.exec(`DELETE FROM users WHERE user_id = '${OTRO}'`);
assert.equal((await como("service_role", null, `SELECT count(*)::int AS n FROM contactos WHERE user_id = $1`, [OTRO]))[0].n, 0);

// Solo hay una política y es la nuestra (re-aplicar la migración no las acumula).
assert.deepEqual((await db.query(`SELECT policyname FROM pg_policies WHERE tablename = 'contactos'`)).rows.map((r) => r.policyname), ["contactos_all_own"]);

// Solo la llave y el índice único (usuario, teléfono): ningún índice que la app no use.
assert.deepEqual(
  (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'contactos' ORDER BY indexname`)).rows.map((r) => r.indexname),
  ["contactos_pkey", "idx_contactos_user_telefono"],
);

console.log("check-018: OK");
