// Bandeja de avisos: carga, refresco automático y marcar como leído (con actualización inmediata).
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushApi, type Notice } from './api';

export type InboxStatus = 'loading' | 'ready' | 'error';

type InboxData = { items: Notice[]; unread: number };

export function useInbox() {
  const [data, setData] = useState<InboxData>({ items: [], unread: 0 });
  const [status, setStatus] = useState<InboxStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const loaded = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await pushApi.inbox();
      if (!alive.current) return;
      loaded.current = true;
      setData({ items: result.items, unread: result.unread });
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (!alive.current || loaded.current) return; // un refresco que falla no borra lo que ya se ve
      setError(e instanceof Error ? e.message : 'No se pudo cargar la bandeja.');
      setStatus('error');
    }
  }, []);

  const retry = useCallback(() => {
    setStatus('loading');
    return load();
  }, [load]);

  // Al entrar, al volver a la app y cuando el service worker avisa de que llegó un push.
  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'wabid:aviso') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
    };
  }, [load]);

  // Se refleja al instante; si el servidor falla, se vuelve a leer la verdad.
  const markRead = useCallback(
    async (ids: string[]) => {
      const now = new Date().toISOString();
      setData((prev) => {
        const flipped = prev.items.filter((n) => ids.includes(n.id) && n.readAt === null).length;
        if (flipped === 0) return prev;
        return {
          items: prev.items.map((n) => (ids.includes(n.id) && n.readAt === null ? { ...n, readAt: now } : n)),
          unread: Math.max(0, prev.unread - flipped),
        };
      });
      try {
        await pushApi.markRead(ids);
      } catch {
        void load();
      }
    },
    [load],
  );

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setData((prev) => ({ items: prev.items.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)), unread: 0 }));
    try {
      await pushApi.markAllRead();
    } catch {
      void load();
    }
  }, [load]);

  return { items: data.items, unread: data.unread, status, error, reload: load, retry, markRead, markAllRead };
}
