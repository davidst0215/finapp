// Corre en Node: node --experimental-strip-types --test apps/web/src/components/claude/chat.test.mjs
// Lista de conversaciones y filas del chat (lo puro de la pestaña Claude Code como chat).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRows, deliveryLine, deliveryOf, taskTimeline } from "./chatModel.ts";
import { buildConversations, laptopLine, sessionStatus, taskConversationStatus } from "./conversations.ts";

const NOW = Date.parse("2026-10-04T19:30:00.000Z"); // 14:30 en Lima
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

const session = (over = {}) => ({
  id: "s1", device_id: "d", project: "finapp", cwd: null, status: "trabajando", summary: "Voy a migrar la tabla.", last_role: "claude",
  started_at: ago(3600), last_event_at: ago(60), ended_at: null, ...over,
});
const task = (over = {}) => ({
  id: "t1", project: "vera", prompt: "Revisa el hero", status: "en_cola", cancel_requested: false, session_id: null, progress: null,
  result: null, error: null, created_at: ago(120), started_at: null, finished_at: null, ...over,
});
const approval = (over = {}) => ({
  id: "a1", session_id: "s1", project: "finapp", tool_name: "Bash", description: null, preview: "git push", truncated: false,
  status: "pendiente", created_at: ago(10), expires_at: ago(-110), expires_in_ms: 110_000, decided_at: null, ...over,
});
const overview = (over = {}) => ({ now: ago(0), devices: [], sessions: [], pending: [], recent: [], messages: [], tasks: [], ...over });

// --- Estado de cada conversación ---------------------------------------------------------------------------------------

test("sessionStatus: un texto legible por cada estado", () => {
  assert.deepEqual(sessionStatus(session(), 0, NOW), { tone: "active", label: "Claude está trabajando…" });
  assert.deepEqual(sessionStatus(session({ status: "esperando" }), 0, NOW), { tone: "waiting", label: "Te está esperando" });
  assert.deepEqual(sessionStatus(session({ status: "terminada", ended_at: "2026-10-04T19:20:00.000Z" }), 0, NOW), { tone: "done", label: "Terminó" });
  assert.deepEqual(sessionStatus(session({ status: "error", last_event_at: "2026-10-04T18:05:00.000Z" }), 0, NOW), { tone: "error", label: "Falló" });
});

test("un permiso pendiente manda sobre el estado guardado", () => {
  assert.deepEqual(sessionStatus(session({ status: "esperando" }), 1, NOW), { tone: "asking", label: "Claude te necesita" });
});

test("sin señal por más de 6 h ya no figura como trabajando, pero una falla no se disfraza de inactividad", () => {
  const old = { last_event_at: "2026-10-04T10:00:00.000Z" };
  assert.deepEqual(sessionStatus(session(old), 0, NOW), { tone: "stale", label: "Sin actividad" });
  assert.equal(sessionStatus(session({ ...old, status: "esperando" }), 0, NOW).tone, "stale");
  assert.equal(sessionStatus(session({ ...old, status: "error" }), 0, NOW).tone, "error");
});

test("taskConversationStatus cubre cada estado de tarea", () => {
  const label = (status, extra = {}) => taskConversationStatus(task({ status, ...extra }));
  assert.deepEqual(label("en_cola"), { tone: "queued", label: "En cola, esperando a tu laptop" });
  assert.equal(label("ejecutando").label, "Claude está trabajando…");
  assert.equal(label("terminada").label, "Terminó");
  assert.equal(label("fallida").tone, "error");
  assert.equal(label("rechazada").label, "Tu laptop no la aceptó");
  assert.equal(label("vencida").tone, "stale");
  assert.equal(label("ejecutando", { cancel_requested: true }).label, "Cancelando…");
});

// --- Lista de conversaciones -----------------------------------------------------------------------------------------------

test("cada sesión es una conversación con proyecto, vista previa, estado y hora; lo que necesita permiso va primero", () => {
  const list = buildConversations(
    overview({
      sessions: [session({ id: "a", project: "vera", last_event_at: ago(30) }), session({ id: "b", project: "finapp", last_event_at: ago(900) })],
      pending: [approval({ session_id: "b" })],
    }),
    NOW,
  );
  assert.deepEqual(list.map((c) => c.title), ["finapp", "vera"], "la que pide permiso sube aunque sea más vieja");
  assert.equal(list[0].pending, 1);
  assert.equal(list[0].status.tone, "asking");
  assert.equal(list[0].preview, "Voy a migrar la tabla.");
  assert.equal(list[0].path, "/claude/s/b");
});

