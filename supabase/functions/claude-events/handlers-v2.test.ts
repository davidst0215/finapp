// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/handlers-v2.test.ts
// Contrato v2 (SPEC-claude-code-v2.md): escribirle a una sesión (mensajes) y lanzar tareas (runner).
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

// deno-lint-ignore no-explicit-any
type Json = any;

function setup(opts: { ownerId?: string | null } = {}) {
  const store = new MemoryStore();
  let nowMs = START;
  store.clock = () => new Date(nowMs).toISOString();
  const notices: Notice[] = [];
  const state = { user: DAVID as string | null };
  const deps: ApiDeps = {
    store,
    now: () => new Date(nowMs),
    notify: async (_userId, notice) => {
      notices.push(notice);
    },
    authenticateUser: async () => (state.user ? { userId: state.user } : null),
    randomUUID: () => crypto.randomUUID(),
    publicUrl: BASE_URL,
    ownerId: opts.ownerId === undefined ? DAVID : opts.ownerId,
  };
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers = new Headers();
    if (token) headers.set("x-wabid-device-token", token);
    const res = await handleApi({ method, path: `/claude-events${path}`, headers, body: body === undefined ? "" : JSON.stringify(body) }, deps);
    return res as { status: number; body: Json };
  };
  async function pair() {
    const res = await call("POST", "/ui/devices", { name: "Laptop" });
    assert.equal(res.status, 201);
    const token = res.body.token as string;
    return {
      id: res.body.device.id as string,
      token,
      stop: (session = SESSION) => call("POST", "/device/events", { type: "stop", session_id: session, project: "finapp", message: "listo" }, token),
      start: (session = SESSION) => call("POST", "/device/events", { type: "session_start", session_id: session, project: "finapp" }, token),
      ack: (id: string) => call("POST", `/device/messages/${id}/ack`, {}, token),
      claim: (session = SESSION) => call("POST", `/device/sessions/${session}/messages/next`, {}, token),
      next: (projects: string[]) => call("POST", "/device/tasks/next", { projects }, token),
      taskEvent: (id: string, body: unknown) => call("POST", `/device/tasks/${id}/events`, body, token),
    };
  }
  const tick = (ms: number) => {
    nowMs += ms;
  };
  return { store, notices, state, call, pair, tick };
}

// --- Mensajes ---------------------------------------------------------------------------------------------------

test("el evento stop responde si el modo ausente está activo", async () => {
  const t = setup();
  const d = await t.pair();
  assert.deepEqual((await d.stop()).body, { ok: true, away: false });
  assert.equal((await t.call("PATCH", `/ui/devices/${d.id}`, { approvals_enabled: true })).status, 200);
  assert.deepEqual((await d.stop()).body, { ok: true, away: true });
});

test("un mensaje se entrega una sola vez, en orden, y su texto se borra", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  const m1 = await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "  sigue con la migración  " });
  assert.equal(m1.status, 201);
  assert.equal(m1.body.message.status, "en_cola");
  assert.equal("text" in m1.body.message || "body" in m1.body.message, false, "la vista nunca trae el texto");
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "y luego los tests" });

  const a = await d.claim();
  assert.equal(a.body.message.text, "sigue con la migración");
  assert.equal((await d.claim()).body.message.text, "y luego los tests");
  assert.equal((await d.claim()).body.message, null);

  // Fase 1 hecha: reclamados, el texto sigue hasta que el hook confirme.
  const rows = [...t.store.messages.values()];
  assert.ok(rows.every((m) => m.status === "entregando" && m.body !== null));
  for (const m of rows) assert.equal((await d.ack(m.message_id)).status, 200);
  assert.ok([...t.store.messages.values()].every((m) => m.status === "entregado" && m.body === null), "sin texto tras el ack");
  assert.equal(JSON.stringify((await t.call("GET", "/ui/overview")).body).includes("migración"), false);
});

test("sin ack, el mensaje vuelve a la cola a los 60 s y se entrega de nuevo; con ack no", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" });
  const first = await d.claim();
  assert.equal(first.body.message.text, "hola");
  t.tick(30_000);
  assert.equal((await d.claim()).body.message, null, "aún dentro del plazo de confirmación");
  t.tick(31_000);
  const again = await d.claim();
  assert.equal(again.body.message.text, "hola", "el hook murió antes de entregar: se reentrega");
  assert.equal((await d.ack(again.body.message.id)).status, 200);
  t.tick(120_000);
  assert.equal((await d.claim()).body.message, null);
  assert.equal((await d.ack(again.body.message.id)).status, 404, "ack repetido");
});

