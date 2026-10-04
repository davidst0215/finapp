import { localDateKey, toLocalDate } from '@/lib/utils';
import type { Destination } from './types';

// Helpers puros de presentación. El servidor ya agrupa, ordena y etiqueta fechas en hora de Lima:
// aquí solo se formatea lo que depende del reloj del cliente o de la forma de la pantalla.

/** El mensaje del servidor se muestra tal cual (VaultApiError extiende Error). */
export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Algo salió mal. Intenta de nuevo.';
}

/** Solo enlaces https: lo que venga con otro esquema (javascript:, http:) no se convierte en link. */
export function safeHttpsUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "Sincronizado hace 3 min" a partir del ISO del servidor. `now` entra por parámetro para que se re-renderice con el reloj. */
export function syncedLabel(syncedAt: string | null, now: number): string {
  const at = syncedAt ? Date.parse(syncedAt) : Number.NaN;
  if (Number.isNaN(at)) return 'Sin sincronizar';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'Sincronizado ahora';
  if (minutes < 60) return `Sincronizado hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Sincronizado hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Sincronizado hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Suma días a un AAAA-MM-DD sin pasar por UTC (new Date('2026-10-04') retrocede un día en Lima). */
export function addDaysISO(iso: string, days: number): string {
  const d = toLocalDate(iso);
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

const SHORT_DATE = new Intl.DateTimeFormat('es-PE', { weekday: 'short', day: 'numeric', month: 'short' });

/** "vie 9 oct" */
export function formatShortDate(iso: string): string {
  return SHORT_DATE.format(toLocalDate(iso)).replace(/[.,]/g, '');
}

export interface DestinationSection {
  project: string;
  items: Destination[];
  /** Un solo destino sin frente: se pinta como fila suelta, sin encabezado que repita su nombre. */
  flat: boolean;
}

/** Agrupa los destinos por proyecto conservando el orden del servidor. */
export function sectionize(destinations: readonly Destination[]): DestinationSection[] {
  const byProject = new Map<string, Destination[]>();
  for (const d of destinations) {
    const list = byProject.get(d.project);
    if (list) list.push(d);
    else byProject.set(d.project, [d]);
  }
  return Array.from(byProject, ([project, items]) => ({
    project,
    items,
    flat: items.length === 1 && items[0]?.frente == null,
  }));
}

export function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
