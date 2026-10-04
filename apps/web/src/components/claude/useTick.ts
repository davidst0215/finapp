import { useEffect, useState } from 'react';

/** Vuelve a renderizar cada `ms` y devuelve Date.now(). Para textos relativos ("hace 3 min"). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Milisegundos que le quedan a algo que venció `expiresInMs` después de `fetchedAt` (performance.now()).
 * Relativo al momento de la consulta: no depende de que el reloj del celular coincida con el del servidor.
 */
export function useRemaining(expiresInMs: number, fetchedAt: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, expiresInMs - (performance.now() - fetchedAt));
}
