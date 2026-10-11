// node --experimental-strip-types --test supabase/functions/_shared/vault/view.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTasksView, firstLink, plainNote, toViewTask } from "./view.ts";
import { corto, hablado, preguntaCual, preguntaDonde, resumenGeneral, resumenTareas, vozCual, vozTareas } from "./speech.ts";
import { parseConfig } from "./taxonomy.ts";
import { prepararVoz } from "../voz.ts";
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
  assert.equal(corto("Validar la bolsa de septiembre con el equipo de finanzas y contabilidad", 40), "Validar la bolsa de septiembre");
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
    "Tienes 2 en el cajón. La primera: Otra del cajón, de Cajón desastre. Y 1 más.",
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

test("speech.vozTareas: solo la primera y «y N más»; la pantalla sigue con hasta 3", () => {
  const v = buildTasksView(ROWS, CFG, [], HOY, null);
  const todas = v.groups.flatMap((g) => g.tasks);
  const vencidas = todas.filter((t) => t.overdue);
  assert.equal(vozTareas("overdue", vencidas), "Tienes 2 tareas vencidas: Cerrar propuesta, de Acme Ventas. Y 1 más.");
  assert.equal(vozTareas("today", todas.filter((t) => t.due === HOY)), "Para hoy tienes 1 tarea: Revisar tickets, de Acme Soporte.");
  assert.equal(vozTareas("project", v.groups[0].tasks, { projectLabel: "Acme Ventas" }), "En Acme Ventas tienes 3 pendientes: Cerrar propuesta. Y 2 más.");
  assert.equal(vozTareas("overdue", []), "No tienes tareas vencidas.");
  // Con títulos larguísimos la voz sigue cabiendo en el tope.
  const largas = Array.from({ length: 8 }, (_, i) =>
    toViewTask(row({ folder: "acme-ventas", text: `Tarea número ${i} con un título bastante largo que describe muchísimas cosas por hacer hoy mismo`, due: "2026-10-01" }), CFG, HOY));
  assert.ok(vozTareas("overdue", largas).length <= 130, vozTareas("overdue", largas));
});

test("speech.resumenGeneral sin cajón (voz) y vozCual: una sola pregunta", () => {
  assert.equal(resumenGeneral({ open: 1, overdue: 1, today: 0, inbox: 3 }, false), "Tienes 1 pendiente, 1 vencida y 0 para hoy.");
  const v = buildTasksView(ROWS, CFG, [], HOY, null);
  // Mismo proyecto: se dice una sola vez.
  assert.equal(vozCual(v.groups[0].tasks.slice(0, 2)), "¿Cuál en Acme Ventas: Cerrar propuesta o Sin fecha alta?");
  assert.match(vozCual(v.groups[0].tasks), /^¿Cuál de las 3 en Acme Ventas: /);
  // Proyectos distintos: cada opción lleva el suyo.
  const todas = v.groups.flatMap((g) => g.tasks);
  const mix = [v.groups[0].tasks[0], todas.find((t) => t.text.startsWith("Esperar"))].filter((t): t is NonNullable<typeof t> => !!t);
  assert.equal(vozCual(mix), "¿Cuál: Cerrar propuesta, de Acme Ventas; o Esperar: Luis envía la base, de Beta Datos?");
});

test("speech.vozCual: con títulos y proyectos largos cabe, no pierde el «?» y las opciones se distinguen", () => {
  const larga = (folder: string, text: string) => toViewTask(row({ folder, text, due: "2026-10-01" }), CFG, HOY);
  // Mismo inicio: los títulos recortados quedarían idénticos.
  const a = larga("acme-ventas", "Preparar la presentación trimestral de resultados para el comité de dirección de Acme");
  const b = larga("beta-datos", "Preparar la presentación trimestral de resultados para el directorio de Beta Datos");
  const p = vozCual([a, b]);
  assert.ok(p.length <= 100 && p.endsWith("?"), p);
  const [x, y] = p.slice("¿Cuál: ".length, -1).split("; o ");
  assert.notEqual(x, y);
  assert.match(p, /comité/);
  assert.match(p, /directorio/);
  // Mismo proyecto y mismo inicio.
  const c = larga("acme-ventas", "Preparar la presentación trimestral de resultados para el comité de dirección");
  const d = larga("acme-ventas", "Preparar la presentación trimestral de resultados para el directorio de socios");
  const q = vozCual([c, d, c]);
  assert.ok(q.length <= 100 && q.endsWith("?") && q.startsWith("¿Cuál de las 3 en Acme Ventas: "), q);
  assert.match(q, /comité[^?]* o [^?]*directorio/);
  // Siempre dentro del tope, con cualquier mezcla de largos.
  for (const n of [10, 40, 90, 150]) {
    const t1 = larga("acme-soporte", "Tarea ".repeat(n / 6 + 1).trim());
    const t2 = larga("beta-datos", "Otra ".repeat(n / 5 + 1).trim());
    const r = vozCual([t1, t2]);
    assert.ok(r.length <= 100 && r.endsWith("?"), `${n}: ${r}`);
  }
});

