// Contrato HTTP de claude-events. Dos fronteras de confianza en una sola función desplegada SIN verificación
// de JWT (el dispositivo no tiene uno), así que cada ruta se autentica sola:
//   /device/*  token de dispositivo en la cabecera x-wabid-device-token (se compara contra su hash)
//   /ui/*      usuario de Supabase (JWT) vía deps.authenticateUser()
//
// Sin globals de Deno ni acceso directo a la base: todo pasa por `Store`, así se prueba en Node.

import type { Notice } from "../_shared/notify.ts";
import { mergeSession, parseDeviceEvent, planNotice, summarizeEvent } from "./events.ts";
import { cleanLine, normalizeForStorage, sanitizeText } from "./redact.ts";
import { matchRoute } from "./routes.ts";
import type { Cutoffs, Store } from "./store.ts";
import { generateDeviceToken, parseDeviceToken, verifyDeviceToken } from "./token.ts";
import type { ApiRequest, ApiResult, DeviceRow, TaskRow } from "./types.ts";
import { RUNNER_ONLINE_MS, toApprovalView, toDeviceView, toEventView, toMessageView, toSessionView, toTaskView } from "./views.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const LIMITS = {
  /** Cuánto espera una aprobación al celular antes de vencer sola. */
  approvalTtlMs: 120_000,
  pollIntervalMs: 2_000,
  maxPendingApprovals: 10,
  maxEventsPerMinute: 120,
  /** Eventos que pueden terminar en un push, por dispositivo y minuto. */
  maxNoticeEventsPerMinute: 20,
  maxNewSessionsPerHour: 30,
  /** Poda de datos viejos cada N eventos de un dispositivo (además de la primera tras una pausa). */
  pruneEveryEvents: 25,
  maxActiveDevices: 5,
  /** El sondeo cada 2 s no debe escribir "último contacto" en cada vuelta. */
  touchEveryMs: 30_000,
  recentApprovalsWindowMs: DAY,
  retention: { eventsMs: 14 * DAY, approvalsMs: 30 * DAY, sessionsMs: 30 * DAY, messagesMs: 7 * DAY, tasksMs: 14 * DAY },
  // v2 (SPEC-claude-code-v2.md)
  message: {
    maxChars: 2000,
    /** Un mensaje que nadie recogió en este tiempo vence (y pierde el texto): no debe ejecutarse mucho después. */
    ttlMs: 6 * HOUR,
    maxQueuedPerSession: 5,
  },
  task: {
    maxPromptChars: 4000,
    /** Una tarea que el runner no reclamó (laptop apagada) vence. */
    queueTtlMs: HOUR,
    maxQueued: 5,
    /** Una tarea 'ejecutando' sin latido del runner en este tiempo se da por fallida. */
    staleMs: 3 * 60_000,
    maxRunnerProjects: 20,
    resultMax: 1500,
    progressMax: 300,
    errorMax: 300,
  },
  deviceNameMax: 60,
} as const;

export interface ApiDeps {
  store: Store;
  now: () => Date;
  /** Avisos al celular. Un fallo aquí nunca debe tumbar el pedido. */
  notify: (userId: string, notice: Notice) => Promise<unknown>;
  /** Usuario del JWT del pedido, o null. */
  authenticateUser: () => Promise<{ userId: string } | null>;
  randomUUID: () => string;
  /** URL pública de la función, para que la app se la muestre a David al emparejar. */
  publicUrl: string;
  /** UUID de David (WABID_OWNER_ID). Las rutas que mandan texto o tareas a la laptop exigen que el JWT sea de este usuario. */
  ownerId?: string | null;
}

// --- Respuestas ------------------------------------------------------------------------------------------

const ok = (body: unknown, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, body: { error, ...extra } });
const UNAUTHORIZED = () => fail(401, "No autorizado");

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// Un aviso o una limpieza que falla se registra y se sigue: son secundarios frente al evento.
async function bestEffort(label: string, task: () => Promise<unknown>) {
  try {
    await task();
  } catch (e) {
    console.error(`claude-events ${label}:`, e instanceof Error ? e.message : e);
  }
}

