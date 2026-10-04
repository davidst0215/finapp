// Contrato de la función claude-events (rutas /ui/*), espejo de supabase/functions/claude-events/types.ts.
// Los textos libres ya vienen limpios y sin secretos: se muestran como texto plano, nunca como HTML.

export type SessionStatus = 'trabajando' | 'esperando' | 'terminada' | 'error';
export type ApprovalStatus = 'pendiente' | 'aprobada' | 'denegada' | 'vencida';
export type EventKind = 'session_start' | 'session_end' | 'stop' | 'stop_failure' | 'notification' | 'permission_request';

export interface DeviceView {
  id: string;
  name: string;
  approvals_enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
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
}

export interface PairedDevice {
  device: DeviceView;
  /** Se muestra una sola vez: el servidor solo guarda su hash. */
  token: string;
  url: string;
}

export type Decision = 'aprobar' | 'denegar';
