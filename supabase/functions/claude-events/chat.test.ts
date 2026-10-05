// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/chat.test.ts
// 013: la sesión como chat. Línea de tiempo (pura y por HTTP), evento user_prompt, textos largos y compatibilidad con eventos viejos.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notice } from "../_shared/notify.ts";
import { mergeSession, parseDeviceEvent, summarizeEvent } from "./events.ts";
import { handleApi } from "./handlers.ts";
import type { ApiDeps } from "./handlers.ts";
import { MemoryStore } from "./memory-store.ts";
import { buildTimeline } from "./timeline.ts";
import type { ApprovalRow, EventRow, MessageRow, TaskRow } from "./types.ts";

const T0 = Date.parse("2026-10-05T15:00:00.000Z");
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const ev = (n: number, kind: EventRow["kind"], summary: string, sec: number, detail: string | null = null): EventRow => ({
  event_id: `ev${n}`, user_id: "u", session_id: "s", device_id: "d", kind, detail, summary, created_at: iso(sec),
});
const msg = (n: number, body: string | null, status: MessageRow["status"], sec: number): MessageRow => ({
  message_id: `m${n}`, user_id: "u", session_id: "s", device_id: "d", body, status, created_at: iso(sec), expires_at: iso(sec + 3600),
  claimed_at: null, delivered_at: status === "entregado" ? iso(sec + 5) : null,
});
const appr = (n: number, status: ApprovalRow["status"], sec: number): ApprovalRow => ({
  approval_id: `a${n}`, user_id: "u", device_id: "d", session_id: "s", project: "finapp", tool_name: "Bash", description: null,
  preview: "git push", preview_truncated: false, status, created_at: iso(sec), expires_at: iso(sec + 120),
  decided_at: status === "pendiente" ? null : iso(sec + 10), decided_by: null,
});
const task = (over: Partial<TaskRow>): TaskRow => ({
  task_id: "t1", user_id: "u", device_id: "d", project: "finapp", prompt: "haz esto", status: "terminada", cancel_requested: false,
  session_id: "s", progress: null, result: null, error: null, created_at: iso(0), expires_at: iso(3600), started_at: iso(1),
  updated_at: iso(9), finished_at: iso(9), ...over,
});
const build = (src: Partial<Parameters<typeof buildTimeline>[0]>, limit = 60) =>
  buildTimeline({ sessionId: "s", events: [], messages: [], approvals: [], tasks: [], nowMs: T0 + 30_000, ...src }, limit);

// --- Línea de tiempo (pura) ----------------------------------------------------------------------------------------

test("mezcla eventos, mensajes del celular y permisos en orden cronológico", () => {
  const { items } = build({
    events: [
      ev(1, "session_start", "Sesión iniciada", 0, "startup"),
      ev(2, "user_prompt", "arregla el login", 5),
      ev(3, "stop", "Listo, el login ya no falla.\nProbé con tres usuarios.", 20),
    ],
    messages: [msg(1, "ahora los tests", "entregado", 25)],
    approvals: [appr(1, "pendiente", 28)],
  });
  assert.deepEqual(items.map((i) => i.type), ["system", "user", "claude", "user", "approval"]);
  const [, laptop, reply, phone, card] = items;
  assert.deepEqual([laptop!.type === "user" && laptop.source, laptop!.type === "user" && laptop.text], ["laptop", "arregla el login"]);
  assert.equal(reply!.type === "claude" && reply.text, "Listo, el login ya no falla.\nProbé con tres usuarios.", "conserva los saltos de línea");
  assert.deepEqual([phone!.type === "user" && phone.source, phone!.type === "user" && phone.delivery], ["phone", "entregado"]);
  assert.equal(card!.type === "approval" && card.approval.status, "pendiente");
  assert.equal(card!.type === "approval" && card.approval.expires_in_ms, 118_000, "relativo al momento de la consulta");
});