// --- Punto de entrada ------------------------------------------------------------------------------------

export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResult> {
  const route = matchRoute(req.method, req.path);
  if (route === "not_found") return fail(404, "No existe");
  if (route === "method_not_allowed") return fail(405, "Método no permitido");

  try {
    if (route.name.startsWith("device.")) {
      const device = await authenticateDevice(req, deps);
      if (!device) return UNAUTHORIZED();
      switch (route.name) {
        case "device.ping":
          return ok({ ok: true, device: { name: device.name, approvals_enabled: device.approvals_enabled }, server_time: deps.now().toISOString() });
        case "device.event":
          return await deviceEvent(req, deps, device);
        case "device.approval":
          return await deviceApproval(route.id, deps, device);
        case "device.messageNext":
          return await deviceMessageNext(route.sessionId, deps, device);
        case "device.taskNext":
          return await deviceTaskNext(req, deps, device);
        case "device.taskEvent":
          return await deviceTaskEvent(route.id, req, deps, device);
      }
    }

    const user = await deps.authenticateUser();
    if (!user) return UNAUTHORIZED();
    switch (route.name) {
      case "ui.overview":
        return await uiOverview(deps, user.userId);
      case "ui.sessionEvents":
        return ok({ events: (await deps.store.listEvents(user.userId, route.sessionId, 30)).map(toEventView) });
      case "ui.deviceCreate":
        return await uiDeviceCreate(req, deps, user.userId);
      case "ui.devicePatch":
        return await uiDevicePatch(route.id, req, deps, user.userId);
      case "ui.deviceRevoke":
        return await uiDeviceRevoke(route.id, deps, user.userId);
      case "ui.approvalDecision":
        return await uiApprovalDecision(route.id, req, deps, user.userId);
      case "ui.messageCreate":
        return await uiMessageCreate(route.sessionId, req, deps, user.userId);
      case "ui.taskCreate":
        return await uiTaskCreate(req, deps, user.userId);
      case "ui.taskCancel":
        return await uiTaskCancel(route.id, deps, user.userId);
    }
    return fail(404, "No existe");
  } catch (e) {
    // Nunca devolver detalles internos: van al registro del servidor.
    console.error("claude-events:", e instanceof Error ? e.message : e);
    return fail(500, "Error interno");
  }
}

// --- Dispositivo: autenticación ----------------------------------------------------------------------------

async function authenticateDevice(req: ApiRequest, deps: ApiDeps): Promise<DeviceRow | null> {
  const token = req.headers.get("x-wabid-device-token") ?? "";
  const parsed = parseDeviceToken(token);
  if (!parsed) return null;
  const device = await deps.store.findDevice(parsed.deviceId);
  if (!device || device.revoked_at) return null;
  if (!(await verifyDeviceToken(token, device.token_hash))) return null;

  const now = deps.now();
  if (!device.last_seen_at || now.getTime() - Date.parse(device.last_seen_at) > LIMITS.touchEveryMs) {
    await bestEffort("touch", () => deps.store.touchDevice(device.device_id, now.toISOString()));
  }
  return device;
}

// --- Dispositivo: eventos --------------------------------------------------------------------------------------

function retentionCutoffs(nowMs: number): Cutoffs {
  const r = LIMITS.retention;
  return {
    events: new Date(nowMs - r.eventsMs).toISOString(),
    approvals: new Date(nowMs - r.approvalsMs).toISOString(),
    sessions: new Date(nowMs - r.sessionsMs).toISOString(),
    messages: new Date(nowMs - r.messagesMs).toISOString(),
    tasks: new Date(nowMs - r.tasksMs).toISOString(),
  };
}

