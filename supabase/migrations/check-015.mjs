// Prueba la migración 015 contra un Postgres real (PGlite, WASM): aplica 005 (índice del vault) y 015 (dos veces: idempotencia) y
// comprueba (a) que vault_search completa con OR cuando la búsqueda estricta trae menos de 3 resultados y pone primero lo estricto,
// (b) que no relaja con comillas ni exclusiones, (c) vault_catalogo y (d) los permisos.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-015.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth; CREATE SCHEMA extensions;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE users (user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
`);
const run = (f) => db.exec(readFileSync(path.join(dir, f), "utf8"));
await run("005_vault.sql");
await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;`);

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
await db.exec(`INSERT INTO auth.users VALUES ('${U}'), ('${OTRO}'); INSERT INTO users VALUES ('${U}'), ('${OTRO}');`);
const doc = (user, p, kind, title, cliente, content) =>
  db.query(
    `INSERT INTO vault_docs (user_id, path, kind, title, cliente, content, sha) VALUES ($1, $2, $3, $4, $5, $6, 'x')`,
    [user, p, kind, title, cliente, content],
  );
await doc(U, "60-wiki/proyectos/novafondos.md", "ficha", "Novafondos (sistema EAFC)", "Novafondos", "# Novafondos\n\n## Qué es\nSistema de fondos colectivos para operar una EAFC supervisada por la SMV.\nSegunda línea del qué es.\n\n## Estado actual\nMotor y API listos.");
await doc(U, "60-wiki/proyectos/novafondos-simulador.md", "ficha", "Novafondos: simulador", "Novafondos", "## Qué es\nSimulador de la operación de novafondos.\n## Estado\nok");
await doc(U, "60-wiki/proyectos/novafondos-normativa.md", "ficha", "Novafondos: normativa SMV", "Novafondos", "Cobranza y normativa de novafondos.");
await doc(U, "60-wiki/proyectos/norte.md", "ficha", "Norte (gestor de pendientes)", "personal", "## QUÉ ES\nGestor local. Da contexto de las tareas de novafondos y otros proyectos.\n");
await doc(U, "60-wiki/proyectos/tdv.md", "ficha", "TDV plataforma", "TDV", "Contexto de la plataforma de datos de TDV.");
await doc(U, "30-areas/notas/nota-suelta.md", "nota", "Nota suelta", "personal", "Idea sobre novafondos para el contexto del mes.");
await doc(OTRO, "60-wiki/proyectos/novafondos-ajeno.md", "ficha", "Novafondos ajeno", "X", "## Qué es\nDe otro usuario, nunca debe verse.");

