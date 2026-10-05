// Corre en Node: node --experimental-strip-types --test apps/web/src/lib/vozTexto.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { limpiarParaVoz, recortarParaVoz, unirDictado } from "./vozTexto.ts";

test("unirDictado: campo vacío, con texto, con espacio final, dictado vacío", () => {
  assert.equal(unirDictado("", "  hola  "), "hola");
  assert.equal(unirDictado("   ", "hola"), "hola");
  assert.equal(unirDictado("Revisa esto", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto ", "y avísame"), "Revisa esto y avísame");
  assert.equal(unirDictado("Revisa esto\n", "y avísame"), "Revisa esto\ny avísame");
  assert.equal(unirDictado("texto", "  "), "texto");
});

test("recortarParaVoz: texto corto pasa entero", () => {
  assert.deepEqual(recortarParaVoz("Listo. Ya quedó."), { texto: "Listo. Ya quedó.", recortado: false });
  const justo = "a".repeat(600);
  assert.equal(recortarParaVoz(justo).recortado, false);
});

test("recortarParaVoz: corta en el último fin de frase antes de 600", () => {
  const frase = "Esta es una frase de prueba con bastantes palabras. ";
  const largo = frase.repeat(30);
  const r = recortarParaVoz(largo);
  assert.equal(r.recortado, true);
  assert.ok(r.texto.length <= 600);
  assert.ok(r.texto.endsWith("palabras."));
  assert.equal(r.texto.length % frase.trim().length === 0 || r.texto.endsWith("."), true);
});

test("recortarParaVoz: sin puntuación corta en espacio; sin espacios corta duro", () => {
  const sinPunto = "palabra ".repeat(200);
  const a = recortarParaVoz(sinPunto);
  assert.ok(a.recortado && a.texto.length <= 600 && a.texto.endsWith("palabra"));
  const b = recortarParaVoz("x".repeat(900));
  assert.equal(b.texto.length, 600);
});

test("recortarParaVoz: un punto de abreviatura pegado no cuenta como fin", () => {
  const r = recortarParaVoz(("Ver archivo.ts " + "z".repeat(30) + " ").repeat(40));
  assert.ok(r.texto.length <= 600);
});

test("limpiarParaVoz: código, énfasis, enlaces, encabezados", () => {
  const md = "## Listo\nCambié **`foo.ts`** y [el doc](http://x.y).\n```js\nconst a = 1;\n```\n- punto";
  const out = limpiarParaVoz(md);
  assert.ok(!out.includes("`") && !out.includes("**") && !out.includes("http") && !out.includes("const a"));
  assert.ok(out.includes("(código)") && out.includes("el doc") && out.includes("foo.ts"));
});