async function deviceEvent(req: ApiRequest, deps: ApiDeps, device: DeviceRow): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const parsed = parseDeviceEvent(json.value);
  if (!parsed.ok) return fail(400, parsed.error);
  const e = parsed.event;

  const now = deps.now();
  const atIso = now.toISOString();
  const { store } = deps;
  const userId = device.user_id;

  const lastMinute = await store.countEventsSince(device.device_id, new Date(now.getTime() - 60_000).toISOString());
  if (lastMinute >= LIMITS.maxEventsPerMinute) return fail(429, "Demasiados eventos; espera un minuto");

  const existing = await store.getSession(userId, e.sessionId);
  // Una sesión es de un solo dispositivo: otro dispositivo (o un token robado) no puede tocarla ni sobrescribirla.
  if (existing && existing.device_id !== device.device_id) {
    // Si el dueño fue revocado (p. ej. se re-emparejó la laptop), la sesión se reasigna a este dispositivo.
    const owner = await store.findDevice(existing.device_id);
    if (owner && !owner.revoked_at) return fail(409, "Esa sesión pertenece a otro dispositivo");
  }
  if (!existing && (await store.countSessionsSince(device.device_id, new Date(now.getTime() - 3_600_000).toISOString())) >= LIMITS.maxNewSessionsPerHour) {
    return fail(429, "Demasiadas sesiones nuevas; espera un rato");
  }

  const summary = summarizeEvent(e);
  const session = mergeSession(existing, e, { userId, deviceId: device.device_id, atIso, summary });
  await store.saveSession(session);
  await store.insertEvent({
    user_id: userId,
    session_id: e.sessionId,
    device_id: device.device_id,
    kind: e.type,
    detail: e.detail || null,
    summary,
    created_at: atIso,
  });

  // Poda periódica (no hay cron): la primera tras una pausa y luego cada N eventos del dispositivo.
  if (e.type === "session_start" || lastMinute % LIMITS.pruneEveryEvents === 0) {
    await bestEffort("prune", () => store.prune(userId, retentionCutoffs(now.getTime())));
  }
  if (e.type === "session_end") await store.expireApprovals(userId, atIso, { sessionId: e.sessionId, deviceId: device.device_id, all: true });

  // Una aprobación solo existe si el modo ausente está activo y no hay demasiadas pendientes.
  let approval = null;
  let reason: "desactivada" | "limite" | "truncado" | undefined;
  if (e.type === "permission_request") {
    // Un comando recortado no se puede aprobar desde el celular: lo del medio no se ve. Se resuelve en la terminal.
    if (!device.approvals_enabled) reason = "desactivada";
    else if (e.previewTruncated) reason = "truncado";
    else if ((await store.countPending(userId, atIso, { deviceId: device.device_id })) >= LIMITS.maxPendingApprovals) reason = "limite";
    else {
      approval = await store.insertApproval({
        approval_id: deps.randomUUID(),
        user_id: userId,
        device_id: device.device_id,
        session_id: e.sessionId,
        project: session.project,
        tool_name: e.toolName,
        description: e.description || null,
        preview: e.preview,
        preview_truncated: e.previewTruncated,
        created_at: atIso,
        expires_at: new Date(now.getTime() + LIMITS.approvalTtlMs).toISOString(),
      });
    }
  }

  const hasPendingApproval =
    e.type === "notification" && e.detail === "permission_prompt" ? (await store.countPending(userId, atIso, { sessionId: e.sessionId })) > 0 : false;
  const notice = planNotice(e, { approvalCreated: approval !== null, hasPendingApproval });
  // Tope de avisos push por dispositivo y minuto: un dispositivo ruidoso no inunda el celular.
  // (Los chequeos de cupo son contar-y-luego-insertar, no atómicos: aceptable para un solo usuario.)
  if (notice) {
    const noisy = await store.countEventsSince(device.device_id, new Date(now.getTime() - 60_000).toISOString(), ["permission_request", "stop_failure", "notification"]);
    if (noisy <= LIMITS.maxNoticeEventsPerMinute) await bestEffort("notify", () => deps.notify(userId, notice));
  }

  // El hook Stop necesita saber si el modo ausente está activo para decidir si espera mensajes.
  if (e.type === "stop") return ok({ ok: true, away: device.approvals_enabled });
  if (e.type !== "permission_request") return ok({ ok: true });
  return ok({
    ok: true,
    approval: approval
      ? { id: approval.approval_id, status: approval.status, expires_in_ms: LIMITS.approvalTtlMs, poll_interval_ms: LIMITS.pollIntervalMs }
      : null,
    ...(reason ? { reason } : {}),
  });
}

