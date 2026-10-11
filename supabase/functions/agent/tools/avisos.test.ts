// node --experimental-strip-types --test supabase/functions/agent/tools/avisos.test.ts
// create_reminder / list_reminders / cancel_reminder de punta a punta con la tabla de avisos en memoria (nada sale a la red).
// Hoy es domingo 2026-10-11, 12:00 en Lima (el agente recibe `limaNow` ya corrido −5 h, por eso 12:00Z en el contexto).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capturarLog, OWNER } from "./testlib.ts";
import { fakeAvisos } from "./avisosTestlib.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";

const { avisos, cancelarAvisosDeTarea, crearAvisoDeTarea, moverAvisosDeTarea } = await import("./avisos.ts");
const { planDeTarea } = await import("./avisosPlan.ts");

const OTRO = "bbbbbbbb-0000-4000-8000-000000000002";
const ctx = (db: unknown, text = "", ahoraLima = "2026-10-11T12:00:00Z") =>
  ({ supabase: db as never, user: { id: OWNER } as never, text, limaNow: new Date(ahoraLima) });
const cabe = (r: { message: string; voz?: string }) => assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX, loQueSeDice(r));
const fila = (id: string, titulo: string, cuando: string, extra: Record<string, unknown> = {}) =>
  ({ aviso_id: id, user_id: OWNER, origen: "recordatorio", titulo, cuando, estado: "pendiente", ...extra });

test("«recuérdame llamar a Marco a las 5»: guarda el aviso de esta tarde (17:00 de Lima) a nombre de David y lo confirma", async () => {
  const f = fakeAvisos();
  const r = await avisos.handlers.create_reminder({ text: "llamar a Marco", due: "hoy", time: "17:00" }, ctx(f.db, "recuérdame llamar a Marco a las 5"), undefined);
  assert.equal(r.action, "create_reminder");
  assert.equal(r.message, "Hecho. Te aviso hoy a las cinco de la tarde: «Llamar a Marco».");
  assert.equal(r.voz, "Hecho, te aviso hoy a las cinco de la tarde.");
  cabe(r);
  assert.equal(f.filas.length, 1);
  assert.deepEqual(f.escrituras[0]!.valores, {
    user_id: OWNER, origen: "recordatorio", titulo: "Llamar a Marco", cuerpo: "Me pediste que te lo recordara.", url: "/avisos", cuando: "2026-10-11T22:00:00.000Z",
  });
});

test("«recuérdame el jueves a las 9 revisar el simulador»: el jueves 15 a las 9:00 de Lima (14:00 UTC)", async () => {
  const f = fakeAvisos();
  const r = await avisos.handlers.create_reminder({ text: "Revisar el simulador", due: "jueves", time: "09:00" }, ctx(f.db), undefined);
  assert.equal(f.filas[0]!.cuando, "2026-10-15T14:00:00.000Z");
  assert.equal(r.voz, "Hecho, te aviso el jueves 15 de octubre a las nueve de la mañana.");
  cabe(r);
});

test("«en 20 minutos»: relativo al instante real, aunque el reloj del agente esté corrido −5 h", async () => {
  const f = fakeAvisos();
  const r = await avisos.handlers.create_reminder({ text: "Sacar la pizza", en_minutos: 20 }, ctx(f.db), undefined);
  assert.equal(f.filas[0]!.cuando, "2026-10-11T17:20:00.000Z", "12:00 en Lima + 20 min = 12:20 Lima = 17:20 UTC");
  assert.equal(r.voz, "Hecho, te aviso en 20 minutos.");
});

test("decirlo dos veces no lo duplica: «Ya lo tenía anotado»", async () => {
  const f = fakeAvisos();
  const args = { text: "Llamar a Marco", due: "hoy", time: "17:00" };
  await avisos.handlers.create_reminder(args, ctx(f.db), undefined);
  const otra = await avisos.handlers.create_reminder(args, ctx(f.db), undefined);
  assert.equal(f.filas.length, 1);
  assert.match(otra.message, /^Ya lo tenía anotado\./);
  assert.equal(otra.voz, "Ya lo tenía anotado, te aviso hoy a las cinco de la tarde.");
  // misma tarea a otra hora sí es otro aviso
  await avisos.handlers.create_reminder({ ...args, time: "18:00" }, ctx(f.db), undefined);
  assert.equal(f.filas.length, 2);
});

