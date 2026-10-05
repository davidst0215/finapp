import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentos, respuestaInservible } from "./respuesta.ts";

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
