import { useCallback, useEffect, useRef, useState } from 'react';
import { briefApi } from './api';
import type { Brief } from './types';

export type BriefStatus = 'loading' | 'ready' | 'error';

/** Carga el último brief y permite generar el de hoy. Ignora respuestas de pedidos viejos. */
export function useBrief() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [hoy, setHoy] = useState<string | null>(null);
  const [status, setStatus] = useState<BriefStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false); // el brief mostrado no quedó guardado
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setStatus('loading');
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
      setStatus('error');
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
