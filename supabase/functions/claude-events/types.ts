// Tipos del módulo claude-code: filas de la base, eventos del dispositivo y vistas que ve la app.
// Solo tipos: sin globals de Deno ni imports de jsr (las pruebas corren en Node).

export type SessionStatus = "trabajando" | "esperando" | "terminada" | "error";
export type EventKind = "session_start" | "session_end" | "stop" | "stop_failure" | "notification" | "permission_request";
export type ApprovalStatus = "pendiente" | "aprobada" | "denegada" | "vencida";

export const EVENT_KINDS: readonly EventKind[] = [
  "session_start",
  "session_end",
  "stop",
  "stop_failure",
  "notification",
  "permission_request",
];

// --- Filas de la base (migración 008) ---------------------------------------------------------------------

export interface DeviceRow {
  device_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  approvals_enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** Nombres (no rutas) de los proyectos que el runner de la laptop dice poder abrir (012). */
  runner_projects: string[];
  runner_seen_at: string | null;
}

export interface SessionRow {
  user_id: string;
  session_id: string;
  device_id: string;
  project: string;
  cwd: string | null;
  status: SessionStatus;
  last_summary: string | null;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
}

export interface EventRow {
  event_id: string;
  user_id: string;
  session_id: string;
  device_id: string;
  kind: EventKind;
  detail: string | null;
  summary: string;
  created_at: string;
}

export interface ApprovalRow {
  approval_id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  project: string;
  tool_name: string;
  description: string | null;
  preview: string;
  preview_truncated: boolean;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

// --- Evento que manda el hook de la laptop (ya validado y limpio) -----------------------------------------

export interface ParsedEvent {
  type: EventKind;
  sessionId: string;
  project: string;
  cwd: string | null;
  detail: string;
  message: string;
  toolName: string;
  preview: string;
  previewTruncated: boolean;
  description: string;
}

// --- Vistas hacia la app (nunca incluyen token_hash) -------------------------------------------------------

export interface DeviceView {
  id: string;
  name: string;
  approvals_enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
  runner: { projects: string[]; online: boolean };
}

export interface SessionView {
  id: string;
  device_id: string;
  project: string;
  cwd: string | null;
  status: SessionStatus;
  summary: string | null;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
}

export interface ApprovalView {
  id: string;
  session_id: string;
  project: string;
  tool_name: string;
  description: string | null;
  preview: string;
  truncated: boolean;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  /** Milisegundos que le quedan (0 si ya no está pendiente). Relativo: no depende del reloj del celular. */
  expires_in_ms: number;
  decided_at: string | null;
}

export interface EventView {
  id: string;
  kind: EventKind;
  detail: string | null;
  summary: string;
  created_at: string;
}

// --- Contrato HTTP (la entrada de index.ts convierte Request/Response a esto) ------------------------------

export interface ApiRequest {
  method: string;
  /** Ruta ya sin consulta (?...). Puede traer el prefijo /claude-events. */
  path: string;
  headers: Headers;
  /** Cuerpo en texto (vacío si no hay). Index.ts ya aplicó el tope de tamaño. */
  body: string;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

// --- v2 (012): mensajes al celular -> sesión y tareas nuevas -------------------------------------------------

export type MessageStatus = "en_cola" | "entregado" | "vencido";
export type TaskStatus = "en_cola" | "ejecutando" | "terminada" | "fallida" | "cancelada" | "rechazada" | "vencida";
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ["terminada", "fallida", "cancelada", "rechazada", "vencida"];

export interface MessageRow {
  message_id: string;
  user_id: string;
  session_id: string;
  device_id: string;
  /** Solo mientras status = 'en_cola'; null al entregar o vencer. */
  body: string | null;
  status: MessageStatus;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
}

export interface TaskRow {
  task_id: string;
  user_id: string;
  device_id: string;
  project: string;
  prompt: string;
  status: TaskStatus;
  cancel_requested: boolean;
  session_id: string | null;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

/** Nunca incluye el texto. */
export interface MessageView {
  id: string;
  session_id: string;
  status: MessageStatus;
  created_at: string;
  delivered_at: string | null;
}

export interface TaskView {
  id: string;
  project: string;
  prompt: string;
  status: TaskStatus;
  cancel_requested: boolean;
  session_id: string | null;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
