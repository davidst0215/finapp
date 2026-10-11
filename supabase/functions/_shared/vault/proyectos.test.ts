// node --experimental-strip-types --test supabase/functions/_shared/vault/proyectos.test.ts
// Las carpetas de 20-projects son las reales de David; las fichas, mínimas e inventadas con la misma forma que las reales
// (cliente, ficha madre y la línea «Vault: …» que nombra carpetas). La configuración de Norte NO está aquí (no vive en el repo).
import test from "node:test";
import assert from "node:assert/strict";
import {
  carpetasDeFicha, carpetasParaPendientes, construirIndice, destinoHablado, fichaProy, frenteHablado, preguntaProyecto, refsDeVault, resolverProyecto,
  type FichaProy, type Indice,
} from "./proyectos.ts";
import { EMPTY_CONFIG, parseConfig } from "./taxonomy.ts";

const CARPETAS = [
  "cajon-desastre", "croma", "life", "lota", "mqsco-admision", "mqsco-aprobaciones", "mqsco-arquitectura-de-datos", "mqsco-cobranzas",
  "mqsco-fidelizacion", "mqsco-herramientas", "mqsco-presentaciones", "mqsco-reingresos", "mqsco-reporteria", "mqsco-retencion",
  "mqspe-aprobaciones", "mqspe-arquitectura-de-datos", "mqspe-enrutamiento", "mqspe-funnel-de-seguimiento", "mqspe-herramientas",
  "mqspe-presentaciones", "mqspe-reporteria", "mqspe-scoring", "norte", "novafondos-app", "novafondos-normativa", "panzones",
  "tdv-analisis", "tdv-arquitectura-de-datos", "tdv-bolsa-de-costos", "tdv-herramientas", "tdv-reporteria-de-procesos", "vera", "wabid",
];

const ficha = (slug: string, cliente: string | null, padre: string | null, content: string): FichaProy => fichaProy({ slug, cliente, padre, content });
const FICHAS: FichaProy[] = [
  ficha("tdv", "TDV", null, String.raw`Vault: \`30-areas\textil-tdv\textil-tdv.md\`, \`20-projects\tdv-*\pendientes.md\`, \`_parked\gosentio-*\`. API de GitHub.`.replaceAll("\\`", "`")),
  ficha("tdv-bolsa-de-costos", "TDV", "tdv", String.raw`Vault: \`20-projects\tdv-bolsa-de-costos\pendientes.md\`.`.replaceAll("\\`", "`")),
  ficha("tdv-reportes-e-informes", "TDV", "tdv", String.raw`Vault: \`20-projects\tdv-analisis\pendientes.md\`, \`20-projects\tdv-reporteria-de-procesos\pendientes.md\` (vacío).`.replaceAll("\\`", "`")),
  ficha("maqui-colombia", "Maqui CO", null, "Repos locales (git log). Vault 20-projects/mqsco-*/pendientes.md y _parked."),
  ficha("maqui-colombia-cobranzas-gestion", "Maqui CO", "maqui-colombia", "Repo con git desde 2026-09-01. Vault: mqsco-herramientas, mqsco-cobranzas."),
  ficha("maqui-peru", "Maqui PE", null, "- Vault: 20-projects/mqspe-*/pendientes.md; _parked/comisiones-pe, _parked/mqs-dashboard"),
  ficha("novafondos", "Novafondos", null, "Vault: `20-projects/novafondos-app/pendientes.md` y `novafondos-normativa/pendientes.md` (tareas del 27-sep)."),
  ficha("novafondos-normativa", "Novafondos", "novafondos", "Vault: `20-projects/novafondos-normativa/pendientes.md`."),
  ficha("novafondos-simulador", "Novafondos", "novafondos", "Simulador de la operación."),
  ficha("lota", "personal", null, "Pendientes en el vault (`20-projects/lota/pendientes.md`, 2026-08-25)."),
  ficha("lota-vision", "personal", "lota", "Estadísticas por jugador desde video."),
  ficha("vera", "Vera", null, "Vault: `20-projects/vera/vera.md` y `pendientes.md`."),
  ficha("vera-web", "Vera", "vera", "Vault `20-projects/vera/vera.md` (stale)."),
  // Un índice general nombra muchas carpetas: no debe regalar su nombre a todas.
  ficha("parqueados", "personal", null, "Carpetas: 20-projects/croma/x.md, 20-projects/life/x.md, 20-projects/lota/x.md, 20-projects/norte/x.md, 20-projects/wabid/x.md, 20-projects/vera/x.md"),
  ficha("norte", "personal", null, "Los `.md` de `vault/20-projects/` con slugs prefijados (`tdv-`, `mqsco-`, `mqspe-`)."),
  ficha("life", "personal", null, "La carpeta del vault `20-projects/life/` donde caen los pendientes del día a día."),
  ficha("wabid", "personal", null, "Asistente personal."),
  ficha("croma", "personal", null, "Vault: `20-projects/croma/pendientes.md` vacío."),
  ficha("panzones", "personal", null, "Landings."),
];

