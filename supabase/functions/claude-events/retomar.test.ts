// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/retomar.test.ts
// 014: un mensaje del celular que sigue en cola con la sesión quieta o cerrada se convierte en una tarea de retomar del runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notice } from "../_shared/notify.ts";
import { handleApi, LIMITS } from "./handlers.ts";
import type { ApiDeps } from "./handlers.ts";
import { MemoryStore } from "./memory-store.ts";

const BASE_URL = "https://proyecto.supabase.co/functions/v1/claude-events";
const START = Date.parse("2026-10-05T15:00:00.000Z");
const DAVID = "david";
const SESSION = "11111111-aaaa-4bbb-8ccc-222222222222";
const NEW_SESSION = "99999999-aaaa-4bbb-8ccc-333333333333";

// deno-lint-ignore no-explicit-any
type Json = any;

function setup(makeStore: () => MemoryStore = () => new MemoryStore()) {
  const store = makeStore();
  let nowMs = START;
  store.clock = () => new Date(nowMs).toISOString();
  const notices: Notice[] = [];
  const deps: ApiDeps = {
    store,
    now: () => new Date(nowMs),
    notify: async (_u, n) => {
      notices.push(n);
    },
    authenticateUser: async () => ({ userId: DAVID }),
    randomUUID: () => crypto.randomUUID(),
    publicUrl: BASE_URL,
    ownerId: DAVID,
  };
  const call = async (method: string, path: string, body?: unknown, token?: string, query?: string) => {
    const headers = new Headers();
    if (token) headers.set("x-wabid-device-token", token);
    return (await handleApi({ method, path: `/claude-events${path}`, query, headers, body: body === undefined ? "" : JSON.stringify(body) }, deps)) as { status: number; body: Json };
  };
  async function pair() {
    const res = await call("POST", "/ui/devices", { name: "Laptop" });
    const token = res.body.token as string;
    const ev = (type: string, session: string, extra: Record<string, unknown> = {}) =>
      call("POST", "/device/events", { type, session_id: session, project: "finapp", cwd: "~\\finapp", ...extra }, token);
    return {
      id: res.body.device.id as string,
      token,
      ev,
      start: (session = SESSION) => ev("session_start", session),
      stop: (session = SESSION) => ev("stop", session, { message: "listo" }),
      end: (session = SESSION) => ev("session_end", session),
      claim: (session = SESSION) => call("POST", `/device/sessions/${session}/messages/next`, {}, token),
      ack: (id: string) => call("POST", `/device/messages/${id}/ack`, {}, token),
      next: (body: Record<string, unknown> = {}) => call("POST", "/device/tasks/next", { projects: [], resume: true, ...body }, token),
      taskEvent: (id: string, body: unknown) => call("POST", `/device/tasks/${id}/events`, body, token),
    };
  }
  const send = (text: string, session = SESSION) => call("POST", `/ui/sessions/${session}/messages`, { text });
  const tick = (ms: number) => {
    nowMs += ms;
  };
  const timeline = async (session = SESSION) => (await call("GET", `/ui/sessions/${session}/timeline`)).body;
  return { store, notices, call, pair, send, tick, timeline };
}

const afterThreshold = LIMITS.message.resumeAfterMs + 1000;

test("no convierte antes del umbral; pasado el umbral con la sesión quieta crea una tarea de retomar", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop(); // sesión 'esperando'
  const sent = await t.send("Sí hazlo");
  assert.equal(sent.status, 201);

  t.tick(30_000);
  assert.equal((await d.next()).body.task, null, "aún no pasan 60 s");
  assert.equal([...t.store.messages.values()][0]!.status, "en_cola");

  t.tick(31_000);
  const res = await d.next();
  assert.equal(res.body.task.kind, "resume");
  assert.equal(res.body.task.prompt, "Sí hazlo");
  assert.deepEqual(res.body.task.resume, { session_id: SESSION, cwd: "~\\finapp" });
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "retomando");
  assert.equal(m.resume_task_id, res.body.task.id);
  assert.equal([...t.store.tasks.values()][0]!.status, "ejecutando");
});

test("con la sesión trabajando no se convierte: sigue esperando al Stop", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start(); // trabajando
  await t.send("hola");
  t.tick(10 * 60_000);
  assert.equal((await d.next()).body.task, null);
  assert.equal([...t.store.messages.values()][0]!.status, "en_cola");
  // Cuando Claude termina el turno, el Stop lo entrega como siempre.
  await d.stop();
  assert.equal((await d.claim()).body.message.text, "hola");
});