test("el ack exige el dispositivo dueño y una sesión propia", async () => {
  const t = setup();
  const a = await t.pair();
  const b = await t.pair();
  await a.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" });
  const id = (await a.claim()).body.message.id;
  assert.equal((await b.ack(id)).status, 404);
  assert.equal((await t.call("POST", `/device/messages/${id}/ack`, {})).status, 401);
  assert.equal((await a.ack(id)).status, 200);
});

test("el estado 'entregando' se ve en el overview y no trae texto", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "texto privado" });
  await d.claim();
  const o = (await t.call("GET", "/ui/overview")).body;
  assert.equal(o.messages[0].status, "entregando");
  assert.equal(JSON.stringify(o).includes("texto privado"), false);
});

test("retención: al terminar una tarea el prompt queda como resumen redactado y el resultado recortado", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
  const prompt = `usa la llave ${secret} y ` + "x".repeat(3000);
  const task = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt })).body.task;
  await d.next(["finapp"]);
  assert.equal((await t.store.findTask(DAVID, task.id))!.prompt.length, prompt.length, "completo mientras corre");
  await d.taskEvent(task.id, { type: "finish", outcome: "terminada", result: "r".repeat(3000) });
  const row = (await t.store.findTask(DAVID, task.id))!;
  assert.ok(row.prompt.length <= LIMITS.task.promptSummaryMax);
  assert.ok(!row.prompt.includes("sk-ant"));
  assert.ok(row.result!.length < 700);
});

test("cancelar una tarea en cola también reduce su prompt", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const task = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "y".repeat(500) })).body.task;
  await t.call("POST", `/ui/tasks/${task.id}/cancel`);
  assert.ok((await t.store.findTask(DAVID, task.id))!.prompt.length <= LIMITS.task.promptSummaryMax);
});

test("entregar un mensaje devuelve la sesión a 'trabajando'", async () => {
  const t = setup();
  const d = await t.pair();
  await d.stop();
  assert.equal((await t.store.getSession(DAVID, SESSION))!.status, "esperando");
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" });
  await d.claim();
  assert.equal((await t.store.getSession(DAVID, SESSION))!.status, "trabajando");
});

test("un mensaje vence a las 6 h y entonces no se entrega ni conserva el texto", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" });
  t.tick(LIMITS.message.ttlMs + 1000);
  assert.equal((await d.claim()).body.message, null);
  const overview = (await t.call("GET", "/ui/overview")).body;
  assert.equal(overview.messages[0].status, "vencido");
  assert.equal([...t.store.messages.values()][0]!.body, null);
});

test("validación de mensajes: vacío, largo, sesión ajena o terminada", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  const send = (text: unknown, session = SESSION) => t.call("POST", `/ui/sessions/${session}/messages`, { text });
  assert.equal((await send("")).status, 400);
  assert.equal((await send("   ")).status, 400);
  assert.equal((await send(5)).status, 400);
  assert.equal((await send("x".repeat(2001))).status, 400);
  assert.equal((await send("x".repeat(2000))).status, 201);
  assert.equal((await send("hola", "no-existe")).status, 404);
  for (let i = 0; i < LIMITS.message.maxQueuedPerSession; i++) await send("otro");
  assert.equal((await send("uno más")).status, 429);
  await t.call("POST", "/device/events", { type: "session_end", session_id: SESSION }, d.token);
  assert.equal((await send("tarde")).status, 409);
});

test("mensajes: solo el dueño (WABID_OWNER_ID); sin configurar falla cerrado", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  t.state.user = "otro-usuario";
  assert.equal((await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" })).status, 403);
  const closed = setup({ ownerId: null });
  const d2 = await closed.pair();
  await d2.start();
  assert.equal((await closed.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "hola" })).status, 503);
});

test("otro dispositivo no puede reclamar los mensajes de una sesión ajena", async () => {
  const t = setup();
  const a = await t.pair();
  const b = await t.pair();
  await a.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "secreto" });
  assert.equal((await b.claim()).status, 404);
  assert.equal((await a.claim()).body.message.text, "secreto");
});

