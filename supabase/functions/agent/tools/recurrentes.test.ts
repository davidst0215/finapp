import { test } from "node:test";
import assert from "node:assert/strict";
import { fechaHablada, type Recurrente, resumenRecurrentes } from "./recurrentes.ts";

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