const IX = construirIndice(EMPTY_CONFIG, CARPETAS, FICHAS);

const una = (ix: Indice, q: string) => {
  const r = resolverProyecto(q, ix);
  assert.equal(r.kind, "one", `«${q}» → ${r.kind}${r.kind === "many" ? ": " + r.opciones.map((o) => o.folder).join(", ") : ""}`);
  return r.kind === "one" ? r.destino.folder : "";
};
const varias = (ix: Indice, q: string) => {
  const r = resolverProyecto(q, ix);
  assert.equal(r.kind, "many", q);
  return r.kind === "many" ? r.opciones.map((o) => o.folder) : [];
};

test("refsDeVault: rutas con / y con \\, prefijos, listas «Vault: a, b» y «x/pendientes.md»", () => {
  const r = refsDeVault(
    String.raw`Vault 20-projects/mqsco-*/pendientes.md y _parked.
Vault: mqsco-herramientas, mqsco-cobranzas.
\`20-projects\tdv-analisis\pendientes.md\` y 20-projects\tdv-*\pendientes.md
Vault: \`20-projects/novafondos-app/pendientes.md\` y \`novafondos-normativa/pendientes.md\`
20-projects/vera/vera.md y la carpeta 20-projects/`.replaceAll("\\`", "`"),
  );
  assert.deepEqual(r.prefijos.sort(), ["mqsco-", "tdv-"]);
  assert.deepEqual(r.carpetas.sort(), ["mqsco-cobranzas", "mqsco-herramientas", "novafondos-app", "novafondos-normativa", "tdv-analisis", "vera"]);
  assert.deepEqual(refsDeVault("sin nada de eso"), { carpetas: [], prefijos: [] });
});

test("resolverProyecto: los alias hablados que David usa", () => {
  assert.equal(una(IX, "TDV bolsa"), "tdv-bolsa-de-costos");
  assert.equal(una(IX, "tdv bolsa de costos"), "tdv-bolsa-de-costos");
  assert.equal(una(IX, "la bolsa de costos de tdv"), "tdv-bolsa-de-costos");
  assert.equal(una(IX, "Maqui Colombia cobranzas"), "mqsco-cobranzas");
  assert.equal(una(IX, "cobranzas de maqui colombia"), "mqsco-cobranzas");
  assert.equal(una(IX, "maqui co cobranzas"), "mqsco-cobranzas");
  assert.equal(una(IX, "mqs co cobranzas"), "mqsco-cobranzas");
  assert.equal(una(IX, "mqsco-cobranzas"), "mqsco-cobranzas");
  assert.equal(una(IX, "novafondos app"), "novafondos-app");
  assert.equal(una(IX, "nova fondos normativa"), "novafondos-normativa");
  assert.equal(una(IX, "vera"), "vera");
  assert.equal(una(IX, "Lota"), "lota");
  assert.equal(una(IX, "wabid"), "wabid");
  assert.equal(una(IX, "mi proyecto life"), "life");
  assert.equal(una(IX, "scoring de maqui peru"), "mqspe-scoring");
  assert.equal(una(IX, "el funnel de seguimiento de maqui perú"), "mqspe-funnel-de-seguimiento");
});

test("resolverProyecto: tolera tildes, mayúsculas, espacios y guiones", () => {
  assert.equal(una(IX, "Reportería de procesos"), "tdv-reporteria-de-procesos");
  assert.equal(una(IX, "reporteria-de-procesos"), "tdv-reporteria-de-procesos");
  assert.equal(una(IX, "TDV—BOLSA"), "tdv-bolsa-de-costos");
  assert.equal(una(IX, "  tdv   bolsa  "), "tdv-bolsa-de-costos");
  assert.equal(una(IX, "NOVA-FONDOS APP"), "novafondos-app");
  assert.equal(una(IX, "Funnel de Seguimiento Perú"), "mqspe-funnel-de-seguimiento");
  assert.equal(una(IX, "admisión colombia"), "mqsco-admision");
});

test("resolverProyecto: «nova fondos» o «novafondos» a secas son ambiguos → ¿app o normativa?", () => {
  for (const q of ["nova fondos", "novafondos", "Nova Fondos", "nova-fondos"]) {
    assert.deepEqual(varias(IX, q), ["novafondos-app", "novafondos-normativa"], q);
  }
  const r = resolverProyecto("nova fondos", IX);
  assert.equal(r.kind === "many" && r.mismoGrupo, true);
  const p = preguntaProyecto(r as Extract<typeof r, { kind: "many" }>);
  assert.equal(p.message, "¿En qué frente de Novafondos: app o normativa?");
  assert.equal(p.voz, "¿En Novafondos: app o normativa?");
});