test("reclamar sin token o con un token inválido → 401", async () => {
  const t = setup();
  assert.equal((await t.call("POST", `/device/sessions/${SESSION}/messages/next`, {})).status, 401);
});

test("dos reclamos simultáneos entregan el mensaje una sola vez", async () => {
  const t = setup();
  const d = await t.pair();
  await d.start();
  await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "uno" });
  const [x, y] = await Promise.all([d.claim(), d.claim()]);
  assert.equal([x, y].filter((r) => r.body.message !== null).length, 1);
});

// --- Tareas -----------------------------------------------------------------------------------------------------

test("crear una tarea exige proyecto reportado por un runner conectado", async () => {
  const t = setup();
  const d = await t.pair();
  const create = (project: string, prompt = "haz algo") => t.call("POST", "/ui/tasks", { project, prompt });
  assert.equal((await create("finapp")).status, 409, "ningún runner ha reportado proyectos");
  await d.next(["finapp", "vera"]);
  assert.equal((await create("otro")).status, 409, "fuera de la lista");
  assert.equal((await create("../etc")).status, 400);
  assert.equal((await create("finapp", "")).status, 400);
  assert.equal((await create("finapp", "x".repeat(4001))).status, 400);
  const ok = await create("finapp", "x".repeat(4000));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.task.status, "en_cola");
  t.tick(LIMITS.task.queueTtlMs / 4);
  assert.equal((await create("finapp")).status, 409, "el runner dejó de dar señal");
});

test("tareas: solo el dueño", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  t.state.user = "otro-usuario";
  assert.equal((await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "x" })).status, 403);
  assert.equal((await t.call("POST", `/ui/tasks/${crypto.randomUUID()}/cancel`)).status, 403);
  const closed = setup({ ownerId: null });
  assert.equal((await closed.call("POST", "/ui/tasks", { project: "finapp", prompt: "x" })).status, 503);
});

test("ciclo completo: en cola → reclamada → avance → fin con aviso", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const created = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "arregla el build" })).body.task;

  const next = await d.next(["finapp"]);
  assert.deepEqual(next.body.task, { id: created.id, project: "finapp", prompt: "arregla el build" });
  assert.equal((await d.next(["finapp"])).body.task, null, "no hay más en cola");

  t.tick(5000);
  const start = await d.taskEvent(created.id, { type: "start", session_id: "abc-123" });
  assert.deepEqual(start.body, { ok: true, cancel_requested: false });
  await d.taskEvent(created.id, { type: "progress", message: "Usa Bash: npm run build con token sk-ant-api03-abcdefghijklmnopqrstuvwxyz" });
  let row = (await t.store.findTask(DAVID, created.id))!;
  assert.equal(row.session_id, "abc-123");
  assert.ok(row.progress!.includes("[oculto]") && !row.progress!.includes("sk-ant"), "el avance se redacta también en el servidor");

  t.tick(60_000);
  const fin = await d.taskEvent(created.id, { type: "finish", outcome: "terminada", result: "Listo, el build pasa." });
  assert.deepEqual(fin.body, { ok: true, cancel_requested: false });
  row = (await t.store.findTask(DAVID, created.id))!;
  assert.equal(row.status, "terminada");
  assert.equal(row.result, "Listo, el build pasa.");
  assert.ok(row.finished_at);
  assert.equal(t.notices.length, 1);
  assert.deepEqual({ kind: t.notices[0]!.kind, url: t.notices[0]!.url }, { kind: "claude", url: "/claude" });
  assert.match(t.notices[0]!.title, /Tarea terminada · finapp/);

  assert.equal((await d.taskEvent(created.id, { type: "progress", message: "tarde" })).body.cancel_requested, true, "ya no está ejecutándose: el runner debe parar");
});

test("una tarea a la vez por dispositivo", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "uno" });
  await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "dos" });
  assert.equal((await d.next(["finapp"])).body.task.prompt, "uno");
  assert.equal((await d.next(["finapp"])).body.task, null, "la primera sigue ejecutándose");
});

