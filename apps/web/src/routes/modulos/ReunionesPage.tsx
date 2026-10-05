import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCachedState } from '@/lib/moduleCache';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { EsperasSection } from '@/components/reuniones/EsperasSection';
import { ReunionCard } from '@/components/reuniones/ReunionCard';
import { leerEsperas, listarReuniones, sincronizar, type EsperasRespuesta, type Reunion } from '@/components/reuniones/api';

export function ReunionesPage() {
  const addToast = useToastStore((s) => s.addToast);
  const [reuniones, setReuniones] = useCachedState<Reunion[]>('reuniones.lista');
  const [esperas, setEsperas] = useCachedState<EsperasRespuesta>('reuniones.esperas');
  const [errorReuniones, setErrorReuniones] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  const cargar = useCallback(async () => {
    const [r, e] = await Promise.allSettled([listarReuniones(30), leerEsperas()]);
    if (r.status === 'fulfilled') { setReuniones(r.value); setErrorReuniones(null); }
    else setErrorReuniones(r.reason instanceof Error ? r.reason.message : 'No pude cargar las reuniones.');
    if (e.status === 'fulfilled') setEsperas(e.value);
    else setEsperas({ ok: false, motivo: 'error', mensaje: e.reason instanceof Error ? e.reason.message : 'No pude cargar las esperas.' });
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  async function sync() {
    setSincronizando(true);
    try {
      const { nuevas, avisos, completa } = await sincronizar();
      await cargar();
      const base = (nuevas === 0 ? 'Todo al día.' : nuevas === 1 ? '1 reunión nueva.' : `${nuevas} reuniones nuevas.`)
        + (completa ? '' : ' Faltan más: vuelve a sincronizar.');
      addToast(avisos > 0 ? `${base} ${avisos} ${avisos === 1 ? 'espera pasó' : 'esperas pasaron'} de 3 días.` : base, 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'No pude sincronizar con Fathom.', 'error');
    } finally {
      setSincronizando(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Reuniones</h1>
        <button
          type="button"
          onClick={sync}
          disabled={sincronizando}
          className="btn-primary min-h-[44px] flex items-center gap-2"
        >
          <RefreshCw size={16} className={cn(sincronizando && 'animate-spin')} />
          {sincronizando ? 'Sincronizando…' : 'Sincronizar'}
        </button>
      </div>

      <EsperasSection datos={esperas} cargando={esperas === null} />

      <section className="space-y-3" aria-labelledby="recientes-titulo">
        <h2 id="recientes-titulo" className="text-lg font-bold">Recientes</h2>
        {errorReuniones ? (
          <div className="card space-y-2">
            <p className="text-sm text-slate-300">{errorReuniones}</p>
            <button type="button" onClick={() => void cargar()} className="btn-secondary min-h-[44px]">Reintentar</button>
          </div>
        ) : reuniones === null ? (
          <div className="space-y-3" aria-busy="true">
            <div className="card h-32 animate-pulse" />
            <div className="card h-32 animate-pulse" />
          </div>
        ) : reuniones.length === 0 ? (
          <div className="card">
            <p className="text-sm text-slate-300">Todavía no hay reuniones guardadas. Toca Sincronizar para traerlas de Fathom.</p>
          </div>
        ) : (
          reuniones.map((r) => <ReunionCard key={r.recording_id} reunion={r} />)
        )}
      </section>
    </div>
  );
}