// El hook sondea esto cada ~2 s. El servidor es el único árbitro de cuándo venció.
async function deviceApproval(approvalId: string, deps: ApiDeps, device: DeviceRow): Promise<ApiResult> {
  const now = deps.now();
  const userId = device.user_id;
  let row = await deps.store.findApproval(userId, approvalId);
  if (!row || row.device_id !== device.device_id) return fail(404, "No existe");

  if (row.status === "pendiente" && Date.parse(row.expires_at) <= now.getTime()) {
    await deps.store.expireApprovals(userId, now.toISOString());
    row = (await deps.store.findApproval(userId, approvalId)) ?? row;
  }
  const remaining = row.status === "pendiente" ? Math.max(0, Date.parse(row.expires_at) - now.getTime()) : 0;
  return ok({ status: row.status, expires_in_ms: remaining });
}

// --- App: vista general y dispositivos ------------------------------------------------------------------------------

async function uiOverview(deps: ApiDeps, userId: string): Promise<ApiResult> {
  const now = deps.now();
  const { store } = deps;
  const nowIso = now.toISOString();
  await store.expireApprovals(userId, nowIso);
  await store.expireMessages(userId, nowIso);
  const staleIso = new Date(now.getTime() - LIMITS.task.staleMs).toISOString();

  const [devices, sessions, pending, recent, messages] = await Promise.all([
    store.listDevices(userId),
    store.listSessions(userId, 20),
    store.listApprovals(userId, { statuses: ["pendiente"], limit: 20 }),
    store.listApprovals(userId, {
      statuses: ["aprobada", "denegada", "vencida"],
      sinceIso: new Date(now.getTime() - LIMITS.recentApprovalsWindowMs).toISOString(),
      limit: 8,
    }),
    store.listMessages(userId, 30),
  ]);
  // Una tarea cuyo runner dejó de dar señal se marca fallida aunque nadie más sondee.
  for (const d of devices) await store.sweepTasks(userId, d.device_id, nowIso, staleIso);
  const tasks = await store.listTasks(userId, 15);
  const view = (a: (typeof pending)[number]) => toApprovalView(a, now.getTime());
  return ok({
    now: nowIso,
    devices: devices.map((d) => toDeviceView(d, now.getTime())),
    sessions: sessions.map(toSessionView),
    pending: pending.map(view),
    recent: recent.map(view),
    messages: messages.map(toMessageView),
    tasks: tasks.map(toTaskView),
  });
}

function parseDeviceName(value: unknown): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string") return null;
  return cleanLine(value, LIMITS.deviceNameMax);
}

async function uiDeviceCreate(req: ApiRequest, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const name = parseDeviceName(asObject(json.value).name);
  if (name === null) return fail(400, "El nombre debe ser texto");

  if ((await deps.store.listDevices(userId)).length >= LIMITS.maxActiveDevices) {
    return fail(409, `Ya tienes ${LIMITS.maxActiveDevices} dispositivos conectados; revoca uno antes de agregar otro`);
  }
  const { token, deviceId, tokenHash } = await generateDeviceToken(deps.randomUUID());
  const device = await deps.store.insertDevice({ device_id: deviceId, user_id: userId, name: name || "Mi laptop", token_hash: tokenHash });
  // El token viaja en esta respuesta y en ningún otro lugar: en la base solo queda su hash.
  return ok({ device: toDeviceView(device, deps.now().getTime()), token, url: deps.publicUrl }, 201);
}