const como = async (rol, user, sql, params = []) => {
  await db.exec(`SET ROLE ${rol}; SELECT set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
const buscar = (q, extra = "") => como("authenticated", U, `SELECT path, kind FROM vault_search($1${extra})`, [q]);
const slugs = (rows) => rows.map((r) => path.basename(r.path, ".md"));

// --- Antes de 015 (comportamiento de 005): "contexto novafondos" solo trae lo que tiene AMBAS palabras ---
const antes = slugs(await buscar("contexto novafondos"));
assert.deepEqual(antes.sort(), ["nota-suelta", "norte"].sort(), "con 005 solo cumplen las dos palabras (Norte y la nota)");

await run("015_vault_memoria_catalogo.sql");
await run("015_vault_memoria_catalogo.sql"); // idempotente
await run("015_vault_memoria_catalogo.sql");

// --- (a) AND < 3 → completa con OR, lo estricto primero ---
const despues = slugs(await buscar("contexto novafondos"));
assert.ok(despues.length >= 5, `con 015 completa con OR (devolvió ${despues.length})`);
assert.deepEqual(new Set(despues.slice(0, 2)), new Set(["norte", "nota-suelta"]), "los que cumplen TODAS las palabras van primero");
for (const s of ["novafondos", "novafondos-simulador", "novafondos-normativa", "tdv"]) assert.ok(despues.includes(s), `incluye ${s}`);
assert.ok(!despues.includes("novafondos-ajeno"), "nunca filas de otro usuario");

// "nova fondos" (como lo transcribe la voz): ninguna ficha tiene "nova" suelta, pero el OR por "fondos" ya encuentra la principal
assert.equal(slugs(await buscar("nova fondos"))[0], "novafondos");

// Una sola palabra con >= 3 resultados: no cambia nada ("novafondos" está en 5 docs; TDV no lo tiene y no entra)
const solo = slugs(await buscar("novafondos"));
assert.equal(solo.length, 5);
assert.ok(!solo.includes("tdv"));
// Dos palabras: lo que cumple ambas va primero
assert.equal(slugs(await buscar("novafondos simulador"))[0], "novafondos-simulador");

// Con >= 3 resultados estrictos NO se amplía: las tres primeras fichas dicen "contexto" Y "novafondos" y TDV (solo "contexto") queda fuera
await doc(U, "60-wiki/proyectos/novafondos-extra1.md", "ficha", "Extra 1", "Novafondos", "contexto de novafondos uno");
await doc(U, "60-wiki/proyectos/novafondos-extra2.md", "ficha", "Extra 2", "Novafondos", "contexto de novafondos dos");
const estrictos = slugs(await buscar("contexto novafondos"));
assert.equal(estrictos.length, 4, `norte, nota-suelta y los 2 extra; sin TDV ni las demás (devolvió ${estrictos})`);
assert.ok(!estrictos.includes("tdv"));
await db.exec(`DELETE FROM vault_docs WHERE path LIKE '%novafondos-extra%'`);

// --- (b) comillas y exclusiones: lo exacto no se relaja ---
assert.deepEqual(slugs(await buscar('"contexto novafondos"')), [], "frase exacta sin coincidencia exacta: nada");
const excl = slugs(await buscar("novafondos -simulador"));
assert.ok(!excl.includes("novafondos-simulador"), "exclusión respetada");

// --- palabras vacías ---
assert.deepEqual(await buscar("de la"), []);

// --- kinds, límite y contexto siguen funcionando ---
assert.ok((await como("authenticated", U, `SELECT kind FROM vault_search('novafondos', NULL, ARRAY['nota'], 2, true)`)).every((r) => r.kind === "nota"));
const ctx = await como("authenticated", U, `SELECT context FROM vault_search('novafondos', NULL, NULL, 8, true)`);
assert.ok(ctx[0].context.includes("⟦"), "context con coincidencias marcadas");

// --- (c) vault_catalogo ---
const cat = await como("authenticated", U, `SELECT * FROM vault_catalogo()`);
assert.equal(cat.length, 5, "5 fichas del usuario (la ajena no)");
const nf = cat.find((r) => r.path.endsWith("/novafondos.md"));
assert.ok(nf.que_es.startsWith("Sistema de fondos colectivos para operar una EAFC supervisada por la SMV."), nf.que_es);
assert.ok(nf.que_es.includes("Segunda línea") && !nf.que_es.includes("Motor y API"), "solo la sección Qué es, en una línea");
assert.ok(cat.find((r) => r.path.endsWith("/norte.md")).que_es.startsWith("Gestor local"), "encabezado en mayúsculas");
assert.equal(cat.find((r) => r.path.endsWith("/tdv.md")).que_es, "", "sin sección Qué es: vacío");
assert.ok(cat.every((r) => r.que_es.length <= 400));

// --- (d) permisos: anon no ejecuta; authenticated y service_role sí ---
for (const fn of ["vault_search(text, text, text[], integer, boolean)", "vault_catalogo()"]) {
  const priv = async (rol) => (await db.query(`SELECT has_function_privilege('${rol}', '${fn}', 'EXECUTE') AS ok`)).rows[0].ok;
  assert.equal(await priv("anon"), false, `${fn}: anon no`);
  assert.equal(await priv("authenticated"), true, `${fn}: authenticated sí`);
  assert.equal(await priv("service_role"), true, `${fn}: service_role sí`);
}
const sec = (await db.query(`SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('vault_search', 'vault_catalogo')`)).rows;
assert.ok(sec.every((r) => r.prosecdef === false), "ambas corren como el usuario que llama (RLS), igual que en 005");

console.log("check-015: OK");
