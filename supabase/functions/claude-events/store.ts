// Puerto de persistencia de la función. Toda operación que toca datos de un usuario recibe su `userId`:
// no existe forma de consultar o modificar filas sin decir de quién son (la autorización por construcción).
// Implementaciones: supabase-store.ts (producción) y memory-store.ts (pruebas).

import type { ApprovalRow, ApprovalStatus, DeviceRow, EventKind, EventRow, MessageRow, SessionRow, TaskRow, TaskStatus } from "./types.ts";

export interface NewDevice {
  device_id: string;
  user_id: string;
  name: string;
  token_hash: string;
}

export interface NewApproval {
  approval_id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  project: string;
  tool_name: string;
  description: string | null;
  preview: string;
  preview_truncated: boolean;
  created_at: string;
  expires_at: string;
}

export type NewEvent = Omit<EventRow, "event_id">;

/** Qué aprobaciones pendientes dar por vencidas. Sin `all`, solo las que ya pasaron su `expires_at`. */
export interface ExpireScope {
  deviceId?: string;
  sessionId?: string;
  all?: boolean;
}

export interface NewMessage {
  message_id: string;
  user_id: string;
  session_id: string;
  device_id: string;
  body: string;
  created_at: string;
  expires_at: string;
}

export interface NewTask {
  task_id: string;
  user_id: string;
  device_id: string;
  project: string;
  prompt: string;
  created_at: string;
  expires_at: string;
  /** 014: tarea de retomar una sesión. Sin `kind` es una tarea nueva. */
  kind?: "new" | "resume";
  resume_session_id?: string | null;
  resume_cwd?: string | null;
}

/** Campos que el runner o la app pueden cambiar en una tarea. */
export interface TaskPatch {
  status?: TaskStatus;
  /** Al terminar la tarea se reemplaza por un resumen redactado y corto (retención mínima). */
  prompt?: string;
  cancel_requested?: boolean;
  session_id?: string | null;
  progress?: string | null;
  result?: string | null;
  error?: string | null;
  started_at?: string | null;
  updated_at?: string;
  finished_at?: string | null;
}

export interface Cutoffs {
  /** Se borran los eventos anteriores a esta fecha (ISO). */
  events: string;
  approvals: string;
  sessions: string;
  /** Mensajes ya entregados o vencidos (sin texto) anteriores a esta fecha. */
  messages?: string;
  /** Tareas terminadas anteriores a esta fecha. */
  tasks?: string;
}

export interface Store {
  // --- Dispositivos
  /** Sin userId a propósito: es la autenticación (el token trae el id del dispositivo). */
  findDevice(deviceId: string): Promise<DeviceRow | null>;
  insertDevice(row: NewDevice): Promise<DeviceRow>;
  /** Solo los no revocados, del más antiguo al más nuevo. */
  listDevices(userId: string): Promise<DeviceRow[]>;
  patchDevice(userId: string, deviceId: string, patch: { name?: string; approvals_enabled?: boolean }): Promise<DeviceRow | null>;
  /** null si no existe, no es del usuario o ya estaba revocado. */
  revokeDevice(userId: string, deviceId: string, atIso: string): Promise<DeviceRow | null>;
  touchDevice(deviceId: string, atIso: string): Promise<void>;

  // --- Sesiones y eventos
  getSession(userId: string, sessionId: string): Promise<SessionRow | null>;
  /** Inserta o reemplaza por (user_id, session_id). */
  saveSession(row: SessionRow): Promise<void>;
  insertEvent(row: NewEvent): Promise<void>;
  /** Cambia SOLO la vista previa de la lista (last_summary y last_role); no toca estado, fechas ni nada más (013). */
  touchSessionPreview(userId: string, sessionId: string, summary: string, role: "usuario" | "claude"): Promise<void>;
  /** Eventos del dispositivo desde la fecha; con `kinds`, solo de esos tipos. */
  countEventsSince(deviceId: string, sinceIso: string, kinds?: EventKind[]): Promise<number>;
  /** Sesiones que este dispositivo creó (started_at) desde la fecha. */
  countSessionsSince(deviceId: string, sinceIso: string): Promise<number>;
  /** Más recientes primero. */
  listSessions(userId: string, limit: number): Promise<SessionRow[]>;
  /** Más recientes primero. */
  listEvents(userId: string, sessionId: string, limit: number): Promise<EventRow[]>;
  prune(userId: string, cutoffs: Cutoffs): Promise<void>;

  // --- Aprobaciones
  /** Pendientes que aún no vencen (expires_at > nowIso), opcionalmente de un dispositivo y/o una sesión. */
  countPending(userId: string, nowIso: string, scope?: { deviceId?: string; sessionId?: string }): Promise<number>;
  insertApproval(row: NewApproval): Promise<ApprovalRow>;
  findApproval(userId: string, approvalId: string): Promise<ApprovalRow | null>;
  /** Más recientes primero. */
  listApprovals(userId: string, opts: { statuses: ApprovalStatus[]; sinceIso?: string; limit: number }): Promise<ApprovalRow[]>;
  /** De cualquier estado, de una sola sesión, más recientes primero (013). */
  listSessionApprovals(userId: string, sessionId: string, limit: number): Promise<ApprovalRow[]>;
  /**
   * Transición atómica pendiente → aprobada|denegada, solo si sigue pendiente y no venció.
   * Devuelve la fila actualizada, o null si no hubo transición (no existe, ya decidida o vencida).
   */
  decideApproval(userId: string, approvalId: string, status: "aprobada" | "denegada", byUserId: string, nowIso: string): Promise<ApprovalRow | null>;
  expireApprovals(userId: string, nowIso: string, scope?: ExpireScope): Promise<void>;