test("resolverProyecto: «Maqui Perú» y «TDV» son un proyecto con varios frentes", () => {
  const pe = varias(IX, "Maqui Perú");
  assert.equal(pe.length, 8);
  assert.ok(pe.every((f) => f.startsWith("mqspe-")));
  const co = varias(IX, "maqui colombia");
  assert.equal(co.length, 10);
  assert.ok(co.every((f) => f.startsWith("mqsco-")));
  assert.deepEqual(varias(IX, "tdv").sort(), ["tdv-analisis", "tdv-arquitectura-de-datos", "tdv-bolsa-de-costos", "tdv-herramientas", "tdv-reporteria-de-procesos"]);
  const r = resolverProyecto("maqui peru", IX);
  assert.equal(r.kind === "many" && r.mismoGrupo, true);
  const p = preguntaProyecto(r as Extract<typeof r, { kind: "many" }>);
  assert.match(p.message, /^Hay 8 frentes en Maqui PE: /);
  assert.ok(p.voz.length <= 96 && p.voz.endsWith("?") || p.voz.endsWith("."), p.voz);
  assert.match(p.voz, /Maqui PE/);
});

test("resolverProyecto: un frente que existe en varios proyectos pregunta entre proyectos", () => {
  const r = resolverProyecto("herramientas", IX);
  assert.equal(r.kind, "many");
  if (r.kind !== "many") return;
  assert.deepEqual(r.opciones.map((o) => o.folder), ["mqsco-herramientas", "mqspe-herramientas", "tdv-herramientas"]);
  assert.equal(r.mismoGrupo, false);
  const p = preguntaProyecto(r);
  assert.equal(p.message, "¿En cuál: Maqui CO herramientas, Maqui PE herramientas o TDV herramientas?");
  assert.ok(p.voz.length <= 96 && p.voz.endsWith("?"), p.voz);
});

test("resolverProyecto: una palabra que no reconoce ningún proyecto se descarta si queda la mitad («lota visión» → lota)", () => {
  const r = resolverProyecto("lota visión", IX);
  assert.equal(r.kind === "one" && r.destino.folder, "lota");
  assert.equal(r.kind === "one" && r.aproximado, true);
  const t = resolverProyecto("vera marketing", IX);
  assert.equal(t.kind === "one" && t.destino.folder, "vera");
  // demasiadas palabras desconocidas: no se adivina
  assert.equal(resolverProyecto("lota alfa beta gamma", IX).kind, "none");
  assert.equal(resolverProyecto("alfa beta", IX).kind, "none");
});

test("resolverProyecto: vacío, relleno y el cajón", () => {
  for (const q of ["", "   ", "de la", "mi proyecto", "las tareas", undefined, 42]) assert.equal(resolverProyecto(q, IX).kind, "none", String(q));
  for (const q of ["el cajón", "cajon desastre", "Cajón"]) {
    const r = resolverProyecto(q, IX);
    assert.equal(r.kind === "one" && r.destino.folder, "cajon-desastre", q);
  }
});

test("los índices generales (parqueados) no regalan su nombre: «parqueados» no es alias de ninguna carpeta", () => {
  assert.equal(resolverProyecto("parqueados", IX).kind, "none");
  for (const d of IX.destinos) assert.ok(!d.palabras.includes("parqueados"), d.folder);
  // y la ficha madre sí habla de sus carpetas
  assert.deepEqual(carpetasDeFicha(IX, "novafondos").sort(), ["novafondos-app", "novafondos-normativa"]);
});

test("carpetasDeFicha: una ficha hija sin carpeta propia usa la de su ficha madre; las que nombran carpetas, esas", () => {
  assert.deepEqual(carpetasDeFicha(IX, "lota-vision"), ["lota"]);
  assert.deepEqual(carpetasDeFicha(IX, "novafondos-normativa"), ["novafondos-normativa"]);
  assert.deepEqual(carpetasDeFicha(IX, "tdv-bolsa-de-costos"), ["tdv-bolsa-de-costos"]);
  assert.deepEqual(carpetasDeFicha(IX, "maqui-colombia-cobranzas-gestion").sort(), ["mqsco-cobranzas", "mqsco-herramientas"]);
  assert.deepEqual(carpetasDeFicha(IX, "novafondos-simulador").sort(), ["novafondos-app", "novafondos-normativa"]);
  assert.deepEqual(carpetasDeFicha(IX, "no-existe"), []);
});

