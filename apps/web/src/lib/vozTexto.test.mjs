// Corre en Node: node --experimental-strip-types --test apps/web/src/lib/vozTexto.test.mjs
// El cliente solo limpia el markdown y manda hasta 600 caracteres a /tts; el recorte a 100 lo hace el servidor
// (supabase/functions/_shared/voz.test.ts prueba ese recorte).
import assert from "node:assert/strict";
import { test } from "node:test";
import { limpiarParaVoz, MAX_ENVIO, primeraParte, recortarParaVoz, unirDictado } from "./vozTexto.ts";

test("unirDictado: campo vacío, con texto, con espacio final, dictado vacío", () => {
  assert.equal(unirDictado("", "  hola  "), "hola");
  assert.equal(unirDictado("   ", "hola"), "hola");
  assert.equal(unirDictado("Revisa esto", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto ", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto\n", "y avísame"), "Revisa esto\ny avísame");
  assert.equal(unirDictado("texto", "  "), "texto");
});

test("limpiarParaVoz: código, énfasis, enlaces, encabezados", () => {
  const md = "## Listo\nCambié **`foo.ts`** y [el doc](http://x.y).\n```js\nconst a = 1;\n```\n- punto";
  const out = limpiarParaVoz(md);
  assert.ok(!out.includes("`") && !out.includes("**") && !out.includes("http") && !out.includes("const a"));
  assert.ok(out.includes("(código)") && out.includes("el doc") && out.includes("foo.ts"));
});

test("limpiarParaVoz: un enlace markdown queda como su texto y una imagen como su descripción", () => {
  assert.equal(limpiarParaVoz("Mira [el informe](https://x.y/z?a=1) y ![captura](a.png)."), "Mira el informe y captura.");
});

test("primeraParte: salta código y líneas sin letras; una línea muy corta se junta con la siguiente", () => {
  assert.equal(primeraParte("(código)\n---\nCambié el cálculo del saldo y pasan los tests."), "Cambié el cálculo del saldo y pasan los tests.");
  assert.equal(primeraParte("Listo.\nCorregí el bug del login."), "Listo. Corregí el bug del login.");
  assert.equal(primeraParte("(código)"), "(código)");
});

test("recortarParaVoz (Escuchar en Claude Code): manda la primera parte, limpia y de hasta 600; el recorte a 100 es del servidor", () => {
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
  ].join("\n");
  const r = recortarParaVoz(mensaje);
  // Sin encabezado ni código ni markdown; las dos oraciones viajan enteras (el servidor dirá la que quepa).
  assert.equal(r.texto, "Corregí el cálculo del saldo en saldo.ts y ahora coincide con OpenRouter. Además agregué la prueba que faltaba.");
  assert.equal(r.recortado, true); // más de ~100 caracteres: no se leerá todo
});

test("recortarParaVoz: nunca manda más de 600 caracteres a /tts", () => {
  const largo = recortarParaVoz("palabra ".repeat(300));
  assert.equal(largo.texto.length, MAX_ENVIO);
  assert.equal(largo.recortado, true);
  assert.equal(recortarParaVoz("x".repeat(900)).texto.length, MAX_ENVIO);
  assert.equal(MAX_ENVIO, 600);
});

test("recortarParaVoz: el aviso «recortado» se estima por largo (~100)", () => {
  assert.equal(recortarParaVoz("a".repeat(100)).recortado, false);
  assert.equal(recortarParaVoz("a".repeat(101)).recortado, true);
});
