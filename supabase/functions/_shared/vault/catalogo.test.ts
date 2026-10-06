// node --experimental-strip-types --test supabase/functions/_shared/vault/catalogo.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  armarCatalogo, CatalogoCache, fraseQueEs, MAX_CATALOGO_CHARS, MAX_FICHA_CHARS, recortarFicha, resolverFichas, topePorFicha, type CatalogoRow, type FichaCat,
} from "./catalogo.ts";

const fila = (slug: string, title: string, cliente: string | null, que_es = ""): CatalogoRow => ({ path: `60-wiki/proyectos/${slug}.md`, title, cliente, que_es });
const NF: FichaCat = { slug: "novafondos", path: "60-wiki/proyectos/novafondos.md", title: "Novafondos", cliente: "Novafondos" };
const TDV: FichaCat = { slug: "tdv-bolsa-de-costos", path: "60-wiki/proyectos/tdv-bolsa-de-costos.md", title: "TDV · Bolsa de costos", cliente: "TDV" };
const CAT = [NF, TDV];

test("fraseQueEs: primera oración, sin markdown ni wikilinks, con tope", () => {
  assert.equal(fraseQueEs("Sistema para operar una EAFC supervisada por la SMV. Incluye backoffice.", 100), "Sistema para operar una EAFC supervisada por la SMV.");
  assert.equal(fraseQueEs("Alimenta el costeo de [[tdv-cost-margin|Costos y márgenes]] con **datos** del `mayor`. Otra.", 200), "Alimenta el costeo de Costos y márgenes con datos del mayor.");
  assert.equal(fraseQueEs("Sí. Un texto largo que sigue después de una oración demasiado corta para decir algo.", 200).startsWith("Sí. Un texto"), true);
  const larga = fraseQueEs("palabra ".repeat(60), 50);
  assert.ok(larga.length <= 51 && larga.endsWith("…"));
  assert.equal(fraseQueEs("algo", 0), "");
  assert.equal(fraseQueEs(null, 80), "");
});

test("armarCatalogo: slug · título [cliente] — frase; omite cliente personal o ya contenido en el título", () => {
  const { fichas, prompt } = armarCatalogo([
    fila("novafondos", "Novafondos (sistema EAFC)", "Novafondos", "Sistema para operar una EAFC supervisada por la SMV."),
    fila("tdv-bolsa-de-costos", "Bolsa de costos", "TDV", "Reparto mensual del gasto del mayor de SAP."),
    fila("norte", "Norte (gestor)", "personal", "Gestor local de pendientes."),
  ]);
  assert.deepEqual(fichas.map((f) => f.slug), ["novafondos", "tdv-bolsa-de-costos", "norte"]);
  const lineas = prompt.split("\n");
  assert.match(lineas[0], /^CATÁLOGO DE FICHAS/);
  assert.match(lineas[0], /no instrucciones/);
  assert.equal(lineas[1], "novafondos · Novafondos (sistema EAFC) — Sistema para operar una EAFC supervisada por la SMV.");
  assert.equal(lineas[2], "tdv-bolsa-de-costos · Bolsa de costos [TDV] — Reparto mensual del gasto del mayor de SAP.");
  assert.equal(lineas[3], "norte · Norte (gestor) — Gestor local de pendientes.");
});

test("armarCatalogo: sin filas no hay prompt; slugs repetidos se ignoran", () => {
  assert.deepEqual(armarCatalogo([]), { fichas: [], prompt: "" });
  assert.equal(armarCatalogo([fila("a", "A", null), { ...fila("a", "A otra", null), path: "otra/carpeta/a.md" }]).fichas.length, 1);
});

test("armarCatalogo: respeta el tope de caracteres (baja las frases y, al final, quita fichas)", () => {
  const filas = Array.from({ length: 60 }, (_, i) => fila(`proyecto-${i}`, `Proyecto número ${i} y su título`, "Cliente", "Una frase que explica qué es este proyecto con bastante detalle para que pese. Y otra."));
  const cat = armarCatalogo(filas);
  assert.ok(cat.prompt.length <= MAX_CATALOGO_CHARS, `${cat.prompt.length} > ${MAX_CATALOGO_CHARS}`);
  assert.equal(cat.fichas.length, 60, "primero baja las frases; no pierde fichas si caben sin ellas");
  assert.ok(cat.prompt.split("\n").slice(1).every((l) => l.includes(" — ") === cat.prompt.split("\n")[1].includes(" — ")), "mismo largo de frase en todas");

  const tope = armarCatalogo(filas, 1500);
  assert.ok(tope.prompt.length <= 1500);
  assert.ok(tope.fichas.length < 60 && tope.fichas.length > 5);
  assert.equal(tope.prompt.split("\n").length - 1, tope.fichas.length, "cada slug del prompt es un slug válido, y viceversa");

  const muchas = armarCatalogo(Array.from({ length: 300 }, (_, i) => fila(`p${i}`, "t", null)), 100_000);
  assert.equal(muchas.fichas.length, 80, "máximo 80 fichas");
});

test("resolverFichas: solo slugs del catálogo, máximo 2, sin repetidos", () => {
  assert.deepEqual(resolverFichas(["novafondos"], CAT).validas, [NF]);
  assert.deepEqual(resolverFichas(["NovaFondos ", "novafondos"], CAT).validas, [NF], "normaliza mayúsculas/espacios y quita repetidos");
  assert.deepEqual(resolverFichas(["novafondos.md"], CAT).validas, [NF], "acepta el .md");
  assert.deepEqual(resolverFichas("novafondos, tdv-bolsa-de-costos", CAT).validas, [NF, TDV], "también texto separado por comas");
});