  // --- v2 (012): runner y mensajes ---------------------------------------------------------------------------
  /** Guarda los nombres de proyecto que reporta el runner y su último contacto. */
  setRunnerState(deviceId: string, projects: string[], atIso: string): Promise<void>;

  /** Mensajes en cola de esa sesión que aún no vencen. */
  countQueuedMessages(userId: string, sessionId: string, nowIso: string): Promise<number>;
  insertMessage(row: NewMessage): Promise<MessageRow>;
  /**
   * Fase 1 de la entrega. Reclamo atómico del mensaje en cola más antiguo de la sesión: pasa a 'entregando'
   * (UPDATE condicional status = 'en_cola'; el texto sigue guardado hasta la confirmación). Devuelve el texto o null.
   */
  claimNextMessage(userId: string, sessionId: string, nowIso: string): Promise<{ messageId: string; text: string } | null>;
  /** Fase 2: el hook ya escribió el texto. 'entregando' -> 'entregado'. El texto se CONSERVA (013: lo muestra el chat). false si no hubo transición. */
  ackMessage(userId: string, messageId: string, deviceId: string, nowIso: string): Promise<boolean>;
  /** Reclamos sin confirmar desde `olderThanIso` vuelven a la cola. */
  requeueStaleMessages(userId: string, olderThanIso: string): Promise<void>;
  /** Mensajes sin confirmar (en cola o entregando) con expires_at <= ahora pasan a 'vencido' y pierden el texto. */
  expireMessages(userId: string, nowIso: string): Promise<void>;
  /** Más recientes primero. Nunca devuelve el texto. */
  listMessages(userId: string, limit: number): Promise<MessageRow[]>;
  /** Más recientes primero, CON texto (013): solo para la línea de tiempo de una sesión; nunca va a la vista general. */
  listSessionMessages(userId: string, sessionId: string, limit: number): Promise<MessageRow[]>;

  // --- 014: retomar sesiones quietas con el runner -----------------------------------------------------------
  /** Mensajes 'en_cola' del dispositivo creados antes de `olderThanIso` y sin vencer, con texto, los más viejos primero. */
  listStalledMessages(userId: string, deviceId: string, olderThanIso: string, nowIso: string, limit: number): Promise<MessageRow[]>;
  /**
   * Reclamo atómico para retomar: 'en_cola' -> 'retomando' (UPDATE condicional status = 'en_cola') y guarda la tarea que lo lleva.
   * false si otro lo tomó antes (el hook Stop lo entregó o lo reclamó, o venció): ese mensaje NO se retoma.
   */
  claimMessageForResume(userId: string, messageId: string, taskId: string, nowIso: string): Promise<boolean>;
  /** La tarea no se pudo crear: sus mensajes 'retomando' vuelven a 'en_cola'. */
  releaseResumeMessages(userId: string, taskId: string): Promise<void>;
  /**
   * La tarea terminó: sus mensajes 'retomando' pasan a 'entregado' (ok; con `error` si la continuación se abrió pero terminó mal)
   * o a 'no_retomado' (con el motivo).
   */
  settleResumeMessages(userId: string, taskId: string, outcome: { ok: true; atIso: string; error?: string } | { ok: false; error: string }): Promise<void>;
  /** Mensajes 'retomando' reclamados antes de `claimedBeforeIso`: candidatos a huérfanos (la función murió antes de crear la tarea, o la tarea ya terminó). */
  listStaleResumeMessages(userId: string, claimedBeforeIso: string): Promise<MessageRow[]>;

  // --- v2 (012): tareas --------------------------------------------------------------------------------------
  countQueuedTasks(userId: string, nowIso: string): Promise<number>;
  insertTask(row: NewTask): Promise<TaskRow>;
  findTask(userId: string, taskId: string): Promise<TaskRow | null>;
  /** Más recientes primero. */
  listTasks(userId: string, limit: number): Promise<TaskRow[]>;
  /**
   * Reclamo atómico de la tarea en cola más antigua del dispositivo: pasa a 'ejecutando'. Devuelve null si no hay
   * o si el dispositivo ya tiene una ejecutándose (índice único parcial en la base).
   */
  claimNextTask(userId: string, deviceId: string, nowIso: string): Promise<TaskRow | null>;
  /** Actualiza solo si la tarea está en uno de `onlyIfStatus`. Devuelve la fila nueva o null si no hubo transición. */
  updateTask(userId: string, taskId: string, patch: TaskPatch, onlyIfStatus: TaskStatus[]): Promise<TaskRow | null>;
  /**
   * Barrido de tareas: en cola vencidas -> 'vencida'; 'ejecutando' del dispositivo sin latido desde `staleIso`
   * -> 'fallida' ("el runner dejó de responder"). Devuelve las filas que cambió: el handler les reduce el prompt a un
   * resumen redactado (la redacción vive en el servidor, no en SQL).
   */
  sweepTasks(userId: string, deviceId: string, nowIso: string, staleIso: string): Promise<TaskRow[]>;
}
