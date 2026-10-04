// node --experimental-strip-types --test supabase/functions/_shared/vault/docs.test.ts
// Fixtures con la forma de las fichas reales (frontmatter + secciones) pero con contenido inventado.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDoc, classifyPath, cleanMarkdown, folderOfPath, isTaskFile, parseFrontmatter, planSync, slugOf, snippetParts, snippetText,
  wikilinks,
} from "./docs.ts";

const FICHA = `---
type: ficha-proyecto
proyecto: acme-ventas
padre: acme
cliente: Acme
estado: activo
actualizado: 2026-10-04
repos: [acme/ventas-api, acme/ventas-web]
rutas_locales: [C:\\Users\\Ejemplo\\ventas, "C:\\otra ruta"]
tags: [ficha, proyecto/acme-ventas, "#cliente/acme", stack/python]
---
# Acme · Ventas (tablero)

## Qué es
Tablero de ventas. Ver [[acme]] y [[Acme Datos|los datos]] o [[ventas-web#Estado]].

## Estado
| Campo | Valor |
|---|---|
| Entrega | **septiembre** |
`;

test("classifyPath: qué se indexa y como qué", () => {
  assert.equal(classifyPath("20-projects/acme-ventas/pendientes.md"), "pendientes");
  assert.equal(classifyPath("20-projects/acme-ventas/ventas.md"), "nota");
  assert.equal(classifyPath("20-projects/acme-ventas/sessions/s1.md"), "nota");
  assert.equal(classifyPath("20-projects/acme-ventas/sessions/pendientes.md"), "nota");
  assert.equal(classifyPath("60-wiki/proyectos/acme-ventas.md"), "nota"); // pasa a ficha según el frontmatter
  assert.equal(classifyPath("60-wiki/proyectos/INDEX.md"), null);
  for (const p of ["30-areas/a/b.md", "40-resources/x.md", "50-archive/z/z.md", "10-daily/2026-10-04.md"]) assert.equal(classifyPath(p), "nota", p);
  for (const p of [
    "README.md", "SETUP.md", "90-meta/MOC-projects.md", "_parked/x/y.md", "_backups/a.md", ".obsidian/x.md", "05-raw/INDEX.md",
    "20-projects/suelto.md", "20-projects/a/.oculto.md", "60-wiki/proyectos/foto.png", "00-inbox/Sin título.base",
  ]) assert.equal(classifyPath(p), null, p);
});

test("isTaskFile y folderOfPath (Norte busca tareas en todo 20-projects)", () => {
  assert.equal(isTaskFile("20-projects/acme-ventas/pendientes.md"), true);
  assert.equal(isTaskFile("20-projects/acme-ventas/otra.md"), true);
  assert.equal(isTaskFile("60-wiki/proyectos/acme-ventas.md"), false);
  assert.equal(isTaskFile("20-projects/pendientes.md"), false);
  assert.equal(folderOfPath("20-projects/acme-ventas/sessions/s1.md"), "acme-ventas");
  assert.equal(slugOf("60-wiki/proyectos/acme-ventas.md"), "acme-ventas");
});

test("parseFrontmatter: escalares, listas en línea con comillas y listas con guiones", () => {
  const { data, body } = parseFrontmatter(FICHA);
  assert.equal(data.type, "ficha-proyecto");
  assert.equal(data.cliente, "Acme");
  assert.deepEqual(data.repos, ["acme/ventas-api", "acme/ventas-web"]);
  assert.deepEqual(data.rutas_locales, ["C:\\Users\\Ejemplo\\ventas", "C:\\otra ruta"]);
  assert.deepEqual(data.tags, ["ficha", "proyecto/acme-ventas", "#cliente/acme", "stack/python"]);
  assert.equal(body.startsWith("# Acme · Ventas"), true);

  const lista = parseFrontmatter("---\r\ntags:\r\n  - uno\r\n  - \"dos y tres\"\r\ntitle: Algo\r\n---\r\ncuerpo");
  assert.deepEqual(lista.data.tags, ["uno", "dos y tres"]);
  assert.equal(lista.data.title, "Algo");
  assert.equal(lista.body, "cuerpo");

  assert.deepEqual(parseFrontmatter("sin frontmatter"), { data: {}, body: "sin frontmatter" });
});

test("wikilinks: sin alias, sin encabezado, en minúscula y sin repetir", () => {
  assert.deepEqual(wikilinks("[[Acme]] y [[acme]] más [[Acme Datos|los datos]] y [[carpeta/Nota#Parte]]"), ["acme", "acme datos", "nota"]);
  assert.deepEqual(wikilinks("nada"), []);
});

