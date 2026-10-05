// Contrato de la función claude-events (rutas /ui/*), espejo de supabase/functions/claude-events/types.ts.
// Los textos libres ya vienen limpios y sin secretos: se muestran como texto plano, nunca como HTML.

export type SessionStatus = 'trabajando' | 'esperando' | 'terminada' | 'error';
export type ApprovalStatus = 'pendiente' | 'aprobada' | 'denegada' | 'vencida';
export type EventKind = 'session_start' | 'session_end' | 'stop' | 'stop_failure' | 'notification' | 'permission_request' | 'user_prompt';
/** Quién habló último en la sesión. null en sesiones anteriores a la migración 013. */
export type SessionRole = 'usuario' | 'claude';

export interface DeviceView {
  id: string;
  name: string;
  approvals_enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
  /** Runner de tareas de esa laptop: nombres de proyecto (nunca rutas) y si dio señal hace poco. */
  runner: { projects: string[]; online: boolean };
}

export interface SessionView {
  id: string;
  device_id: string;
  project: string;
  cwd: string | null;
  status: SessionStatus;
  summary: string | null;
  last_role: SessionRole | null;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  /** Sesión original de la que esta es continuación (se retomó desde el celular). */
  continued_from?: string | null;
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
  /** Lo que le queda, relativo al momento en que se pidió la vista general (no depende del reloj del celular). */
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

export interface Overview {
  now: string;
  devices: DeviceView[];
  sessions: SessionView[];
  pending: ApprovalView[];
  recent: ApprovalView[];
  messages: MessageView[];
  tasks: TaskView[];
}

/** 'retomando' = lo tomó el runner de la laptop; 'no_retomado' = no se pudo (ver `error`). */
export type MessageStatus = 'en_cola' | 'entregando' | 'entregado' | 'vencido' | 'retomando' | 'no_retomado';
export type TaskStatus = 'en_cola' | 'ejecutando' | 'terminada' | 'fallida' | 'cancelada' | 'rechazada' | 'vencida';

/** Nunca trae el texto: el servidor lo borra al entregar o vencer. */
export interface MessageView {
  id: string;
  session_id: string;
  status: MessageStatus;
  created_at: string;
  delivered_at: string | null;
  error?: string | null;
}

export interface TaskView {
  id: string;
  /** 'resume' = retomar una sesión con un mensaje del celular (no es una tarea nueva). */
  kind?: 'new' | 'resume';
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

// --- Chat (013): línea de tiempo de una sesión. Espejo de supabase/functions/claude-events/timeline.ts ---------------

export type QueueHint = 'turn' | 'idle_runner' | 'idle_no_runner';

export type TimelineItem =
  /** Lo que David escribió: en la laptop, desde el celular, o el encargo de una tarea lanzada desde el celular. */
  | {
      id: string;
      at: string;
      type: 'user';
      source: 'laptop' | 'phone' | 'task';
      text: string | null;
      delivery: MessageStatus | null;
      /** Por qué un mensaje del celular sigue en cola: Claude trabaja (turn) · quieto con runner · quieto sin runner. */
      queue?: QueueHint | null;
      /** Mensajes que no se pudieron retomar: el motivo. */
      note?: string | null;
      /** Sesión nueva donde el runner retomó la conversación con este mensaje. */
      continuation?: string | null;
    }
  /** Lo que dice Claude: respuesta al fin de un turno, aviso o error. */
  | { id: string; at: string; type: 'claude'; tone: 'reply' | 'notice' | 'error'; text: string }
  /** Eventos de sistema: chips pequeños y centrados. */
  | { id: string; at: string; type: 'system'; text: string }
  /** Un permiso: pendiente = tarjeta con Aprobar/Rechazar; resuelto = chip. */
  | { id: string; at: string; type: 'approval'; approval: ApprovalView };

export interface TimelineResponse {
  now: string;
  items: TimelineItem[];
  has_more: boolean;
  /** Si la sesión es una continuación (014): de cuál. */
  continued_from?: { id: string; project: string | null } | null;
}

export interface PairedDevice {
  device: DeviceView;
  /** Se muestra una sola vez: el servidor solo guarda su hash. */
  token: string;
  url: string;
}

export type Decision = 'aprobar' | 'denegar';
