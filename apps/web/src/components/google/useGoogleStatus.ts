import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, writeCache } from '@/lib/moduleCache';
import { googleCall, GoogleUiError } from './googleApi';
import type { GoogleStatus } from './types';

type State = { loading: boolean; status: GoogleStatus | null; error: string | null };

const KEY = 'google.status';

/**
 * Estado de la conexión con Google (barato: una consulta, sin llamar a Google). Con el último estado
 * guardado, Agenda y Correo piden sus datos de una vez en vez de esperar esta consulta primero.
 */
export function useGoogleStatus() {
  const [state, setState] = useState<State>(() => {
    const status = readCache<GoogleStatus>(KEY) ?? null;
    return { loading: !status, status, error: null };
  });
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const status = await googleCall<GoogleStatus>('status');
      writeCache(KEY, status);
      if (alive.current) setState({ loading: false, status, error: null });
    } catch (e) {
      if (alive.current) setState({ loading: false, status: null, error: e instanceof GoogleUiError ? e.message : 'No pude consultar Google.' });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  return { ...state, reload };
}