test("una sesión terminada también se retoma", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await d.next(); // el runner da señal
  await d.end();
  assert.equal((await t.send("sigue")).status, 201, "con runner conectado se acepta aunque la sesión esté cerrada");
  t.tick(afterThreshold);
  assert.equal((await d.next()).body.task.resume.session_id, SESSION);
});

test("una sesión cerrada sin runner conectado sigue rechazando mensajes", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await d.end();
  assert.equal((await t.send("hola")).status, 409);
});

test("una sola entrega: si el Stop reclamó primero, el runner no lo retoma; si el runner reclamó primero, el Stop no lo ve", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("uno");
  t.tick(afterThreshold);
  const claimed = await d.claim(); // el Stop gana
  assert.equal(claimed.body.message.text, "uno");
  assert.equal((await d.next()).body.task, null, "entregando: el runner no lo toca");
  await d.ack(claimed.body.message.id);
  assert.equal((await d.next()).body.task, null);

  await d.stop(); // Claude termina el turno y queda quieto
  await t.send("dos");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  assert.equal(task.prompt, "dos");
  assert.equal((await d.claim()).body.message, null, "retomando: el Stop ya no lo ve");
});

test("carrera simultánea Stop vs runner: exactamente una vía entrega el mensaje", async () => {
  for (let i = 0; i < 20; i++) {
    const t = setup();
    const d = await t.pair();
    await d.stop();
    await t.send("carrera");
    t.tick(afterThreshold);
    const [stop, runner] = await Promise.all([d.claim(), d.next()]);
    const viaStop = stop.body.message !== null;
    const viaRunner = runner.body.task !== null;
    assert.equal(Number(viaStop) + Number(viaRunner), 1, `iteración ${i}: Stop=${viaStop} runner=${viaRunner}`);
  }
});

test("varios mensajes de la misma sesión viajan juntos y en orden en una sola tarea", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("primero");
  t.tick(5_000);
  await t.send("segundo");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  assert.equal(task.prompt, "primero\n\nsegundo");
  assert.equal(t.store.tasks.size, 1);
  assert.ok([...t.store.messages.values()].every((m) => m.status === "retomando" && m.resume_task_id === task.id));
});

test("solo los mensajes que ya pasaron el umbral se convierten", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("viejo");
  t.tick(afterThreshold);
  await t.send("nuevo");
  const task = (await d.next()).body.task;
  assert.equal(task.prompt, "viejo");
  assert.deepEqual([...t.store.messages.values()].map((m) => m.status), ["retomando", "en_cola"]);
});

test("un runner anterior a 014 (no declara resume) nunca recibe tareas de retomar", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(10 * 60_000);
  assert.equal((await t.call("POST", "/device/tasks/next", { projects: [] }, d.token)).body.task, null);
  assert.equal([...t.store.messages.values()][0]!.status, "en_cola", "sigue esperando al Stop, como antes");
});

test("el runner puede pedir otro umbral (con mínimo) o apagar el retomar", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(25_000);
  assert.equal((await d.next({ resume: false })).body.task, null, "resume:false lo apaga");
  assert.equal((await d.next({ resume_after_seconds: 1 })).body.task.prompt, "hola", "1 s se sube al mínimo (20 s), ya pasaron 25");
});

test("no convierte si el dispositivo ya está ejecutando una tarea", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "otra" }).catch(() => {});
  // Una tarea en marcha: se simula reclamándola directamente.
  await t.store.insertTask({ task_id: crypto.randomUUID(), user_id: DAVID, device_id: d.id, project: "finapp", prompt: "x", created_at: new Date(START).toISOString(), expires_at: new Date(START + 3_600_000).toISOString() });
  await d.next({ projects: ["finapp"] });
  await t.send("hola");
  t.tick(afterThreshold);
  assert.equal((await d.next()).body.task, null);
  assert.equal([...t.store.messages.values()][0]!.status, "en_cola");
});

test("la sesión de otro dispositivo no se retoma desde este runner", async () => {
  const t = setup();
  const a = await t.pair();
  const b = await t.pair();
  await a.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  assert.equal((await b.next()).body.task, null);
  assert.equal((await a.next()).body.task.prompt, "hola");
});