test("buildDoc: ficha con metadatos, título del H1, tags limpios y fecha válida", () => {
  const d = buildDoc("60-wiki/proyectos/acme-ventas.md", FICHA, "abc123")!;
  assert.equal(d.kind, "ficha");
  assert.equal(d.title, "Acme · Ventas (tablero)");
  assert.equal(d.cliente, "Acme");
  assert.equal(d.proyecto, "acme-ventas");
  assert.equal(d.padre, "acme");
  assert.equal(d.estado, "activo");
  assert.deepEqual(d.tags, ["ficha", "proyecto/acme-ventas", "cliente/acme", "stack/python"]);
  assert.deepEqual(d.links, ["acme", "acme datos", "ventas-web"]);
  assert.equal(d.actualizado, "2026-10-04");
  assert.equal(d.sha, "abc123");
  assert.equal(d.content.includes("type: ficha-proyecto"), false); // sin frontmatter
  assert.equal(d.content.includes("Tablero de ventas"), true);
});

test("buildDoc: nota sin frontmatter usa el H1 o el nombre del archivo", () => {
  const conH1 = buildDoc("30-areas/ops/ops.md", "# Operaciones\ntexto", "s1")!;
  assert.equal(conH1.kind, "nota");
  assert.equal(conH1.title, "Operaciones");
  assert.equal(conH1.cliente, null);
  assert.equal(conH1.proyecto, null);
  const sinH1 = buildDoc("30-areas/ops/guia-de-despliegue.md", "texto", "s2")!;
  assert.equal(sinH1.title, "guia de despliegue");
});

test("buildDoc: los pendientes no guardan contenido (sus tareas van aparte) y los no indexables dan null", () => {
  const p = buildDoc("20-projects/acme-ventas/pendientes.md", "# Pendientes — Ventas\n- [ ] algo\n", "s3")!;
  assert.equal(p.kind, "pendientes");
  assert.equal(p.content, "");
  assert.equal(p.title, "Pendientes — Ventas");
  assert.equal(buildDoc("README.md", "x", "s4"), null);
});

test("buildDoc: fecha inválida se descarta", () => {
  const d = buildDoc("30-areas/a/a.md", "---\nactualizado: ayer\n---\ncuerpo", "s5")!;
  assert.equal(d.actualizado, null);
});

test("planSync: descarga lo nuevo o cambiado, borra lo que desapareció y cuenta lo igual", () => {
  const tree = [
    { path: "20-projects/a/pendientes.md", type: "blob", sha: "1", size: 100 },
    { path: "60-wiki/proyectos/x.md", type: "blob", sha: "2", size: 100 },
    { path: "60-wiki/proyectos/y.md", type: "blob", sha: "3", size: 100 },
    { path: "60-wiki/proyectos/grande.md", type: "blob", sha: "4", size: 900_000 },
    { path: ".obsidian/plugins/x/main.js", type: "blob", sha: "5", size: 10 },
    { path: "60-wiki", type: "tree", sha: "6" },
    { path: "README.md", type: "blob", sha: "7", size: 10 },
  ];
  const existing = new Map([
    ["20-projects/a/pendientes.md", "1"],
    ["60-wiki/proyectos/x.md", "viejo"],
    ["60-wiki/proyectos/borrado.md", "9"],
    ["60-wiki/proyectos/grande.md", "4"],
  ]);
  const plan = planSync(tree, existing);
  assert.deepEqual(plan.fetch.map((e) => e.path), ["60-wiki/proyectos/x.md", "60-wiki/proyectos/y.md"]);
  assert.deepEqual(plan.remove.sort(), ["60-wiki/proyectos/borrado.md", "60-wiki/proyectos/grande.md"]);
  assert.equal(plan.unchanged, 1);
});

test("cleanMarkdown y snippetParts: sin ruido de markdown y con las coincidencias marcadas", () => {
  assert.equal(cleanMarkdown("## Estado | **Entrega** | [[acme|Acme]] y [web](https://x.io/a)"), "Estado · Entrega · Acme y web");
  assert.equal(cleanMarkdown("|---|---|\n| a | b |"), "a · b");
  assert.deepEqual(snippetParts("la ⟦fuga⟧ real de ⟦caja⟧ ⟦chica⟧ es"), [
    { t: "la ", hit: false }, { t: "fuga", hit: true }, { t: " real de ", hit: false },
    { t: "caja", hit: true }, { t: " ", hit: false }, { t: "chica", hit: true }, { t: " es", hit: false },
  ]);
  assert.deepEqual(snippetParts("**negrita** ⟦clave⟧ [[nota|alias]]"), [
    { t: "negrita ", hit: false }, { t: "clave", hit: true }, { t: " alias", hit: false },
  ]);
  assert.equal(snippetText("a ⟦b⟧ **c**"), "a b c");
  assert.deepEqual(snippetParts("sin marcas"), [{ t: "sin marcas", hit: false }]);
  assert.deepEqual(snippetParts(""), []);
});