async function uiDevicePatch(deviceId: string, req: ApiRequest, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const body = asObject(json.value);

  const patch: { name?: string; approvals_enabled?: boolean } = {};
  if (body.approvals_enabled !== undefined) {
    if (typeof body.approvals_enabled !== "boolean") return fail(400, "approvals_enabled debe ser true o false");
    patch.approvals_enabled = body.approvals_enabled;
  }
  if (body.name !== undefined) {
    const name = parseDeviceName(body.name);
    if (!name) return fail(400, "El nombre no puede estar vacío");
    patch.name = name;
  }
  if (Object.keys(patch).length === 0) return fail(400, "Nada que cambiar");

  const device = await deps.store.patchDevice(userId, deviceId, patch);
  if (!device) return fail(404, "No existe");
  // Apagar el modo ausente: lo que esperaba respuesta del celular deja de esperar.
  if (patch.approvals_enabled === false) await deps.store.expireApprovals(userId, deps.now().toISOString(), { deviceId, all: true });
  return ok({ device: toDeviceView(device, deps.now().getTime()) });
}

async function uiDeviceRevoke(deviceId: string, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const atIso = deps.now().toISOString();
  const device = await deps.store.revokeDevice(userId, deviceId, atIso);
  if (!device) return fail(404, "No existe");
  await deps.store.expireApprovals(userId, atIso, { deviceId, all: true });
  return ok({ ok: true });
}

// --- App: decidir una aprobación --------------------------------------------------------------------------------------

async function uiApprovalDecision(approvalId: string, req: ApiRequest, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const decision = asObject(json.value).decision;
  const status = decision === "aprobar" ? "aprobada" : decision === "denegar" ? "denegada" : null;
  if (!status) return fail(400, "decision debe ser 'aprobar' o 'denegar'");

  const now = deps.now();
  const nowIso = now.toISOString();
  // Una sola sentencia atómica: solo cambia si sigue pendiente y no venció.
  const decided = await deps.store.decideApproval(userId, approvalId, status, userId, nowIso);
  if (decided) return ok({ approval: toApprovalView(decided, now.getTime()) });

  const current = await deps.store.findApproval(userId, approvalId);
  if (!current) return fail(404, "No existe");
  if (current.status === "pendiente") await deps.store.expireApprovals(userId, nowIso); // venció y nadie lo había marcado
  const after = (await deps.store.findApproval(userId, approvalId)) ?? current;
  return fail(409, "Esa solicitud ya no está pendiente", { status: after.status });
}

// =============================================================================================================
// v2 · Responderle a una sesión y lanzar tareas (SPEC-claude-code-v2.md)
// =============================================================================================================

// Mandar texto o tareas a la laptop equivale a ejecutar cosas en ella: solo el dueño. Sin WABID_OWNER_ID
// configurado la función falla cerrada (503) en vez de aceptar a cualquier usuario autenticado.
function requireOwner(deps: ApiDeps, userId: string): ApiResult | null {
  if (!deps.ownerId) return fail(503, "Falta configurar WABID_OWNER_ID");
  return userId === deps.ownerId ? null : fail(403, "No autorizado");
}

const PROJECT_NAME_RE = /^[A-Za-z0-9._ -]{1,60}$/;

// Texto de David: no se redacta (cambiaría lo que quiso decir), pero se unifican saltos y se marcan los
// caracteres invisibles para que lo que se ve en pantalla sea lo que recibe Claude.
function parseUserText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeText(value).trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

// --- Dispositivo: siguiente mensaje de una sesión (lo llama el hook Stop) ------------------------------------------------

async function deviceMessageNext(sessionId: string, deps: ApiDeps, device: DeviceRow): Promise<ApiResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const userId = device.user_id;
  const session = await deps.store.getSession(userId, sessionId);
  // La sesión es de un solo dispositivo: otro token no puede leer sus mensajes.
  if (!session || session.device_id !== device.device_id) return fail(404, "No existe");

  await deps.store.expireMessages(userId, nowIso);
  const claimed = await deps.store.claimNextMessage(userId, sessionId, nowIso);
  if (!claimed) return ok({ message: null, away: device.approvals_enabled });
  // Entregado: Claude vuelve a trabajar. (Nunca se registra el texto.)
  if (!session.ended_at) await deps.store.saveSession({ ...session, status: "trabajando", last_event_at: nowIso });
  return ok({ message: { id: claimed.messageId, text: claimed.text }, away: device.approvals_enabled });
}

// --- Dispositivo: runner de tareas ---------------------------------------------------------------------------------------