// Lo que se dice se presupuesta YA CONVERTIDO a palabras: un monto o un % crece al hablarse y no debe empujar fuera el «?» ni el «Y N más».
const tarea = (folder: string, text: string, extra: Partial<ReturnType<typeof toViewTask>> = {}) => ({
  ...toViewTask(row({ folder, text, due: "2026-10-01" }), CFG, HOY),
  ...extra,
});

test("speech.vozCual: con montos en los títulos mide lo hablado y no pierde el «?»", () => {
  const a = tarea("acme-ventas", "Pagar S/ 1,200 a Juan por el alquiler del local de Surco");
  const b = tarea("acme-ventas", "Pagar S/ 800 a Juan por el alquiler del local de Surco");
  const p = vozCual([a, b]);
  assert.ok(p.length <= 100 && p.endsWith("?"), `${p.length}: ${p}`);
  assert.equal(prepararVoz(p), p); // al convertir no crece ni se recorta
  assert.match(p, /mil doscientos/);
  assert.match(p, /ochocientos/);
  // Proyectos distintos y 3 opciones.
  const c = tarea("beta-datos", "Pagar S/ 1,500 de alquiler y el 18% de comisión a la inmobiliaria Hernández");
  const d = tarea("acme-soporte", "Pagar S/ 2,350.50 al proveedor de internet por los tres meses atrasados");
  const q = vozCual([c, d, a]);
  assert.ok(q.length <= 100 && q.endsWith("?"), `${q.length}: ${q}`);
  assert.equal(prepararVoz(q), q);
  assert.match(q, /^¿Cuál de las 3: /);
});

test("speech.vozCual: títulos idénticos en proyectos distintos se distinguen por proyecto, no por la última palabra", () => {
  const texto = "Preparar la presentación trimestral de resultados para el comité de dirección";
  const a = tarea("acme-ventas", texto);
  const b = tarea("beta-datos", texto);
  assert.equal(vozCual([a, b]), "¿La de Acme Ventas o la de Beta Datos?");
  assert.equal(vozCual([a, b, a]), "¿La de Acme Ventas o la de Beta Datos?");
  // En el mismo proyecto no hay nada que los distinga: se dice.
  assert.equal(vozCual([a, tarea("acme-ventas", texto)]), "Tienen el mismo título en Acme Ventas: ¿cuál?");
  // Títulos que solo comparten el inicio siguen mostrándose desde donde difieren.
  const c = tarea("acme-ventas", `${texto} de Acme`);
  const d = tarea("acme-ventas", `${texto} de Beta`);
  assert.match(vozCual([c, d]), /de Acme o .*de Beta\?$/);
});

test("speech.vozTareas: con montos y un proyecto largo cabe, acota el proyecto y conserva «Y N más.»", () => {
  const largo = "Maquimas Colombia cobranzas regionales y nacionales";
  const primera = tarea("acme-ventas", "Cobrar S/ 2,350.50 al cliente moroso de la región norte y el 18% de recargo", { project: largo, frente: null });
  const resto = Array.from({ length: 4 }, (_, i) => tarea("acme-ventas", `Otra ${i}`, { project: largo, frente: null }));
  for (const kind of ["overdue", "today", "inbox"] as const) {
    const v = vozTareas(kind, [primera, ...resto]);
    assert.ok(v.length <= 100, `${kind} ${v.length}: ${v}`);
    assert.ok(v.endsWith("Y 4 más."), `${kind}: ${v}`);
    assert.equal(prepararVoz(v), v);
    assert.doesNotMatch(v, /(dos|mil|trescientos|cincuenta|cientos),/); // un número cortado sin su unidad afirmaría otra cifra
    assert.ok(!v.includes("regionales y nacionales"), `el proyecto debe acotarse a ~24: ${v}`);
  }
  const p = vozTareas("project", [primera, ...resto], { projectLabel: largo });
  assert.ok(p.length <= 100 && p.endsWith("Y 4 más.") && prepararVoz(p) === p, `${p.length}: ${p}`);
  assert.equal(vozTareas("overdue", []), "No tienes tareas vencidas.");
});
