// node --experimental-strip-types --test supabase/functions/_shared/vault/view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTasksView, firstLink, plainNote, toViewTask } from "./view.ts";
import { corto, hablado, preguntaCual, preguntaDonde, resumenGeneral, resumenTareas } from "./speech.ts";
import { parseConfig } from "./taxonomy.ts";
import type { TaskRow } from "./types.ts";

const HOY = "2026-10-05"; // lunes
const CFG = parseConfig({
  trabajo: {
    Acme: [{ carpeta: "acme-ventas", nombre: "Ventas" }, { carpeta: "acme-soporte", nombre: "Soporte" }],
    Beta: [{ carpeta: "beta-datos", nombre: "Datos" }],
  },
});

let n = 0;
const row = (o: Partial<TaskRow> & { text: string; folder: string }): TaskRow => ({
  path: `20-projects/${o.folder}/pendientes.md`,
  line: ++n,
  raw: `- [ ] ${o.text}`,
  status: "pending",
  priority: 0,
  due: null,
  scheduled: null,
  done_on: null,
  recurring: null,
  shared: false,
  shared_with: null,
  suggest: null,
  source: null,
  note: null,
  indent: 0,
  parent_line: null,
  ...o,
});

const ROWS: TaskRow[] = [
  row({ folder: "acme-ventas", text: "Cerrar propuesta", priority: 3, due: "2026-10-02" }),
  row({ folder: "acme-ventas", text: "Llamar a Ana", priority: 1, due: "2026-10-09" }),
  row({ folder: "acme-ventas", text: "Sin fecha alta", priority: 3 }),
  row({ folder: "acme-ventas", text: "Hecha ayer", status: "completed", done_on: "2026-10-04", due: "2026-10-03" }),
  row({ folder: "acme-soporte", text: "Revisar tickets", priority: 2, due: HOY, status: "in-progress" }),
  row({ folder: "beta-datos", text: "Esperar: Luis envía la base", shared: true, shared_with: "luis", due: "2026-10-01" }),
  row({ folder: "life", text: "Cuadrar finanzas", priority: 1 }),
  row({ folder: "wabid", text: "Conectar la voz" }),
  row({ folder: "cajon-desastre", text: "Agendar con Rafa", priority: 2, suggest: "acme-soporte", source: "fathom", note: "Sync semanal · 15 sep · [grabación](https://example.com/g/1) · contexto" }),
  row({ folder: "cajon-desastre", text: "Otra del cajón", priority: 3 }),
  row({ folder: "cajon-desastre", text: "Cerrada del cajón", status: "completed" }),
];
// subtareas de la primera tarea de acme-ventas
const PADRE = ROWS[0];
ROWS.push(
  row({ folder: "acme-ventas", text: "sub 1", path: PADRE.path, indent: 4, parent_line: PADRE.line, status: "completed" }),
  row({ folder: "acme-ventas", text: "sub 2", path: PADRE.path, indent: 4, parent_line: PADRE.line }),
);

test("plainNote y firstLink: el detalle de Fathom queda legible y con su link", () => {
  const nota = "Sync semanal · 15 sep · [grabación](https://example.com/g/1) · contexto";
  assert.equal(plainNote(nota), "Sync semanal · 15 sep · grabación · contexto");
  assert.equal(firstLink(nota), "https://example.com/g/1");
  assert.equal(firstLink("sin link"), null);
  assert.equal(firstLink("[x](http://inseguro.com)"), null); // solo https
  assert.equal(plainNote(null), null);
});

test("toViewTask: etiquetas de fecha, vencida, conjunto y sugerencia", () => {
  const v = toViewTask(ROWS[5], CFG, HOY);
  assert.equal(v.label, "Beta › Datos");
  assert.equal(v.due, "2026-10-01");
  assert.equal(v.dueLabel, "Venció hace 4 días");
  assert.equal(v.overdue, true);
  assert.equal(v.sharedWith, "Luis");
  const c = toViewTask(ROWS[8], CFG, HOY);
  assert.equal(c.scope, "cajon");
  assert.equal(c.suggestLabel, "Acme › Soporte");
  assert.equal(c.source, "fathom");
  assert.equal(c.link, "https://example.com/g/1");
  assert.equal(c.id, `${ROWS[8].path}::${ROWS[8].line}`);
  const hecha = toViewTask(ROWS[3], CFG, HOY);
  assert.equal(hecha.overdue, false); // una tarea hecha no vence
});

test("buildTasksView: grupos en el orden de Norte, tareas por prioridad y fecha, solo abiertas", () => {
  const v = buildTasksView(ROWS, CFG, ["acme-ventas", "acme-soporte", "beta-datos", "life", "wabid", "cajon-desastre"], HOY, "2026-10-05T12:00:00Z");
  assert.deepEqual(v.groups.map((g) => g.label), ["Acme › Ventas", "Acme › Soporte", "Beta › Datos", "Life", "Wabid"]);
  assert.deepEqual(v.groups.map((g) => g.scope), ["trabajo", "trabajo", "trabajo", "personal", "personal"]);
  // prioridad alta primero; entre iguales la fecha más próxima; sin fecha al final
  assert.deepEqual(v.groups[0].tasks.map((t) => t.text), ["Cerrar propuesta", "Sin fecha alta", "Llamar a Ana"]);
  assert.deepEqual(v.inbox.map((t) => t.text), ["Otra del cajón", "Agendar con Rafa"]);
  assert.equal(v.syncedAt, "2026-10-05T12:00:00Z");
});

