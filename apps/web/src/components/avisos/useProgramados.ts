// Recordatorios próximos y preferencias de avisos automáticos (migración 017). Se leen y escriben directo contra las tablas con el
// JWT de David: la RLS limita todo a lo suyo, y solo permite crear recordatorios y CANCELAR (no editar la hora ni el estado de envío).
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { readCache, writeCache } from '@/lib/moduleCache';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';

export type Recordatorio = { id: string; titulo: string; cuando: string };
export type Prefs = { vencimientos: boolean; presupuestos: boolean };
export type PrefKey = keyof Prefs;
export type ProgramadosStatus = 'loading' | 'ready' | 'error';

type Data = { items: Recordatorio[]; prefs: Prefs };

const KEY = 'avisos-programados';
const TODO_ENCENDIDO: Prefs = { vencimientos: true, presupuestos: true };
const MAX_VISIBLES = 30;

async function leer(): Promise<Data> {
  const [lista, prefs] = await Promise.all([
    supabase
      .from('avisos_programados')
      .select('aviso_id, titulo, cuando')
      .in('origen', ['recordatorio', 'tarea']) // los de vencimientos y presupuestos los manda el sistema: no son "recordatorios"
      .eq('estado', 'pendiente')
      .order('cuando', { ascending: true })
      .limit(MAX_VISIBLES),
    supabase.from('avisos_preferencias').select('vencimientos, presupuestos').maybeSingle(),
  ]);
  if (lista.error) throw new Error(lista.error.message);
  if (prefs.error) throw new Error(prefs.error.message);
  return {
    items: (lista.data ?? []).map((r) => ({ id: r.aviso_id as string, titulo: r.titulo as string, cuando: r.cuando as string })),
    // Sin fila = todo encendido (así lo trata también el envío).
    prefs: prefs.data ? { vencimientos: Boolean(prefs.data.vencimientos), presupuestos: Boolean(prefs.data.presupuestos) } : TODO_ENCENDIDO,
  };
}

export function useProgramados() {
  const userId = useAuthStore((s) => s.user?.id);
  const [initial] = useState(() => readCache<Data>(KEY));
  const [data, setData] = useState<Data>(initial ?? { items: [], prefs: TODO_ENCENDIDO });
  const [status, setStatus] = useState<ProgramadosStatus>(initial ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<PrefKey | null>(null);
  const [prefError, setPrefError] = useState<string | null>(null);
  const alive = useRef(true);
  const loaded = useRef(Boolean(initial));

  useEffect(() => {
    if (status === 'ready') writeCache(KEY, data);
  }, [status, data]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await leer();
      if (!alive.current) return;
      loaded.current = true;
      setData(result);
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (!alive.current || loaded.current) return; // un refresco que falla no borra lo que ya se ve
      setError(e instanceof Error ? e.message : 'No se pudieron cargar los recordatorios.');
      setStatus('error');
    }
  }, []);

  const retry = useCallback(() => {
    setStatus('loading');
    return load();
  }, [load]);

  // Al entrar, al volver a la app y cuando el service worker avisa de que llegó un push (un recordatorio que salió ya no está pendiente).
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

  // Se quita de la lista al instante; si el servidor no lo cancela (ya salió, o falló), se vuelve a leer la verdad y se avisa.
  const cancelar = useCallback(
    async (id: string) => {
      const toast = useToastStore.getState().addToast;
      setData((prev) => ({ ...prev, items: prev.items.filter((r) => r.id !== id) }));
      const { data: filas, error: e } = await supabase
        .from('avisos_programados')
        .update({ estado: 'cancelado' })
        .eq('aviso_id', id)
        .eq('estado', 'pendiente')
        .select('aviso_id');
      if (e) {
        toast('No pude cancelar el recordatorio. Inténtalo de nuevo.', 'error');
      } else if (!filas?.length) {
        toast('Ese recordatorio ya salió.', 'info');
      } else {
        toast('Recordatorio cancelado.', 'success');
        return;
      }
      void load();
    },
    [load],
  );

  const cambiarPref = useCallback(
    async (key: PrefKey, value: boolean) => {
      if (!userId) return;
      const previo = data.prefs[key];
      setPrefError(null);
      setGuardando(key);
      setData((prev) => ({ ...prev, prefs: { ...prev.prefs, [key]: value } }));
      const { error: e } = await supabase
        .from('avisos_preferencias')
        .upsert({ user_id: userId, [key]: value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (!alive.current) return;
      setGuardando(null);
      if (e) {
        setData((prev) => ({ ...prev, prefs: { ...prev.prefs, [key]: previo } }));
        setPrefError('No pude guardar el cambio. Inténtalo de nuevo.');
      }
    },
    [data.prefs, userId],
  );

  return { items: data.items, prefs: data.prefs, status, error, retry, cancelar, cambiarPref, guardando, prefError };
}
