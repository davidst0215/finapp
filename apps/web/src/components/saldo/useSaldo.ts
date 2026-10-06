import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, writeCache } from '@/lib/moduleCache';
import { cargarSaldo } from './api';
import type { Saldo } from './types';

const KEY = 'saldo';

/** Carga el saldo de IA. Con lo último guardado abre listo y refresca por detrás; un refresco que falla no tapa lo que ya se ve. */
export function useSaldo() {
  const [saldo, setSaldo] = useState<Saldo | null>(() => readCache<Saldo>(KEY) ?? null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => writeCache(KEY, saldo), [saldo]);

  const recargar = useCallback(async () => {
    const id = ++seq.current;
    setCargando(true);
    setError(null);
    try {
      const s = await cargarSaldo();
      if (id !== seq.current) return;
      setSaldo(s);
    } catch (e) {
      if (id !== seq.current) return;
      setError(e instanceof Error ? e.message : 'No pude consultar el saldo.');
    } finally {
      if (id === seq.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
    return () => {
      seq.current++;
    };
  }, [recargar]);

  return { saldo, cargando, error, recargar };
}