test("la vista previa dice quién habló: David o Claude; una sesión sin mensajes lo avisa", () => {
  const [a, b, c] = buildConversations(
    overview({
      sessions: [
        session({ id: "a", summary: "sigue con los tests", last_role: "usuario", last_event_at: ago(10) }),
        session({ id: "b", summary: "Listo.\n\n  Terminé.", last_role: "claude", last_event_at: ago(20) }),
        session({ id: "c", summary: null, last_role: null, last_event_at: ago(30) }),
      ],
    }),
    NOW,
  );
  assert.deepEqual([a.previewRole, a.preview], ["usuario", "sigue con los tests"]);
  assert.equal(b.preview, "Listo. Terminé.", "una sola línea");
  assert.deepEqual([c.previewRole, c.preview], [null, "Sin mensajes todavía"]);
});

test("compatibilidad: sesiones anteriores a 013 (sin last_role) se listan sin romperse", () => {
  const legacy = session({ last_role: undefined });
  const [c] = buildConversations(overview({ sessions: [legacy] }), NOW);
  assert.equal(c.previewRole, null);
  assert.equal(c.preview, "Voy a migrar la tabla.");
});

test("una conversación se mueve a lo alto cuando David le escribe desde el celular", () => {
  const list = buildConversations(
    overview({
      sessions: [session({ id: "a", last_event_at: ago(600) }), session({ id: "b", project: "otra", last_event_at: ago(300) })],
      messages: [{ id: "m", session_id: "a", status: "en_cola", created_at: ago(20), delivered_at: null }],
    }),
    NOW,
  );
  assert.equal(list[0].sessionId, "a");
});

test("una tarea que ya abrió su sesión es ESA conversación (con etiqueta «tarea»); una sin sesión aparece sola", () => {
  const list = buildConversations(
    overview({
      sessions: [session({ id: "s9", project: "cost-margin", last_event_at: ago(100) })],
      tasks: [task({ id: "t9", project: "cost-margin", session_id: "s9", status: "ejecutando" }), task({ id: "t2", project: "tdv" })],
    }),
    NOW,
  );
  assert.equal(list.length, 2, "no se duplica");
  const bySession = list.find((c) => c.sessionId === "s9");
  assert.deepEqual([bySession.isTask, bySession.taskId, bySession.path], [true, "t9", "/claude/s/s9"]);
  const alone = list.find((c) => c.key === "t:t2");
  assert.deepEqual([alone.isTask, alone.path, alone.status.tone, alone.preview, alone.previewRole], [true, "/claude/t/t2", "queued", "Revisa el hero", "usuario"]);
});

test("una tarea terminada sin sesión muestra su resultado; una fallida, su error", () => {
  const [done, failed] = buildConversations(
    overview({
      tasks: [
        task({ id: "t1", status: "terminada", result: "Revisé los 14 márgenes.", finished_at: ago(10) }),
        task({ id: "t2", status: "fallida", error: "El runner dejó de responder", finished_at: ago(20) }),
      ],
    }),
    NOW,
  );
  assert.deepEqual([done.preview, done.previewRole], ["Revisé los 14 márgenes.", "claude"]);
  assert.deepEqual([failed.preview, failed.status.tone], ["El runner dejó de responder", "error"]);
});

test("laptopLine: sin laptop, esperando la primera señal, y con señal", () => {
  assert.equal(laptopLine([], NOW), "Sin laptop conectada");
  assert.equal(laptopLine([{ name: "Legion 5", last_seen_at: null }], NOW), "Legion 5 · esperando la primera señal");
  assert.equal(laptopLine([{ name: "Legion 5", last_seen_at: ago(180) }], NOW), "Legion 5 · última señal hace 3 min");
  assert.equal(laptopLine([{ name: "A", last_seen_at: ago(30) }, { name: "B", last_seen_at: ago(900) }], NOW), "2 laptops · última señal hace un momento");
});

// --- Filas del chat ------------------------------------------------------------------------------------------------------------

const user = (id, sec, over = {}) => ({ id, at: ago(sec), type: "user", source: "phone", text: id, delivery: "entregado", ...over });
const claude = (id, sec) => ({ id, at: ago(sec), type: "claude", tone: "reply", text: id });
const chip = (id, sec) => ({ id, at: ago(sec), type: "system", text: id });

test("buildRows agrupa burbujas seguidas del mismo lado y corta el grupo con otro lado, un chip o una pausa larga", () => {
  const rows = buildRows([user("u1", 900), user("u2", 880), claude("c1", 800), chip("x", 700), claude("c2", 690), user("u3", 100)], NOW).filter((r) => r.kind === "item");
  const flags = rows.map((r) => `${r.item.id}:${r.groupStart ? "S" : "-"}${r.groupEnd ? "E" : "-"}`);
  assert.deepEqual(flags, ["u1:S-", "u2:-E", "c1:SE", "x:SE", "c2:SE", "u3:SE"]);
});

test("buildRows pone un separador de día cuando cambia el día en Lima", () => {
  const yesterday = { ...claude("viejo", 0), at: "2026-10-03T15:00:00.000Z" };
  const rows = buildRows([yesterday, claude("hoy", 60)], NOW);
  assert.deepEqual(rows.map((r) => (r.kind === "day" ? `día:${r.label}` : r.item.id)), ["día:Ayer", "viejo", "día:Hoy", "hoy"]);
  assert.equal(rows.filter((r) => r.kind === "item").every((r) => r.groupStart && r.groupEnd), true, "un día distinto no se agrupa");
  assert.deepEqual(buildRows([], NOW), []);
});

