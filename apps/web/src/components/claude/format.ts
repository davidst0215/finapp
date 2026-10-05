import type { ApprovalView, EventKind, MessageStatus, SessionView, TaskStatus, TaskView } from './types';

// Todo se muestra en hora de Lima (UTC-5): el celular de David puede cambiar de zona al viajar.
const TZ = 'America/Lima';
const clockFmt = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, day: 'numeric', month: 'short' });
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

const MIN = 60_000;
const HOUR = 60 * MIN;

/** "14:20" */
export const limaClock = (iso: string) => clockFmt.format(new Date(iso));

/** "14:20" si es de hoy (en Lima); "3 oct 14:20" si es de otro día. */
export function limaDayClock(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const sameDay = dayKeyFmt.format(d) === dayKeyFmt.format(new Date(nowMs));
  return sameDay ? clockFmt.format(d) : `${dayFmt.format(d).replace('.', '')} ${clockFmt.format(d)}`;
}

/** "hace un momento" · "hace 3 min" · "hace 2 h" · "hace 4 d" */
export function timeAgo(iso: string, nowMs: number): string {
  const diff = Math.max(0, nowMs - Date.parse(iso));
  if (diff < MIN) return 'hace un momento';
  if (diff < HOUR) return `hace ${Math.floor(diff / MIN)} min`;
  if (diff < 24 * HOUR) return `hace ${Math.floor(diff / HOUR)} h`;
  return `hace ${Math.floor(diff / (24 * HOUR))} d`;
}

/** Cuenta regresiva "1:42". Redondea hacia arriba para no mostrar 0:00 mientras todavía queda tiempo. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: 'Ejecutar un comando',
  PowerShell: 'Ejecutar un comando',
  Write: 'Crear o sobrescribir un archivo',
  Edit: 'Editar un archivo',
  MultiEdit: 'Editar un archivo',
  NotebookEdit: 'Editar un notebook',
  Read: 'Leer un archivo',
  Glob: 'Buscar archivos',
  Grep: 'Buscar en archivos',
  WebFetch: 'Abrir una página web',
  WebSearch: 'Buscar en la web',
  Agent: 'Lanzar un subagente',
  Task: 'Lanzar un subagente',
};

/** Qué pide Claude, en una frase. Las herramientas MCP (mcp__servidor__acción) se nombran por su servidor. */
export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `Usar ${mcp[2]} de ${mcp[1]}`;
  return `Usar ${toolName}`;
}

export type SessionTone = 'active' | 'waiting' | 'done' | 'error' | 'asking' | 'stale';

export interface SessionLine {
  tone: SessionTone;
  text: string;
}

// Una sesión sin señal por tanto tiempo ya no está "trabajando": probablemente se cerró la laptop sin SessionEnd.
const STALE_AFTER_MS = 6 * HOUR;

/** Estado de una sesión como texto. `asking` viene de tener una aprobación pendiente (no se guarda en la base). */
export function describeSession(session: SessionView, pending: ApprovalView | undefined, nowMs: number): SessionLine {
  if (pending) return { tone: 'asking', text: 'Pide permiso' };
  switch (session.status) {
    case 'terminada':
      return { tone: 'done', text: `Terminó ${limaDayClock(session.ended_at ?? session.last_event_at, nowMs)}` };
    case 'error':
      return { tone: 'error', text: `Falló · ${limaDayClock(session.last_event_at, nowMs)}` };
    case 'esperando':
    case 'trabajando': {
      if (nowMs - Date.parse(session.last_event_at) > STALE_AFTER_MS) {
        return { tone: 'stale', text: `Sin actividad desde ${limaDayClock(session.last_event_at, nowMs)}` };
      }
      return session.status === 'esperando'
        ? { tone: 'waiting', text: `Esperando tu instrucción · ${timeAgo(session.last_event_at, nowMs)}` }
        : { tone: 'active', text: `Trabajando · ${timeAgo(session.last_event_at, nowMs)}` };
    }
  }
}

const EVENT_WORDS: Record<EventKind, string> = {
  session_start: 'Inicio',
  session_end: 'Fin',
  stop: 'Respuesta',
  stop_failure: 'Falla',
  notification: 'Aviso',
  permission_request: 'Permiso',
};

export const eventWord = (kind: EventKind) => EVENT_WORDS[kind];

const MESSAGE_LABELS: Record<MessageStatus, string> = { en_cola: 'En cola', entregando: 'Entregando…', entregado: 'Entregado', vencido: 'Vencido' };
export const messageStatusLabel = (status: MessageStatus) => MESSAGE_LABELS[status];

const TASK_LABELS: Record<TaskStatus, string> = {
  en_cola: 'En cola',
  ejecutando: 'Ejecutando',
  terminada: 'Terminada',
  fallida: 'Fallida',
  cancelada: 'Cancelada',
  rechazada: 'Rechazada por la laptop',
  vencida: 'Venció sin ejecutarse',
};
export const taskStatusLabel = (status: TaskStatus) => TASK_LABELS[status];

/** Una tarea sigue viva (se puede cancelar) mientras esté en cola o ejecutándose. */
export const isTaskActive = (status: TaskStatus) => status === 'en_cola' || status === 'ejecutando';

/** "45 s" · "3 min" · "1 h 05 min". Vacío si aún no empezó. Una tarea viva cuenta hasta `nowMs`. */
export function taskDuration(task: Pick<TaskView, 'started_at' | 'finished_at'>, nowMs: number): string {
  if (!task.started_at) return '';
  const end = task.finished_at ? Date.parse(task.finished_at) : nowMs;
  const sec = Math.max(0, Math.round((end - Date.parse(task.started_at)) / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