async function deviceTaskNext(req: ApiRequest, deps: ApiDeps, device: DeviceRow): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const raw = asObject(json.value).projects;
  if (!Array.isArray(raw)) return fail(400, "projects debe ser una lista de nombres");
  const projects = [...new Set(raw.filter((p): p is string => typeof p === "string" && PROJECT_NAME_RE.test(p)))].slice(0, LIMITS.task.maxRunnerProjects);

  const now = deps.now();
  const nowIso = now.toISOString();
  const userId = device.user_id;
  const { store } = deps;

  await store.setRunnerState(device.device_id, projects, nowIso);
  await store.sweepTasks(userId, device.device_id, nowIso, new Date(now.getTime() - LIMITS.task.staleMs).toISOString());

  // Una tarea a la vez por dispositivo.
  const busy = (await store.listTasks(userId, 30)).some((t) => t.device_id === device.device_id && t.status === "ejecutando");
  if (busy) return ok({ task: null });

  const task = await store.claimNextTask(userId, device.device_id, nowIso);
  return ok({ task: task ? { id: task.task_id, project: task.project, prompt: task.prompt } : null });
}

const TASK_OUTCOMES = new Set(["terminada", "fallida", "cancelada", "rechazada"]);

async function deviceTaskEvent(taskId: string, req: ApiRequest, deps: ApiDeps, device: DeviceRow): Promise<ApiResult> {
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const body = asObject(json.value);
  const type = body.type;
  if (type !== "start" && type !== "progress" && type !== "finish") return fail(400, "Tipo de evento desconocido");

  const now = deps.now();
  const nowIso = now.toISOString();
  const userId = device.user_id;
  const { store } = deps;

  const task = await store.findTask(userId, taskId);
  if (!task || task.device_id !== device.device_id) return fail(404, "No existe");
  // Si la tarea ya no está ejecutándose (se dio por fallida por falta de latido, o terminó), el runner debe parar.
  if (task.status !== "ejecutando") return ok({ ok: false, cancel_requested: true, status: task.status });

  const sessionId = typeof body.session_id === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(body.session_id) ? body.session_id : undefined;
  const patch: Parameters<Store["updateTask"]>[2] = { updated_at: nowIso, ...(sessionId ? { session_id: sessionId } : {}) };

  if (type === "progress") {
    const progress = cleanLine(typeof body.message === "string" ? body.message : "", LIMITS.task.progressMax);
    if (progress) patch.progress = progress;
  }

  if (type === "finish") {
    const outcome = body.outcome;
    if (typeof outcome !== "string" || !TASK_OUTCOMES.has(outcome)) return fail(400, "outcome inválido");
    patch.status = outcome as TaskRow["status"];
    patch.finished_at = nowIso;
    const result = typeof body.result === "string" ? body.result : "";
    if (result.trim()) patch.result = normalizeForStorage(result, { max: LIMITS.task.resultMax, head: 1000, tail: 400 }).text;
    const error = cleanLine(typeof body.error === "string" ? body.error : "", LIMITS.task.errorMax);
    if (error) patch.error = error;
    patch.progress = null;
  }

  const updated = await store.updateTask(userId, taskId, patch, ["ejecutando"]);
  if (!updated) return ok({ ok: false, cancel_requested: true });

  if (type === "finish" && updated.status !== "cancelada") {
    const detail = updated.status === "terminada" ? updated.result : updated.error || updated.result;
    const title = updated.status === "terminada" ? `Tarea terminada · ${updated.project}` : `Tarea ${updated.status} · ${updated.project}`;
    await bestEffort("notify", () =>
      deps.notify(userId, { kind: "claude", title: cleanLine(title, 120), body: cleanLine(detail ?? "", 120), url: "/claude" })
    );
  }
  return ok({ ok: true, cancel_requested: updated.cancel_requested });
}

// --- App: escribirle a una sesión -----------------------------------------------------------------------------------------