test("deliveryOf: ticks estilo chat", () => {
  assert.deepEqual(deliveryOf("en_cola"), { label: "En cola", ticks: 1 });
  assert.deepEqual(deliveryOf("entregando"), { label: "Entregando…", ticks: 1 });
  assert.deepEqual(deliveryOf("entregado"), { label: "Entregado", ticks: 2 });
  assert.deepEqual(deliveryOf("vencido"), { label: "No se entregó", ticks: 0 });
});

test("taskTimeline: el encargo de David y cómo va, para una tarea sin sesión", () => {
  assert.deepEqual(taskTimeline(task()).map((i) => i.type), ["user"]);
  const running = taskTimeline(task({ status: "ejecutando", started_at: ago(60), progress: "Leyendo el hero" }));
  assert.deepEqual(running.map((i) => i.type), ["user", "system", "claude"]);
  const failed = taskTimeline(task({ status: "rechazada", error: "Proyecto no permitido", finished_at: ago(5) }));
  assert.deepEqual(failed.map((i) => (i.type === "system" ? i.text : i.type)), ["user", "claude", "Tu laptop no aceptó la tarea"]);
  const done = taskTimeline(task({ status: "terminada", result: "Listo.", started_at: ago(90), finished_at: ago(5) }));
  assert.deepEqual(done.map((i) => i.type), ["user", "system", "claude", "system"]);
});

// --- 014: estados de un mensaje en cola ------------------------------------------------------------------------------------------

const phone = (delivery, over = {}) => ({ id: "m", at: ago(5), type: "user", source: "phone", text: "Sí hazlo", delivery, ...over });

test("deliveryLine: un mensaje en cola dice por qué espera según la sesión", () => {
  assert.equal(deliveryLine(phone("en_cola", { queue: "turn" })).label, "En cola: se entrega cuando Claude termine su turno");
  assert.equal(deliveryLine(phone("en_cola", { queue: "idle_runner" })).label, "Claude está quieto: lo retomo en la laptop…");
  assert.equal(deliveryLine(phone("retomando")).label, "Claude está quieto: lo retomo en la laptop…");
  assert.match(deliveryLine(phone("en_cola", { queue: "idle_no_runner" })).label, /runner de la laptop no está conectado/);
  assert.equal(deliveryLine(phone("en_cola")).label, "En cola", "mensaje recién enviado, antes de que el servidor diga por qué");
  assert.equal(deliveryLine(phone("entregando")).label, "Entregando…");
});

test("deliveryLine: retomado enlaza la sesión nueva; si no se pudo retomar es una alarma con el motivo", () => {
  const done = deliveryLine(phone("entregado", { continuation: "nueva" }));
  assert.deepEqual([done.label, done.ticks, done.continuation, done.alert], ["Retomado en la laptop", 2, "nueva", false]);
  assert.equal(deliveryLine(phone("entregado")).continuation, null, "entregado por el hook Stop: sin enlace");
  const bad = deliveryLine(phone("no_retomado", { note: "proyecto no autorizado en la laptop" }));
  assert.deepEqual([bad.label, bad.alert, bad.ticks], ["No se puede retomar: proyecto no autorizado en la laptop", true, 0]);
  assert.match(deliveryLine(phone("no_retomado")).label, /^No se puede retomar: /);
  assert.equal(deliveryLine({ ...phone("entregado"), source: "laptop" }), null);
});

test("buildConversations: retomar no crea filas de tarea ni marca la sesión nueva como tarea", () => {
  const list = buildConversations(
    {
      now: ago(0), devices: [], pending: [], recent: [], messages: [],
      sessions: [session({ id: "nueva", continued_from: "s1" })],
      tasks: [
        { id: "t1", kind: "resume", project: "finapp", prompt: "x", status: "terminada", cancel_requested: false, session_id: "nueva", progress: null, result: "ok", error: null, created_at: ago(60), started_at: ago(50), finished_at: ago(10) },
        { id: "t2", kind: "resume", project: "finapp", prompt: "y", status: "rechazada", cancel_requested: false, session_id: null, progress: null, result: null, error: "no", created_at: ago(60), started_at: null, finished_at: ago(10) },
      ],
    },
    NOW,
  );
  assert.deepEqual(list.map((c) => [c.key, c.isTask]), [["s:nueva", false]]);
});

test("deliveryLine: retomado con error enlaza la continuación y avisa en rojo (no es 'no se pudo retomar')", () => {
  const l = deliveryLine(phone("entregado", { continuation: "nueva", note: "Claude terminó con error: error_max_turns" }));
  assert.deepEqual([l.label, l.alert, l.continuation, l.ticks], ["Retomado con error: Claude terminó con error: error_max_turns", true, "nueva", 2]);
});