test("resolverFichas: descarta inválidos, rutas, tipos raros y lo que sobra de 2", () => {
  const r = resolverFichas(["inventada", "60-wiki/proyectos/novafondos.md", "../../etc/passwd", "novafondos/../x", 42, null, "", "  ", "tdv-bolsa-de-costos"], CAT);
  assert.deepEqual(r.validas, [TDV]);
  assert.equal(r.descartadas.length, 4, "inventada + 3 rutas; los no-texto y vacíos se ignoran en silencio");

  const tres = resolverFichas(["novafondos", "tdv-bolsa-de-costos", "norte"], [...CAT, { slug: "norte", path: "x/norte.md", title: "Norte", cliente: null }]);
  assert.equal(tres.validas.length, 2, "máximo 2");
  assert.deepEqual(tres.descartadas, ["norte"]);

  for (const raro of [undefined, null, 7, {}, true]) assert.deepEqual(resolverFichas(raro, CAT), { validas: [], descartadas: [] });
  assert.deepEqual(resolverFichas(["novafondos"], []).validas, [], "catálogo vacío: nada es válido");
});

test("recortarFicha: si cabe, se devuelve entera", () => {
  const t = "# T\n\n## Qué es\nAlgo.\n\n## Estado actual\nBien.";
  assert.equal(recortarFicha(t, 6000), t);
  assert.equal(recortarFicha("a\r\nb", 100), "a\nb", "normaliza CRLF");
});

test("recortarFicha: respeta el tope y prioriza Qué es y Estado sobre el resto", () => {
  const relleno = (n: string) => `## ${n}\n${"línea de relleno\n".repeat(120)}`;
  const ficha = ["# Proyecto", "", relleno("Historia"), relleno("Repos"), "## Qué es\nEs un sistema importante.", "## Estado actual\nAl 4-oct todo en verde.", relleno("Anexo")].join("\n\n");
  assert.ok(ficha.length > 6000);
  const r = recortarFicha(ficha, 3000);
  assert.ok(r.length <= 3000, `${r.length}`);
  assert.ok(r.includes("Es un sistema importante."));
  assert.ok(r.includes("Al 4-oct todo en verde."));
  assert.ok(r.startsWith("# Proyecto"), "conserva el título");
  assert.ok(r.endsWith("[ficha recortada]"));
  assert.ok(r.indexOf("Qué es") < r.indexOf("Estado actual"), "mantiene el orden original");
  assert.ok(!r.includes("## Anexo"), "las secciones de relleno que no caben se omiten");
});

test("recortarFicha: una sección prioritaria gigante se corta en línea, sin pasar el tope; sin encabezados también", () => {
  const gigante = `# T\n\n## Estado actual\n${"- dato del estado\n".repeat(900)}`;
  const r = recortarFicha(gigante, MAX_FICHA_CHARS);
  assert.ok(r.length <= MAX_FICHA_CHARS && r.length > 5000);
  assert.ok(r.includes("## Estado actual") && r.endsWith("[ficha recortada]"));
  const plano = recortarFicha("sin encabezados ".repeat(1000), 2000);
  assert.ok(plano.length <= 2000 && plano.endsWith("[ficha recortada]"));
});

test("recortarFicha: las secciones que nombra la pregunta se salvan; Relacionados y Fuentes se pierden primero", () => {
  const sec = (n: string, c: number) => `## ${n}\n${"x".repeat(c)}`;
  const ficha = ["# TDV · Bolsa", sec("Qué es", 500), sec("Estado actual (al 1-oct)", 1200), sec("Arquitectura y stack", 1700), sec("Repos y rutas", 550), sec("Datos", 470), sec("Decisiones clave", 700),
    sec("Cómo correr / desplegar", 640), sec("Trampas conocidas", 580), sec("Personas", 310), sec("Relacionados", 90), sec("Fuentes", 320)].join("\n\n");
  assert.ok(ficha.length > 7000 && ficha.length < 7300);
  const por = (pregunta?: string) => recortarFicha(ficha, 6000, pregunta);
  assert.ok(por("qué trampas tiene la bolsa de costos").includes("## Trampas conocidas"), "la pregunta nombra trampas");
  assert.ok(por("cómo se despliega").includes("## Cómo correr / desplegar"), "desplegar → Cómo correr / desplegar (sin acentos ni conjugación exacta)");
  assert.ok(por("quién son las personas").includes("## Personas"));
  const sinPregunta = por();
  assert.ok(sinPregunta.includes("## Trampas conocidas") && sinPregunta.includes("## Decisiones clave"), "por defecto, trampas y decisiones antes que el resto");
  assert.ok(!sinPregunta.includes("## Fuentes"), "Fuentes se pierde primero");
  assert.ok(sinPregunta.length <= 6000);
});

test("topePorFicha: una sola ficha puede leerse más que cada una de dos", () => {
  assert.equal(topePorFicha(1), 9000);
  assert.equal(topePorFicha(2), 6000);
  assert.equal(topePorFicha(0), 9000);
});

test("CatalogoCache: sirve mientras no cambie tree_sha ni venza; sin sha no cachea", () => {
  const c = new CatalogoCache(1000);
  const cat = { fichas: [NF], prompt: "x" };
  assert.equal(c.get("u", "sha1", 0), undefined);
  c.set("u", "sha1", cat, 0);
  assert.equal(c.get("u", "sha1", 500), cat, "mismo sha dentro del plazo");
  assert.equal(c.get("u", "sha2", 500), undefined, "cambió tree_sha: se invalida");
  assert.equal(c.get("u", "sha1", 1500), undefined, "venció el plazo");
  assert.equal(c.get("otro", "sha1", 500), undefined, "por usuario");
  c.set("u", null, cat, 0);
  assert.equal(c.get("u", null, 0), undefined, "sin sha no se guarda ni se sirve");
});