test("termina bien: mensaje entregado por el runner, sesión nueva enlazada, push al chat nuevo y línea de tiempo", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("Sí hazlo");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;

  // El runner aviso inicio y progreso con el id de la sesión nueva (bifurcada).
  assert.equal((await d.taskEvent(task.id, { type: "start" })).status, 200);
  await d.taskEvent(task.id, { type: "progress", message: "Claude: trabajando", session_id: NEW_SESSION });
  const nueva = await t.store.getSession(DAVID, NEW_SESSION);
  assert.equal(nueva!.continued_from, SESSION);
  assert.equal(nueva!.project, "finapp");

  // Un evento de los hooks de la sesión nueva no borra el enlace.
  await d.ev("stop", NEW_SESSION, { message: "Hecho" });
  assert.equal((await t.store.getSession(DAVID, NEW_SESSION))!.continued_from, SESSION);

  await d.taskEvent(task.id, { type: "finish", outcome: "terminada", session_id: NEW_SESSION, result: "Hecho" });
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "entregado");
  assert.ok(m.delivered_at);
  assert.equal(t.notices.at(-1)!.url, `/claude/s/${NEW_SESSION}`);
  assert.match(t.notices.at(-1)!.title, /retomó/);

  const original = await t.timeline(SESSION);
  const sent = original.items.find((i: Json) => i.type === "user" && i.source === "phone");
  assert.equal(sent.delivery, "entregado");
  assert.equal(sent.continuation, NEW_SESSION);

  const cont = await t.timeline(NEW_SESSION);
  assert.deepEqual(cont.continued_from, { id: SESSION, project: "finapp" });
  const shown = cont.items.find((i: Json) => i.type === "user");
  assert.equal(shown.text, "Sí hazlo", "la continuación muestra el mensaje que la originó");
  assert.equal(cont.items.filter((i: Json) => i.type === "user" && i.source === "task").length, 0, "no se repite como encargo de tarea");
});

test("rechazada en la laptop: el mensaje queda 'no_retomado' con el motivo y se avisa; no se reentrega", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  await d.taskEvent(task.id, { type: "finish", outcome: "rechazada", error: "proyecto no autorizado en la laptop" });
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "no_retomado");
  assert.equal(m.error, "proyecto no autorizado en la laptop");
  assert.equal(t.notices.at(-1)!.url, `/claude/s/${SESSION}`);
  assert.match(t.notices.at(-1)!.title, /No se pudo retomar/);
  const item = (await t.timeline()).items.find((i: Json) => i.type === "user" && i.source === "phone");
  assert.equal(item.delivery, "no_retomado");
  assert.equal(item.note, "proyecto no autorizado en la laptop");
  t.tick(afterThreshold);
  assert.equal((await d.next()).body.task, null);
  assert.equal((await d.claim()).body.message, null);
});

test("un runner que deja de dar latido marca el mensaje 'no_retomado'", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  await d.next();
  t.tick(LIMITS.task.staleMs + 1000);
  await t.call("GET", "/ui/overview"); // el barrido corre al mirar
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "no_retomado");
  assert.match(m.error ?? "", /runner/);
});

test("cancelar la tarea de retomar desde el celular: el mensaje queda 'no_retomado'", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  assert.equal((await t.call("POST", `/ui/tasks/${task.id}/cancel`)).status, 200);
  assert.equal((await d.taskEvent(task.id, { type: "progress" })).body.cancel_requested, true);
  await d.taskEvent(task.id, { type: "finish", outcome: "cancelada" });
  assert.equal([...t.store.messages.values()][0]!.status, "no_retomado");
});

test("la línea de tiempo dice por qué un mensaje sigue en cola", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await t.send("a");
  const hint = async () => (await t.timeline()).items.find((i: Json) => i.type === "user" && i.source === "phone").queue;
  assert.equal(await hint(), "turn", "Claude trabaja: espera al Stop");
  await d.stop();
  assert.equal(await hint(), "idle_no_runner", "quieto y sin runner");
  await d.next();
  assert.equal(await hint(), "idle_runner", "quieto y con runner conectado");
});

test("la vista general expone el estado y el motivo de los mensajes, sin texto", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("secreto-privado");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  await d.taskEvent(task.id, { type: "finish", outcome: "rechazada", error: "proyecto no autorizado en la laptop" });
  const o = (await t.call("GET", "/ui/overview")).body;
  assert.equal(o.messages[0].status, "no_retomado");
  assert.equal(o.messages[0].error, "proyecto no autorizado en la laptop");
  assert.equal(JSON.stringify(o.messages).includes("secreto-privado"), false);
});

// --- Revisión: carrera real, huérfanos, fallida parcial y cwd ----------------------------------------------------------------

// Simula la carrera: el hook Stop reclama el mensaje DESPUÉS de que la conversión lo listó y ANTES de que lo reclame el runner.
class RacyStore extends MemoryStore {
  override async listStalledMessages(userId: string, deviceId: string, olderThanIso: string, nowIso: string, limit: number) {
    const rows = await super.listStalledMessages(userId, deviceId, olderThanIso, nowIso, limit);
    for (const m of rows) await this.claimNextMessage(userId, m.session_id, nowIso); // el Stop gana
    return rows;
  }
}