test("devuelve los últimos N y avisa que hay más atrás", () => {
  const events = Array.from({ length: 10 }, (_, i) => ev(i, "stop", `respuesta ${i}`, i));
  const r = build({ events: events.slice(-4) }, 4);
  assert.equal(r.items.length, 4);
  assert.equal(r.hasMore, true, "la fuente llegó al tope: puede haber más");
  assert.equal(build({ events: events.slice(-3) }, 4).hasMore, false);
  const last = build({ events }, 3);
  assert.deepEqual(last.items.map((i) => i.type === "claude" && i.text), ["respuesta 7", "respuesta 8", "respuesta 9"]);
});

test("un mismo instante: lo que David dijo va antes que la respuesta", () => {
  const { items } = build({ events: [ev(1, "stop", "hecho", 5), ev(2, "user_prompt", "haz", 5)] });
  assert.deepEqual(items.map((i) => i.type), ["user", "claude"]);
});

test("compatibilidad: eventos anteriores a 013 (sin user_prompt, resúmenes de una línea) se pintan igual", () => {
  const { items } = build({
    events: [
      ev(1, "session_start", "Sesión iniciada", 0),
      ev(2, "stop", "Terminó de responder", 5),
      ev(3, "stop", "Listo, actualicé los archivos.", 10),
      ev(4, "notification", "Claude is waiting for your input", 12, "idle_prompt"),
      ev(5, "notification", "Algo inesperado", 13, "otro"),
      ev(6, "stop_failure", "Falló (rate_limit): 429", 14, "rate_limit"),
    ],
    messages: [msg(1, null, "entregado", 11)],
  });
  const view = items.map((i) => (i.type === "system" ? `sistema:${i.text}` : i.type === "claude" ? `${i.tone}:${i.text}` : `user:${i.type === "user" ? i.text : ""}`));
  assert.deepEqual(view, [
    "sistema:Sesión iniciada",
    "sistema:Claude terminó",
    "reply:Listo, actualicé los archivos.",
    "user:null",
    "sistema:Claude te espera",
    "notice:Algo inesperado",
    "error:Falló (rate_limit): 429",
  ]);
});

test("un permiso con tarjeta no repite su evento; sin tarjeta queda el aviso", () => {
  const a = appr(1, "aprobada", 3);
  const conTarjeta = build({ events: [ev(1, "permission_request", "Bash: git push", 3)], approvals: [a] });
  assert.deepEqual(conTarjeta.items.map((i) => i.type), ["approval"]);
  const sinTarjeta = build({ events: [ev(1, "permission_request", "Bash: git push", 3)] });
  assert.deepEqual(sinTarjeta.items.map((i) => i.type === "system" && i.text), ["Pidió permiso en la terminal: Bash: git push"]);
});

test("la tarea que abrió la sesión aparece como mensaje 'tarea' y chips; las de otras sesiones no", () => {
  const { items } = build({
    tasks: [task({}), task({ task_id: "t2", session_id: "otra" }), task({ task_id: "t3", session_id: null })],
  });
  assert.deepEqual(items.map((i) => (i.type === "user" ? `user:${i.source}:${i.text}` : i.type === "system" ? i.text : "")), [
    "user:task:haz esto",
    "Tarea iniciada",
    "Tarea terminada",
  ]);
  const fallida = build({ tasks: [task({ status: "fallida", error: "El runner dejó de responder" })] }).items.at(-1);
  assert.equal(fallida!.type === "system" && fallida.text, "Tarea falló: El runner dejó de responder");
});

test("los secretos que David escribió no salen en el chat", () => {
  const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
  const { items } = build({ events: [ev(1, "user_prompt", `usa ${key}`, 1)], messages: [msg(1, `y también ${key}`, "en_cola", 2)] });
  assert.ok(!JSON.stringify(items).includes("sk-ant"));
});

// --- Evento user_prompt y textos largos --------------------------------------------------------------------------------

const parse = (b: Record<string, unknown>) => {
  const r = parseDeviceEvent({ session_id: "s", ...b });
  assert.ok(r.ok, JSON.stringify(r));
  return r.event;
};

