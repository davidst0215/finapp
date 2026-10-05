// Línea de tiempo de una sesión como chat: mezcla eventos, mensajes del celular, permisos y la tarea que la abrió,
// en orden cronológico. Puro (sin base ni reloj propio): se prueba en Node. La arma handlers.ts con lo que lee del Store.
//
// Compatibilidad: los eventos anteriores a 013 existen sin `user_prompt` y con resúmenes de una línea (≤ 300);
// se pintan igual (solo faltan los mensajes de la laptop). Un mensaje del celular entregado antes de 013 no tiene
// texto (`text: null`): la app lo muestra como "Mensaje enviado desde el celular".

import { redactSecrets } from "./redact.ts";
import type { ApprovalRow, EventRow, MessageRow, TaskRow } from "./types.ts";
import type { ApprovalView, MessageStatus } from "./types.ts";
import { toApprovalView } from "./views.ts";

export type TimelineItem =
  /** Lo que David escribió: en la laptop, desde el celular, o el encargo de una tarea lanzada desde el celular. */
  | { id: string; at: string; type: "user"; source: "laptop" | "phone" | "task"; text: string | null; delivery: MessageStatus | null }
  /** Lo que dice Claude: respuesta al fin de un turno, aviso o error. */
  | { id: string; at: string; type: "claude"; tone: "reply" | "notice" | "error"; text: string }
  /** Eventos de sistema: chips pequeños y centrados. */
  | { id: string; at: string; type: "system"; text: string }
  /** Un permiso. Pendiente = tarjeta con Aprobar/Rechazar; resuelto = chip. */
  | { id: string; at: string; type: "approval"; approval: ApprovalView };

export interface TimelineSources {
  sessionId: string;
  events: EventRow[];
  messages: MessageRow[];
  approvals: ApprovalRow[];
  /** Todas las tareas del usuario; aquí solo cuentan las que abrieron esta sesión. */
  tasks: TaskRow[];
  nowMs: number;
}

// Textos fijos que genera events.ts: no son una respuesta de Claude, son un fin de turno sin mensaje.
const EMPTY_STOP = "Terminó de responder";

const NOTICE_CHIPS: Record<string, string> = {
  idle_prompt: "Claude te espera",
  permission_prompt: "Claude espera un permiso en la terminal",
  elicitation_dialog: "Claude te hizo una pregunta en la terminal",
  elicitation_url_dialog: "Claude te hizo una pregunta en la terminal",
  agent_needs_input: "Claude necesita tu atención",
  test: "Conexión de la laptop verificada",
};

// Lo que David escribe no se redacta al guardarlo (cambiaría lo que quiso decir), pero tampoco sale sin pasar por las
// reglas de secretos: el chat se guarda en la nube y se lee en un celular.
const shown = (text: string | null): string | null => (text === null ? null : redactSecrets(text));

function fromEvent(e: EventRow, approvalTimes: Set<number>): TimelineItem | null {
  const base = { id: `e:${e.event_id}`, at: e.created_at };
  switch (e.kind) {
    case "user_prompt":
      return { ...base, type: "user", source: "laptop", text: shown(e.summary), delivery: null };
    case "stop":
      return e.summary === EMPTY_STOP ? { ...base, type: "system", text: "Claude terminó" } : { ...base, type: "claude", tone: "reply", text: e.summary };
    case "stop_failure":
      return { ...base, type: "claude", tone: "error", text: e.summary };
    case "notification": {
      const chip = NOTICE_CHIPS[e.detail ?? ""];
      return chip ? { ...base, type: "system", text: chip } : { ...base, type: "claude", tone: "notice", text: e.summary };
    }
    case "session_start":
    case "session_end":
      return { ...base, type: "system", text: e.summary };
    case "permission_request":
      // Con modo ausente, el permiso ya es una tarjeta (misma marca de tiempo). Sin él, queda el aviso de que se pidió.
      return approvalTimes.has(Date.parse(e.created_at)) ? null : { ...base, type: "system", text: `Pidió permiso en la terminal: ${e.summary}` };
  }
}

const taskText = (t: TaskRow) => (t.status === "terminada" ? "Tarea terminada" : t.status === "cancelada" ? "Tarea cancelada" : `Tarea ${t.status === "fallida" ? "falló" : t.status}`);

function fromTask(t: TaskRow): TimelineItem[] {
  const out: TimelineItem[] = [{ id: `t:${t.task_id}`, at: t.created_at, type: "user", source: "task", text: shown(t.prompt), delivery: null }];
  if (t.started_at) out.push({ id: `t:${t.task_id}:start`, at: t.started_at, type: "system", text: "Tarea iniciada" });
  if (t.finished_at) {
    const why = t.status === "fallida" || t.status === "rechazada" ? (t.error ? `: ${t.error}` : "") : "";
    out.push({ id: `t:${t.task_id}:end`, at: t.finished_at, type: "system", text: `${taskText(t)}${why}` });
  }
  return out;
}

// Mismo instante: el mensaje de David antes que la respuesta, y los chips al final del grupo.
const ORDER: Record<TimelineItem["type"], number> = { user: 0, claude: 1, approval: 2, system: 3 };

/** Los últimos `limit` elementos en orden cronológico (el más reciente al final) y si hay más atrás. */
export function buildTimeline(src: TimelineSources, limit: number): { items: TimelineItem[]; hasMore: boolean } {
  const approvalTimes = new Set(src.approvals.map((a) => Date.parse(a.created_at)));
  const items: TimelineItem[] = [];

  for (const e of src.events) {
    const item = fromEvent(e, approvalTimes);
    if (item) items.push(item);
  }
  for (const m of src.messages) {
    items.push({ id: `m:${m.message_id}`, at: m.created_at, type: "user", source: "phone", text: shown(m.body), delivery: m.status });
  }
  for (const a of src.approvals) items.push({ id: `a:${a.approval_id}`, at: a.created_at, type: "approval", approval: toApprovalView(a, src.nowMs) });
  for (const t of src.tasks) if (t.session_id === src.sessionId) items.push(...fromTask(t));

  // Por instante, no por texto: PostgREST y JS no escriben igual los decimales de un timestamp.
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || ORDER[a.type] - ORDER[b.type] || a.id.localeCompare(b.id));

  // Cada fuente trae como mucho `limit` filas: si alguna llegó al tope, puede haber más atrás aunque no se vea aquí.
  const maybeMore = [src.events, src.messages, src.approvals].some((rows) => rows.length >= limit);
  return { items: items.slice(-limit), hasMore: items.length > limit || maybeMore };
}
