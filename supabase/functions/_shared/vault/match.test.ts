// node --experimental-strip-types --test supabase/functions/_shared/vault/match.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { findTask, queryTokens } from "./match.ts";
import { parseConfig } from "./taxonomy.ts";
import type { TaskRow } from "./types.ts";

const CFG = parseConfig({ trabajo: { Acme: [{ carpeta: "acme-ventas", nombre: "Ventas" }, { carpeta: "acme-soporte", nombre: "Soporte técnico" }] } });

let n = 0;
const row = (folder: string, text: string, o: Partial<TaskRow> = {}): TaskRow => ({
  path: `20-projects/${folder}/pendientes.md`, line: ++n, folder, raw: `- [ ] ${text}`, text, status: "pending", priority: 0, due: null,
  scheduled: null, done_on: null, recurring: null, shared: false, shared_with: null, suggest: null, source: null, note: null, indent: 0,
  parent_line: null, ...o,
});

const ROWS = [
  row("acme-ventas", "Validar bolsa de septiembre", { due: "2026-10-04", priority: 3 }),
  row("acme-ventas", "Validar facturas pendientes del cliente"),
  row("acme-soporte", "Rotar el token del cotizador"),
  row("acme-soporte", "Responder correo a Cristian"),
  row("life", "Cuadrar finanzas personales"),
  row("life", "Comprar regalo de cumpleaños"),
];

test("queryTokens quita palabras de orden y de relleno", () => {
  assert.deepEqual(queryTokens("completa la tarea de validar la bolsa"), ["validar", "bolsa"]);
  assert.deepEqual(queryTokens("márcala como hecha: rotar token"), ["rotar", "token"]);
  assert.deepEqual(queryTokens("   "), []);
});

test("findTask: una coincidencia clara aunque la frase sea parcial o con tildes", () => {
  for (const [q, texto] of [
    ["validar la bolsa", "Validar bolsa de septiembre"],
    ["completa lo de rotar token", "Rotar el token del cotizador"],
    ["cuadrar finanzas", "Cuadrar finanzas personales"],
    ["regalo de cumpleanos", "Comprar regalo de cumpleaños"],
    ["correo de Cristian", "Responder correo a Cristian"],
  ] as const) {
    const r = findTask(q, ROWS, CFG);
    assert.equal(r.kind, "one", q);
    assert.equal(r.kind === "one" ? r.match.row.text : "", texto, q);
  }
});

test("findTask: el nombre del proyecto ayuda a desempatar pero no basta", () => {
  const r = findTask("validar soporte", [row("acme-soporte", "Validar accesos"), row("acme-ventas", "Validar accesos")], CFG);
  assert.equal(r.kind, "one");
  assert.equal(r.kind === "one" ? r.match.row.folder : "", "acme-soporte");
  assert.equal(findTask("soporte técnico", ROWS, CFG).kind, "none"); // solo el proyecto: no identifica una tarea
});

test("findTask: si hay dos igual de cerca pregunta en vez de adivinar", () => {
  const r = findTask("validar", ROWS, CFG);
  assert.equal(r.kind, "many");
  assert.deepEqual(r.kind === "many" ? r.matches.map((m) => m.row.text) : [], ["Validar bolsa de septiembre", "Validar facturas pendientes del cliente"]);
  const dup = findTask("tarea repetida", [row("life", "Tarea repetida"), row("wabid", "Tarea repetida")], CFG);
  assert.equal(dup.kind, "many");
});

test("findTask: una tarea que contiene todas las palabras gana a otra que solo comparte una", () => {
  const r = findTask("validar bolsa", ROWS, CFG);
  assert.equal(r.kind, "one");
  assert.equal(r.kind === "one" ? r.match.row.text : "", "Validar bolsa de septiembre");
});

test("findTask: sin coincidencia suficiente o consulta vacía", () => {
  assert.equal(findTask("planificar vacaciones", ROWS, CFG).kind, "none");
  assert.equal(findTask("", ROWS, CFG).kind, "none");
  assert.equal(findTask(undefined, ROWS, CFG).kind, "none");
  assert.equal(findTask("completa la tarea", ROWS, CFG).kind, "none");
  assert.equal(findTask("validar", [], CFG).kind, "none");
});