test("user_prompt: se acepta, conserva saltos de línea, redacta y recorta a ~2000", () => {
  const e = parse({ type: "user_prompt", message: "hola\nsegundo renglón con token=abcd1234efgh" });
  assert.equal(e.type, "user_prompt");
  assert.ok(e.message.includes("\n"));
  assert.ok(!e.message.includes("abcd1234efgh"));
  const long = parse({ type: "user_prompt", message: "x".repeat(5000) });
  assert.ok(long.message.length <= 2000, `largo ${long.message.length}`);
  assert.equal(summarizeEvent(e), e.message);
  assert.equal(summarizeEvent(parse({ type: "user_prompt" })), "Mensaje");
});

test("stop: la respuesta sube de 300 a ~2000 caracteres; los demás mensajes siguen en una línea de 300", () => {
  assert.ok(parse({ type: "stop", message: "a".repeat(1500) }).message.length >= 1500);
  assert.ok(parse({ type: "stop", message: "a".repeat(9000) }).message.length <= 2000);
  const noti = parse({ type: "notification", detail: "idle_prompt", message: "b".repeat(900) + "\nlinea" });
  assert.ok(noti.message.length <= 300 && !noti.message.includes("\n"));
});

test("la sesión guarda quién habló último y una vista previa de una línea (≤ 300)", () => {
  const ctx = { userId: "u", deviceId: "d", atIso: iso(1) };
  const longReply = "Primera línea.\n" + "y".repeat(1500);
  const afterReply = mergeSession(null, parse({ type: "stop", message: longReply }), { ...ctx, summary: longReply });
  assert.equal(afterReply.last_role, "claude");
  assert.ok(afterReply.last_summary!.length <= 300 && !afterReply.last_summary!.includes("\n"));
  const afterPrompt = mergeSession(afterReply, parse({ type: "user_prompt", message: "sigue" }), { ...ctx, summary: "sigue" });
  assert.deepEqual([afterPrompt.last_role, afterPrompt.last_summary, afterPrompt.status], ["usuario", "sigue", "trabajando"]);
  const afterNotice = mergeSession(afterPrompt, parse({ type: "notification", detail: "x" }), { ...ctx, summary: "n" });
  assert.deepEqual([afterNotice.last_role, afterNotice.last_summary], ["usuario", "sigue"], "un aviso no cambia la vista previa");
});

// --- HTTP ---------------------------------------------------------------------------------------------------------------

const DAVID = "david";
const SESSION = "sess-chat-1";

function setup(opts: { ownerId?: string | null } = {}) {
  const store = new MemoryStore();
  let nowMs = T0;
  store.clock = () => new Date(nowMs).toISOString();
  const notices: Notice[] = [];
  const state = { user: DAVID as string | null };
  const deps: ApiDeps = {
    store, now: () => new Date(nowMs), notify: async (_u, n) => { notices.push(n); },
    authenticateUser: async () => (state.user ? { userId: state.user } : null),
    randomUUID: () => crypto.randomUUID(), publicUrl: "https://x.supabase.co/functions/v1/claude-events",
    ownerId: opts.ownerId === undefined ? DAVID : opts.ownerId,
  };
  // deno-lint-ignore no-explicit-any
  const call = async (method: string, path: string, body?: unknown, token?: string, query = ""): Promise<{ status: number; body: any }> => {
    const headers = new Headers();
    if (token) headers.set("x-wabid-device-token", token);
    return await handleApi({ method, path: `/claude-events${path}`, query, headers, body: body === undefined ? "" : JSON.stringify(body) }, deps);
  };
  const tick = (ms: number) => { nowMs += ms; };
  return { store, state, call, tick };
}

async function pair(t: ReturnType<typeof setup>) {
  const res = await t.call("POST", "/ui/devices", { name: "Laptop" });
  const token = res.body.token as string;
  const event = (e: Record<string, unknown>) => t.call("POST", "/device/events", { session_id: SESSION, project: "finapp", ...e }, token);
  return { id: res.body.device.id as string, token, event };
}