test("sin cuándo, con una hora que ya pasó o ininteligible: pregunta y NO guarda nada", async () => {
  const f = fakeAvisos();
  for (const args of [{ text: "Algo" }, { text: "Algo", due: "hoy", time: "08:00" }, { text: "Algo", time: "tardecito" }, { text: "" }]) {
    const r = await avisos.handlers.create_reminder(args, ctx(f.db), undefined);
    assert.ok(r.action === "clarify" || r.action === "error", JSON.stringify(args));
  }
  assert.equal(f.escrituras.length, 0);
});

test("tope de 50 pendientes: avisa y no guarda; un fallo de la base se dice sin lanzar", async () => {
  const log = capturarLog();
  try {
    const muchos = fakeAvisos(Array.from({ length: 50 }, (_, i) => fila(`m${i}`, `Aviso ${i}`, `2026-11-${String(1 + (i % 28)).padStart(2, "0")}T14:00:00.000Z`)));
    const lleno = await avisos.handlers.create_reminder({ text: "Uno más", due: "mañana", time: "10:00" }, ctx(muchos.db), undefined);
    assert.equal(lleno.action, "error");
    assert.match(lleno.message, /Ya tienes 50 recordatorios pendientes/);
    assert.equal(muchos.escrituras.length, 0);

    const roto = fakeAvisos([], { errorEn: "insert" });
    const r = await avisos.handlers.create_reminder({ text: "Algo", due: "mañana", time: "10:00" }, ctx(roto.db), undefined);
    assert.deepEqual([r.action, r.message], ["error", "No pude programar el aviso. Inténtalo de nuevo."]);
    const sinLeer = await avisos.handlers.list_reminders({}, ctx(fakeAvisos([], { errorEn: "select" }).db), undefined);
    assert.equal(sinLeer.action, "error");
  } finally {
    log.restaurar();
  }
});

test("list_reminders: solo los pendientes de David, recordatorios y tareas, del más próximo al más lejano", async () => {
  const f = fakeAvisos([
    fila("2", "Revisar el simulador", "2026-10-15T14:00:00.000Z", { origen: "tarea", tarea_texto: "Revisar el simulador" }),
    fila("1", "Llamar a Marco", "2026-10-11T22:00:00.000Z"),
    fila("x", "De otro usuario", "2026-10-11T21:00:00.000Z", { user_id: OTRO }),
    fila("v", "Mañana vence Netflix", "2026-10-11T14:00:00.000Z", { origen: "vencimiento" }),
    fila("e", "Ya enviado", "2026-10-11T13:00:00.000Z", { estado: "enviado" }),
    fila("c", "Cancelado", "2026-10-11T13:30:00.000Z", { estado: "cancelado" }),
  ]);
  const r = await avisos.handlers.list_reminders({}, ctx(f.db, "qué recordatorios tengo"), undefined);
  assert.equal(r.action, "list_reminders");
  assert.equal(r.message, "Tienes 2 recordatorios: «Llamar a Marco» hoy a las cinco de la tarde; «Revisar el simulador» el jueves 15 de octubre a las nueve de la mañana.");
  assert.equal(r.voz, "Tienes 2. El próximo: Llamar a Marco, hoy a las cinco de la tarde.");
  cabe(r);
  const vacio = await avisos.handlers.list_reminders({}, ctx(fakeAvisos().db), undefined);
  assert.equal(vacio.message, "No tienes recordatorios pendientes.");
});

test("cancel_reminder: por palabras cancela ese y solo ese; con varios que calzan pregunta; sin coincidencia lo dice", async () => {
  const f = fakeAvisos([
    fila("1", "Llamar a Marco", "2026-10-11T22:00:00.000Z"),
    fila("2", "Revisar el simulador", "2026-10-15T14:00:00.000Z"),
    fila("3", "Llamar a Ana", "2026-10-16T14:00:00.000Z"),
    fila("4", "Llamar a Marco (ajeno)", "2026-10-11T22:00:00.000Z", { user_id: OTRO }),
  ]);
  const varios = await avisos.handlers.cancel_reminder({ search: "llamar" }, ctx(f.db), undefined);
  assert.equal(varios.action, "clarify");
  assert.equal(varios.message, "¿Cuál recordatorio: «Llamar a Marco» o «Llamar a Ana»?");
  assert.equal(f.escrituras.length, 0, "preguntar no cancela");

  const ninguno = await avisos.handlers.cancel_reminder({ search: "dentista" }, ctx(f.db), undefined);
  assert.equal(ninguno.action, "error");
  assert.match(ninguno.message, /No encontré un recordatorio que se parezca a «dentista»/);

  const uno = await avisos.handlers.cancel_reminder({ search: "el recordatorio de Marco" }, ctx(f.db, "cancela el recordatorio de Marco"), undefined);
  assert.equal(uno.action, "cancel_reminder");
  assert.equal(uno.message, "Cancelé el recordatorio «Llamar a Marco».");
  assert.equal(uno.voz, "Cancelé «Llamar a Marco».");
  cabe(uno);
  assert.deepEqual(f.filas.map((x) => [x.aviso_id, x.estado]), [["1", "cancelado"], ["2", "pendiente"], ["3", "pendiente"], ["4", "pendiente"]], "el de otro usuario no se toca");
});