test("carrera: si el Stop reclama entre el listado y el reclamo del runner, la conversión NO crea tarea ni toca el mensaje", async () => {
  const t = setup(() => new RacyStore());
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  assert.equal((await d.next()).body.task, null);
  assert.equal(t.store.tasks.size, 0, "ninguna tarea para un mensaje que ya entrega el Stop");
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "entregando");
  assert.equal(m.resume_task_id, null);
});

test("huérfano: si la función murió entre el reclamo y la tarea, el mensaje vuelve a la cola pasado el plazo (no antes) y se retoma una sola vez", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  const m = [...t.store.messages.values()][0]!;
  t.tick(afterThreshold);
  const ghost = crypto.randomUUID();
  assert.equal(await t.store.claimMessageForResume(DAVID, m.message_id, ghost, new Date(START + afterThreshold).toISOString()), true);
  // dentro del plazo del reclamo: no se toca (la tarea podría estar a punto de crearse)
  t.tick(10_000);
  await t.call("GET", `/ui/sessions/${SESSION}/timeline`);
  assert.equal(m.status, "retomando");
  // pasado el plazo y sin tarea: vuelve a la cola con su texto, y el siguiente pedido del runner la retoma con una tarea real
  t.tick(LIMITS.message.claimTtlMs);
  const tl = await t.call("GET", `/ui/sessions/${SESSION}/timeline`);
  const item = tl.body.items.find((i: Json) => i.type === "user" && i.source === "phone");
  assert.equal(item.delivery, "en_cola");
  assert.equal(m.body, "hola");
  assert.equal(m.resume_task_id, null);
  const task = (await d.next()).body.task;
  assert.equal(task.prompt, "hola");
  assert.equal(t.store.tasks.size, 1);
  assert.equal(m.status, "retomando");
  assert.equal(m.resume_task_id, task.id);
});

test("laptop que nunca vuelve: al mirar el chat (no solo la vista general) la tarea vencida liquida el mensaje", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("hola");
  t.tick(afterThreshold);
  await d.next(); // tarea 'ejecutando' y la laptop desaparece
  t.tick(LIMITS.task.staleMs + 1000);
  const item = (await t.timeline()).items.find((i: Json) => i.type === "user" && i.source === "phone");
  assert.equal(item.delivery, "no_retomado");
  assert.match(item.note, /runner/);
});

test("fallida parcial: si la continuación llegó a abrirse, Claude sí leyó el mensaje: entregado con el error y enlace, no 'no se pudo retomar'", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("sigue");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  await d.taskEvent(task.id, { type: "progress", message: "Claude: trabajando", session_id: NEW_SESSION });
  await d.taskEvent(task.id, { type: "finish", outcome: "fallida", session_id: NEW_SESSION, error: "Claude terminó con error: error_max_turns" });
  const m = [...t.store.messages.values()][0]!;
  assert.equal(m.status, "entregado");
  assert.match(m.error ?? "", /error_max_turns/);
  assert.match(t.notices.at(-1)!.title, /con error/);
  assert.equal(t.notices.at(-1)!.url, `/claude/s/${NEW_SESSION}`);
  const item = (await t.timeline()).items.find((i: Json) => i.type === "user" && i.source === "phone");
  assert.deepEqual([item.delivery, item.continuation, /error_max_turns/.test(item.note)], ["entregado", NEW_SESSION, true]);
});

test("fallida sin sesión nueva (no llegó a abrirse) sigue siendo 'no_retomado'", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  await t.send("sigue");
  t.tick(afterThreshold);
  const task = (await d.next()).body.task;
  await d.taskEvent(task.id, { type: "finish", outcome: "fallida", error: "No se pudo iniciar claude (ENOENT)" });
  assert.equal([...t.store.messages.values()][0]!.status, "no_retomado");
});

test("cwd: se retoma desde la carpeta donde NACIÓ la sesión aunque después hiciera cd", async () => {
  const t = setup();
  const d = await t.pair();
  await d.ev("session_start", SESSION, { cwd: "~\\finapp" });
  await d.ev("stop", SESSION, { cwd: "~\\finapp\\apps\\web", message: "listo" });
  assert.equal((await t.store.getSession(DAVID, SESSION))!.cwd, "~\\finapp\\apps\\web", "cwd sigue al último evento");
  await t.send("hola");
  t.tick(afterThreshold);
  assert.deepEqual((await d.next()).body.task.resume, { session_id: SESSION, cwd: "~\\finapp" });
});
