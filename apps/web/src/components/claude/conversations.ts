// De la vista general (sesiones, tareas, permisos) a la lista de conversaciones. Puro: sin React ni red, se prueba en Node.
// Cada sesión de Claude Code es un chat. Una tarea lanzada desde el celular es un chat más (etiqueta «tarea»): si ya abrió
// una sesión, es ESA sesión; mientras no (en cola, rechazada, vencida) aparece sola con su propio estado.

import { taskStatusLabel, timeAgo } from './format.ts'; // con extensión: estas pruebas corren en Node sin compilar
import type { ApprovalView, MessageView, Overview, SessionView, TaskStatus, TaskView } from './types';

// El estado se lee por forma y por texto, nunca solo por color (DESIGN.md): punto lleno = trabajando, anillo grueso = te
// espera, anillo con halo = te necesita, hueco = terminó, rojo (único color) = falló.
export type ConversationTone = 'active' | 'asking' | 'waiting' | 'queued' | 'done' | 'error' | 'stale';

export interface ConversationStatus {
  tone: ConversationTone;
  /** Legible de un vistazo: «Claude está trabajando…», «Te está esperando»… */
  label: string;
}

export interface Conversation {
  /** 's:<session_id>' o 't:<task_id>' */
  key: string;
  /** Ruta dentro de la pestaña (/claude/s/:id o /claude/t/:id). */
  path: string;
  sessionId: string | null;
  taskId: string | null;
  title: string;
  preview: string;
  /** Quién dijo la vista previa: «Tú: …» si fue David. */
  previewRole: 'usuario' | 'claude' | null;
  /** Última actividad (ISO): ordena la lista y da la hora. */
  at: string;
  status: ConversationStatus;
  /** Se abrió con una tarea lanzada desde el celular. */
  isTask: boolean;
  /** Permisos esperando respuesta. */
  pending: number;
  deviceId: string | null;
}

// Una sesión sin señal por tanto tiempo ya no está "trabajando": probablemente se cerró la laptop sin SessionEnd.
const STALE_AFTER_MS = 6 * 3_600_000;

export function sessionStatus(session: SessionView, pending: number, nowMs: number): ConversationStatus {
  if (pending > 0) return { tone: 'asking', label: 'Claude te necesita' };
  switch (session.status) {
    case 'terminada':
      return { tone: 'done', label: 'Terminó' };
    case 'error':
      return { tone: 'error', label: 'Falló' };
    case 'esperando':
    case 'trabajando':
      if (nowMs - Date.parse(session.last_event_at) > STALE_AFTER_MS) {
        return { tone: 'stale', label: 'Sin actividad' };
      }
      return session.status === 'esperando'
        ? { tone: 'waiting', label: 'Te está esperando' }
        : { tone: 'active', label: 'Claude está trabajando…' };
  }
}

const TASK_LABELS: Record<TaskStatus, ConversationStatus> = {
  en_cola: { tone: 'queued', label: 'En cola, esperando a tu laptop' },
  ejecutando: { tone: 'active', label: 'Claude está trabajando…' },
  terminada: { tone: 'done', label: 'Terminó' },
  fallida: { tone: 'error', label: 'Falló' },
  cancelada: { tone: 'done', label: 'Cancelada' },
  rechazada: { tone: 'error', label: 'Tu laptop no la aceptó' },
  vencida: { tone: 'stale', label: 'No se ejecutó: la laptop no respondió' },
};

export const taskConversationStatus = (task: TaskView): ConversationStatus =>
  task.cancel_requested && (task.status === 'ejecutando' || task.status === 'en_cola')
    ? { tone: 'active', label: 'Cancelando…' }
    : (TASK_LABELS[task.status] ?? { tone: 'done', label: taskStatusLabel(task.status) });

const newer = (a: string, b: string | undefined) => (b && Date.parse(b) > Date.parse(a) ? b : a);

function taskPreview(task: TaskView): { text: string; role: 'usuario' | 'claude' } {
  if (task.status === 'ejecutando' && task.progress) return { text: task.progress, role: 'claude' };
  if (task.status === 'terminada' && task.result) return { text: task.result, role: 'claude' };
  if ((task.status === 'fallida' || task.status === 'rechazada') && task.error) return { text: task.error, role: 'claude' };
  return { text: task.prompt, role: 'usuario' };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function buildConversations(overview: Overview, nowMs: number): Conversation[] {
  const pendingBySession = new Map<string, ApprovalView[]>();
  for (const a of overview.pending) pendingBySession.set(a.session_id, [...(pendingBySession.get(a.session_id) ?? []), a]);

  const lastMessageAt = new Map<string, string>();
  for (const m of overview.messages as MessageView[]) lastMessageAt.set(m.session_id, newer(m.created_at, lastMessageAt.get(m.session_id)));

  const taskBySession = new Map<string, TaskView>();
  // Retomar (014) no es una tarea nueva: su sesión es una continuación y el estado vive en el mensaje, no en la lista.
  for (const t of overview.tasks) if (t.session_id && t.kind !== 'resume') taskBySession.set(t.session_id, t);
  const sessionIds = new Set(overview.sessions.map((s) => s.id));

  const out: Conversation[] = overview.sessions.map((s) => {
    const pending = pendingBySession.get(s.id)?.length ?? 0;
    const task = taskBySession.get(s.id);
    return {
      key: `s:${s.id}`,
      path: `/claude/s/${encodeURIComponent(s.id)}`,
      sessionId: s.id,
      taskId: task?.id ?? null,
      title: s.project || 'Sesión de Claude Code',
      preview: oneLine(s.summary ?? '') || 'Sin mensajes todavía',
      previewRole: s.summary ? (s.last_role ?? null) : null, // un servidor anterior a 013 no manda last_role
      at: newer(s.last_event_at, lastMessageAt.get(s.id)),
      status: sessionStatus(s, pending, nowMs),
      isTask: task !== undefined,
      pending,
      deviceId: s.device_id,
    };
  });

  for (const t of overview.tasks) {
    if (t.kind === 'resume') continue;
    if (t.session_id && sessionIds.has(t.session_id)) continue; // ya es esa sesión
    const p = taskPreview(t);
    out.push({
      key: `t:${t.id}`,
      path: `/claude/t/${encodeURIComponent(t.id)}`,
      sessionId: t.session_id,
      taskId: t.id,
      title: t.project,
      preview: oneLine(p.text),
      previewRole: p.role,
      at: t.finished_at ?? t.started_at ?? t.created_at,
      status: taskConversationStatus(t),
      isTask: true,
      pending: 0,
      deviceId: null,
    });
  }

  // Lo que te necesita primero; luego lo más reciente.
  return out.sort((a, b) => Number(b.pending > 0) - Number(a.pending > 0) || Date.parse(b.at) - Date.parse(a.at));
}

/** «Legion 5 · última señal hace 3 min» / «Sin laptop conectada». Sin latido, «conectada» sería una afirmación que no podemos verificar. */
export function laptopLine(devices: Overview['devices'], nowMs: number): string {
  if (devices.length === 0) return 'Sin laptop conectada';
  const label = devices.length === 1 ? (devices[0]?.name ?? 'Laptop') : `${devices.length} laptops`;
  const seen = devices.flatMap((d) => (d.last_seen_at ? [d.last_seen_at] : [])).sort().pop();
  return seen ? `${label} · última señal ${timeAgo(seen, nowMs)}` : `${label} · esperando la primera señal`;
}