test("cancel_reminder: sin palabras y con uno solo cancela ese; sin ninguno lo dice; si ya salió, no miente", async () => {
  const solo = fakeAvisos([fila("1", "Llamar a Marco", "2026-10-11T22:00:00.000Z")]);
  const r = await avisos.handlers.cancel_reminder({}, ctx(solo.db, "cancela el recordatorio"), undefined);
  assert.equal(r.action, "cancel_reminder");
  assert.equal(solo.filas[0]!.estado, "cancelado");
  const vacio = await avisos.handlers.cancel_reminder({}, ctx(fakeAvisos().db), undefined);
  assert.equal(vacio.message, "No tienes recordatorios pendientes.");

  // salió justo entre la lectura y el UPDATE: el UPDATE exige estado = pendiente y no toca nada
  const f: ReturnType<typeof fakeAvisos> = fakeAvisos([fila("1", "Llamar a Marco", "2026-10-11T22:00:00.000Z")], {
    alEscribir: () => { f.filas[0]!.estado = "enviado"; },
  });
  const tarde = await avisos.handlers.cancel_reminder({ search: "marco" }, ctx(f.db), undefined);
  assert.deepEqual([tarde.action, tarde.message], ["error", "Ese aviso ya salió o ya estaba cancelado."]);
  assert.equal(f.filas[0]!.estado, "enviado", "no lo pisó con «cancelado»");
});

test("recordatorio de una tarea: se liga a su ruta y línea; al completar la tarea se cancela, y solo el suyo", async () => {
  const f = fakeAvisos();
  const p = planDeTarea("Llamar a Ana", { fecha: "2026-10-12", hora: "17:00", porDefecto: false }, new Date("2026-10-11T17:00:00Z"));
  assert.ok("plan" in p);
  const tarea = { path: "20-projects/cajon-desastre/pendientes.md", line: 4, texto: "Llamar a Ana" };
  assert.equal(await crearAvisoDeTarea(f.db as never, OWNER, p.plan, tarea, "el cajón"), "creado");
  assert.equal(await crearAvisoDeTarea(f.db as never, OWNER, p.plan, tarea, "el cajón"), "repetido");
  assert.deepEqual(
    { o: f.filas[0]!.origen, p: f.filas[0]!.tarea_path, l: f.filas[0]!.tarea_line, t: f.filas[0]!.tarea_texto, u: f.filas[0]!.url, c: f.filas[0]!.cuerpo },
    { o: "tarea", p: tarea.path, l: 4, t: "Llamar a Ana", u: "/tareas", c: "Tu pendiente en el cajón. Me pediste que te lo recordara." },
  );
  // otra tarea en la misma línea de OTRO archivo y la misma en otra línea: no se tocan
  f.filas.push(fila("o1", "Otra", "2026-10-12T22:00:00.000Z", { origen: "tarea", tarea_path: "20-projects/lota/pendientes.md", tarea_line: 4, tarea_texto: "Llamar a Ana" }));
  f.filas.push(fila("o2", "Otra", "2026-10-12T22:00:00.000Z", { origen: "tarea", tarea_path: tarea.path, tarea_line: 5, tarea_texto: "Llamar a Ana" }));
  f.filas.push(fila("o3", "Otra", "2026-10-12T22:00:00.000Z", { origen: "tarea", tarea_path: tarea.path, tarea_line: 4, tarea_texto: "Otro texto (el archivo cambió)" }));
  assert.equal(await cancelarAvisosDeTarea(f.db as never, OWNER, tarea), 1);
  assert.deepEqual(f.filas.map((x) => x.estado), ["cancelado", "pendiente", "pendiente", "pendiente"]);
  // sin tarea a mano, el aviso sale como recordatorio suelto
  const g = fakeAvisos();
  assert.equal(await crearAvisoDeTarea(g.db as never, OWNER, p.plan, null, "el cajón"), "creado");
  assert.equal(g.filas[0]!.origen, "recordatorio");
  assert.equal("tarea_path" in g.filas[0]!, false);
});

