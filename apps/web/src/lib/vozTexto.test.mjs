// Corre en Node: node --experimental-strip-types --test apps/web/src/lib/vozTexto.test.mjs
// El tope de voz (100 caracteres) es el mismo que pone el servidor: ElevenLabs cobra por carácter.
// acotarVoz es copia de supabase/functions/_shared/voz.ts; los mismos casos están en voz.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acotarVoz, limpiarParaVoz, MAX_VOZ, primeraParte, recortarParaVoz, unirDictado } from "./vozTexto.ts";

/** El resultado es un prefijo del original (más, quizá, un punto de cierre) y no parte ninguna palabra. */
function esCorteLimpio(original, corte) {
  const base = original.startsWith(corte) ? corte : corte.slice(0, -1);
  assert.ok(original.startsWith(base), `"${corte}" no es prefijo de "${original}"`);
  const siguiente = original[base.length];
  assert.ok(siguiente === undefined || !/[\p{L}\p{N}]/u.test(siguiente), `parte la palabra en "${corte}"`);
}

test("unirDictado: campo vacío, con texto, con espacio final, dictado vacío", () => {
  assert.equal(unirDictado("", "  hola  "), "hola");
  assert.equal(unirDictado("   ", "hola"), "hola");
  assert.equal(unirDictado("Revisa esto", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto ", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto\n", "y avísame"), "Revisa esto\ny avísame");
  assert.equal(unirDictado("texto", "  "), "texto");
});

test("el tope es 100 caracteres", () => assert.equal(MAX_VOZ, 100));

test("acotarVoz: lo que cabe pasa entero; si no, el último fin de oración", () => {
  assert.equal(acotarVoz("Esta semana gastaste S/ 312, casi todo en comida."), "Esta semana gastaste S/ 312, casi todo en comida.");
  assert.equal(acotarVoz("a".repeat(100)), "a".repeat(100));
  const texto = "Mañana tienes tres reuniones. La primera es a las nueve con Marco. La segunda es a las once con Ana y la tercera a las cuatro.";
  assert.equal(acotarVoz(texto, 70), "Mañana tienes tres reuniones. La primera es a las nueve con Marco.");
  assert.equal(acotarVoz(texto, 40), "Mañana tienes tres reuniones.");
});

test("acotarVoz: abreviaturas, montos y decimales no parten oraciones", () => {
  assert.equal(
    acotarVoz("Cita con el Dr. Pérez en la Av. Arequipa mañana. Después te cuento lo demás con todo el detalle que haga falta.", 60),
    "Cita con el Dr. Pérez en la Av. Arequipa mañana.",
  );
  const t = "Pagaste S/ 45.90 en el almuerzo y gastas 12.5 por ciento más que el mes pasado. Vas bien con el presupuesto general.";
  assert.equal(acotarVoz(t, 90), "Pagaste S/ 45.90 en el almuerzo y gastas 12.5 por ciento más que el mes pasado.");
});

test("acotarVoz: la primera oración se pasa del tope, corta en la última coma y cierra con punto", () => {
  const larga = "Gastaste S/ 450.50 en comida, S/ 120.00 en taxi, S/ 80 en cine, y además el presupuesto de entretenimiento ya se pasó por mucho esta semana.";
  const r = acotarVoz(larga, 100);
  assert.equal(r, "Gastaste S/ 450.50 en comida, S/ 120.00 en taxi, S/ 80 en cine.");
  esCorteLimpio(larga, r);
  assert.equal(acotarVoz("El resumen de hoy: tres reuniones, dos tareas vencidas y un pago que vence mañana por la mañana temprano", 60), "El resumen de hoy: tres reuniones.");
});

test("acotarVoz: una sola oración de más de 200 caracteres, sin pausa o con ella, nunca parte una palabra", () => {
  const sinPausa = "Una sola oración larguísima sin ninguna pausa natural que sigue y sigue y sigue y sigue y sigue y sigue y sigue y sigue y sigue";
  const r = acotarVoz(sinPausa, 100);
  assert.ok(r.length <= 100 && r.endsWith("."), r);
  assert.doesNotMatch(r, /\b(y|de|la|el|que)\.$/);
  esCorteLimpio(sinPausa, r);
  const parrafo = "Tienes tres reuniones mañana, la primera a las nueve con Marco; después, a las once, el comité de cobranzas. Además, recuerda que el pago de la luz vence el viernes y que Daniel espera tu respuesta sobre el cotizador desde hace seis días.";
  assert.ok(parrafo.length > 200);
  for (let max = 20; max <= 120; max++) {
    const c = acotarVoz(parrafo, max);
    assert.ok(c.length <= max && c.length > 0, `${max}: ${c}`);
    esCorteLimpio(parrafo, c);
  }
});

test("limpiarParaVoz: código, énfasis, enlaces, encabezados", () => {
  const md = "## Listo\nCambié **`foo.ts`** y [el doc](http://x.y).\n```js\nconst a = 1;\n```\n- punto";
  const out = limpiarParaVoz(md);
  assert.ok(!out.includes("`") && !out.includes("**") && !out.includes("http") && !out.includes("const a"));
  assert.ok(out.includes("(código)") && out.includes("el doc") && out.includes("foo.ts"));
});

test("primeraParte: salta código y líneas sin letras; una línea muy corta se junta con la siguiente", () => {
  assert.equal(primeraParte("(código)\n---\nCambié el cálculo del saldo y pasan los tests."), "Cambié el cálculo del saldo y pasan los tests.");
  assert.equal(primeraParte("Listo.\nCorregí el bug del login."), "Listo. Corregí el bug del login.");
  assert.equal(primeraParte("(código)"), "(código)");
});

test("recortarParaVoz (Escuchar en Claude Code): un resumen de ≤ 100 caracteres, no el mensaje completo", () => {
  assert.deepEqual(recortarParaVoz("Listo. Ya quedó."), { texto: "Listo. Ya quedó.", recortado: false });

  const mensaje = [
    "## Resultado",
    "Corregí el cálculo del saldo en `saldo.ts` y ahora coincide con OpenRouter. Además agregué la prueba que faltaba.",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "- cambié el redondeo",
    "- agregué dos pruebas",
    "- actualicé la documentación de la función y del módulo completo",
  ].join("\n");
  const r = recortarParaVoz(mensaje);
  assert.equal(r.recortado, true);
  assert.equal(r.texto, "Corregí el cálculo del saldo en saldo.ts y ahora coincide con OpenRouter.");
  assert.ok(r.texto.length <= MAX_VOZ);

  const largo = recortarParaVoz("palabra ".repeat(200));
  assert.ok(largo.recortado && largo.texto.length <= MAX_VOZ && largo.texto.endsWith("palabra."), largo.texto);
  assert.equal(recortarParaVoz("x".repeat(900)).texto.length, MAX_VOZ);
});
