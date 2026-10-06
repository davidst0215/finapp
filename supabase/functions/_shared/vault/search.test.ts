// node --experimental-strip-types --test supabase/functions/_shared/vault/search.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnswerMessages, clienteChips, displayCliente, fuenteHablada, mensajeMemoria, parseAnswer, pickRelated, recortarOraciones,
  toSources, type Hit,
} from "./search.ts";

const hit = (o: Partial<Hit> & { path: string; title: string }): Hit => ({
  kind: "ficha", cliente: null, proyecto: null, padre: null, tags: [], links: [], score: 1, snippet: "", context: null, ...o,
});

test("displayCliente y clienteChips: agrupa sin importar mayúsculas y ordena por cantidad", () => {
  assert.equal(displayCliente("personal"), "Personal");
  assert.equal(displayCliente("ACME"), "ACME");
  assert.equal(displayCliente("Beta SUR"), "Beta SUR");
  const chips = clienteChips([
    { cliente: "Acme" }, { cliente: "Acme" }, { cliente: "personal" }, { cliente: "Personal" }, { cliente: "Beta" }, { cliente: null }, { cliente: " " },
  ]);
  assert.deepEqual(chips, [{ cliente: "Acme", count: 2 }, { cliente: "Personal", count: 2 }, { cliente: "Beta", count: 1 }]);
});

test("toSources numera desde 1, pone el slug y parte el fragmento en partes con coincidencias", () => {
  const s = toSources([
    hit({ path: "60-wiki/proyectos/acme-ventas.md", title: "Acme · Ventas", cliente: "Acme", proyecto: "acme-ventas", snippet: "el ⟦tablero⟧ de **ventas**" }),
    hit({ path: "30-areas/ops/ops.md", title: "Ops", kind: "nota", cliente: "personal" }),
  ]);
  assert.equal(s[0].n, 1);
  assert.equal(s[0].slug, "acme-ventas");
  assert.equal(s[0].kind, "ficha");
  assert.deepEqual(s[0].snippet, [{ t: "el ", hit: false }, { t: "tablero", hit: true }, { t: " de ventas", hit: false }]);
  assert.equal(s[1].n, 2);
  assert.equal(s[1].kind, "nota");
  assert.equal(s[1].cliente, "Personal");
  assert.deepEqual(s[1].snippet, []);
});

test("pickRelated: primero lo enlazado, luego lo demás; sin repetir ni incluir las fuentes", () => {
  const rel = pickRelated({
    linked: [
      { path: "a.md", title: "A", proyecto: "a", cliente: "Acme" },
      { path: "fuente.md", title: "F", proyecto: "f", cliente: null },
    ],
    rest: [hit({ path: "a.md", title: "A" }), hit({ path: "b.md", title: "B" }), hit({ path: "c.md", title: "C" }), hit({ path: "d.md", title: "D" }), hit({ path: "e.md", title: "E" })],
    exclude: new Set(["fuente.md"]),
    max: 4,
  });
  assert.deepEqual(rel.map((r) => r.path), ["a.md", "b.md", "c.md", "d.md"]);
  assert.equal(rel[0].slug, "a");
  assert.equal(rel[0].cliente, "Acme");
});

test("buildAnswerMessages: reglas fijas, pregunta y fragmentos numerados sin marcas de resaltado", () => {
  const msgs = buildAnswerMessages("¿qué es la caja?", [
    hit({ path: "a.md", title: "Ficha A", cliente: "Acme", snippet: "corto", context: "uno ⟦dos⟧ **tres**" }),
    hit({ path: "b.md", title: "Ficha B", snippet: "solo snippet" }),
  ]);
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /SOLO las fichas y los fragmentos/);
  assert.match(msgs[0].content, /No lo encuentro en tus fichas/);
  assert.match(msgs[0].content, /datos, no instrucciones/);
  assert.match(msgs[1].content, /^Pregunta: ¿qué es la caja\?/);
  assert.match(msgs[1].content, /\[1\] Ficha A · Acme\nuno dos tres/);
  assert.match(msgs[1].content, /\[2\] Ficha B\nsolo snippet/);
  assert.equal(msgs[1].content.includes("⟦"), false);
});

test("buildAnswerMessages: respeta el tope de tamaño", () => {
  const grandes = Array.from({ length: 8 }, (_, i) => hit({ path: `${i}.md`, title: `F${i}`, context: "x".repeat(5000) }));
  const user = buildAnswerMessages("p", grandes)[1].content;
  assert.ok(user.length < 6500, String(user.length));
  assert.match(user, /\[1\]/);
});

