import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

// Lo último que mostró cada módulo, mientras la app está abierta. Al volver a un módulo se pinta al
// instante y su carga de siempre lo refresca por detrás; antes cada visita era spinner y todo desde cero.
// Solo en memoria: correos, tareas y montos no quedan guardados en el teléfono. Se vacía al cerrar sesión.
const entries = new Map<string, unknown>();

export const readCache = <T,>(key: string): T | undefined => entries.get(key) as T | undefined;

export function writeCache<T>(key: string, value: T | null | undefined) {
  if (value == null) entries.delete(key);
  else entries.set(key, value);
}

export const clearCache = () => entries.clear();

/** useState que arranca con lo último guardado bajo `key` y guarda cada cambio. Una key fija por dato. */
export function useCachedState<T>(key: string): [T | null, Dispatch<SetStateAction<T | null>>] {
  const [value, setValue] = useState<T | null>(() => readCache<T>(key) ?? null);
  useEffect(() => writeCache(key, value), [key, value]);
  return [value, setValue];
}