test("buildTasksView: subtareas solo cuentan como avance y los contadores salen de la lista", () => {
  const v = buildTasksView(ROWS, CFG, [], HOY, null);
  const cerrar = v.groups[0].tasks.find((t) => t.text === "Cerrar propuesta")!;
  assert.deepEqual(cerrar.subtasks, { done: 1, total: 2 });
  assert.equal(v.groups.flatMap((g) => g.tasks).some((t) => t.text.startsWith("sub ")), false);
  assert.deepEqual(v.counts, { open: 7, overdue: 2, today: 1, inbox: 2 });
});

test("buildTasksView: destinos incluyen la configuración y el cajón al final; carpetas nuevas aparecen solas", () => {
  const v = buildTasksView([row({ folder: "nueva-carpeta", text: "x" })], CFG, ["nueva-carpeta"], HOY, null);
  assert.equal(v.groups[0].label, "Nueva Carpeta");
  assert.equal(v.destinations.at(-1)!.folder, "cajon-desastre");
  assert.equal(v.destinations.some((d) => d.folder === "beta-datos"), true);
});

test("speech.corto y hablado", () => {
  assert.equal(corto("Validar la bolsa de septiembre con el equipo de finanzas y contabilidad", 40), "Validar la bolsa de septiembre con el");
  assert.equal(corto("corto"), "corto");
  assert.equal(hablado({ project: "Acme", frente: "Ventas" }), "Acme Ventas");
  assert.equal(hablado({ project: "Life", frente: null }), "Life");
});

test("speech.resumenTareas: vencidas, hoy, proyecto y cajón", () => {
  const v = buildTasksView(ROWS, CFG, [], HOY, null);
  const todas = v.groups.flatMap((g) => g.tasks);
  const vencidas = todas.filter((t) => t.overdue);
  assert.equal(
    resumenTareas("overdue", vencidas),
    "Tienes 2 tareas vencidas: Cerrar propuesta, de Acme Ventas; Esperar: Luis envía la base, de Beta Datos.",
  );
  assert.equal(
    resumenTareas("today", todas.filter((t) => t.due === HOY)),
    "Para hoy tienes 1 tarea: Revisar tickets, de Acme Soporte.",
  );
  assert.equal(
    resumenTareas("project", v.groups[0].tasks, { projectLabel: "Acme Ventas", max: 2 }),
    "En Acme Ventas tienes 3 pendientes: Cerrar propuesta; Sin fecha alta. Y 1 más.",
  );
  assert.equal(
    resumenTareas("inbox", v.inbox, { max: 1 }),
    "Tienes 2 en el cajón. Las primeras: Otra del cajón, de Cajón desastre. Y 1 más.",
  );
  assert.equal(resumenTareas("overdue", []), "No tienes tareas vencidas.");
  assert.equal(resumenTareas("today", []), "No tienes tareas para hoy.");
  assert.equal(resumenTareas("inbox", []), "El cajón está vacío.");
  assert.equal(resumenTareas("project", [], { projectLabel: "Life" }), "No hay pendientes en Life.");
});

test("speech.resumenTareas: nunca pasa de ~340 caracteres aunque los títulos sean largos", () => {
  const largas = Array.from({ length: 8 }, (_, i) =>
    toViewTask(row({ folder: "acme-ventas", text: `Tarea número ${i} con un título bastante largo que describe muchísimas cosas por hacer hoy mismo`, due: "2026-10-01" }), CFG, HOY));
  const s = resumenTareas("overdue", largas);
  assert.ok(s.length <= 340, `${s.length}: ${s}`);
  assert.match(s, /Y \d+ más\.$/);
});

test("speech.resumenGeneral y preguntas de aclaración", () => {
  assert.equal(resumenGeneral({ open: 7, overdue: 2, today: 1, inbox: 0 }), "Tienes 7 pendientes, 2 vencidas y 1 para hoy.");
  assert.equal(resumenGeneral({ open: 1, overdue: 1, today: 0, inbox: 3 }), "Tienes 1 pendiente, 1 vencida y 0 para hoy. Y 3 esperan en el cajón.");
  const v = buildTasksView(ROWS, CFG, [], HOY, null);
  assert.equal(preguntaCual(v.groups[0].tasks.slice(0, 2)), "Encontré 2 parecidas: Cerrar propuesta, de Acme Ventas; o Sin fecha alta, de Acme Ventas. ¿Cuál?");
  const dests = v.destinations.filter((d) => d.project === "Acme");
  assert.equal(preguntaDonde(dests), "¿En qué frente de Acme: Ventas o Soporte?");
  assert.equal(preguntaDonde(v.destinations.filter((d) => d.folder === "acme-ventas" || d.folder === "beta-datos")), "¿En cuál: Acme Ventas, Beta Datos?");
});
