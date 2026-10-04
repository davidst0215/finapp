import { useEffect, useState } from 'react';

/** Reloj que se actualiza solo: mantiene al día etiquetas como "hace 3 min" sin pedir datos. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, intervalMs);
    // Al volver a la pestaña el intervalo pudo haberse dormido: se refresca de inmediato.
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs]);

  return now;
}
