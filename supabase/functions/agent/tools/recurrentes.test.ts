import { test } from "node:test";
import assert from "node:assert/strict";
import { fechaHablada, type Recurrente, resumenRecurrentes, vozRecurrentes } from "./recurrentes.ts";

const r = (id: string, description: string, amount: number, next_due_date: string): Recurrente =>
  ({ recurring_id: id, description, amount, frequency: "monthly", next_due_date });

const lista = [
  r("1", "Netflix", 52, "2026-10-15"),
  r("2", "Banco 2", 950, "2026-11-01"),
  r("3", "Spotify", 26, "2026-10-03"),
  r("4", "Internet", 100, "2026-11-04"), // ya pagado este mes, vence el próximo
];
const pagados = new Set(["4"]);
const HOY = "2026-10-04";

test("fechaHablada dice 'primero' el día 1", () => {
  assert.equal(fechaHablada("2026-11-01"), "el primero de noviembre");
  assert.equal(fechaHablada("2026-10-15T00:00:00"), "el 15 de octubre");
});

test("pendientes: solo lo que vence este mes sin pago, ordenado y con vencidos", () => {
  assert.equal(
    resumenRecurrentes(lista, pagados, HOY, "pending"),
    "Te faltan S/ 78.00: Spotify S/ 26.00 vencido desde el 3 de octubre y Netflix S/ 52.00 el 15 de octubre.",
  );
});

test("pendientes vacío", () => {
  assert.equal(resumenRecurrentes([lista[3]], pagados, HOY, "pending"), "No te falta pagar nada este mes.");
});

test("pagados con total", () => {
  assert.equal(resumenRecurrentes(lista, pagados, HOY, "paid"), "Este mes ya pagaste Internet: S/ 100.00 en total.");
  assert.equal(resumenRecurrentes(lista, new Set(), HOY, "paid"), "Todavía no registras pagos fijos este mes.");
});

test("todos: total mensual y pendientes", () => {
  assert.equal(
    resumenRecurrentes(lista, pagados, HOY, "all"),
    "Tienes 4 pagos fijos por S/ 1128.00 al mes. Te faltan Spotify S/ 26.00 vencido desde el 3 de octubre y Netflix S/ 52.00 el 15 de octubre.",
  );
});

test("todos: con frecuencias mezcladas no suma un total engañoso", () => {
  const mezcla = [...lista, { ...r("5", "SOAT", 120, "2027-03-01"), frequency: "annual" }];
  assert.match(resumenRecurrentes(mezcla, pagados, HOY, "all"), /^Tienes 5 pagos fijos\. Te faltan/);
});

test("sin recurrentes sugiere cómo crear uno", () => {
  assert.match(resumenRecurrentes([], new Set(), HOY, "pending"), /No tienes pagos fijos/);
});

test("más de cinco pendientes se resumen para la voz", () => {
  const muchos = Array.from({ length: 7 }, (_, i) => r(String(i), `Pago ${i}`, 10, `2026-10-${String(10 + i).padStart(2, "0")}`));
  assert.match(resumenRecurrentes(muchos, new Set(), HOY, "pending"), /Pago 4 S\/ 10\.00 el 14 de octubre y 2 más\.$/);
});

test("fin de mes correcto en febrero", () => {
  const feb = [r("1", "Luz", 80, "2027-02-28")];
  assert.match(resumenRecurrentes(feb, new Set(), "2027-02-10", "pending"), /Luz S\/ 80\.00 el 28 de febrero/);
});

test("voz: el total en cifras redondas, el primero y «y N más»; las fechas se ven en pantalla", () => {
  assert.equal(vozRecurrentes(lista, pagados, HOY, "pending"), "Te faltan S/ 78: Spotify S/ 26, vencido; y 1 más.");
  assert.equal(vozRecurrentes(lista, pagados, HOY, "all"), "Tienes 4 pagos fijos por S/ 1128 al mes. Te faltan S/ 78: Spotify S/ 26, vencido; y 1 más.");
  // «unos» solo cuando se redondea: 452.25 → «unos S/ 452»; el pago concreto conserva sus céntimos.
  const pagos = [r("1", "Netflix", 45.9, "2026-10-15"), r("2", "Spotify", 26, "2026-10-03"), r("3", "Luz del Sur", 118.45, "2026-10-20"), r("4", "Internet", 99.9, "2026-10-25")];
  assert.equal(vozRecurrentes(pagos, new Set(), HOY, "pending"), "Te faltan unos S/ 290: Spotify S/ 26, vencido; y 3 más.");
  assert.equal(vozRecurrentes([pagos[0]!], new Set(), HOY, "pending"), "Te falta Netflix S/ 45.90.");
  assert.equal(vozRecurrentes(pagos, new Set(["2", "3"]), HOY, "paid"), "Este mes ya pagaste unos S/ 144 en 2 pagos.");
  assert.equal(vozRecurrentes(lista, pagados, HOY, "paid"), "Este mes ya pagaste S/ 100 en 1 pago.");
  assert.equal(vozRecurrentes([lista[3]!], pagados, HOY, "pending"), "No te falta pagar nada este mes.");
  assert.equal(vozRecurrentes(lista, new Set(), HOY, "paid"), "Todavía no registras pagos fijos este mes.");
  assert.match(vozRecurrentes([], new Set(), HOY, "pending"), /No tienes pagos fijos/);
  const uno = [r("1", "Netflix", 45.9, "2026-10-15")];
  assert.equal(vozRecurrentes(uno, new Set(), HOY, "pending"), "Te falta Netflix S/ 45.90.");
  assert.equal(vozRecurrentes(uno, new Set(["1"]), HOY, "all"), "Tienes 1 pago fijo por S/ 45.90 al mes. Este mes no te falta ninguno.");
});

test("la voz es bastante más corta que la pantalla cuando hay muchos pagos", () => {
  const muchos = Array.from({ length: 7 }, (_, i) => r(String(i), `Pago número ${i}`, 10 + i, `2026-10-${String(10 + i).padStart(2, "0")}`));
  assert.ok(vozRecurrentes(muchos, new Set(), HOY, "pending").length <= 60);
  assert.ok(resumenRecurrentes(muchos, new Set(), HOY, "pending").length > 150);
});
