// Prueba la migración 019 contra un Postgres real (PGlite, WASM): la aplica tres veces (idempotencia) y comprueba (a) las restricciones de
// la tabla, (b) RLS (cada usuario solo ve y toca lo suyo; anon, nada), (c) el SQL equivalente a lo que manda agent/tools/hechos.ts
// (leer los más recientes, insertar, actualizar, borrar, duplicado literal) y (d) los permisos.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-019.mjs
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

await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE users (user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
  -- Supabase da estos privilegios por defecto a las tablas nuevas de public; la migración tiene que quitarlos a anon.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
`);
const run = () => db.exec(readFileSync(path.join(dir, "019_wabid_hechos.sql"), "utf8"));
await run();
await run(); // idempotente
await run();

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
await db.exec(`INSERT INTO auth.users VALUES ('${U}'), ('${OTRO}'); INSERT INTO users VALUES ('${U}'), ('${OTRO}');`);

/** Corre una consulta como el rol y usuario dados (lo que hace PostgREST con el JWT). */
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

// --- (a) restricciones ---
// user_id por defecto = el de la sesión (como en 011): el agente lo manda igual, pero un insert sin él también vale
const [h1] = await mios(`INSERT INTO wabid_hechos (texto, categoria) VALUES ('La tarjeta principal de David es la BBVA', 'finanzas') RETURNING *`);
assert.equal(h1.user_id, U, "user_id por defecto = auth.uid()");
assert.equal(h1.categoria, "finanzas");
assert.ok(h1.hecho_id && h1.creado && h1.actualizado, "id y marcas de tiempo por defecto");
await falla(() => mios(`INSERT INTO wabid_hechos (texto) VALUES ('   ')`), "23514", "texto en blanco");
await falla(() => mios(`INSERT INTO wabid_hechos (texto) VALUES ($1)`, ["x".repeat(201)]), "22001", "más de 200 caracteres");
await mios(`INSERT INTO wabid_hechos (texto) VALUES ($1)`, ["y".repeat(200)]); // 200 caben
await falla(() => mios(`INSERT INTO wabid_hechos (texto) VALUES ('la tarjeta principal de david es la bbva')`), "23505", "duplicado literal (sin mayúsculas)");
await falla(() => mios(`INSERT INTO wabid_hechos (texto, categoria) VALUES ('Otro', $1)`, ["c".repeat(41)]), "22001", "categoría de más de 40");

// --- (b) RLS ---
await como("authenticated", OTRO, `INSERT INTO wabid_hechos (texto) VALUES ('Marco es de Saya')`);
assert.deepEqual((await mios(`SELECT texto FROM wabid_hechos WHERE texto LIKE 'Marco%'`)), [], "no ve lo del otro usuario");
assert.equal((await como("authenticated", OTRO, `SELECT count(*)::int AS n FROM wabid_hechos`))[0].n, 1, "el otro solo ve el suyo");
await falla(() => mios(`INSERT INTO wabid_hechos (user_id, texto) VALUES ('${OTRO}', 'Falso')`), "42501", "no inserta a nombre de otro");
await falla(() => mios(`UPDATE wabid_hechos SET user_id = '${OTRO}' WHERE hecho_id = $1`, [h1.hecho_id]), "42501", "no pasa un recuerdo a otro usuario");
const ajeno = (await como("service_role", null, `SELECT hecho_id FROM wabid_hechos WHERE texto LIKE 'Marco%'`))[0].hecho_id;
assert.equal((await mios(`UPDATE wabid_hechos SET texto = 'Pisado' WHERE hecho_id = $1 RETURNING 1`, [ajeno])).length, 0, "no actualiza lo ajeno");
assert.equal((await mios(`DELETE FROM wabid_hechos WHERE hecho_id = $1 RETURNING 1`, [ajeno])).length, 0, "no borra lo ajeno");
assert.equal((await como("service_role", null, `SELECT count(*)::int AS n FROM wabid_hechos`))[0].n, 3, "el rol de servicio ve todo (RLS no aplica)");
await assert.rejects(() => como("anon", null, `SELECT * FROM wabid_hechos`), /permission denied/, "anon no lee");
await assert.rejects(() => como("anon", U, `INSERT INTO wabid_hechos (texto) VALUES ('x')`), /permission denied/, "anon no escribe");

// --- (c) lo que hace el agente ---
// actualizar un recuerdo: la marca de tiempo sube y vuelve a ser el más reciente
await db.exec(`UPDATE wabid_hechos SET actualizado = '2026-01-01T00:00:00Z', creado = '2026-01-01T00:00:00Z' WHERE user_id = '${U}'`);
await mios(`INSERT INTO wabid_hechos (user_id, texto, creado, actualizado) VALUES ('${U}', 'Segundo recuerdo', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')`);
const orden = () => mios(`SELECT texto FROM wabid_hechos ORDER BY actualizado DESC, creado DESC LIMIT 41`).then((r) => r.map((x) => x.texto.slice(0, 20)));
assert.deepEqual((await orden())[0], "Segundo recuerdo", "los más recientes primero");
await mios(`UPDATE wabid_hechos SET texto = 'La tarjeta principal de David es la Interbank', actualizado = '2026-03-01T00:00:00Z' WHERE hecho_id = $1 AND user_id = '${U}'`, [h1.hecho_id]);
assert.equal((await orden())[0], "La tarjeta principal", "el actualizado pasa al frente");
assert.equal((await mios(`SELECT count(*)::int AS n FROM wabid_hechos`))[0].n, 3, "actualizar no duplica");
assert.equal((await mios(`SELECT count(*)::int AS n FROM wabid_hechos WHERE texto ILIKE '%BBVA%'`))[0].n, 0);
// borrar
assert.equal((await mios(`DELETE FROM wabid_hechos WHERE hecho_id = $1 AND user_id = '${U}' RETURNING 1`, [h1.hecho_id])).length, 1);
assert.equal((await mios(`SELECT count(*)::int AS n FROM wabid_hechos`))[0].n, 2);
// al borrar al usuario caen sus recuerdos
await db.exec(`DELETE FROM auth.users WHERE id = '${OTRO}'`);
assert.equal((await como("service_role", null, `SELECT count(*)::int AS n FROM wabid_hechos WHERE user_id = '${OTRO}'`))[0].n, 0, "ON DELETE CASCADE");

// --- (d) permisos y forma ---
const priv = async (rol, p) => (await db.query(`SELECT has_table_privilege('${rol}', 'wabid_hechos', '${p}') AS ok`)).rows[0].ok;
for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
  assert.equal(await priv("anon", p), false, `anon no tiene ${p}`);
  assert.equal(await priv("authenticated", p), true, `authenticated tiene ${p}`);
}
assert.equal(await priv("authenticated", "TRUNCATE"), false, "authenticated no puede vaciar la tabla");
const rls = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'wabid_hechos'`)).rows[0];
assert.equal(rls.relrowsecurity, true, "RLS activa");
const pol = (await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'wabid_hechos'`)).rows[0].n;
assert.equal(pol, 1, "una sola política (las corridas repetidas no acumulan)");

console.log("check-019: OK");
