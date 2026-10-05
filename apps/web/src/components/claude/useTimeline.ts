import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readCache, writeCache } from '@/lib/moduleCache';
import { ApiError, claudeApi } from './api';
import { POLL_MS } from './useClaudeOverview';
import type { TimelineItem, TimelineResponse } from './types';

const PAGE = 60;

/**
 * La conversación de una sesión: los últimos N elementos, al día mientras la pantalla está a la vista (sondeo, ver el porqué en
 * useClaudeOverview). Un mensaje que David acaba de enviar se pinta al instante y se reemplaza por el del servidor cuando llega.
 */
export function useTimeline(sessionId: string | null) {
  const cacheKey = `claude.timeline.${sessionId}`;
  const [data, setData] = useState<TimelineResponse | null>(() => (sessionId ? (readCache<TimelineResponse>(cacheKey) ?? null) : null));
  /** performance.now() del último éxito: las cuentas regresivas de los permisos cuentan desde aquí. */
  const [fetchedAt, setFetchedAt] = useState(() => performance.now());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => data === null);
  const [limit, setLimit] = useState(PAGE);
  const [local, setLocal] = useState<TimelineItem[]>([]);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  const timer = useRef<number | null>(null);

  // Una consulta a la vez: si hay una en vuelo, el sondeo salta ese tick (no la aborta, así una red lenta no deja la
  // conversación sin actualizarse nunca) y una acción de David (enviar, decidir) pide una vuelta más al terminar.
  // Solo se aborta al desmontar o al cambiar el límite. Un 404 (sesión podada) detiene el sondeo: no volverá.
  const refresh = useCallback(async () => {
    if (!sessionId || stopped.current) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    const mine = new AbortController();
    controller.current = mine;
    busy.current = true;
    try {
      do {
        again.current = false;
        try {
          const res = await claudeApi.sessionTimeline(sessionId, limit, mine.signal);
          if (mine.signal.aborted) return;
          setData(res);
          setFetchedAt(performance.now());
          writeCache(cacheKey, res);
          setError(null);
        } catch (e) {
          if (mine.signal.aborted) return;
          if (e instanceof ApiError && e.status === 404) {
            stopped.current = true;
            if (timer.current !== null) window.clearInterval(timer.current);
            setError('Esta conversación ya no existe.');
            return;
          }
          setError(e instanceof ApiError ? e.message : 'No se pudo cargar la conversación.');
        } finally {
          if (!mine.signal.aborted) setLoading(false);
        }
      } while (again.current && !mine.signal.aborted);
    } finally {
      if (controller.current === mine) busy.current = false;
    }
  }, [sessionId, limit, cacheKey]);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    timer.current = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      document.removeEventListener('visibilitychange', tick);
      controller.current?.abort();
      busy.current = false;
    };
  }, [refresh]);

  /** Pinta ya un mensaje del celular que el servidor aceptó; cuando la línea de tiempo lo trae, deja de ser local. */
  const addLocal = useCallback((item: TimelineItem) => setLocal((prev) => [...prev, item]), []);

  const items = useMemo(() => {
    const server = data?.items ?? [];
    const known = new Set(server.map((i) => i.id));
    const extra = local.filter((i) => !known.has(i.id));
    return extra.length === 0 ? server : [...server, ...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [data, local]);

  const loadOlder = useCallback(() => setLimit((l) => l + PAGE), []);

  return { items, hasMore: data?.has_more ?? false, fetchedAt, error, loading, refresh, addLocal, loadOlder };
}
