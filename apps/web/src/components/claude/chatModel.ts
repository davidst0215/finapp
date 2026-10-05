// De la línea de tiempo del servidor a las filas que pinta el chat: separadores de día, agrupación de burbujas
// seguidas del mismo lado y la conversación de una tarea que aún no abrió sesión. Puro: se prueba en Node.

import { dayLabel } from './format.ts'; // con extensión: estas pruebas corren en Node sin compilar
import type { MessageStatus, TaskView, TimelineItem } from './types';

export type Side = 'user' | 'claude';

export type Row =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'item';
      key: string;
      item: TimelineItem;
      /** Burbujas seguidas del mismo lado dentro de 5 min forman un grupo: poca separación y la hora solo al final. */
      groupStart: boolean;
      groupEnd: boolean;
    };

const GROUP_GAP_MS = 5 * 60_000;

const sideOf = (item: TimelineItem): Side | null => (item.type === 'user' ? 'user' : item.type === 'claude' ? 'claude' : null);

export function buildRows(items: TimelineItem[], nowMs: number): Row[] {
  const rows: Row[] = [];
  items.forEach((item, i) => {
    const label = dayLabel(item.at, nowMs);
    const prev = items[i - 1];
    const next = items[i + 1];
    // La etiqueta cambia con el día (Hoy, Ayer, «lunes, 29 sep»): comparar etiquetas basta.
    if (prev === undefined || dayLabel(prev.at, nowMs) !== label) rows.push({ kind: 'day', key: `d:${item.id}`, label });

    const side = sideOf(item);
    const joins = (other: TimelineItem | undefined) =>
      side !== null &&
      other !== undefined &&
      sideOf(other) === side &&
      dayLabel(other.at, nowMs) === label &&
      Math.abs(Date.parse(item.at) - Date.parse(other.at)) <= GROUP_GAP_MS;
    rows.push({ kind: 'item', key: item.id, item, groupStart: !joins(prev), groupEnd: !joins(next) });
  });
  return rows;
}

const MESSAGE_TICKS: Record<MessageStatus, { label: string; ticks: 0 | 1 | 2 }> = {
  en_cola: { label: 'En cola', ticks: 1 },
  entregando: { label: 'Entregando…', ticks: 1 },
  entregado: { label: 'Entregado', ticks: 2 },
  vencido: { label: 'No se entregó', ticks: 0 },
};

/** Estado de entrega estilo ticks: un tick = salió del celular, dos = Claude lo recibió. */
export const deliveryOf = (status: MessageStatus) => MESSAGE_TICKS[status];

/**
 * Conversación de una tarea que todavía no abrió sesión (en cola, rechazada, vencida): el encargo de David y cómo va.
 * Cuando la tarea abre su sesión, la pantalla salta a la conversación real.
 */
export function taskTimeline(task: TaskView): TimelineItem[] {
  const items: TimelineItem[] = [{ id: `t:${task.id}`, at: task.created_at, type: 'user', source: 'task', text: task.prompt, delivery: null }];
  if (task.started_at) items.push({ id: `t:${task.id}:start`, at: task.started_at, type: 'system', text: 'Tarea iniciada' });
  if (task.progress && task.status === 'ejecutando') {
    items.push({ id: `t:${task.id}:progress`, at: task.started_at ?? task.created_at, type: 'claude', tone: 'notice', text: task.progress });
  }
  if (task.finished_at) {
    const bad = task.status === 'fallida' || task.status === 'rechazada';
    if (task.status === 'terminada' && task.result) {
      items.push({ id: `t:${task.id}:result`, at: task.finished_at, type: 'claude', tone: 'reply', text: task.result });
    }
    if (bad && task.error) items.push({ id: `t:${task.id}:error`, at: task.finished_at, type: 'claude', tone: 'error', text: task.error });
    const word: Record<string, string> = {
      terminada: 'Tarea terminada',
      fallida: 'Tarea fallida',
      cancelada: 'Tarea cancelada',
      rechazada: 'Tu laptop no aceptó la tarea',
      vencida: 'La tarea venció sin ejecutarse: la laptop no respondió',
    };
    items.push({ id: `t:${task.id}:end`, at: task.finished_at, type: 'system', text: word[task.status] ?? 'Tarea terminada' });
  }
  return items;
}
