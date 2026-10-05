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
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const res = await claudeApi.sessionTimeline(sessionId, limit, controller.signal);
      if (controller.signal.aborted) return;
      setData(res);
      setFetchedAt(performance.now());
      writeCache(cacheKey, res);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof ApiError ? e.message : 'No se pudo cargar la conversación.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [sessionId, limit, cacheKey]);

  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      inFlight.current?.abort();
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
