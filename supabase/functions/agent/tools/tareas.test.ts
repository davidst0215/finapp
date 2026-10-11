// node --experimental-strip-types --test supabase/functions/agent/tools/tareas.test.ts
// create_task / list_tasks de punta a punta con un vault falso: la base está en memoria y GitHub es un doble que solo APUNTA
// lo que se escribiría (nada sale a la red). Hoy es domingo 2026-10-11 en Lima.
import test from "node:test";
import assert from "node:assert/strict";
import { capturarLog, doc, fakeDb, githubFalso, OWNER, tarea } from "./testlib.ts";
import { conAvisos, fakeAvisos } from "./avisosTestlib.ts";
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
const VAULT = (sha = "sha1") => ({
  vault_sync: [{ user_id: OWNER, tree_sha: sha, synced_at: "2026-10-11T00:00:00Z", docs: 5, tasks: 5 }],
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
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: true, candidatos: 1, aproximado: false });
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
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: false, candidatos: 2, aproximado: false });

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
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: false, candidatos: 0, aproximado: false });
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

// --- «recuérdame…» sobre una tarea: además de escribirla, programa el aviso push (migración 017) -----------------------------------
const conAviso = (filas: Record<string, unknown>[] = [], opciones: Parameters<typeof fakeAvisos>[1] = {}) => {
  const avisos = fakeAvisos(filas, opciones);
  return { db: conAvisos(fakeDb(VAULT()).db, avisos), avisos };
};