test("timeline por HTTP: conversación completa, el texto del celular sigue tras la entrega, y solo el dueño la ve", async () => {
  const t = setup();
  const d = await pair(t);
  await d.event({ type: "session_start", detail: "startup" });
  t.tick(1000);
  assert.equal((await d.event({ type: "user_prompt", message: "revisa el login" })).status, 200);
  t.tick(1000);
  assert.equal((await d.event({ type: "stop", message: "Revisé el login.\nTodo bien." })).status, 200);
  t.tick(1000);
  const sent = await t.call("POST", `/ui/sessions/${SESSION}/messages`, { text: "ahora los tests" });
  assert.equal(sent.status, 201);
  const claimed = await t.call("POST", `/device/sessions/${SESSION}/messages/next`, {}, d.token);
  await t.call("POST", `/device/messages/${claimed.body.message.id}/ack`, {}, d.token);

  const r = await t.call("GET", `/ui/sessions/${SESSION}/timeline`);
  assert.equal(r.status, 200);
  assert.equal(r.body.has_more, false);
  const kinds = r.body.items.map((i: { type: string; source?: string }) => (i.source ? `${i.type}:${i.source}` : i.type));
  assert.deepEqual(kinds, ["system", "user:laptop", "claude", "user:phone"]);
  assert.equal(r.body.items[3].text, "ahora los tests");
  assert.equal(r.body.items[3].delivery, "entregado");
  assert.equal(JSON.stringify(r.body).includes("token_hash"), false);

  t.state.user = "otro";
  assert.equal((await t.call("GET", `/ui/sessions/${SESSION}/timeline`)).status, 403, "otro usuario no lee el chat");
  t.state.user = null;
  assert.equal((await t.call("GET", `/ui/sessions/${SESSION}/timeline`)).status, 401);
  assert.equal((await setup({ ownerId: null }).call("GET", `/ui/sessions/${SESSION}/timeline`)).status, 503, "sin WABID_OWNER_ID falla cerrado");
});

test("timeline: limit con tope, sesión inexistente = 404, y un permiso vencido ya no figura como pendiente", async () => {
  const t = setup();
  const d = await pair(t);
  await d.event({ type: "session_start" });
  await t.call("PATCH", `/ui/devices/${d.id}`, { approvals_enabled: true });
  for (let i = 0; i < 5; i++) {
    t.tick(1000);
    await d.event({ type: "stop", message: `r${i}` });
  }
  const two = await t.call("GET", `/ui/sessions/${SESSION}/timeline`, undefined, undefined, "limit=2&forceFunctionRegion=us-west-2");
  assert.equal(two.body.items.length, 2);
  assert.equal(two.body.has_more, true);
  assert.equal((await t.call("GET", `/ui/sessions/${SESSION}/timeline`, undefined, undefined, "limit=99999")).status, 200);
  assert.equal((await t.call("GET", "/ui/sessions/no-existe/timeline")).status, 404);

  t.tick(1000);
  await d.event({ type: "permission_request", tool_name: "Bash", preview: "git push" });
  const pending = (await t.call("GET", `/ui/sessions/${SESSION}/timeline`)).body.items.at(-1);
  assert.equal(pending.type, "approval");
  assert.equal(pending.approval.status, "pendiente");
  t.tick(130_000);
  const expired = (await t.call("GET", `/ui/sessions/${SESSION}/timeline`)).body.items.find((i: { type: string }) => i.type === "approval");
  assert.equal(expired.approval.status, "vencida");
});

test("compatibilidad: el hook viejo (stop de 280 caracteres, sin user_prompt) sigue funcionando contra el servidor nuevo", async () => {
  const t = setup();
  const d = await pair(t);
  assert.equal((await d.event({ type: "stop", message: "Listo, actualicé los archivos." })).status, 200);
  const o = (await t.call("GET", "/ui/overview")).body.sessions[0];
  assert.equal(o.summary, "Listo, actualicé los archivos.");
  assert.equal(o.last_role, "claude");
  const items = (await t.call("GET", `/ui/sessions/${SESSION}/timeline`)).body.items;
  assert.equal(items[0].text, "Listo, actualicé los archivos.");
});