test("cancelar: en cola al instante; ejecutándose se avisa por el latido", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const a = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "uno" })).body.task;
  const cancelled = await t.call("POST", `/ui/tasks/${a.id}/cancel`);
  assert.equal(cancelled.body.task.status, "cancelada");
  assert.equal((await d.next(["finapp"])).body.task, null, "una cancelada no se reclama");

  const b = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "dos" })).body.task;
  await d.next(["finapp"]);
  const running = await t.call("POST", `/ui/tasks/${b.id}/cancel`);
  assert.equal(running.body.task.status, "ejecutando");
  assert.equal(running.body.task.cancel_requested, true);
  assert.equal((await d.taskEvent(b.id, { type: "progress", message: "..." })).body.cancel_requested, true);
  await d.taskEvent(b.id, { type: "finish", outcome: "cancelada" });
  assert.equal((await t.store.findTask(DAVID, b.id))!.status, "cancelada");
  assert.equal(t.notices.length, 0, "cancelar no avisa");
  assert.equal((await t.call("POST", `/ui/tasks/${b.id}/cancel`)).status, 409);
});

test("una tarea sin latido del runner se da por fallida; una en cola que nadie reclama vence", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const a = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "uno" })).body.task;
  await d.next(["finapp"]);
  t.tick(LIMITS.task.staleMs + 1000);
  const overview = (await t.call("GET", "/ui/overview")).body;
  assert.equal(overview.tasks.find((x: Json) => x.id === a.id).status, "fallida");

  await d.next(["finapp"]);
  const b = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "dos" })).body.task;
  t.tick(LIMITS.task.queueTtlMs + 1000);
  const later = (await t.call("GET", "/ui/overview")).body;
  assert.equal(later.tasks.find((x: Json) => x.id === b.id).status, "vencida");
});

test("las tareas vencidas o sin latido también pierden el prompt completo (resumen redactado)", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const long = "usa sk-ant-api03-abcdefghijklmnopqrstuvwxyz " + "z".repeat(900);
  const a = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: long })).body.task;
  await d.next(["finapp"]); // a: ejecutando
  t.tick(LIMITS.task.staleMs + 1000);
  await t.call("GET", "/ui/overview"); // a: fallida por falta de latido
  await d.next(["finapp"]);
  const b = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: long })).body.task;
  t.tick(LIMITS.task.queueTtlMs + 1000);
  await t.call("GET", "/ui/overview"); // b: vencida
  for (const id of [a.id, b.id]) {
    const row = (await t.store.findTask(DAVID, id))!;
    assert.ok(["fallida", "vencida"].includes(row.status));
    assert.ok(row.prompt.length <= LIMITS.task.promptSummaryMax, row.status);
    assert.ok(!row.prompt.includes("sk-ant"));
  }
});

test("el runner solo reporta nombres válidos y el servidor los muestra en el dispositivo", async () => {
  const t = setup();
  const d = await t.pair();
  const res = await d.next(["finapp", "C:\\Users\\Dsalg\\finapp", "ok name", 7 as unknown as string, "../x"]);
  assert.equal(res.status, 200);
  const overview = (await t.call("GET", "/ui/overview")).body;
  assert.deepEqual(overview.devices[0].runner, { projects: ["finapp", "ok name"], online: true });
  t.tick(120_000);
  assert.equal((await t.call("GET", "/ui/overview")).body.devices[0].runner.online, false);
  assert.equal((await d.next("no-es-lista" as unknown as string[])).status, 400);
});

test("un runner no toca las tareas de otro dispositivo; fin con outcome inválido se rechaza", async () => {
  const t = setup();
  const a = await t.pair();
  const b = await t.pair();
  await a.next(["finapp"]);
  const task = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "uno" })).body.task;
  await a.next(["finapp"]);
  assert.equal((await b.taskEvent(task.id, { type: "progress", message: "x" })).status, 404);
  assert.equal((await a.taskEvent(task.id, { type: "finish", outcome: "magia" })).status, 400);
  assert.equal((await a.taskEvent(task.id, { type: "otra" })).status, 400);
});

test("una tarea rechazada por la allowlist local avisa", async () => {
  const t = setup();
  const d = await t.pair();
  await d.next(["finapp"]);
  const task = (await t.call("POST", "/ui/tasks", { project: "finapp", prompt: "uno" })).body.task;
  await d.next(["finapp"]);
  await d.taskEvent(task.id, { type: "finish", outcome: "rechazada", error: "Proyecto fuera de la allowlist local" });
  assert.equal((await t.store.findTask(DAVID, task.id))!.status, "rechazada");
  assert.equal(t.notices.length, 1);
});
