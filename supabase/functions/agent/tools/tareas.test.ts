// node --experimental-strip-types --test supabase/functions/agent/tools/tareas.test.ts
// create_task / list_tasks de punta a punta con un vault falso: la base está en memoria y GitHub es un doble que solo APUNTA
// lo que se escribiría (nada sale a la red). Hoy es domingo 2026-10-11 en Lima.
import test from "node:test";
import assert from "node:assert/strict";
import { capturarLog, doc, fakeDb, githubFalso, OWNER, tarea } from "./testlib.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";

const { tareas } = await import("./tareas.ts");

const FOLDERS = [
  "cajon-desastre", "lota", "mqsco-cobranzas", "mqsco-herramientas", "mqspe-aprobaciones", "mqspe-scoring", "novafondos-app", "novafondos-normativa",
  "tdv-bolsa-de-costos", "tdv-analisis", "mqspe-herramientas", "tdv-herramientas",
];
const FICHAS = [
  doc("60-wiki/proyectos/maqui-colombia.md", "ficha", "Maqui Colombia", { cliente: "Maqui CO", content: "Vault 20-projects/mqsco-*/pendientes.md" }),
  doc("60-wiki/proyectos/maqui-peru.md", "ficha", "Maqui Perú", { cliente: "Maqui PE", content: "Vault: 20-projects/mqspe-*/pendientes.md" }),
  doc("60-wiki/proyectos/novafondos.md", "ficha", "Novafondos", { cliente: "Novafondos", content: "Vault: `20-projects/novafondos-app/pendientes.md` y `novafondos-normativa/pendientes.md`" }),
  doc("60-wiki/proyectos/tdv.md", "ficha", "TDV", { cliente: "TDV", content: "Vault: `20-projects\\tdv-*\\pendientes.md`" }),
  doc("60-wiki/proyectos/lota.md", "ficha", "LOTA", { cliente: "personal", content: "" }),
];
const VAULT = () => ({
  vault_sync: [{ user_id: OWNER, tree_sha: "sha1", synced_at: "2026-10-11T00:00:00Z", docs: 5, tasks: 5 }],
  vault_docs: [...FICHAS, ...FOLDERS.map((f) => doc(`20-projects/${f}/pendientes.md`, "pendientes", `Pendientes — ${f}`))],
  vault_tasks: [
    tarea("20-projects/mqspe-scoring/pendientes.md", "mqspe-scoring", 2, "Recalibrar el modelo", { due: "2026-10-13" }),
    tarea("20-projects/mqspe-aprobaciones/pendientes.md", "mqspe-aprobaciones", 2, "Revisar aprobaciones de septiembre"),
    tarea("20-projects/lota/pendientes.md", "lota", 2, "Probar la cámara"),
  ],
});
const ctx = (db: unknown, text: string, ahoraUtc = "2026-10-11T12:00:00Z") =>
  ({ supabase: db as never, user: { id: OWNER } as never, text, limaNow: new Date(ahoraUtc) });

