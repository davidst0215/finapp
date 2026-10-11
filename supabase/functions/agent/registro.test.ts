// node --experimental-strip-types --test supabase/functions/agent/registro.test.ts
// Invariantes que index.ts da por hechas al arrancar (un nombre de tool repetido tumba la función entera). registry.ts no carga en Node
// (algunos módulos importan de jsr:), así que aquí se cargan los módulos de memoria y vault y el registro se lee como texto.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./tools/testlib.ts"; // instala Deno.env antes de cargar los módulos

const { memoria } = await import("./tools/memoria.ts");
const { tareas } = await import("./tools/tareas.ts");
const { notas } = await import("./tools/notas.ts");
const { hechos } = await import("./tools/hechos.ts");
const MODULOS = [tareas, memoria, notas, hechos];

test("cada tool tiene un solo dueño y un handler (y ningún handler sin tool)", () => {
  const nombres = MODULOS.flatMap((m) => m.definitions.map((d) => d.function.name));
  assert.equal(new Set(nombres).size, nombres.length, `repetidas: ${nombres.filter((n, i) => nombres.indexOf(n) !== i)}`);
  for (const m of MODULOS) assert.deepEqual(Object.keys(m.handlers).sort(), m.definitions.map((d) => d.function.name).sort(), `módulo ${m.id}`);
  for (const nueva of ["add_note", "remember_fact", "forget_fact", "list_facts"]) assert.ok(nombres.includes(nueva), nueva);
});

test("registry.ts registra notas y hechos, y los recuerdos van DESPUÉS de memoria: su bloque `estable` sigue al catálogo de fichas", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "registry.ts"), "utf8");
  const lista = src.slice(src.indexOf("export const MODULES")).split("\n").map((l) => l.trim().replace(/[,\s].*$/, "")).filter(Boolean);
  const orden = (id: string) => lista.indexOf(id);
  assert.ok(orden("memoria") >= 0 && orden("notas") >= 0 && orden("hechos") >= 0, `MODULES: ${lista}`);
  assert.ok(orden("memoria") < orden("hechos"));
  assert.equal(memoria.loadContext !== undefined && hechos.loadContext !== undefined, true);
});

test("las reglas nuevas se suman al prefijo del sistema sin pasarse (notas + recuerdos < 2 400 caracteres, ~700 tokens)", () => {
  const largo = (notas.rules?.length ?? 0) + (hechos.rules?.length ?? 0);
  assert.ok(largo < 2400, `reglas de notas y recuerdos: ${largo} caracteres`);
});
