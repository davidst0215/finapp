// Lógica pura de la pantalla de agenda: qué eventos van en cada día, dónde cae la marca "ahora" y los textos de cada fila.
import { minutesOf } from '../google/lima.ts';
import type { CalEvent } from '../google/types.ts';

export type TimelineRow = { kind: 'event'; event: CalEvent } | { kind: 'now'; hm: string };

/** Eventos que cubren el día `key`: primero los de todo el día, luego por hora. */
export function eventsOnDay(events: CalEvent[], key: string): CalEvent[] {
  return events
    .filter((e) => e.day_key <= key && key <= e.end_day_key)
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_hm.localeCompare(b.start_hm) || a.title.localeCompare(b.title));
}

/** Filas de la línea de tiempo. Si el día es hoy, la marca "ahora" se intercala entre lo que ya empezó y lo que falta. */
export function timelineRows(events: CalEvent[], key: string, todayKey: string, nowHM: string): TimelineRow[] {
  const day = eventsOnDay(events, key);
  const rows: TimelineRow[] = [];
  const showNow = key === todayKey && day.some((e) => !e.all_day);
  let placed = !showNow;
  for (const event of day) {
    if (!placed && !event.all_day && minutesOf(event.start_hm) > minutesOf(nowHM)) {
      rows.push({ kind: 'now', hm: nowHM });
      placed = true;
    }
    rows.push({ kind: 'event', event });
  }
  if (!placed) rows.push({ kind: 'now', hm: nowHM });
  return rows;
}

/** "Mónica, Juanjo" · "Mónica, Juanjo y 2 más" */
export function guestSummary(e: Pick<CalEvent, 'guests' | 'guest_names'>): string {
  const names = e.guest_names.slice(0, 2);
  if (names.length === 0) return e.guests === 1 ? '1 invitado' : `${e.guests} invitados`;
  const rest = e.guests - names.length;
  return rest > 0 ? `${names.join(', ')} y ${rest} más` : names.join(', ');
}

/** Segunda línea de la fila: Meet, lugar, invitados, estado. */
export function eventMeta(e: CalEvent): string {
  const parts: string[] = [];
  if (e.my_response === 'declined') parts.push('Declinado');
  if (e.kind === 'outOfOffice') parts.push('Fuera de oficina');
  if (e.kind === 'focusTime') parts.push('Concentración');
  if (e.meet_url) parts.push('Meet');
  if (e.location) parts.push(e.location);
  if (e.guests > 0) parts.push(guestSummary(e));
  return parts.join(' · ');
}

export function durationMinutes(e: Pick<CalEvent, 'start' | 'end'>): number {
  const ms = Date.parse(e.end) - Date.parse(e.start);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
}

/** Hora de inicio por defecto de un evento nuevo: la próxima media hora (o 09:00 si no es hoy). */
export function defaultStart(selectedKey: string, todayKey: string, nowHM: string): string {
  if (selectedKey !== todayKey) return '09:00';
  const next = Math.min(Math.ceil((minutesOf(nowHM) + 1) / 30) * 30, 23 * 60 + 30);
  return `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
}