test("«recuérdame mañana a las 5 llamar a Ana»: anota la tarea Y programa el aviso de mañana 17:00 de Lima, ligado a la tarea", async () => {
  const { db, avisos } = conAviso();
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, ctx(db, "recuérdame mañana a las cinco llamar a Ana"), undefined);
    assert.equal(r.message, "Anoté «Llamar a Ana» en el cajón para mañana a las cinco de la tarde. Te aviso a esa hora.");
    assert.equal(r.voz, "Anotado en el cajón para mañana a las cinco de la tarde. Te aviso.");
    assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX);
    assert.equal(gh.escrituras.length, 1, "la tarea se escribió en Norte");
    assert.equal(avisos.filas.length, 1);
    const a = avisos.filas[0]!;
    assert.deepEqual([a.origen, a.titulo, a.cuando, a.url, a.user_id], ["tarea", "Llamar a Ana", "2026-10-12T22:00:00.000Z", "/tareas", OWNER]);
    assert.equal(a.tarea_path, "20-projects/cajon-desastre/pendientes.md");
    assert.equal(typeof a.tarea_line, "number");
    assert.equal(a.tarea_texto, "Llamar a Ana");
    assert.match(String(a.cuerpo), /^Tu pendiente en el cajón\. /);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«recuérdame el viernes…» sin hora: la tarea es del viernes y el aviso sale a las 9:00 (y lo dice)", async () => {
  const { db, avisos } = conAviso();
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Llamar a Ana", due: "viernes" }, ctx(db, "recuérdame el viernes llamar a Ana"), undefined);
    assert.equal(avisos.filas[0]!.cuando, "2026-10-16T14:00:00.000Z");
    assert.match(r.message, /para el viernes 16 de octubre\. Te aviso a las nueve de la mañana\.$/);
    assert.match(r.voz ?? "", /Te aviso a las nueve de la mañana\.$/);
    assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«recuérdame» sin cuándo, con la hora ya pasada, sin la palabra o con «avisar a Ana» en la tarea: no hay aviso, y se dice cuando hacía falta", async () => {
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const caso = async (args: Record<string, unknown>, dictado: string) => {
      const { db, avisos } = conAviso();
      const r = await tareas.handlers.create_task(args, ctx(db, dictado), undefined);
      assert.equal(r.action, "create_task");
      assert.equal(avisos.filas.length, 0, dictado);
      return r;
    };
    const sinFecha = await caso({ text: "Comprar leche" }, "recuérdame comprar leche");
    assert.match(sinFecha.message, / Sin fecha no puedo avisarte; dime cuándo\.$/);
    assert.equal(sinFecha.voz, "Anotado en el cajón. Dime cuándo y te aviso.");
    const pasada = await caso({ text: "Llamar a Ana", due: "hoy", time: "09:00" }, "avísame hoy a las 9 que llame a Ana");
    assert.match(pasada.message, / Esa hora ya pasó, así que no hay aviso\.$/);
    const sinPedirlo = await caso({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, "anota llamar a Ana mañana a las 5");
    assert.doesNotMatch(sinPedirlo.message, /aviso/i);
    const avisarEnElTexto = await caso({ text: "Avisar a Ana del cambio", due: "mañana" }, "agrega avisar a Ana del cambio para mañana");
    assert.doesNotMatch(avisarEnElTexto.message, /Te aviso|Sin fecha/);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«recuérdame que Ana envíe el contrato»: una tarea que espera a otra persona también avisa; repetir el pedido no duplica el aviso", async () => {
  const { db, avisos } = conAviso();
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const args = { text: "Que Ana envíe el contrato", due: "mañana", time: "10:00", with: "Ana" };
    await tareas.handlers.create_task(args, ctx(db, "recuérdame mañana a las 10 que Ana envíe el contrato"), undefined);
    assert.equal(avisos.filas.length, 1);
    const otra = await tareas.handlers.create_task(args, ctx(db, "recuérdame mañana a las 10 que Ana envíe el contrato"), undefined);
    assert.equal(avisos.filas.length, 1, "mismo texto y hora: un solo aviso");
    assert.match(otra.message, /Te aviso a esa hora\.$/);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("«…y recuérdame a las 5» sin que llegue time: pregunta la hora y NO escribe la tarea ni programa nada (no cae en las 9:00)", async () => {
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const casos: [string, Record<string, unknown>][] = [
      ["agéndame llamar a Ana mañana y recuérdame a las 5", { text: "Llamar a Ana", due: "mañana" }],
      ["recuérdame mañana a la una llamar a Ana", { text: "Llamar a Ana", due: "mañana" }],
      ["recuérdame el viernes a las 5 y media llamar a Ana", { text: "Llamar a Ana", due: "viernes" }],
    ];
    for (const [dictado, args] of casos) {
      const { db, avisos } = conAviso();
      const r = await tareas.handlers.create_task(args, ctx(db, dictado), undefined);
      assert.equal(r.action, "clarify", dictado);
      assert.equal(r.message, "¿A qué hora te aviso? Dímela como las cinco de la tarde.");
      assert.equal(r.voz, "¿A qué hora te aviso?");
      assert.equal(avisos.filas.length, 0, `${dictado}: ningún aviso`);
    }
    assert.equal(gh.escrituras.length, 0, "ninguna tarea escrita en Norte");
    // al responder la hora, el modelo repite create_task con time y ahora sí: tarea + aviso a las 17:00
    const { db, avisos } = conAviso();
    const r = await tareas.handlers.create_task({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, ctx(db, "agéndame llamar a Ana mañana y recuérdame a las 5"), undefined);
    assert.equal(r.action, "create_task");
    assert.equal(avisos.filas[0]!.cuando, "2026-10-12T22:00:00.000Z");
    assert.equal(gh.escrituras.length, 1);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("si el aviso no se puede guardar, la tarea ya escrita queda y se dice (no se deshace)", async () => {
  const { db, avisos } = conAviso([], { errorEn: "insert" });
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Llamar a Ana", due: "mañana", time: "17:00" }, ctx(db, "recuérdame mañana a las 5 llamar a Ana"), undefined);
    assert.equal(r.action, "create_task");
    assert.equal(gh.escrituras.length, 1);
    assert.equal(avisos.filas.length, 0);
    assert.match(r.message, / No pude programar el aviso\.$/);
    assert.equal(r.voz, "Anotado en el cajón para mañana a las cinco de la tarde. No pude programar el aviso.");
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("completar la tarea cancela su recordatorio pendiente; reabrirla o cambiarla de estado no toca nada", async () => {
  const RUTA = "20-projects/lota/pendientes.md";
  const aviso = { aviso_id: "av-1", user_id: OWNER, origen: "tarea", titulo: "Probar la cámara", cuando: "2026-10-12T22:00:00.000Z", estado: "pendiente", tarea_path: RUTA, tarea_line: 2, tarea_texto: "Probar la cámara" };
  const gh = githubFalso({ [RUTA]: "# Pendientes\n\n- [ ] Probar la cámara\n" });
  const log = capturarLog();
  try {
    const { db: enCurso, avisos: a1 } = conAviso([{ ...aviso }]);
    const curso = await tareas.handlers.update_task({ search: "probar la cámara", status: "in-progress" }, ctx(enCurso, "la cámara está en curso"), undefined);
    assert.equal(curso.action, "update_task");
    assert.equal(a1.filas[0]!.estado, "pendiente", "en curso: el recordatorio sigue");

    const { db, avisos } = conAviso([{ ...aviso }]);
    const r = await tareas.handlers.update_task({ search: "probar la cámara" }, ctx(db, "ya probé la cámara"), undefined);
    assert.equal(r.action, "update_task");
    assert.match(r.message, /^Completé «Probar la cámara»\./);
    assert.deepEqual(avisos.filas.map((f) => f.estado), ["cancelado"]);
    // si cancelar falla, completar la tarea no se rompe
    const { db: roto } = conAviso([{ ...aviso }], { errorEn: "update" });
    const gh2 = githubFalso({ [RUTA]: "# Pendientes\n\n- [ ] Probar la cámara\n" });
    try {
      const ok = await tareas.handlers.update_task({ search: "probar la cámara" }, ctx(roto, "ya probé la cámara"), undefined);
      assert.equal(ok.action, "update_task");
    } finally {
      gh2.restaurar();
    }
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

test("las reglas de tareas explican agendar, la diferencia con el calendario y que «recuérdame» solo es otro módulo", () => {
  const rules = tareas.rules ?? "";
  assert.match(rules, /agéndame revisar X el jueves/);
  assert.match(rules, /en mi calendario/);
  assert.match(rules, /create_reminder/);
  assert.match(rules, /anótalo y recuérdame/);
  assert.doesNotMatch(rules, /No prometas una alarma/, "ya hay alarma real");
  assert.doesNotMatch(rules, /agéndame \/ recuérdame/, "«recuérdame» ya no manda a create_task");
  assert.match(rules, /¿app o normativa\?/);
  const crear = tareas.definitions.find((d) => d.function.name === "create_task")!;
  assert.ok("time" in (crear.function.parameters as { properties: object }).properties);
});

test("create_task con una coincidencia aproximada («lota visión») pregunta y NO escribe; leer sí puede ser aproximado", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Probar la cámara", project: "lota visión" }, ctx(db, "anota probar la cámara en lota visión"), undefined);
    assert.equal(r.action, "clarify");
    assert.equal(r.message, "¿Lo anoto en Lota?");
    assert.equal(r.voz, "¿En Lota?");
    assert.equal(gh.escrituras.length, 0);
    assert.deepEqual(log.eventos().find((e) => e.evt === "tareas"), { evt: "tareas", proyecto_resuelto: true, candidatos: 1, aproximado: true });
    // al confirmar, el modelo repite con el nombre completo y se escribe
    const hecho = await tareas.handlers.create_task({ text: "Probar la cámara", project: "lota" }, ctx(db, "sí"), undefined);
    assert.equal(hecho.action, "create_task");
    assert.equal(gh.escrituras[0].path, "20-projects/lota/pendientes.md");
    // y listar con la misma frase aproximada sí funciona
    const lista = await tareas.handlers.list_tasks({ filter: "project", project: "lota visión" }, ctx(db, "pendientes de lota visión"), undefined);
    assert.equal(lista.action, "list_tasks");
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("índice de proyectos en dos pasos: «tdv bolsa» no baja el contenido de las fichas; «maqui colombia» sí, una vez por versión del vault", async () => {
  const leeContenido = (lecturas: { table: string; cols: string }[]) => lecturas.filter((l) => l.table === "vault_docs" && l.cols.includes("content")).length;
  const { db, lecturas } = fakeDb(VAULT("sha-dos-pasos"));
  const gh = githubFalso();
  const log = capturarLog();
  try {
    await tareas.handlers.list_tasks({ filter: "project", project: "tdv bolsa" }, ctx(db, "pendientes de tdv bolsa"), undefined);
    await tareas.handlers.create_task({ text: "Algo", project: "tdv bolsa" }, ctx(db, "anota algo en tdv bolsa"), undefined);
    assert.equal(leeContenido(lecturas), 0, "el índice ligero alcanza");
    assert.ok(lecturas.some((l) => l.table === "vault_docs" && l.cols === "path, cliente, padre"), "sí leyó cliente y madre de las fichas");

    await tareas.handlers.create_task({ text: "Llamar", project: "maqui colombia cobranzas" }, ctx(db, "anota llamar en maqui colombia cobranzas"), undefined);
    assert.equal(leeContenido(lecturas), 1, "no alcanzó: se leyeron las rutas que nombran las fichas");
    assert.equal(gh.escrituras.at(-1)!.path, "20-projects/mqsco-cobranzas/pendientes.md");

    // la siguiente petición (misma versión del vault) ya lo tiene
    await tareas.handlers.create_task({ text: "Llamar otra vez", project: "maqui colombia cobranzas" }, ctx(db, "otra"), undefined);
    await tareas.handlers.list_tasks({ filter: "project", project: "maqui perú" }, ctx(db, "pendientes de maqui perú"), undefined);
    assert.equal(leeContenido(lecturas), 1, "cacheado por tree_sha");

    // el vault cambió (otro tree_sha): se vuelve a leer
    const { db: db2, lecturas: lecturas2 } = fakeDb(VAULT("sha-dos-pasos-v2"));
    await tareas.handlers.create_task({ text: "Llamar", project: "maqui colombia cobranzas" }, ctx(db2, "x"), undefined);
    assert.equal(leeContenido(lecturas2), 1);
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});

test("la confirmación dice «Maqui CO cobranzas», nunca «Mqsco cobranzas»: con el índice ligero la etiqueta saldría cruda y se escala al completo", async () => {
  const leeContenido = (ls: { table: string; cols: string }[]) => ls.filter((l) => l.table === "vault_docs" && l.cols.includes("content")).length;
  const { db, lecturas } = fakeDb(VAULT("sha-etiqueta"));
  const gh = githubFalso();
  const log = capturarLog();
  try {
    const r = await tareas.handlers.create_task({ text: "Llamar a Gabriela", project: "mqsco cobranzas" }, ctx(db, "anota llamar a Gabriela en mqsco cobranzas"), undefined);
    assert.equal(r.voz, "Anotado en Maqui CO cobranzas.");
    assert.match(r.message, /en Maqui CO cobranzas\./);
    assert.equal(leeContenido(lecturas), 1);
    // una carpeta suelta o de un grupo con cliente en el ligero se dice bien sin leer más
    const { db: db2, lecturas: l2 } = fakeDb(VAULT("sha-etiqueta-2"));
    const sola = await tareas.handlers.create_task({ text: "Algo", project: "lota" }, ctx(db2, "x"), undefined);
    assert.equal(sola.voz, "Anotado en Lota.");
    const tdv = await tareas.handlers.create_task({ text: "Algo", project: "tdv bolsa" }, ctx(db2, "x"), undefined);
    assert.equal(tdv.voz, "Anotado en TDV bolsa de costos.");
    assert.equal(leeContenido(l2), 0, "etiquetas buenas con el índice ligero: no se baja nada");
  } finally {
    gh.restaurar();
    log.restaurar();
  }
});
