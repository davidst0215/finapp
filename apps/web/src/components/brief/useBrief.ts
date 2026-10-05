import { useCallback, useEffect, useRef, useState } from 'react';
import { readCache, writeCache } from '@/lib/moduleCache';
import { briefApi } from './api';
import type { Brief } from './types';

export type BriefStatus = 'loading' | 'ready' | 'error';

type Snapshot = { brief: Brief | null; hoy: string | null; preview: boolean };
const KEY = 'brief';

/** Carga el último brief y permite generar el de hoy. Ignora respuestas de pedidos viejos. */
export function useBrief() {
  // Con lo último guardado la pantalla abre lista y la carga lo actualiza por detrás.
  const [initial] = useState(() => readCache<Snapshot>(KEY));
  const [brief, setBrief] = useState<Brief | null>(initial?.brief ?? null);
  const [hoy, setHoy] = useState<string | null>(initial?.hoy ?? null);
  const [status, setStatus] = useState<BriefStatus>(initial ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(initial?.preview ?? false); // el brief mostrado no quedó guardado
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (status === 'ready') writeCache<Snapshot>(KEY, { brief, hoy, preview });
  }, [status, brief, hoy, preview]);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    setError(null);
    try {
      const res = await briefApi.latest();
      if (id !== seq.current) return;
      setBrief(res.brief);
      setPreview(false);
      setHoy(res.hoy);
      setStatus('ready');
    } catch (e) {
      if (id !== seq.current) return;
      setError(e instanceof Error ? e.message : 'No pude cargar tu brief.');
      setStatus((s) => (s === 'ready' ? s : 'error')); // un refresco que falla no tapa el brief que ya se ve
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const generate = useCallback(async (force = false) => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await briefApi.generate(force);
      setBrief(res.brief);
      setPreview(!res.persistido);
      setHoy(res.brief.fecha);
      setStatus('ready');
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'No pude armar el brief.');
    } finally {
      setGenerating(false);
    }
  }, []);

  return { brief, preview, hoy, status, error, reload: load, generate, generating, generateError };
}
