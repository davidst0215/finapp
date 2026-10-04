import { readStorage, removeStorage, writeStorage } from '../tareas/storage';

// Búsquedas recientes: comodidad local (localStorage, con try/catch). Sin almacenamiento la pantalla funciona igual.

const KEY = 'wabid-buscar-recientes';
export const MAX_RECENTS = 8;

export function loadRecents(): string[] {
  const raw = readStorage(KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** La más reciente primero, sin repetir (sin distinguir mayúsculas), con tope de MAX_RECENTS. */
export function pushRecent(list: readonly string[], query: string): string[] {
  const key = query.toLocaleLowerCase('es');
  return [query, ...list.filter((item) => item.toLocaleLowerCase('es') !== key)].slice(0, MAX_RECENTS);
}

export function saveRecents(list: readonly string[]): void {
  writeStorage(KEY, JSON.stringify(list));
}

export function clearRecents(): void {
  removeStorage(KEY);
}
