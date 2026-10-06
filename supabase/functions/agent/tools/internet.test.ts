import { test } from "node:test";
import assert from "node:assert/strict";
import { paraDecir } from "./internetTexto.ts";

test("quita los enlaces markdown y deja el nombre", () => {
  assert.equal(paraDecir("El dólar cerró en S/ 3.71 ([BCRP](https://www.bcrp.gob.pe/x))."), "El dólar cerró en S/ 3.71 (BCRP).");
});

test("quita URLs sueltas, negritas y viñetas", () => {
  assert.equal(paraDecir("**Hoy** llueve poco.\n- Fuente: https://senamhi.gob.pe/pronostico"), "Hoy llueve poco. Fuente:");
});

test("montos con más de 2 decimales se redondean (la voz solo lee 2)", () => {
  assert.equal(paraDecir("El dólar cotiza a S/ 3.4475; venta S/3.454 y US$ 1.12345."), "El dólar cotiza a S/ 3.45; venta S/3.45 y US$ 1.12.");
});

test("fechas día/mes pasan a palabras", () => {
  assert.equal(paraDecir("según cierre del 02/10 y el 30/9/2026"), "según cierre del 2 de octubre y el 30 de septiembre de 2026");
});

test("un texto limpio queda igual", () => {
  assert.equal(paraDecir("Universitario ganó 2 a 1."), "Universitario ganó 2 a 1.");
});
