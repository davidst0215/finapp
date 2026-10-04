// Reglas puras del módulo: validar lo que manda el hook, resumirlo, mantener el estado de la sesión y decidir
// cuándo avisar al celular. Sin globals de Deno ni acceso a la base: se prueba en Node.

import type { Notice } from "../_shared/notify.ts";
import { cleanLine, normalizeForStorage, toOneLine } from "./redact.ts";
import { EVENT_KINDS } from "./types.ts";
import type { EventKind, ParsedEvent, SessionRow, SessionStatus } from "./types.ts";

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const PREVIEW_LIMITS = { max: 2000, head: 1400, tail: 500 };

const asString = (v: unknown) => (typeof v === "string" ? v : "");

// --- Validación del evento --------------------------------------------------------------------------------

export function parseDeviceEvent(body: unknown): { ok: true; event: ParsedEvent } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "El cuerpo debe ser un objeto JSON" };
  const b = body as Record<string, unknown>;

  const type = b.type;
  if (typeof type !== "string" || !(EVENT_KINDS as readonly string[]).includes(type)) return { ok: false, error: "Tipo de evento desconocido" };
  if (typeof b.session_id !== "string" || !SESSION_ID_RE.test(b.session_id)) return { ok: false, error: "session_id inválido" };

  const cwd = cleanLine(asString(b.cwd), 300);
  const event: ParsedEvent = {
    type: type as EventKind,
    sessionId: b.session_id,
    project: cleanLine(asString(b.project), 100),
    cwd: cwd || null,
    detail: asString(b.detail).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60),
    message: cleanLine(asString(b.message), 300),
    toolName: "",
    preview: "",
    previewTruncated: false,
    description: cleanLine(asString(b.description), 200),
  };

  if (event.type === "permission_request") {
    const toolName = asString(b.tool_name);
    if (!TOOL_NAME_RE.test(toolName)) return { ok: false, error: "tool_name inválido" };
    const rawPreview = asString(b.preview);
    if (!rawPreview.trim()) return { ok: false, error: "preview requerido" };
    const preview = normalizeForStorage(rawPreview, PREVIEW_LIMITS);
    event.toolName = toolName;
    event.preview = preview.text;
    event.previewTruncated = preview.truncated || b.truncated === true;
  }
  return { ok: true, event };
}

// --- Resumen de una línea para la línea de tiempo -----------------------------------------------------------

const START_LABELS: Record<string, string> = {
  startup: "Sesión iniciada",
  resume: "Sesión reanudada",
  clear: "Conversación limpiada (/clear)",
  fork: "Sesión bifurcada",
};

const END_LABELS: Record<string, string> = {
  logout: "Cerró la sesión de Claude",
  clear: "Conversación limpiada",
  resume: "Cambió a otra conversación",
};

export function summarizeEvent(e: ParsedEvent): string {
  switch (e.type) {
    case "session_start":
      return START_LABELS[e.detail] ?? "Sesión iniciada";
    case "session_end":
      return END_LABELS[e.detail] ?? "Sesión terminada";
    case "stop":
      return e.message || "Terminó de responder";
    case "stop_failure": {
      const head = e.detail ? `Falló (${e.detail})` : "Falló";
      return e.message ? `${head}: ${e.message}` : head;
    }
    case "notification":
      return e.message || e.detail || "Aviso";
    case "permission_request":
      return `${e.toolName}: ${toOneLine(e.preview.split("\n")[0] ?? "", 120)}`;
  }
}

// --- Estado de la sesión -------------------------------------------------------------------------------------

// Avisos que significan "Claude está parado esperándote".
const WAITING_NOTIFICATIONS = new Set(["idle_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

// Estado al que lleva el evento, o null si no cambia el que ya tenía.
function statusFor(e: ParsedEvent): SessionStatus | null {
  switch (e.type) {
    case "session_start":
    case "permission_request":
      return "trabajando";
    case "session_end":
      return "terminada";
    case "stop":
      return "esperando";
    case "stop_failure":
      return "error";
    case "notification":
      if (WAITING_NOTIFICATIONS.has(e.detail)) return "esperando";
      return e.detail === "permission_prompt" ? "trabajando" : null;
  }
}

export interface MergeContext {
  userId: string;
  deviceId: string;
  atIso: string;
  summary: string;
}

// Mezcla el evento con la fila actual de la sesión (o crea una). Un evento tardío no resucita una sesión
// terminada: los hooks asíncronos pueden llegar fuera de orden.
export function mergeSession(existing: SessionRow | null, e: ParsedEvent, ctx: MergeContext): SessionRow {
  if (existing?.ended_at && e.type !== "session_start") return existing;

  const next = statusFor(e);
  const keepsSummary = e.type === "stop" || e.type === "stop_failure";
  return {
    user_id: ctx.userId,
    session_id: e.sessionId,
    device_id: ctx.deviceId,
    project: e.project || existing?.project || "",
    cwd: e.cwd ?? existing?.cwd ?? null,
    status: next ?? existing?.status ?? "trabajando",
    last_summary: keepsSummary ? ctx.summary : (existing?.last_summary ?? null),
    started_at: existing?.started_at ?? ctx.atIso,
    last_event_at: ctx.atIso,
    ended_at: e.type === "session_end" ? ctx.atIso : e.type === "session_start" ? null : (existing?.ended_at ?? null),
  };
}

// --- Cuándo avisar al celular ------------------------------------------------------------------------------------

export interface NoticeContext {
  /** Este evento creó una aprobación pendiente (el modo ausente estaba activo). */
  approvalCreated: boolean;
  /** Esa sesión ya tiene una aprobación pendiente (para no avisar dos veces el mismo permiso). */
  hasPendingApproval: boolean;
}

const NOTICE_URL = "/claude";

export function planNotice(e: ParsedEvent, ctx: NoticeContext): Notice | null {
  const where = e.project || "Claude Code";
  const make = (title: string, body: string): Notice => ({
    kind: "claude",
    title: toOneLine(title, 120),
    body: toOneLine(body, 120),
    url: NOTICE_URL,
  });

  switch (e.type) {
    case "permission_request":
      return ctx.approvalCreated ? make(`Claude pide permiso · ${where}`, `${e.toolName}: ${e.preview}`) : null;
    case "stop_failure":
      return make(`Claude falló · ${where}`, [e.detail, e.message].filter(Boolean).join(": "));
    case "notification":
      if (e.detail === "permission_prompt") {
        // Claude Code lo dispara tras ~6 s sin que escribas: sirve para volver a la laptop aunque el modo ausente esté apagado.
        return ctx.hasPendingApproval ? null : make(`Claude espera permiso · ${where}`, e.message || "Hay un permiso pendiente en la terminal");
      }
      if (WAITING_NOTIFICATIONS.has(e.detail)) {
        const title = e.detail === "idle_prompt" ? `Claude te espera · ${where}` : `Claude necesita tu atención · ${where}`;
        return make(title, e.message || "Está esperando tu respuesta");
      }
      return null;
    default:
      return null;
  }
}