test("«pendiente en maqui colombia cobranzas, para mañana a las 5»: escribe en mqsco-cobranzas con 📅 de mañana en Lima y la hora en el detalle", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task(
      { text: "Llamar a Gabriela", project: "maqui colombia cobranzas", due: "mañana", time: "17:00" },
      ctx(db, "agrega pendiente en maqui colombia cobranzas para mañana a las 5: llamar a Gabriela"), undefined,
    );
    assert.equal(r.action, "create_task");
    assert.equal(gh.escrituras.length, 1);
    assert.equal(gh.escrituras[0].path, "20-projects/mqsco-cobranzas/pendientes.md");
    assert.match(gh.escrituras[0].text, /- \[ \] Llamar a Gabriela 📅 2026-10-12\n    - Hora: 17:00/);
    assert.equal(r.voz, "Anotado en Maqui CO cobranzas para mañana a las cinco de la tarde.");
    assert.match(r.message, /^Anoté «Llamar a Gabriela» en Maqui CO cobranzas para mañana a las cinco de la tarde\.$/);
    assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX);
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: true, candidatos: 1 });
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«agéndame revisar el simulador de nova fondos el jueves» pregunta cuál frente y NO escribe; al responder «app» sí", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const pregunta = await tareas.handlers.create_task({ text: "Revisar el simulador", project: "nova fondos", due: "jueves" }, ctx(db, "agéndame revisar el simulador de nova fondos el jueves"), undefined);
    assert.equal(pregunta.action, "clarify");
    assert.equal(pregunta.voz, "¿En Novafondos: app o normativa?");
    assert.equal(gh.escrituras.length, 0);
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: false, candidatos: 2 });

    const hecho = await tareas.handlers.create_task({ text: "Revisar el simulador", project: "novafondos app", due: "jueves" }, ctx(db, "app"), undefined);
    assert.equal(hecho.action, "create_task");
    assert.equal(gh.escrituras[0].path, "20-projects/novafondos-app/pendientes.md");
    assert.match(gh.escrituras[0].text, /Revisar el simulador 📅 2026-10-15/);
    assert.equal(hecho.voz, "Anotado en Novafondos app para el jueves 15 de octubre.");
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("el vencimiento es de Lima aunque en UTC ya sea otro día (22:30 del domingo en Lima)", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    // limaNow ya viene corrido −5 h: 03:30 UTC del lunes es 22:30 del domingo en Lima.
    const limaNow = new Date(new Date("2026-10-12T03:30:00Z").getTime() - 5 * 3_600_000).toISOString();
    await tareas.handlers.create_task({ text: "Cerrar la semana", due: "mañana" }, ctx(db, "anota cerrar la semana para mañana", limaNow), undefined);
    assert.match(gh.escrituras[0].text, /Cerrar la semana 📅 2026-10-12/);
    assert.equal(gh.escrituras[0].path, "20-projects/cajon-desastre/pendientes.md");
    await tareas.handlers.create_task({ text: "Algo hoy", due: "hoy" }, ctx(db, "anota algo hoy", limaNow), undefined);
    assert.match(gh.escrituras[1].text, /Algo hoy 📅 2026-10-11/);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("un proyecto que no se encuentra deja la tarea en el cajón, lo dice y lo registra", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Algo", project: "proyecto fantasma" }, ctx(db, "agrega algo en proyecto fantasma"), undefined);
    assert.equal(gh.escrituras[0].path, "20-projects/cajon-desastre/pendientes.md");
    assert.match(r.message, /No encontré el proyecto «proyecto fantasma», así que quedó en el cajón\./);
    assert.equal(r.voz, "Anotado en el cajón. No encontré ese proyecto.");
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: false, candidatos: 0 });
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«recuérdame…»: la pantalla aclara qué avisará (el resumen de las 7:00) en vez de prometer una alarma", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, ctx(db, "recuérdame mañana a las cinco llamar a Ana"), undefined);
    assert.match(r.message, /Te lo recordará el resumen de las 7:00 de ese día; aún no te aviso a la hora exacta\.$/);
    assert.doesNotMatch(r.voz ?? "", /recordar/, "la voz no promete nada");
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("list_tasks de «maqui perú» junta sus frentes; «tdv» y «nova fondos» sin tareas dicen que no hay; un nombre desconocido avisa", async () => {
  const { db } = fakeDb(VAULT());
  const log = capturarLog();
  try {
    const pe = await tareas.handlers.list_tasks({ filter: "project", project: "maqui perú" }, ctx(db, "qué pendientes tengo en maqui perú"), undefined);
    assert.equal(pe.action, "list_tasks");
    assert.match(pe.message, /^En Maqui PE tienes 2 pendientes: /);
    assert.match(pe.message, /Recalibrar el modelo/);
    assert.match(pe.message, /Revisar aprobaciones de septiembre/);
    assert.ok(prepararVoz(loQueSeDice(pe)).length <= VOZ_MAX);

    const lota = await tareas.handlers.list_tasks({ filter: "project", project: "lota visión" }, ctx(db, "qué pendientes tengo en lota visión"), undefined);
    assert.match(lota.message, /^En Lota tienes 1 pendiente: Probar la cámara/);

    const vacio = await tareas.handlers.list_tasks({ filter: "project", project: "tdv bolsa" }, ctx(db, "qué pendientes tengo en tdv bolsa"), undefined);
    assert.equal(vacio.message, "No hay pendientes en TDV bolsa de costos.");

    const fantasma = await tareas.handlers.list_tasks({ filter: "project", project: "marte" }, ctx(db, "pendientes de marte"), undefined);
    assert.equal(fantasma.action, "error");
    assert.match(fantasma.message, /No encontré un proyecto que se parezca a «marte»/);
    assert.deepEqual(log.eventos().filter((e) => e.evt === "tareas").map((e) => e.proyecto_resuelto), [false, true, true, false]);
  } finally {
    log.restaurar();
  }
});

test("list_tasks con proyectos distintos que comparten un frente pregunta entre proyectos", async () => {
  const { db } = fakeDb(VAULT());
  const log = capturarLog();
  try {
    const r = await tareas.handlers.list_tasks({ filter: "project", project: "herramientas" }, ctx(db, "pendientes de herramientas"), undefined);
    assert.equal(r.action, "clarify");
    assert.match(r.message, /^¿En cuál: /);
    assert.ok(r.voz?.endsWith("?"));
  } finally {
    log.restaurar();
  }
});

test("las reglas de tareas explican agendar, recordar y la diferencia con el calendario", () => {
  const rules = tareas.rules ?? "";
  assert.match(rules, /agéndame revisar X el jueves/);
  assert.match(rules, /en mi calendario/);
  assert.match(rules, /No prometas una alarma/);
  assert.match(rules, /¿app o normativa\?/);
  const crear = tareas.definitions.find((d) => d.function.name === "create_task")!;
  assert.ok("time" in (crear.function.parameters as { properties: object }).properties);
});
