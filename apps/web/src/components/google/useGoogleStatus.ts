import { useCallback, useEffect, useRef, useState } from 'react';
import { googleCall, GoogleUiError } from './googleApi';
import type { GoogleStatus } from './types';

type State = { loading: boolean; status: GoogleStatus | null; error: string | null };

/** Estado de la conexión con Google (barato: una consulta, sin llamar a Google). */
export function useGoogleStatus() {
  const [state, setState] = useState<State>({ loading: true, status: null, error: null });
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const status = await googleCall<GoogleStatus>('status');
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