async function uiMessageCreate(sessionId: string, req: ApiRequest, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const denied = requireOwner(deps, userId);
  if (denied) return denied;
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const text = parseUserText(asObject(json.value).text, LIMITS.message.maxChars);
  if (text === null) return fail(400, `El mensaje debe tener entre 1 y ${LIMITS.message.maxChars} caracteres`);

  const now = deps.now();
  const nowIso = now.toISOString();
  const { store } = deps;
  const session = await store.getSession(userId, sessionId);
  if (!session) return fail(404, "No existe");
  if (session.ended_at) return fail(409, "Esa sesión ya terminó");
  const owner = await store.findDevice(session.device_id);
  if (!owner || owner.revoked_at || owner.user_id !== userId) return fail(409, "La laptop de esa sesión ya no está conectada");

  await store.expireMessages(userId, nowIso);
  if ((await store.countQueuedMessages(userId, sessionId, nowIso)) >= LIMITS.message.maxQueuedPerSession) {
    return fail(429, "Ya hay varios mensajes esperando en esa sesión");
  }
  const row = await store.insertMessage({
    message_id: deps.randomUUID(),
    user_id: userId,
    session_id: sessionId,
    device_id: session.device_id,
    body: text,
    created_at: nowIso,
    expires_at: new Date(now.getTime() + LIMITS.message.ttlMs).toISOString(),
  });
  return ok({ message: toMessageView(row) }, 201);
}

// --- App: tareas -----------------------------------------------------------------------------------------------------------

async function uiTaskCreate(req: ApiRequest, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const denied = requireOwner(deps, userId);
  if (denied) return denied;
  const json = parseJsonBody(req.body);
  if (!json.ok) return fail(400, "JSON inválido");
  const body = asObject(json.value);
  const project = body.project;
  if (typeof project !== "string" || !PROJECT_NAME_RE.test(project)) return fail(400, "Elige un proyecto de la lista");
  const prompt = parseUserText(body.prompt, LIMITS.task.maxPromptChars);
  if (prompt === null) return fail(400, `La tarea debe tener entre 1 y ${LIMITS.task.maxPromptChars} caracteres`);

  const now = deps.now();
  const nowIso = now.toISOString();
  const { store } = deps;

  // El proyecto debe estar en la lista que reporta una laptop con el runner conectado. La ruta real vive solo en la laptop.
  const candidates = (await store.listDevices(userId)).filter((d) => (d.runner_projects ?? []).includes(project));
  if (candidates.length === 0) return fail(409, "Ese proyecto no está en la lista de tu laptop");
  const target = candidates.find((d) => d.runner_seen_at && now.getTime() - Date.parse(d.runner_seen_at) <= RUNNER_ONLINE_MS);
  if (!target) return fail(409, "El runner de tu laptop no está conectado");

  await store.sweepTasks(userId, target.device_id, nowIso, new Date(now.getTime() - LIMITS.task.staleMs).toISOString());
  if ((await store.countQueuedTasks(userId, nowIso)) >= LIMITS.task.maxQueued) return fail(429, "Ya hay varias tareas en cola");

  const task = await store.insertTask({
    task_id: deps.randomUUID(),
    user_id: userId,
    device_id: target.device_id,
    project,
    prompt,
    created_at: nowIso,
    expires_at: new Date(now.getTime() + LIMITS.task.queueTtlMs).toISOString(),
  });
  return ok({ task: toTaskView(task) }, 201);
}

async function uiTaskCancel(taskId: string, deps: ApiDeps, userId: string): Promise<ApiResult> {
  const denied = requireOwner(deps, userId);
  if (denied) return denied;
  const nowIso = deps.now().toISOString();
  const { store } = deps;

  // En cola: se cancela al instante. Ejecutándose: se marca y el runner la mata en su próximo latido.
  const queued = await store.updateTask(userId, taskId, { status: "cancelada", finished_at: nowIso, updated_at: nowIso }, ["en_cola"]);
  if (queued) return ok({ task: toTaskView(queued) });
  const running = await store.updateTask(userId, taskId, { cancel_requested: true }, ["ejecutando"]);
  if (running) return ok({ task: toTaskView(running) });

  const current = await store.findTask(userId, taskId);
  if (!current) return fail(404, "No existe");
  return fail(409, "Esa tarea ya terminó", { status: current.status });
}
