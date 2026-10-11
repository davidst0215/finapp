// Prueba, contra un Postgres real (PGlite, WASM), que una nota escrita por Wabid entra al índice con lo MISMO que manda el agente tras
// escribir en GitHub (rowsForFile → vault_apply_sync, ver indexWrites en _shared/vault.ts) y que search_memory la encuentra al instante,
// sin esperar la sincronización de 5 minutos: vault_search la devuelve como `nota`, también cuando el agente ya eligió una ficha
// (kinds = ['nota']), y no crea tareas. Aplica 005 y 015.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node --experimental-strip-types supabase/migrations/check-notas-indice.mjs
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
const { anexarNota, lineaNota, notasHeader, notasPath } = await import(pathToFileURL(path.join(dir, "..", "functions", "_shared", "vault", "notas.ts")).href);
const { rowsForFile } = await import(pathToFileURL(path.join(dir, "..", "functions", "_shared", "vault", "rows.ts")).href);

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
for (const f of ["005_vault.sql", "015_vault_memoria_catalogo.sql"]) await db.exec(readFileSync(path.join(dir, f), "utf8"));
await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;`);

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
await db.exec(`INSERT INTO auth.users VALUES ('${U}'), ('${OTRO}'); INSERT INTO users VALUES ('${U}'), ('${OTRO}');`);
const como = async (user, sql, params = []) => {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec(`RESET ROLE`);
  }
};
/** Lo que hace indexWrites: las filas de rowsForFile al vault_apply_sync, a nombre del usuario. */
const indexar = async (user, path, text, sha) => {
  const r = rowsForFile(path, text, sha);
  await como(user, `SELECT vault_apply_sync($1, $2::jsonb, $3::jsonb, '{}', NULL)`, [user, JSON.stringify([r.doc]), JSON.stringify([{ path, tasks: r.tasks }])]);
};

// Una ficha del proyecto (la elige la IA) y una nota ajena con las mismas palabras
const FICHA = "60-wiki/proyectos/novafondos.md";
await indexar(U, FICHA, "---\ntype: ficha-proyecto\ncliente: Novafondos\n---\n# Novafondos\n\n## Qué es\nSistema de fondos colectivos.\n", "f1");
const P = notasPath("novafondos-app");
await indexar(OTRO, P, anexarNota(null, lineaNota("la cesión del otro usuario es secreta", "2026-10-11", 600), notasHeader("Otro", { cliente: "Novafondos", proyecto: "novafondos-app" })), "o1");

// --- La nota de Wabid ---
const L1 = lineaNota("decidimos cesión de 0,02 % mensual", "2026-10-11", 14 * 60 + 30);
const texto1 = anexarNota(null, L1, notasHeader("Saya Investments › Novafondos app", { cliente: "Novafondos", proyecto: "novafondos-app" }));
await indexar(U, P, texto1, "n1");

const buscar = (q, kinds = null) => como(U, `SELECT path, kind, title FROM vault_search($1, NULL, $2::text[], 8, true)`, [q, kinds]);
let hits = await buscar("cesión novafondos");
assert.ok(hits.some((h) => h.path === P && h.kind === "nota"), `la nota aparece al instante: ${JSON.stringify(hits)}`);
assert.equal(hits.find((h) => h.path === P).title, "Notas — Saya Investments › Novafondos app");
assert.equal((await buscar("secreta")).length, 0, "lo que escribió el otro usuario no sale en mis búsquedas");
assert.equal((await como(U, `SELECT count(*)::int AS n FROM vault_docs WHERE path = $1`, [P]))[0].n, 1, "una fila por archivo; la del otro usuario no se ve");

// con la ficha elegida, search_memory pide solo notas (parametrosBusqueda): la nota sigue saliendo
hits = await buscar("cesión mensual", ["nota"]);
assert.deepEqual(hits.map((h) => h.path), [P]);
const ctxRow = (await como(U, `SELECT context FROM vault_search('cesión mensual', NULL, ARRAY['nota'], 8, true)`))[0].context;
assert.ok(ctxRow.includes("⟦"), "con fragmento marcado para que el modelo redacte la respuesta");

// el filtro por cliente de vault_search (el `cliente` de search_memory) la encuentra gracias al frontmatter del archivo nuevo, y es solo la mía
const porCliente = await como(U, `SELECT path, cliente, proyecto FROM vault_search($1, $2, ARRAY['nota'], 8, false)`, ["cesión", "novafondos"]);
assert.deepEqual(porCliente.map((h) => [h.path, h.cliente, h.proyecto]), [[P, "Novafondos", "novafondos-app"]]);
assert.equal((await como(U, `SELECT count(*)::int AS n FROM vault_search($1, $2, ARRAY['nota'], 8, false)`, ["cesión", "TDV"]))[0].n, 0, "otro cliente: nada");

// --- Una segunda nota (otro sha): el índice se reemplaza, no se duplica, y sigue sin tareas ---
const L2 = lineaNota("cobranza queda para octubre", "2026-10-11", 15 * 60);
const texto2 = anexarNota(texto1, L2, notasHeader("x"));
await indexar(U, P, texto2, "n2");
const doc = (await como(U, `SELECT sha, content, kind FROM vault_docs WHERE path = $1`, [P]))[0];
assert.equal(doc.sha, "n2");
assert.equal(doc.kind, "nota");
assert.ok(doc.content.includes("decidimos cesión") && doc.content.includes("cobranza queda para octubre"), "las dos notas en el contenido");
assert.equal((await buscar("cobranza octubre", ["nota"])).length, 1);
assert.equal((await como(U, `SELECT count(*)::int AS n FROM vault_tasks WHERE path = $1`, [P]))[0].n, 0, "una nota no es una tarea de Norte");

console.log("check-notas-indice: OK");