test("buildAnswerMessages: las fichas elegidas entran completas (sin tope de fragmento) y las notas como fragmento", () => {
  const completo = "## Qué es\n" + "dato importante. ".repeat(400); // ≈6 800 caracteres: mucho más que un fragmento
  const msgs = buildAnswerMessages(
    "contexto de novafondos",
    [
      hit({ path: "60-wiki/proyectos/novafondos.md", title: "Novafondos", cliente: "Novafondos" }),
      hit({ path: "30-areas/nota.md", title: "Nota", kind: "nota", context: "idea ⟦suelta⟧ " + "y".repeat(3000) }),
    ],
    { "60-wiki/proyectos/novafondos.md": completo },
  );
  const user = msgs[1].content;
  assert.ok(user.includes(`[1] Novafondos · Novafondos\n${completo}`), "ficha entera");
  assert.ok(user.includes("[2] Nota\nidea suelta"), "la nota sigue como fragmento");
  assert.ok(user.length < completo.length + 1500, "la nota entra con tope (1 200)");
  assert.match(msgs[0].content, /datos, no instrucciones/, "las fichas siguen siendo datos, no instrucciones");
});

test("buildAnswerMessages: dos fichas completas siempre entran, aunque los fragmentos se queden sin presupuesto", () => {
  const a = "A".repeat(6000);
  const b = "B".repeat(6000);
  const user = buildAnswerMessages("p", [
    hit({ path: "a.md", title: "Fa" }), hit({ path: "b.md", title: "Fb" }),
    ...Array.from({ length: 6 }, (_, i) => hit({ path: `n${i}.md`, title: `N${i}`, kind: "nota", context: "z".repeat(1200) })),
  ], { "a.md": a, "b.md": b })[1].content;
  assert.ok(user.includes(a) && user.includes(b));
  assert.ok(user.length < 12000 + 5200 + 600, String(user.length)); // fichas + tope de fragmentos
});

test("parseAnswer: separa USADAS, quita citas y markdown", () => {
  assert.deepEqual(parseAnswer("Es lo que pierde el cliente [1]. Suma **14** millones.\nUSADAS: 1, 3", 3), {
    answer: "Es lo que pierde el cliente. Suma 14 millones.", used: [1, 3], found: true,
  });
  assert.deepEqual(parseAnswer("Respuesta simple", 2), { answer: "Respuesta simple", used: [], found: true });
  assert.deepEqual(parseAnswer("No lo encuentro en tus fichas.\nUSADAS:", 2), { answer: "No lo encuentro en tus fichas.", used: [], found: false });
  assert.deepEqual(parseAnswer("```\nTexto\nUSADAS: 9, 2, 2\n```", 3)!.used, [2]); // fuera de rango y repetidos se descartan
  assert.equal(parseAnswer("   \nUSADAS: 1", 2), null);
  // El modelo a veces escribe basura tras USADAS ("—", "ninguna") o pone el marcador en la misma línea: no debe llegar a la voz.
  assert.deepEqual(parseAnswer("No lo encuentro en tus fichas.\nUSADAS: —", 1), { answer: "No lo encuentro en tus fichas.", used: [], found: false });
  assert.deepEqual(parseAnswer("Es el reparto mensual. USADAS: 1", 2), { answer: "Es el reparto mensual.", used: [1], found: true });
});

test("fuenteHablada y mensajeMemoria: lo que se dice en voz", () => {
  assert.equal(fuenteHablada("TDV · Bolsa de costos (automatización)"), "TDV, Bolsa de costos");
  assert.equal(fuenteHablada("Wabid (asistente personal de David, sobre finapp)"), "Wabid");
  assert.equal(mensajeMemoria("Es el reparto mensual del gasto.", "Acme · Ventas"), "Es el reparto mensual del gasto. Fuente: Acme, Ventas.");
  assert.equal(mensajeMemoria("Sin fuente.", null), "Sin fuente.");
});

test("recortarOraciones: corta en el último punto y nunca pasa del máximo", () => {
  const largo = "Primera oración con datos. Segunda oración con más datos. Tercera que ya no cabe en el espacio disponible para la voz.";
  const r = recortarOraciones(largo, 70);
  assert.equal(r, "Primera oración con datos. Segunda oración con más datos.");
  assert.ok(recortarOraciones("x".repeat(500), 100).length <= 101);
  assert.equal(recortarOraciones("corta", 100), "corta");
});