test("cómo se dice un destino: frente y proyecto, sin prefijos crudos", () => {
  const d = (f: string) => IX.destinos.find((x) => x.folder === f)!;
  assert.equal(frenteHablado(d("tdv-bolsa-de-costos")), "Bolsa de costos");
  assert.equal(destinoHablado(d("tdv-bolsa-de-costos")), "TDV bolsa de costos");
  assert.equal(destinoHablado(d("mqsco-cobranzas")), "Maqui CO cobranzas");
  assert.equal(destinoHablado(d("novafondos-app")), "Novafondos app");
  assert.equal(destinoHablado(d("vera")), "Vera");
  assert.equal(destinoHablado(IX.inbox), "el cajón");
});

test("con la configuración de Norte, sus nombres de proyecto y frente también valen y mandan en las etiquetas", () => {
  const cfg = parseConfig({ trabajo: { "MQS Colombia": [{ carpeta: "mqsco-cobranzas", nombre: "Cobranzas" }, { carpeta: "mqsco-admision", nombre: "Admisión" }], Nova: [{ carpeta: "novafondos-app", nombre: "App" }, { carpeta: "novafondos-normativa", nombre: "Normativa SMV" }] } });
  const ix = construirIndice(cfg, CARPETAS, FICHAS);
  assert.equal(una(ix, "mqs colombia cobranzas"), "mqsco-cobranzas"); // por la configuración
  assert.equal(una(ix, "maqui colombia cobranzas"), "mqsco-cobranzas"); // por las fichas
  // «mqs colombia» es el nombre de la configuración: solo los frentes que ella lista (los demás del prefijo no se llaman así)
  assert.deepEqual(varias(ix, "mqs colombia").sort(), ["mqsco-admision", "mqsco-cobranzas"]);
  assert.deepEqual(varias(ix, "maqui colombia").length, 10); // por las fichas, todos
  const r = resolverProyecto("nova fondos", ix);
  assert.equal(r.kind, "many");
  const p = preguntaProyecto(r as Extract<typeof r, { kind: "many" }>);
  assert.equal(p.message, "¿En qué frente de Nova: app o normativa SMV?");
  assert.equal(destinoHablado(ix.destinos.find((x) => x.folder === "mqsco-cobranzas")!), "MQS Colombia Cobranzas");
});

test("sin fichas (la lectura falló) los alias propios de las carpetas siguen funcionando", () => {
  const ix = construirIndice(EMPTY_CONFIG, CARPETAS, []);
  assert.equal(una(ix, "tdv bolsa"), "tdv-bolsa-de-costos");
  assert.equal(una(ix, "nova fondos app"), "novafondos-app");
  assert.equal(una(ix, "mqsco cobranzas"), "mqsco-cobranzas");
  assert.equal(resolverProyecto("maqui colombia cobranzas", ix).kind, "none"); // sin fichas no se sabe qué es «maqui colombia»
});

test("carpetasParaPendientes: primero el proyecto de la pregunta, luego las carpetas de las fichas elegidas; nunca el cajón; máximo 3", () => {
  const etiquetas = (slugs: string[], q: string) => carpetasParaPendientes(slugs, q, IX).map((c) => `${c.carpeta}=${c.etiqueta}`);
  // el proyecto que nombra la pregunta
  assert.deepEqual(etiquetas([], "tdv bolsa de costos estado"), ["tdv-bolsa-de-costos=TDV bolsa de costos"]);
  // dos frentes (pocos): los dos
  assert.deepEqual(etiquetas([], "nova fondos"), ["novafondos-app=Novafondos app", "novafondos-normativa=Novafondos normativa"]);
  // demasiados frentes (los 10 de Maqui Colombia): no se trae ninguno por el nombre; manda la ficha elegida
  assert.deepEqual(etiquetas(["maqui-colombia-cobranzas-gestion"], "maqui colombia"), ["mqsco-cobranzas=Maqui CO cobranzas", "mqsco-herramientas=Maqui CO herramientas"]);
  // sin proyecto en la pregunta: las carpetas de la ficha (o de su ficha madre)
  assert.deepEqual(etiquetas(["lota-vision"], "estado visión"), ["lota=Lota"]);
  assert.deepEqual(etiquetas(["novafondos-normativa"], "cesión"), ["novafondos-normativa=Novafondos normativa"]);
  // sin repetidos entre pregunta y ficha, y con tope
  assert.deepEqual(etiquetas(["novafondos"], "novafondos app"), ["novafondos-app=Novafondos app", "novafondos-normativa=Novafondos normativa"]);
  assert.equal(carpetasParaPendientes(["tdv"], "algo", IX).length, 3, "tdv tiene 5 frentes: tope 3");
  // el cajón y lo desconocido no cuentan
  assert.deepEqual(carpetasParaPendientes([], "el cajón", IX), []);
  assert.deepEqual(carpetasParaPendientes(["no-existe"], "xyz", IX), []);
});
