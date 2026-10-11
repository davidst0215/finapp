import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentos, loQueSeDice, respuestaInservible } from "./respuesta.ts";

const call = (name: string, args: unknown) => ({ function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

test("una tool de acción con argumentos sirve", () => {
  assert.equal(respuestaInservible(call("create_transaction", { amount: 12.5, description: "Taxi" })), false);
});

test("una respuesta con texto sirve", () => {
  assert.equal(respuestaInservible(call("analyze_finances", { analysis_type: "overview", answer: "Llevas S/ 20.50." })), false);
});

test("answer vacío, en blanco o no texto se reintenta", () => {
  assert.equal(respuestaInservible(call("analyze_finances", { analysis_type: "overview", answer: "" })), true);
  assert.equal(respuestaInservible(call("query", { answer: "   " })), true);
  assert.equal(respuestaInservible(call("query", { answer: null })), true);
});

test("sin tool o con argumentos ilegibles se reintenta", () => {
  assert.equal(respuestaInservible(undefined), true);
  assert.equal(respuestaInservible({ function: {} }), true);
  assert.equal(respuestaInservible(call("query", "{no es json")), true);
  assert.equal(respuestaInservible(call("query", "[1,2]")), true);
});

test("argumentos devuelve objeto o null", () => {
  assert.deepEqual(argumentos(call("x", { a: 1 })), { a: 1 });
  assert.equal(argumentos(call("x", "nope")), null);
});

test("rellenos del modelo se reintentan", () => {
  for (const a of ["placeholder", "Placeholder", "...", "…", "Revisando tus pagos pendientes...", "déjame revisar", "x"]) {
    assert.equal(respuestaInservible(call("analyze_finances", { answer: a })), true, a);
  }
});

test("respuestas reales cortas o que mencionan 'revisando' en medio no se reintentan", () => {
  for (const a of ["Sí, ya lo anoté.", "Llevas S/ 20.50 este mes.", "Estoy revisando que todo cuadre: vas bien.", "Sí", "No", "Ok", "Revisando tus gastos: gastaste S/ 450 en comida este mes.", "Déjame ver… tienes 3 deudas activas"]) {
    assert.equal(respuestaInservible(call("query", { answer: a })), false, a);
  }
});

test("loQueSeDice: `voz` si el handler la trae; si no, el mismo `message` (cliente y servidor viejos siguen igual)", () => {
  assert.equal(loQueSeDice({ message: "Mañana tienes 3 eventos: a las nueve, Daily; a las once, Comité; y 1 más.", voz: "Mañana tienes 3 eventos; el primero, a las nueve." }), "Mañana tienes 3 eventos; el primero, a las nueve.");
  assert.equal(loQueSeDice({ message: "Gasto de S/ 25.00 en almuerzo." }), "Gasto de S/ 25.00 en almuerzo.");
  assert.equal(loQueSeDice({ message: "Hola.", voz: "   " }), "Hola.");
  assert.equal(loQueSeDice({ message: "Hola.", voz: 42 }), "Hola.");
  assert.equal(loQueSeDice({ message: undefined, voz: undefined }), "");
});