test("las tools y reglas del módulo: nombres únicos en el registro y reglas que separan recordatorio de tarea", async () => {
  assert.deepEqual(avisos.definitions.map((d) => d.function.name), ["create_reminder", "list_reminders", "cancel_reminder"]);
  // El registro no se puede cargar en Node (algunos módulos importan de jsr:): se escanean las fuentes. El agente se niega a arrancar
  // si dos módulos declaran la misma tool, así que cada nombre debe aparecer en un solo tool("…").
  const aqui = dirname(fileURLToPath(import.meta.url));
  const fuentes = readdirSync(aqui).filter((f) => f.endsWith(".ts") && !/\.test\.|testlib/.test(f)).map((f) => readFileSync(join(aqui, f), "utf8"));
  for (const d of avisos.definitions) {
    const veces = fuentes.reduce((n, src) => n + src.split(`tool("${d.function.name}"`).length - 1, 0);
    assert.equal(veces, 1, `${d.function.name} se declara una sola vez`);
  }
  const registro = readFileSync(join(aqui, "..", "registry.ts"), "utf8");
  assert.ok(registro.includes('import { avisos } from "./tools/avisos.ts";'), "el registro importa el módulo");
  assert.match(registro, /\n {2}avisos,\r?\n\];/, "y lo incluye en la lista");
  const rules = avisos.rules ?? "";
  assert.match(rules, /recuérdame/);
  assert.match(rules, /create_reminder/);
  assert.match(rules, /en_minutos/);
  assert.match(rules, /create_task/);
  const crear = avisos.definitions[0]!.function.parameters as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(crear.required, ["text"]);
  for (const k of ["text", "due", "time", "en_minutos"]) assert.ok(k in crear.properties, k);
});

test("mover una tarea (web): sus recordatorios la siguen por RPC con el texto recortado a 200; un error se traga y no rompe el movimiento", async () => {
  const llamadas: { name: string; args: unknown }[] = [];
  const db = { rpc: async (name: string, args: unknown) => { llamadas.push({ name, args }); return { data: 2, error: null }; } };
  const n = await moverAvisosDeTarea(db as never, { path: "a.md", line: 3, texto: "x".repeat(300) }, { path: "b.md", line: 7 });
  assert.equal(n, 2);
  assert.deepEqual(llamadas, [{ name: "avisos_mover_tarea", args: { p_path: "a.md", p_line: 3, p_texto: "x".repeat(200), p_nuevo_path: "b.md", p_nueva_line: 7 } }]);
  const log = capturarLog();
  try {
    const roto = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
    assert.equal(await moverAvisosDeTarea(roto as never, { path: "a.md", line: 3, texto: "t" }, { path: "b.md", line: 7 }), 0);
    const lanza = { rpc: async () => { throw new Error("red"); } };
    assert.equal(await moverAvisosDeTarea(lanza as never, { path: "a.md", line: 3, texto: "t" }, { path: "b.md", line: 7 }), 0);
  } finally {
    log.restaurar();
  }
});

test("la web: task.status a «completed» cancela el recordatorio y task.move lo reubica (la función vault llama a cada helper en su acción)", () => {
  // vault/index.ts usa Deno.serve y no se puede cargar en Node: se escanea la fuente, que es lo que evita que alguien quite la llamada.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vault", "index.ts"), "utf8");
  const status = src.slice(src.indexOf('case "task.status"'), src.indexOf('case "task.move"'));
  const move = src.slice(src.indexOf('case "task.move"'), src.indexOf('case "search"'));
  assert.match(status, /body\.status === "completed"[\s\S]*cancelarAvisosDeTarea\(db, userId, \{ path: body\.path, line: body\.line as number, texto: r\.task\.text \}\)/);
  assert.match(move, /moverAvisosDeTarea\(db, \{ path: body\.path, line: body\.line as number, texto: r\.task\.text \}, \{ path: r\.task\.path, line: r\.task\.line \}\)/);
  assert.ok(src.includes('from "../_shared/avisosTarea.ts"'));
});
