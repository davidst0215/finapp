// node --experimental-strip-types --test supabase/functions/_shared/texto.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { coincide, cubre, norm, sinCubrir } from "./texto.ts";
import { construirIndice, resolverProyecto } from "./vault/proyectos.ts";
import { EMPTY_CONFIG, resolveFolder } from "./vault/taxonomy.ts";

test("norm: sin tildes, en minúscula y con todo lo que no es letra o número como espacio", () => {
  assert.equal(norm("Maqui+ CO — Perú"), "maqui co peru");
  assert.equal(norm("  Reportería  de-procesos "), "reporteria de procesos");
});

test("coincide: iguales, o plurales (prefijo con 4+ letras y a lo sumo 2 de diferencia)", () => {
  for (const [a, b] of [["costo", "costos"], ["cobranza", "cobranzas"], ["tarjeta", "tarjetas"], ["vera", "vera"], ["ahorro", "ahorros"]]) assert.equal(coincide(a, b), true, `${a}/${b}`);
  // un prefijo más largo ya es otra palabra
  for (const [a, b] of [["vera", "veracruz"], ["veracruz", "vera"], ["nova", "novafondos"], ["mqs", "mqsco"], ["ver", "vera"], ["app", "apps"], ["lota", "lotaria"]]) assert.equal(coincide(a, b), false, `${a}/${b}`);
});

test("sinCubrir y cubre: dos palabras seguidas pueden ser un solo nombre («nova fondos» = novafondos), pero solo si miden lo mismo", () => {
  assert.deepEqual(sinCubrir(["nova", "fondos"], ["novafondos", "app"]), []);
  assert.deepEqual(sinCubrir(["mqs", "co"], ["mqsco"]), []);
  assert.deepEqual(sinCubrir(["mqs", "colombia"], ["mqsco", "herramientas"]), ["mqs", "colombia"]);
  assert.equal(cubre(["tdv", "bolsa"], ["tdv", "bolsa", "costos"]), true);
  assert.equal(cubre([], ["tdv"]), false);
});

test("«veracruz» ya no es «vera»: ni al resolver proyectos ni carpetas", () => {
  const ix = construirIndice(EMPTY_CONFIG, ["vera", "lota", "cajon-desastre"], []);
  assert.equal(resolverProyecto("veracruz", ix).kind, "none");
  assert.equal(resolverProyecto("vera", ix).kind, "one");
  assert.equal(resolveFolder("veracruz", EMPTY_CONFIG, ["vera", "lota"]).kind, "none");
  assert.equal(resolveFolder("vera", EMPTY_CONFIG, ["vera", "lota"]).kind, "one");
});
